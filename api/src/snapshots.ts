import { Connection, PublicKey } from "@solana/web3.js";
import { MarketDataProvider, snapshotFund } from "../../keeper/src/chain";
import { valuate } from "../../keeper/src/plan";
import { fromBase6 } from "./convert";
import { Db } from "./db";

type Log = (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;

export interface SnapshotDeps {
  db: Db;
  conn: Connection;
  program: any;
  market: MarketDataProvider;
  /** Don't record NAV from oracles older than this (market closed / feed down). */
  maxPriceAgeSecs: number;
  log?: Log;
}

export interface LiveHoldings {
  navUsd6: bigint;
  idleUsdc: bigint;
  totalShares: bigint;
  navPerShareUsd6: bigint;
  priceAgeSecs: number;
  components: { index: number; mint: string; balance: bigint; valueUsd6: bigint; actualBps: number; targetBps: number }[];
}

/** One live read of a fund: balances x oracle prices. No DB access. */
export async function readLiveHoldings(
  d: Pick<SnapshotDeps, "conn" | "program" | "market">,
  fundAddress: string
): Promise<LiveHoldings> {
  const key = new PublicKey(fundAddress);
  const snap = await snapshotFund(d.conn, d.program, d.market, key);
  const { total, values } = valuate(snap.state);
  const supply = snap.shareSupply; // same slot as the balances (see snapshotFund)
  const comps = snap.account.components.slice(0, snap.account.numComponents);
  return {
    navUsd6: total,
    idleUsdc: snap.state.idleUsdc,
    totalShares: supply,
    navPerShareUsd6: supply === 0n ? 0n : (total * 1_000_000n) / supply,
    priceAgeSecs: snap.maxPriceAgeSecs,
    components: snap.state.components.map((c, i) => ({
      index: i,
      mint: comps[i].mint.toBase58(),
      balance: c.balance,
      valueUsd6: values[i],
      actualBps: total === 0n ? 0 : Number((values[i] * 10_000n) / total),
      targetBps: c.targetBps,
    })),
  };
}

export class Snapshotter {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private log: Log;
  constructor(private d: SnapshotDeps) {
    this.log = d.log ?? (() => {});
  }

  /** Records NAV/share + TVL for one fund. Returns false when skipped (stale oracle, unknown fund). */
  async snapshotFund(fundId: number): Promise<boolean> {
    const fund = await this.d.db.fund.findUnique({ where: { id: fundId } });
    if (!fund) return false;
    const h = await readLiveHoldings(this.d, fund.address);
    if (h.priceAgeSecs > this.d.maxPriceAgeSecs) {
      this.log("warn", "skipping NAV snapshot: stale oracle", { fundId, ageSecs: h.priceAgeSecs });
      return false;
    }
    await this.d.db.navSnapshot.create({
      data: {
        fundId,
        navPerShare: fromBase6(h.navPerShareUsd6),
        tvlUsd: fromBase6(h.navUsd6),
        totalShares: fromBase6(h.totalShares),
      },
    });
    return true;
  }

  async snapshotAll(): Promise<number> {
    if (this.running) return 0; // never overlap
    this.running = true;
    let n = 0;
    try {
      for (const f of await this.d.db.fund.findMany({ select: { id: true } })) {
        try {
          if (await this.snapshotFund(f.id)) n++;
        } catch (e: any) {
          this.log("error", "snapshot failed", { fundId: f.id, error: String(e?.message ?? e) });
        }
      }
    } finally {
      this.running = false;
    }
    return n;
  }

  start(intervalMs: number) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.snapshotAll(), intervalMs);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
