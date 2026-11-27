/**
 * Baska keeper: every INTERVAL_MS, for each fund, deploy idle USDC / trim
 * overweight components via `execute_swap`. Devnet / localnet (mock DEX) only.
 *
 *   RPC_URL          default http://127.0.0.1:8899
 *   KEEPER_KEYPAIR   path to the keeper wallet JSON (must equal config.keeper)
 *   FUND_IDS         comma-separated fund ids; default = every fund
 *   INTERVAL_MS      default 60000
 *   MIN_IDLE_USDC    default 10      (whole USDC)
 *   MAX_TRADE_USDC   default 5000    (whole USDC per swap)
 *   DRIFT_TOL_BPS    default 500
 *   SLIPPAGE_BPS     default 50
 *   MAX_PRICE_AGE_S  default 50      (skip fund if any oracle is older; < on-chain 60s)
 *   DRY_RUN=1        plan and log, never send
 *   PORT             default 8787    (GET /keeper/health)
 *
 * Use a dedicated low-balance wallet for KEEPER_KEYPAIR.
 */
import * as anchor from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { makeConnection } from "./rpc";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { MockFeedProvider, sendSwap, snapshotFund, withRetry } from "./chain";
import { planSwap, PlanOptions } from "./plan";

const env = (k: string, d: string) => process.env[k] ?? d;
const USDC = 1_000_000n;

const RPC_URL = env("RPC_URL", "http://127.0.0.1:8899");
const INTERVAL_MS = Number(env("INTERVAL_MS", "60000"));
const MAX_PRICE_AGE_S = Number(env("MAX_PRICE_AGE_S", "50"));
const DRY_RUN = env("DRY_RUN", "") === "1";
const PORT = Number(env("PORT", "8787"));
const FUND_IDS = env("FUND_IDS", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

const opts: PlanOptions = {
  minIdleUsdc: BigInt(env("MIN_IDLE_USDC", "10")) * USDC,
  maxTradeUsdc: BigInt(env("MAX_TRADE_USDC", "5000")) * USDC,
  driftToleranceBps: Number(env("DRIFT_TOL_BPS", "500")),
  slippageBps: Number(env("SLIPPAGE_BPS", "50")),
  venueFeeBps: 10, // MOCK_SWAP_FEE_BPS in the program
};

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

function loadKeypair(): Keypair {
  const p = env("KEEPER_KEYPAIR", path.join(os.homedir(), ".config", "solana", "id.json"));
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

const health = {
  startedAt: Date.now(),
  ticks: 0,
  lastOkTickAt: 0,
  lastError: null as string | null,
  funds: {} as Record<string, unknown>,
};

function startHealthServer() {
  http
    .createServer((req, res) => {
      if (req.url === "/keeper/health") {
        const ok = health.lastOkTickAt > 0 && Date.now() - health.lastOkTickAt < INTERVAL_MS * 3;
        res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok, dryRun: DRY_RUN, ...health }));
      } else {
        res.writeHead(404).end();
      }
    })
    .listen(PORT, () => log("info", `health endpoint on :${PORT}/keeper/health`));
}

process.on("unhandledRejection", (e: any) => log("warn", "unhandled rejection (ignored)", { error: String(e?.message ?? e).split("\n")[0] }));

async function main() {
  const conn = makeConnection(RPC_URL);
  const wallet = new anchor.Wallet(loadKeypair());
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const idl = require("../../target/idl/baska_vault.json");
  const program: any = new anchor.Program(idl, provider);
  const market = new MockFeedProvider(program);

  const [configKey] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const config = await program.account.globalConfig.fetch(configKey);
  if (!config.keeper.equals(wallet.publicKey)) {
    throw new Error(`wallet ${wallet.publicKey.toBase58()} is not config.keeper ${config.keeper.toBase58()}`);
  }
  const usdcMint: PublicKey = config.usdcMint;
  log("info", "keeper started", { keeper: wallet.publicKey.toBase58(), dryRun: DRY_RUN, opts: String(JSON.stringify(opts, (_, v) => (typeof v === "bigint" ? v.toString() : v))) });
  startHealthServer();

  const tick = async () => {
    const all: { publicKey: PublicKey; account: any }[] = await program.account.fund.all();
    const funds = all.filter((f) => FUND_IDS.length === 0 || FUND_IDS.includes(Number(f.account.id.toString())));
    let failed = 0;

    for (const { publicKey } of funds) {
      const id = Number(all.find((x) => x.publicKey.equals(publicKey))!.account.id.toString());
      try {
        const snap = await snapshotFund(conn, program, market, publicKey);
        if (snap.paused) {
          health.funds[id] = { skipped: "paused" };
          continue;
        }
        // Market-hours / stale-feed policy (guide 5.4 option b): the program rejects
        // stale prices anyway; skip early instead of burning fees on failures.
        if (snap.maxPriceAgeSecs > MAX_PRICE_AGE_S) {
          health.funds[id] = { skipped: "stale-oracle", ageSecs: snap.maxPriceAgeSecs };
          log("warn", "skipping fund: stale oracle", { fund: id, ageSecs: snap.maxPriceAgeSecs });
          continue;
        }
        const swap = planSwap(snap.state, opts);
        if (!swap) {
          health.funds[id] = { status: "balanced" };
          continue;
        }
        const summary = {
          fund: id,
          kind: swap.kind,
          component: swap.index,
          amountIn: swap.amountIn.toString(),
          minOut: swap.minOut.toString(),
          reason: swap.reason,
        };
        if (DRY_RUN) {
          log("info", "dry-run swap", summary);
          health.funds[id] = { status: "dry-run", ...summary };
          continue;
        }
        const sig = await withRetry(() => sendSwap(program, usdcMint, snap, swap), 3, 500, (m) =>
          log("warn", m, { fund: id })
        );
        log("info", "swap sent", { ...summary, sig });
        health.funds[id] = { status: "swapped", sig, at: new Date().toISOString(), ...summary };
      } catch (e: any) {
        failed++;
        const msg = String(e?.message ?? e).split("\n")[0];
        log("error", "fund tick failed", { fund: id, error: msg });
        health.funds[id] = { status: "error", error: msg };
        health.lastError = msg;
      }
    }
    health.ticks++;
    // A tick counts as healthy unless EVERY fund failed (e.g. RPC down).
    if (funds.length === 0 || failed < funds.length) health.lastOkTickAt = Date.now();
  };

  // Sequential loop: never overlap ticks.
  for (;;) {
    try {
      await tick();
    } catch (e: any) {
      health.lastError = String(e?.message ?? e).split("\n")[0];
      log("error", "tick failed", { error: health.lastError });
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((e) => {
  log("error", "fatal", { error: String(e?.message ?? e) });
  process.exit(1);
});
