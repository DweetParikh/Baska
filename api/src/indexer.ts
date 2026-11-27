import * as anchor from "@anchor-lang/core";
import { Connection, PublicKey } from "@solana/web3.js";
import { decodeName, fromBase6, toBase6 } from "./convert";
import { Db } from "./db";

type Log = (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;

export interface IndexerDeps {
  db: Db;
  conn: Connection;
  program: any;
  /** mint -> ticker, used to label fund components. Unknown mints get a short prefix. */
  symbols?: Record<string, string>;
  /** Called after a tx changed a fund's state (deposit / redeem / swap). */
  onFundActivity?: (fundId: number) => Promise<unknown>;
  log?: Log;
}

const TX_EVENTS: Record<string, "deposit" | "redeem" | "redeem_in_kind"> = {
  Deposited: "deposit",
  Redeemed: "redeem",
  RedeemedInKind: "redeem_in_kind",
};

const bn = (v: any): bigint => BigInt(v.toString());

/** Decoded event fields are snake_case with the current IDL; accept camelCase too (older clients). */
const field = (data: any, snake: string): any => {
  const camel = snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const v = data[snake] ?? data[camel];
  if (v === undefined) throw new Error(`event is missing field "${snake}"`);
  return v;
};

/**
 * Turns program logs into rows:
 *   FundCreated / any fund event -> Fund + FundComponent (read from the Fund account)
 *   Deposited / Redeemed / RedeemedInKind -> Tx + Position (idempotent per sig:index)
 * `backfill()` replays history from a stored cursor; `start()` follows live logs.
 * Both paths share `processLogs`, and re-processing a signature is a no-op.
 */
export class Indexer {
  private parser: anchor.EventParser;
  private programId: PublicKey;
  private subId: number | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private log: Log;

  constructor(private d: IndexerDeps) {
    this.programId = d.program.programId;
    this.parser = new anchor.EventParser(this.programId, d.program.coder);
    this.log = d.log ?? (() => {});
  }

  // ---------------------------------------------------------------- funds

  /** Returns the DB fund id for an on-chain fund address, creating it from chain state if new. */
  async ensureFund(fundKey: PublicKey): Promise<number> {
    const address = fundKey.toBase58();
    const existing = await this.d.db.fund.findUnique({ where: { address } });
    if (existing) return existing.id;

    const f = await this.d.program.account.fund.fetch(fundKey);
    const id = Number(f.id.toString());
    const comps = f.components.slice(0, f.numComponents as number);
    const sym = this.d.symbols ?? {};
    await this.d.db.fund.upsert({
      where: { id },
      update: {},
      create: {
        id,
        address,
        name: decodeName(f.name),
        shareMint: f.shareMint.toBase58(),
        mgmtFeeBps: f.mgmtFeeBps,
        components: {
          create: comps.map((c: any) => {
            const mint = c.mint.toBase58();
            return { mint, symbol: sym[mint] ?? mint.slice(0, 4), weightBps: c.targetWeightBps };
          }),
        },
      },
    });
    return id;
  }

  // --------------------------------------------------------------- events

  /** Process one transaction's logs. Returns the fund ids whose state changed. */
  async processLogs(sig: string, slot: number, blockTime: number | null, logs: string[]): Promise<number[]> {
    const touched = new Set<number>();
    const ts = new Date((blockTime ?? Math.floor(Date.now() / 1000)) * 1000);
    let idx = 0;
    for (const ev of this.parser.parseLogs(logs)) {
      const i = idx++;
      const data: any = ev.data;
      // Program(idl) camel-cases the IDL ("redeemed"); the raw IDL says "Redeemed". Accept both.
      const name = ev.name.charAt(0).toUpperCase() + ev.name.slice(1);
      if (name === "FundCreated" || name === "Swapped") {
        touched.add(await this.ensureFund(new PublicKey(field(data, "fund"))));
        continue;
      }
      const kind = TX_EVENTS[name];
      if (!kind) continue;

      const fundId = await this.ensureFund(new PublicKey(field(data, "fund")));
      const usdc = bn(field(data, kind === "deposit" ? "usdc_in" : "usdc_out"));
      const shares = bn(field(data, kind === "deposit" ? "shares_out" : "shares_in"));
      const isNew = await this.record({
        id: `${sig}:${i}`,
        sig,
        wallet: new PublicKey(field(data, "user")).toBase58(),
        fundId,
        kind,
        usdc,
        shares,
        slot,
        ts,
      });
      if (isNew) touched.add(fundId);
    }
    return [...touched];
  }

  private async record(t: {
    id: string;
    sig: string;
    wallet: string;
    fundId: number;
    kind: "deposit" | "redeem" | "redeem_in_kind";
    usdc: bigint;
    shares: bigint;
    slot: number;
    ts: Date;
  }): Promise<boolean> {
    return this.d.db.$transaction(async (tx) => {
      if (await tx.tx.findUnique({ where: { id: t.id } })) return false; // already indexed

      await tx.tx.create({
        data: {
          id: t.id,
          sig: t.sig,
          wallet: t.wallet,
          fundId: t.fundId,
          kind: t.kind,
          usdc: fromBase6(t.usdc),
          shares: fromBase6(t.shares),
          slot: BigInt(t.slot),
          ts: t.ts,
        },
      });

      const key = { wallet_fundId: { wallet: t.wallet, fundId: t.fundId } };
      const pos = await tx.position.findUnique({ where: key });
      const curShares = pos ? toBase6(pos.shares) : 0n;
      const curCost = pos ? toBase6(pos.costBasis) : 0n;

      let shares: bigint;
      let cost: bigint;
      if (t.kind === "deposit") {
        shares = curShares + t.shares;
        cost = curCost + t.usdc;
      } else {
        // Weighted-average cost basis: burning X% of shares removes X% of basis.
        shares = curShares > t.shares ? curShares - t.shares : 0n;
        cost = curShares === 0n ? 0n : (curCost * shares) / curShares;
      }
      await tx.position.upsert({
        where: key,
        update: { shares: fromBase6(shares), costBasis: fromBase6(cost) },
        create: { wallet: t.wallet, fundId: t.fundId, shares: fromBase6(shares), costBasis: fromBase6(cost) },
      });
      return true;
    });
  }

  // ------------------------------------------------------------- cursor

  private async setState(key: string, value: string) {
    await this.d.db.indexerState.upsert({ where: { key }, update: { value }, create: { key, value } });
  }
  async getState(key: string): Promise<string | null> {
    return (await this.d.db.indexerState.findUnique({ where: { key } }))?.value ?? null;
  }

  private async fetchTx(sig: string) {
    const get = (v: number) =>
      this.d.conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: v });
    try {
      return await get(1); // include transaction v1 (SIMD-0385)
    } catch (e: any) {
      if (/version/i.test(String(e?.message))) return get(0); // older RPC nodes
      throw e;
    }
  }

  /** Replay everything since the stored cursor (oldest first). Safe to call repeatedly. */
  async backfill(): Promise<number> {
    const cursor = (await this.getState("cursor")) ?? undefined;
    const sigs: Awaited<ReturnType<Connection["getSignaturesForAddress"]>> = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.d.conn.getSignaturesForAddress(
        this.programId,
        { before, until: cursor, limit: 1000 },
        "confirmed"
      );
      if (!page.length) break;
      sigs.push(...page);
      before = page[page.length - 1].signature;
      if (page.length < 1000) break;
    }
    sigs.reverse();

    let handled = 0;
    const touched = new Set<number>();
    for (const s of sigs) {
      if (!s.err) {
        const tx = await this.fetchTx(s.signature);
        const logs = tx?.meta?.logMessages;
        if (tx && logs && !tx.meta?.err) {
          for (const id of await this.processLogs(s.signature, tx.slot, tx.blockTime ?? null, logs)) touched.add(id);
          handled++;
        }
      }
      await this.setState("cursor", s.signature);
      await this.setState("lastSlot", String(s.slot));
    }
    // One activity hook (NAV snapshot) per touched fund, AFTER the replay. Snapshotting per
    // historical transaction records the same current NAV over and over and costs ~6 RPC calls each.
    for (const id of touched) await this.safeActivity(id);
    if (handled) this.log("info", "backfill complete", { transactions: handled });
    return handled;
  }

  // --------------------------------------------------------------- live

  start() {
    if (this.subId !== null) return;
    this.subId = this.d.conn.onLogs(
      this.programId,
      (l, ctx) => {
        if (l.err) return;
        // Strictly sequential: positions depend on event order.
        this.queue = this.queue
          .then(async () => {
            const funds = await this.processLogs(l.signature, ctx.slot, null, l.logs);
            // Deliberately NOT advancing the backfill cursor here: if the websocket drops a
            // transaction and delivers a later one, moving the cursor past it would skip the
            // missed one forever. Backfill re-reads from the cursor (no-ops for what live
            // already handled) and is the only thing that advances it.
            await this.setState("lastSlot", String(ctx.slot));
            for (const id of funds) await this.safeActivity(id);
          })
          .catch((e) => this.log("error", "live log processing failed", { sig: l.signature, error: String(e?.message ?? e) }));
      },
      "confirmed"
    );
  }

  /** Resolves when everything received so far has been processed (tests / shutdown). */
  async idle() {
    await this.queue;
  }

  async stop() {
    if (this.subId !== null) {
      await this.d.conn.removeOnLogsListener(this.subId).catch(() => {});
      this.subId = null;
    }
    await this.queue;
  }

  private async safeActivity(fundId: number) {
    try {
      await this.d.onFundActivity?.(fundId);
    } catch (e: any) {
      this.log("warn", "activity hook failed", { fundId, error: String(e?.message ?? e) });
    }
  }
}
