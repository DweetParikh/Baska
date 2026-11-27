/**
 * Headless check of everything the UI does on-chain, using the app's own lib code with a
 * Keypair standing in for the wallet. Run from app/ against a seeded cluster with the API,
 * price updater and faucet running:
 *
 *   ADMIN_KEYPAIR=/path/to/admin.json npm run check:devnet
 *
 * It does NOT test the wallet pop-up or any React rendering.
 */
import { getAccount, getMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { api } from "../src/lib/api";
import { CONFIG_PDA, FUNDS, RPC_URL, USDC_MINT } from "../src/lib/config";
import { friendlyError } from "../src/lib/errors";
import { makeProgram } from "../src/lib/program";
import { quoteDeposit, quoteRedeemUsdc, withSlippage } from "../src/lib/quote";
import { toBase6 } from "../src/lib/format";
import {
  buildDeposit,
  buildRedeemInKind,
  buildRedeemUsdc,
  buildSetGlobalPaused,
  confirmByPolling,
  simulate,
  userAta,
} from "../src/lib/tx";

const USDC = 1_000_000n;
// Public devnet RPC rate-limits hard: space requests out and retry 429s with backoff.
let nextAt = 0;
const politeFetch = async (input: any, init?: any) => {
  for (let attempt = 0; ; attempt++) {
    const now = Date.now();
    const wait = Math.max(0, nextAt - now);
    nextAt = Math.max(now, nextAt) + 450;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const res = await fetch(input, init);
    if (res.status !== 429 || attempt >= 8) return res;
    const backoff = Math.min(1000 * 2 ** attempt, 15_000);
    nextAt = Math.max(nextAt, Date.now() + backoff);
    await new Promise((r) => setTimeout(r, backoff));
  }
};
const conn = new Connection(RPC_URL, { commitment: "confirmed", fetch: politeFetch as typeof fetch, disableRetryOnRateLimit: true });
const program = makeProgram(conn);
let failed = 0;

async function check(name: string, fn: () => Promise<string | void>) {
  process.stdout.write(`▶ ${name} ... `);
  try {
    const note = await fn();
    console.log(`ok${note ? `  (${note})` : ""}`);
  } catch (e: any) {
    failed++;
    console.log(`FAILED: ${String(e?.message ?? e).split("\n")[0]}`);
  }
}

/** What the wallet adapter does: set blockhash, sign, send, confirm. Also enforces the 1232-byte limit. */
async function send(tx: Transaction, signer: Keypair): Promise<{ sig: string; bytes: number }> {
  const sim = await simulate(conn, tx, signer.publicKey);
  if (!sim.ok) throw new Error(friendlyError(sim.err, sim.logs));
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(signer);
  const raw = tx.serialize();
  if (raw.length > 1232) throw new Error(`transaction is ${raw.length} bytes (limit 1232)`);
  const sig = await conn.sendRawTransaction(raw);
  await confirmByPolling(conn, sig);
  return { sig, bytes: raw.length };
}

async function main() {
  const adminPath = process.env.ADMIN_KEYPAIR ?? path.join(os.homedir(), ".config", "solana", "id.json");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(adminPath, "utf8"))));
  const user = Keypair.generate();
  console.log(`user ${user.publicKey.toBase58()}  rpc ${RPC_URL}\n`);

  await check("fund the user with SOL", async () => {
    await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: user.publicKey, lamports: 60_000_000 })), admin);
  });
  await check("faucet endpoint mints test USDC", async () => {
    const r = await api.faucet(user.publicKey.toBase58());
    return `${r.amountUsdc} USDC`;
  });

  const f3 = FUNDS.find((f) => f.id === 3)!;
  const f1 = FUNDS.find((f) => f.id === 1)!;
  const bal = async (mint: PublicKey) => (await getAccount(conn, userAta(mint, user.publicKey))).amount;

  // --- error handling: failures must be caught by simulation, with readable messages
  await check("deposit below the fund minimum is rejected in simulation with a friendly message", async () => {
    const tx = await buildDeposit(program, user.publicKey, f3, USDC / 2n, 0n);
    const sim = await simulate(conn, tx, user.publicKey);
    if (sim.ok) throw new Error("expected simulation to fail");
    const msg = friendlyError(sim.err, sim.logs);
    if (!/minimum deposit/i.test(msg)) throw new Error(`unfriendly message: ${msg}`);
    return msg;
  });
  await check("a non-admin cannot toggle the global pause (rejected in simulation)", async () => {
    const sim = await simulate(conn, await buildSetGlobalPaused(program, user.publicKey, true), user.publicKey);
    if (sim.ok) throw new Error("non-admin pause unexpectedly succeeded");
    const msg = friendlyError(sim.err, sim.logs);
    if (!/admin/i.test(msg)) throw new Error(`unfriendly message: ${msg}`);
  });

  // --- fund 3: deposit with a client-side quote, then redeem to USDC
  let f3Shares = 0n;
  await check("fund 3: deposit $50, minted shares match the client-side quote (within 0.5%)", async () => {
    const d = await api.fund(3, { fresh: true });
    if (!d.holdings) throw new Error(`no live holdings: ${d.holdingsError}`);
    // NAV and supply from the SAME snapshot (never mix a cached NAV with a live supply).
    const quote = quoteDeposit(50n * USDC, toBase6(d.holdings.totalShares), toBase6(d.holdings.navUsd))!;
    const tx = await buildDeposit(program, user.publicKey, f3, 50n * USDC, withSlippage(quote, 50));
    const { bytes } = await send(tx, user);
    f3Shares = await bal(new PublicKey(f3.shareMint));
    const diff = Number(f3Shares > quote ? f3Shares - quote : quote - f3Shares) / Number(quote);
    if (diff > 0.005) throw new Error(`quote ${quote} vs minted ${f3Shares}`);
    return `${bytes} bytes, minted ${Number(f3Shares) / 1e6}`;
  });
  await check("fund 3: redeem_usdc pays what the client quoted (within 0.5%)", async () => {
    const d = await api.fund(3, { fresh: true }); // fresh: our deposit just changed NAV and supply
    const shares = 10n * USDC;
    const quote = quoteRedeemUsdc(shares, toBase6(d.holdings!.totalShares), toBase6(d.holdings!.navUsd))!;
    const before = await bal(USDC_MINT);
    const { bytes } = await send(await buildRedeemUsdc(program, user.publicKey, f3, shares, withSlippage(quote, 50)), user);
    const got = (await bal(USDC_MINT)) - before;
    const diff = Number(got > quote ? got - quote : quote - got) / Number(quote);
    if (diff > 0.005) throw new Error(`quote ${quote} vs received ${got}`);
    return `${bytes} bytes, got $${Number(got) / 1e6}`;
  });
  await check("slippage guard: an impossible minimum is rejected before signing", async () => {
    const tx = await buildDeposit(program, user.publicKey, f3, 5n * USDC, 10n ** 15n);
    const sim = await simulate(conn, tx, user.publicKey);
    if (sim.ok) throw new Error("expected failure");
    if (!/price moved/i.test(friendlyError(sim.err, sim.logs))) throw new Error("unfriendly slippage message");
  });

  // --- fund 1: the 7-component worst case for transaction size
  await check("fund 1 (7 components): deposit $100 fits in one transaction", async () => {
    const { bytes } = await send(await buildDeposit(program, user.publicKey, f1, 100n * USDC, 0n), user);
    return `${bytes} bytes`;
  });
  await check("fund 1: redeem_in_kind — setup (7 token accounts) then redeem, each within the size limit", async () => {
    const { setup, main } = await buildRedeemInKind(conn, program, user.publicKey, f1, 20n * USDC);
    if (!setup) throw new Error("expected a setup transaction for a fresh wallet");
    const s = await send(setup, user);
    // Rebuild: now that the accounts exist the plan must be a single transaction.
    const again = await buildRedeemInKind(conn, program, user.publicKey, f1, 20n * USDC);
    if (again.setup) throw new Error("setup still reported missing after creating the accounts");
    const m = await send(again.main, user);
    void main;
    for (const c of f1.components) {
      if ((await bal(new PublicKey(c.mint))) === 0n && c.targetBps > 0) {
        // A component can legitimately be 0 if the keeper hasn't deployed cash into it yet.
        const v = await getAccount(conn, new PublicKey(c.vault));
        if (v.amount > 0n) throw new Error(`${c.symbol} not delivered`);
      }
    }
    return `setup ${s.bytes} bytes, redeem ${m.bytes} bytes`;
  });

  console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}

void CONFIG_PDA;
void TOKEN_PROGRAM_ID;
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
