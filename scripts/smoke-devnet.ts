/**
 * End-to-end smoke test against a seeded cluster (devnet by default). Plays a real user plus the
 * keeper, and checks the running API's view of it.
 *
 * Prereqs (all running): scripts/price-updater.ts, api/src/index.ts (faucet enabled).
 *   API_URL   default http://127.0.0.1:3001
 *
 * Flow:
 *   1. fresh wallet gets SOL from admin, then mock USDC from POST /faucet
 *   2. fund 3 (S&P Core, 1 component):  deposit -> redeem_usdc        (idle buffer path)
 *   3. fund 1 (Mag7, 7 components):     deposit -> keeper rebalances -> redeem_in_kind
 *   4. API reflects it: portfolio, txs, NAV, live holdings
 * Prints compute units per instruction: the 7-component fund is the worst case for the frontend.
 */
import { BN } from "@anchor-lang/core";
import { getAccount, getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetProgram, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { MockFeedProvider, sendSwap, snapshotFund } from "../keeper/src/chain";
import { makeConnection } from "../keeper/src/rpc";
import { currentDrift, planSwap } from "../keeper/src/plan";
import { adminKeypairPath, env, loadDeployment, loadKeypairFile, loadOrCreateKey, log, makeProgram, pk, RPC_URL, sleep } from "./lib";

const API = env("API_URL", "http://127.0.0.1:3001");
const USDC = 1_000_000n;
const results: { step: string; ok: boolean; detail: string }[] = [];
const cu: Record<string, number> = {};

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  process.stdout.write(`▶ ${name} ... `);
  try {
    const r = await fn();
    console.log("ok");
    results.push({ step: name, ok: true, detail: "" });
    return r;
  } catch (e: any) {
    const msg = String(e?.message ?? e).split("\n")[0];
    console.log(`FAILED: ${msg}`);
    results.push({ step: name, ok: false, detail: msg });
    throw e;
  }
}

const api = async (path: string, init?: RequestInit) => {
  const r = await fetch(`${API}${path}`, init);
  return { status: r.status, body: (await r.json()) as any };
};

async function main() {
  const dep = loadDeployment();
  if (!dep) throw new Error("no deployment file; run the seed first");
  const admin = loadKeypairFile(adminKeypairPath());
  const keeperKp = loadOrCreateKey("keeper");
  const conn = makeConnection(RPC_URL);
  const user = Keypair.generate();
  const { program: userProg, provider: userProvider } = makeProgram(user, conn);
  const { program: keeperProg } = makeProgram(keeperKp, conn);
  const usdcMint = pk(dep.usdcMint);
  const cuOf = async (sig: string, label: string) => {
    for (let i = 0; i < 10; i++) {
      const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (t?.meta) return void (cu[label] = Math.max(cu[label] ?? 0, t.meta.computeUnitsConsumed ?? 0));
      await sleep(800);
    }
  };
  const ata = async (mint: string, owner = user.publicKey) => (await getOrCreateAssociatedTokenAccount(conn, admin, pk(mint), owner)).address;

  log(`user wallet: ${user.publicKey.toBase58()}`);

  // 1 ----------------------------------------------------------------- funding
  await step("fund user with SOL for fees", async () => {
    await makeProgram(admin, conn).provider.sendAndConfirm(
      new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: user.publicKey, lamports: 60_000_000 }))
    );
  });

  const userUsdc = await step("faucet mints mock USDC via the API", async () => {
    const r = await api("/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: user.publicKey.toBase58() }) });
    if (r.status !== 200) throw new Error(`faucet ${r.status}: ${JSON.stringify(r.body)}`);
    const a = pk(r.body.tokenAccount);
    const bal = (await getAccount(conn, a)).amount;
    if (bal < 1000n * USDC) throw new Error(`expected >= 1000 USDC, got ${bal}`);
    return a;
  });
  await step("faucet cooldown blocks an immediate second request", async () => {
    const r = await api("/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: user.publicKey.toBase58() }) });
    if (r.status !== 429) throw new Error(`expected 429, got ${r.status}`);
  });

  const oracle = (f: (typeof dep.funds)[number]) =>
    f.components.flatMap((c) => [
      { pubkey: pk(c.vault), isWritable: false, isSigner: false },
      { pubkey: pk(c.priceFeed), isWritable: false, isSigner: false },
    ]);
  const accts = async (f: (typeof dep.funds)[number]) => ({
    user: user.publicKey,
    fund: pk(f.address),
    usdcMint,
    shareMint: pk(f.shareMint),
    usdcVault: pk(f.usdcVault),
    userUsdc,
    userShares: await ata(f.shareMint),
    tokenProgram: TOKEN_PROGRAM_ID,
  });
  const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })];

  // 2 ------------------------------------------------------------- fund 3: idle path
  const f3 = dep.funds.find((f) => f.id === 3)!;
  const f3Shares = await ata(f3.shareMint);
  await step(`deposit $100 into fund 3 (${f3.name}, ${f3.components.length} component)`, async () => {
    const sig = await userProg.methods.deposit(new BN((100n * USDC).toString()), new BN(0))
      .accounts(await accts(f3)).remainingAccounts(oracle(f3)).preInstructions(budget).rpc();
    await cuOf(sig, "deposit (1 component)");
    if ((await getAccount(conn, f3Shares)).amount < 99n * USDC) throw new Error("did not receive ~100 shares");
  });
  await step("redeem_usdc 10 shares from fund 3 pays ~$10 from the idle buffer", async () => {
    const before = (await getAccount(conn, userUsdc)).amount;
    const sig = await userProg.methods.redeemUsdc(new BN((10n * USDC).toString()), new BN(0))
      .accounts(await accts(f3)).remainingAccounts(oracle(f3)).preInstructions(budget).rpc();
    await cuOf(sig, "redeem_usdc (1 component)");
    const got = (await getAccount(conn, userUsdc)).amount - before;
    if (got < 9n * USDC || got > 11n * USDC) throw new Error(`expected ~$10, got ${got}`);
  });

  // 3 --------------------------------------------------- fund 1: 7 components + keeper
  const f1 = dep.funds.find((f) => f.id === 1)!;
  const f1Shares = await ata(f1.shareMint);
  await step(`deposit $100 into fund 1 (${f1.name}, ${f1.components.length} components)`, async () => {
    const sig = await userProg.methods.deposit(new BN((100n * USDC).toString()), new BN(0))
      .accounts(await accts(f1)).remainingAccounts(oracle(f1)).preInstructions(budget).rpc();
    await cuOf(sig, "deposit (7 components)");
  });

  await step("keeper rebalances fund 1 (execute_swap, 7 components) until the planner is satisfied", async () => {
    const market = new MockFeedProvider(keeperProg);
    const opts = { minIdleUsdc: 10n * USDC, maxTradeUsdc: 5_000n * USDC, driftToleranceBps: 500, slippageBps: 50, venueFeeBps: 10 };
    let swaps = 0;
    for (let i = 0; i < 12; i++) {
      const snap = await snapshotFund(conn, keeperProg, market, pk(f1.address));
      if (snap.maxPriceAgeSecs > 50) throw new Error(`oracle is stale (${snap.maxPriceAgeSecs}s): is the price updater running?`);
      const w = planSwap(snap.state, opts);
      if (!w) break;
      const sig = await sendSwap(keeperProg, usdcMint, snap, w);
      await cuOf(sig, "execute_swap (7 components)");
      swaps++;
    }
    const snap = await snapshotFund(conn, keeperProg, new MockFeedProvider(keeperProg), pk(f1.address));
    const drift = currentDrift(snap.state);
    log(`   ${swaps} swaps; idle USDC now ${Number(snap.state.idleUsdc) / 1e6}; drift ${drift} bps`);
    if (swaps === 0) throw new Error("keeper made no swaps (fund should have idle USDC to deploy)");
    if (drift > 150n) throw new Error(`drift ${drift} bps is too high after rebalancing`);
  });

  await step("redeem_in_kind 20 shares from fund 1 returns every component token", async () => {
    const rem = [];
    const dest: string[] = [];
    for (const c of f1.components) {
      const a = await ata(c.mint);
      dest.push(a.toBase58());
      rem.push(
        { pubkey: pk(c.mint), isWritable: false, isSigner: false },
        { pubkey: pk(c.vault), isWritable: true, isSigner: false },
        { pubkey: a, isWritable: true, isSigner: false }
      );
    }
    const sig = await userProg.methods.redeemInKind(new BN((20n * USDC).toString()))
      .accounts(await accts(f1)).remainingAccounts(rem).rpc();
    await cuOf(sig, "redeem_in_kind (7 components)");
    for (const a of dest) if ((await getAccount(conn, pk(a))).amount === 0n) throw new Error("a component token was not delivered");
  });

  // 4 ------------------------------------------------------------------- API view
  await step("API indexes the activity (positions + txs)", async () => {
    const w = user.publicKey.toBase58();
    let body: any;
    for (let i = 0; i < 90; i++) { // live ws or the 30s backfill, whichever lands first
      body = (await api(`/portfolio/${w}/txs`)).body;
      if (body.txs?.length >= 4) break;
      await sleep(2000);
    }
    if ((body.txs?.length ?? 0) < 4) throw new Error(`API has ${body.txs?.length ?? 0}/4 txs after waiting`);
    const kinds = JSON.stringify(body.txs.map((t: any) => t.kind).sort());
    const expected = JSON.stringify(["deposit", "deposit", "redeem", "redeem_in_kind"]);
    if (kinds !== expected) throw new Error(`unexpected tx kinds ${kinds}`);
    const p = (await api(`/portfolio/${w}`)).body;
    const onchain1 = (await getAccount(conn, f1Shares)).amount;
    const pos1 = p.positions.find((x: any) => x.fundId === 1);
    if (!pos1 || BigInt(Math.round(Number(pos1.shares) * 1e6)) !== onchain1) throw new Error(`indexed shares ${pos1?.shares} != on-chain ${onchain1}`);
  });

  await step("API serves fund list, live holdings, NAV series", async () => {
    const funds = (await api("/funds")).body.funds;
    if (funds.length < 4) throw new Error(`expected 4 funds, got ${funds.length}`);
    const d = await api("/funds/1");
    if (d.status !== 200 || !d.body.holdings) throw new Error(`holdings missing: ${d.body.holdingsError ?? d.status}`);
    const n = await api("/funds/1/nav?range=1d");
    if (!n.body.points?.length) throw new Error("no NAV snapshots");
  });

  report();
}

function report() {
  console.log("\n==== compute units (max observed) ====");
  for (const [k, v] of Object.entries(cu)) console.log(`  ${k.padEnd(28)} ${v.toLocaleString()} CU`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`\nsmoke test aborted: ${String(e?.message ?? e).split("\n")[0]}`);
  report();
  process.exit(1);
});
