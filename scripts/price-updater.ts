/**
 * Keeps every MockPriceFeed fresh. The program rejects prices older than 60s, so on devnet this
 * loop MUST be running or deposits / redeem_usdc / swaps revert with OracleStale
 * (redeem_in_kind still works). Default interval 20s leaves two missed ticks of headroom.
 *
 *   INTERVAL_S    default 20
 *   QUOTES        "live" (default: Yahoo Finance real quotes) or "sim" (random walk)
 *   QUOTES_URL    optional JSON endpoint {"AAPL": 231.2, ...}; overrides QUOTES
 *   Live falls back to the simulator only if Yahoo fails for >10 min (logged as a warning).
 *   MAX_MOVE_PCT  default 20; a quote moving more than this vs the last publish is rejected
 *   PORT          default 8788 (GET /oracle/health)
 *   ORACLE_ONCE=1 publish once and exit
 *
 * Default prices are REAL last-trade US equity quotes (Yahoo). Switching from the simulator re-bases
 * every feed on the first publish, so fund NAVs step once to reflect real prices.
 * Uses keys/oracle.json (the feeds' authority) and deployments/<cluster>.json.
 */
import { BN } from "@anchor-lang/core";
import { Transaction } from "@solana/web3.js";
import * as http from "http";
import { FallbackQuotes, HttpQuotes, QuoteSource, SimulatedQuotes, YahooQuotes, toRawPrice } from "./quotes";
import { env, loadDeployment, loadOrCreateKey, makeProgram, pk, sendPolling, sleep } from "./lib";

const INTERVAL_S = Number(env("INTERVAL_S", "20"));
const MAX_MOVE = Number(env("MAX_MOVE_PCT", "20")) / 100;
const PORT = Number(env("PORT", "8788"));
const ONCE = env("ORACLE_ONCE", "") === "1";

const jlog = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

// A rate-limited RPC can reject background web3.js promises we don't own. Log and keep publishing:
// dying here would let every feed go stale within a minute.
process.on("unhandledRejection", (e: any) => jlog("warn", "unhandled rejection (ignored)", { error: String(e?.message ?? e).split("\n")[0] }));

async function main() {
  const dep = loadDeployment();
  if (!dep) throw new Error("no deployments/<cluster>.json: run scripts/seed-devnet.ts first");
  const oracle = loadOrCreateKey("oracle");
  if (oracle.publicKey.toBase58() !== dep.service.oracle) throw new Error("keys/oracle.json does not match deployment oracle key");
  const { program, conn } = makeProgram(oracle);

  const sim = new SimulatedQuotes(Object.fromEntries(dep.stocks.map((s) => [s.symbol, s.baseUsd])));
  const warnFallback = (e: unknown) => jlog("warn", "live quotes failed, using SIMULATOR", { error: String((e as Error).message) });
  const src: QuoteSource = process.env.QUOTES_URL
    ? new FallbackQuotes(new HttpQuotes(process.env.QUOTES_URL), sim, warnFallback)
    : env("QUOTES", "live") === "sim"
      ? sim
      : new FallbackQuotes(new YahooQuotes(), sim, warnFallback);
  const symbols = dep.stocks.map((s) => s.symbol);
  const last = new Map<string, number>();
  const health = { source: src.name, ticks: 0, lastOkAt: 0, consecutiveFailures: 0, lastError: null as string | null };

  jlog("info", "price updater started", { source: src.name, intervalS: INTERVAL_S, feeds: symbols.length, simulated: src.name.includes("simulated") });
  if (!ONCE) {
    http
      .createServer((req, res) => {
        if (req.url !== "/oracle/health") return void res.writeHead(404).end();
        const ok = health.lastOkAt > 0 && Date.now() - health.lastOkAt < INTERVAL_S * 3000;
        res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" }).end(JSON.stringify({ ok, ...health }));
      })
      .listen(PORT);
  }

  const tick = async () => {
    const usd = await src.getUsd(symbols);
    const ixs = [];
    for (const s of dep.stocks) {
      const p = usd[s.symbol];
      const prev = last.get(s.symbol);
      if (prev && Math.abs(p / prev - 1) > MAX_MOVE) {
        jlog("warn", "quote rejected (move too large)", { symbol: s.symbol, prev, p });
        continue;
      }
      const raw = toRawPrice(p);
      ixs.push(
        await program.methods
          .setMockPrice(new BN(raw.toString()), new BN((raw / 20_000n).toString())) // conf = 0.005%
          .accounts({ authority: oracle.publicKey, feed: pk(s.feed) })
          .instruction()
      );
      last.set(s.symbol, p);
    }
    for (let i = 0; i < ixs.length; i += 6) {
      try {
        await sendPolling(conn, new Transaction().add(...ixs.slice(i, i + 6)), [oracle]);
      } catch {
        await sleep(1000);
        await sendPolling(conn, new Transaction().add(...ixs.slice(i, i + 6)), [oracle]); // one retry, fresh blockhash
      }
    }
    health.ticks++;
    health.lastOkAt = Date.now();
    health.consecutiveFailures = 0;
    jlog("info", "prices published", { feeds: ixs.length, sample: Object.fromEntries(symbols.slice(0, 3).map((s) => [s, Number(usd[s].toFixed(2))])) });
  };

  for (;;) {
    const started = Date.now();
    try {
      await tick();
    } catch (e: any) {
      health.consecutiveFailures++;
      health.lastError = String(e?.message ?? e).split("\n")[0];
      jlog("error", "tick failed", { error: health.lastError, consecutiveFailures: health.consecutiveFailures });
    }
    if (ONCE) return process.exit(health.consecutiveFailures ? 1 : 0);
    await sleep(Math.max(1000, INTERVAL_S * 1000 - (Date.now() - started)));
  }
}

main().catch((e) => {
  jlog("error", "fatal", { error: String(e?.message ?? e) });
  process.exit(1);
});
