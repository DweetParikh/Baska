/**
 * Baska API process: Fastify REST + event indexer + NAV snapshotter.
 *
 * Required env: DATABASE_URL. See config.ts for the rest (RPC_URL, REDIS_URL, ...).
 * First run: `npm run api:generate`, apply api/prisma/migrations/*.sql to Postgres.
 */
import * as anchor from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import { MockFeedProvider } from "../../keeper/src/chain";
import { makeConnection } from "../../keeper/src/rpc";
import { buildApp } from "./app";
import { createCache } from "./cache";
import { loadConfig } from "./config";
import { createDb } from "./db";
import { Faucet } from "./faucet";
import { Indexer } from "./indexer";
import { CachedMarketData } from "./prices";
import { readLiveHoldings, Snapshotter } from "./snapshots";

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

// Public RPCs can reject background web3.js promises (e.g. websocket 429s). Log, don't crash.
process.on("unhandledRejection", (e: any) => log("warn", "unhandled rejection (ignored)", { error: String(e?.message ?? e).split("\n")[0] }));

async function main() {
  const cfg = loadConfig();
  const db = createDb(cfg.DATABASE_URL, { maxConnections: cfg.DB_POOL_MAX });
  const cache = createCache(cfg.REDIS_URL);
  if (cache.kind === "memory") log("warn", "REDIS_URL not set: using in-process cache");

  const conn = makeConnection(cfg.RPC_URL);
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(Keypair.generate()), { commitment: "confirmed" });
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const idl = require("../../target/idl/baska_vault.json");
  const program: any = new anchor.Program(idl, provider);

  // Devnet reads mock feeds; swap in a Pyth Hermes / Sunrise provider for mainnet.
  const market = new CachedMarketData(new MockFeedProvider(program), cache, cfg.PRICE_CACHE_TTL_S);
  const snapshotter = new Snapshotter({ db, conn, program, market, maxPriceAgeSecs: cfg.MAX_PRICE_AGE_S, log: log as any });
  const symbols = cfg.SYMBOLS_FILE ? JSON.parse(fs.readFileSync(cfg.SYMBOLS_FILE, "utf8")) : {};
  const indexer = new Indexer({
    db,
    conn,
    program,
    symbols,
    log: log as any,
    onFundActivity: (id) => snapshotter.snapshotFund(id),
  });

  let faucet: Faucet | undefined;
  if (cfg.FAUCET_KEYPAIR) {
    if (cfg.CLUSTER === "mainnet-beta") throw new Error("refusing to enable the faucet on mainnet-beta");
    const [configKey] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
    const onchain = await program.account.globalConfig.fetch(configKey);
    faucet = new Faucet({
      conn,
      payer: Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(cfg.FAUCET_KEYPAIR, "utf8")))),
      usdcMint: onchain.usdcMint,
      amount: BigInt(cfg.FAUCET_AMOUNT_USDC) * 1_000_000n,
      cooldownSecs: cfg.FAUCET_COOLDOWN_S,
      cache,
    });
    await faucet.assertCanMint();
    log("info", "faucet enabled", { amountUsdc: cfg.FAUCET_AMOUNT_USDC, cooldownS: cfg.FAUCET_COOLDOWN_S });
  }

  const app = await buildApp({
    db,
    cache,
    cluster: cfg.CLUSTER,
    corsOrigin: cfg.CORS_ORIGIN,
    rateLimitPerMin: cfg.RATE_LIMIT_PER_MIN,
    liveHoldings: (addr) => readLiveHoldings({ conn, program, market }, addr),
    faucet,
  });

  // Listen before the initial sync: on a fresh database the chain replay can take minutes, and the
  // host (and the web app) should get /health and partial data meanwhile.
  await app.listen({ port: cfg.PORT, host: "0.0.0.0" });
  log("info", "api listening", { port: cfg.PORT, cluster: cfg.CLUSTER });

  // Subscribe first, then backfill: anything in the gap is covered because processing is idempotent.
  indexer.start();
  let backfilling = true;
  // Non-fatal: on a rate-limited RPC the first pass can fail; the periodic backfill retries.
  (async () => {
    try {
      log("info", "initial sync started");
      await indexer.backfill();
      await snapshotter.snapshotAll();
      log("info", "initial sync done");
    } catch (e: any) {
      log("warn", "initial sync incomplete, will retry", { error: String(e?.message ?? e).split("\n")[0] });
    } finally {
      backfilling = false;
    }
  })();
  snapshotter.start(cfg.SNAPSHOT_INTERVAL_MS);

  // Safety net for dropped websockets (common on public RPC): periodically re-read from the cursor.
  const backfillTimer = setInterval(async () => {
    if (backfilling) return;
    backfilling = true;
    try {
      await indexer.backfill();
    } catch (e: any) {
      log("warn", "periodic backfill failed", { error: String(e?.message ?? e) });
    } finally {
      backfilling = false;
    }
  }, cfg.BACKFILL_INTERVAL_MS);

  const shutdown = async () => {
    clearInterval(backfillTimer);
    snapshotter.stop();
    await indexer.stop();
    await app.close();
    await cache.close();
    await db.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  log("error", "fatal", { error: String(e?.message ?? e) });
  process.exit(1);
});