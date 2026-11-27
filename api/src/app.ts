import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { PublicKey } from "@solana/web3.js";
import Fastify, { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { Cache } from "./cache";
import { fromBase6, toBase6 } from "./convert";
import { Db } from "./db";
import { Faucet, FaucetError } from "./faucet";
import type { LiveHoldings } from "./snapshots";

export interface AppDeps {
  db: Db;
  cache: Cache;
  cluster: string;
  corsOrigin: string;
  rateLimitPerMin: number;
  /** Live balances x oracle prices for a fund address (throws if unavailable). */
  liveHoldings?: (fundAddress: string) => Promise<LiveHoldings>;
  /** Devnet/localnet only. Omit to disable POST /faucet. */
  faucet?: Faucet;
}

const isPubkey = (s: string) => {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
};

const idParams = z.object({ id: z.coerce.number().int().nonnegative() });
const walletParams = z.object({ wallet: z.string().refine(isPubkey, "invalid Solana address") });
const rangeQuery = z.object({ range: z.enum(["1d", "7d", "30d", "90d", "1y", "all"]).default("7d") });
// Keyset cursor "<iso ts>|<tx id>". Block times have 1s resolution, so a bare timestamp
// would skip rows that share a second with the page boundary.
const cursorSchema = z
  .string()
  .transform((s, ctx) => {
    const [iso, id = ""] = s.split("|");
    const ts = new Date(iso);
    if (Number.isNaN(ts.getTime())) {
      ctx.addIssue({ code: "custom", message: "invalid cursor" });
      return z.NEVER;
    }
    return { ts, id };
  });
const txQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: cursorSchema.optional(),
});

const DAY = 86_400_000;
const money = (d: { toFixed(n: number): string }) => d.toFixed(6);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { db, cache } = deps;
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: deps.corsOrigin.split(",") });
  await app.register(rateLimit, { max: deps.rateLimitPerMin, timeWindow: "1 minute" });

  app.setErrorHandler((error, _req, reply) => {
    const err = error as Error & { statusCode?: number; code?: string };
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "invalid_request", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) console.error(err);
    return reply.code(status).send({ error: status >= 500 ? "internal_error" : err.code ?? "error", message: status >= 500 ? undefined : err.message });
  });

  /** % change of NAV/share vs the last snapshot at or before `days` ago; null if history is too short. */
  async function perfPct(fundId: number, latest: { navPerShare: any }, days: number): Promise<number | null> {
    const base = await db.navSnapshot.findFirst({
      where: { fundId, ts: { lte: new Date(Date.now() - days * DAY) } },
      orderBy: { ts: "desc" },
    });
    if (!base) return null;
    const b = toBase6(base.navPerShare);
    if (b === 0n) return null;
    const l = toBase6(latest.navPerShare);
    return Number(((l - b) * 1_000_000n) / b) / 10_000; // percent, 4 dp
  }

  async function fundView(f: any) {
    const latest = await db.navSnapshot.findFirst({ where: { fundId: f.id }, orderBy: { ts: "desc" } });
    const performance = latest
      ? { "1d": await perfPct(f.id, latest, 1), "7d": await perfPct(f.id, latest, 7), "30d": await perfPct(f.id, latest, 30) }
      : { "1d": null, "7d": null, "30d": null };
    const [vol, holders] = await Promise.all([
      db.tx.aggregate({ _sum: { usdc: true }, where: { fundId: f.id, ts: { gte: new Date(Date.now() - DAY) } } }),
      db.position.count({ where: { fundId: f.id, shares: { gt: 0 } } }),
    ]);
    return {
      id: f.id,
      address: f.address,
      name: f.name,
      shareMint: f.shareMint,
      mgmtFeeBps: f.mgmtFeeBps,
      navPerShare: latest ? money(latest.navPerShare) : null,
      tvlUsd: latest ? money(latest.tvlUsd) : null,
      totalShares: latest ? money(latest.totalShares) : null,
      updatedAt: latest ? latest.ts.toISOString() : null,
      performance,
      /** Indexed deposits + redemptions (USDC) in the last 24h, and wallets holding shares. */
      volume24hUsd: money(vol._sum.usdc ?? 0),
      holders,
      components: f.components.map((c: any) => ({ mint: c.mint, symbol: c.symbol, targetBps: c.weightBps })),
    };
  }

  const explorer = (addr: string) =>
    `https://explorer.solana.com/address/${addr}${deps.cluster === "mainnet-beta" ? "" : `?cluster=${deps.cluster === "localnet" ? "custom" : deps.cluster}`}`;

  // ------------------------------------------------------------------ routes

  app.get("/health", async (_req, reply) => {
    let dbOk = false;
    try {
      await db.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch {
      /* reported below */
    }
    const cacheOk = await cache.ping();
    const lastSlot = dbOk ? (await db.indexerState.findUnique({ where: { key: "lastSlot" } }))?.value ?? null : null;
    const ok = dbOk && cacheOk;
    return reply.code(ok ? 200 : 503).send({ ok, db: dbOk, cache: { kind: cache.kind, ok: cacheOk }, indexer: { lastSlot } });
  });

  const faucetBody = z.object({ wallet: z.string().refine(isPubkey, "invalid Solana address") });
  if (deps.faucet) {
    const faucet = deps.faucet;
    // Stricter than the global limit: each call costs the faucet SOL for the recipient's token account.
    app.post("/faucet", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
      const { wallet } = faucetBody.parse(req.body);
      try {
        const r = await faucet.drip(new PublicKey(wallet));
        return { wallet, amountUsdc: fromBase6(r.amount), signature: r.signature, tokenAccount: r.ata, note: "MOCK USDC — devnet only, no value" };
      } catch (e) {
        if (e instanceof FaucetError) return reply.code(e.status).send({ error: e.code, message: e.message });
        throw e;
      }
    });
  }

  app.get("/funds", async () => {
    const funds = await db.fund.findMany({ include: { components: true }, orderBy: { id: "asc" } });
    return { funds: await Promise.all(funds.map(fundView)) };
  });

  app.get("/funds/:id", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const f = await db.fund.findUnique({ where: { id }, include: { components: true } });
    if (!f) return reply.code(404).send({ error: "not_found", message: `fund ${id} not found` });

    const base = await fundView(f);
    let holdings: unknown = null;
    let holdingsError: string | undefined;
    if (deps.liveHoldings) {
      const ck = `holdings:${f.address}`;
      // ?fresh=1 skips the 5s cache (used right after the user's own transaction).
      const fresh = (req.query as Record<string, unknown>)?.fresh === "1";
      const hit = fresh ? null : await cache.get(ck);
      if (hit) {
        holdings = JSON.parse(hit);
      } else {
        try {
          const h = await deps.liveHoldings(f.address);
          const symbolOf = new Map(f.components.map((c) => [c.mint, c.symbol]));
          holdings = {
            navUsd: fromBase6(h.navUsd6),
            // Same snapshot as navUsd. Quotes must use these two together: mixing a cached NAV
            // with a live share supply gives wrong prices right after a transaction.
            totalShares: fromBase6(h.totalShares),
            idleUsdc: fromBase6(h.idleUsdc),
            priceAgeSecs: h.priceAgeSecs,
            components: h.components.map((c) => ({
              mint: c.mint,
              symbol: symbolOf.get(c.mint) ?? c.mint.slice(0, 4),
              balance: c.balance.toString(),
              valueUsd: fromBase6(c.valueUsd6),
              targetBps: c.targetBps,
              actualBps: c.actualBps,
            })),
          };
          await cache.set(ck, JSON.stringify(holdings), 5);
        } catch (e: any) {
          holdingsError = String(e?.message ?? e).split("\n")[0]; // e.g. stale oracle off-hours
        }
      }
    }
    return {
      ...base,
      holdings,
      ...(holdingsError ? { holdingsError } : {}),
      links: { fund: explorer(f.address), shareMint: explorer(f.shareMint) },
    };
  });

  app.get("/funds/:id/nav", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { range } = rangeQuery.parse(req.query);
    if (!(await db.fund.findUnique({ where: { id }, select: { id: true } }))) {
      return reply.code(404).send({ error: "not_found", message: `fund ${id} not found` });
    }
    const days = { "1d": 1, "7d": 7, "30d": 30, "90d": 90, "1y": 365, all: null }[range];
    const rows = await db.navSnapshot.findMany({
      where: { fundId: id, ...(days ? { ts: { gte: new Date(Date.now() - days * DAY) } } : {}) },
      orderBy: { ts: "asc" },
      take: 5000,
    });
    return {
      fundId: id,
      range,
      points: rows.map((r) => ({ ts: r.ts.toISOString(), navPerShare: money(r.navPerShare), tvlUsd: money(r.tvlUsd) })),
    };
  });

  app.get("/portfolio/:wallet", async (req) => {
    const { wallet } = walletParams.parse(req.params);
    const positions = await db.position.findMany({ where: { wallet }, include: { fund: true }, orderBy: { fundId: "asc" } });

    let totalValue = 0n;
    let totalCost = 0n;
    const out = [];
    for (const p of positions) {
      const latest = await db.navSnapshot.findFirst({ where: { fundId: p.fundId }, orderBy: { ts: "desc" } });
      const shares = toBase6(p.shares);
      const cost = toBase6(p.costBasis);
      const value = latest ? (shares * toBase6(latest.navPerShare)) / 1_000_000n : null;
      if (value !== null) totalValue += value;
      totalCost += cost;
      out.push({
        fundId: p.fundId,
        fundName: p.fund.name,
        shares: fromBase6(shares),
        costBasis: fromBase6(cost),
        navPerShare: latest ? money(latest.navPerShare) : null,
        valueUsd: value === null ? null : fromBase6(value),
        pnlUsd: value === null ? null : fromBase6(value - cost),
        pnlPct: value === null || cost === 0n ? null : Number(((value - cost) * 1_000_000n) / cost) / 10_000,
      });
    }
    return {
      wallet,
      positions: out,
      totals: { valueUsd: fromBase6(totalValue), costBasis: fromBase6(totalCost), pnlUsd: fromBase6(totalValue - totalCost) },
    };
  });

  app.get("/portfolio/:wallet/txs", async (req) => {
    const { wallet } = walletParams.parse(req.params);
    const { limit, before } = txQuery.parse(req.query);
    const rows = await db.tx.findMany({
      where: {
        wallet,
        ...(before
          ? { OR: [{ ts: { lt: before.ts } }, ...(before.id ? [{ ts: before.ts, id: { lt: before.id } }] : [])] }
          : {}),
      },
      orderBy: [{ ts: "desc" }, { id: "desc" }],
      take: limit,
    });
    return {
      wallet,
      txs: rows.map((t) => ({
        sig: t.sig,
        fundId: t.fundId,
        kind: t.kind,
        usdc: money(t.usdc),
        shares: money(t.shares),
        slot: t.slot.toString(),
        ts: t.ts.toISOString(),
      })),
      nextBefore: rows.length === limit ? `${rows[rows.length - 1].ts.toISOString()}|${rows[rows.length - 1].id}` : null,
    };
  });

  return app;
}
