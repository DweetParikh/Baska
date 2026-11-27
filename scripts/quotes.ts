// Price sources for the devnet MockPriceFeed updater.
//
// DEFAULT = SIMULATED. Nothing here is real market data. To use real quotes, point QUOTES_URL
// at any JSON endpoint returning {"AAPL": 231.2, ...}; the updater falls back to the simulator
// if it fails. Swap in a Pyth Hermes / Sunrise provider for mainnet (that path doesn't use
// these mock feeds at all).

export interface QuoteSource {
  readonly name: string;
  getUsd(symbols: string[]): Promise<Record<string, number>>;
}

/** Mean-reverting random walk around each base price. Deterministic with a seed. */
export class SimulatedQuotes implements QuoteSource {
  readonly name = "simulated";
  private px = new Map<string, number>();
  private rng: () => number;
  constructor(private base: Record<string, number>, seed = Date.now() & 0x7fffffff, private stepPct = 0.15) {
    let s = seed || 1;
    this.rng = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  }
  async getUsd(symbols: string[]) {
    const out: Record<string, number> = {};
    for (const sym of symbols) {
      const base = this.base[sym];
      if (!base) throw new Error(`no base price for ${sym}`);
      const cur = this.px.get(sym) ?? base;
      const shock = (this.rng() - 0.5) * 2 * (this.stepPct / 100);
      const revert = ((base - cur) / base) * 0.02; // gentle pull back toward base
      const next = Math.max(base * 0.5, Math.min(base * 1.5, cur * (1 + shock + revert)));
      this.px.set(sym, next);
      out[sym] = next;
    }
    return out;
  }
}

export class HttpQuotes implements QuoteSource {
  readonly name: string;
  constructor(private url: string) {
    this.name = `http(${new URL(url).host})`;
  }
  async getUsd(symbols: string[]) {
    const res = await fetch(this.url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`quote endpoint returned ${res.status}`);
    const j = (await res.json()) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const s of symbols) {
      const v = Number(j[s]);
      if (!Number.isFinite(v) || v <= 0) throw new Error(`quote endpoint has no valid price for ${s}`);
      out[s] = v;
    }
    return out;
  }
}

/**
 * Real US equity prices from Yahoo Finance's public chart endpoint (no key). Quotes are fetched in
 * parallel; a symbol that fails keeps its last good price for up to `maxStaleMs`, after which the
 * whole call throws (so the caller can fall back). Outside market hours the price is the last
 * trade, which is correct: it just doesn't move.
 */
export class YahooQuotes implements QuoteSource {
  readonly name = "yahoo";
  private last = new Map<string, { usd: number; at: number }>();
  constructor(private maxStaleMs = 10 * 60_000) {}
  private async one(sym: string): Promise<number> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`yahoo ${sym}: HTTP ${res.status}`);
    const j: any = await res.json();
    const px = Number(j?.chart?.result?.[0]?.meta?.regularMarketPrice);
    if (!Number.isFinite(px) || px <= 0) throw new Error(`yahoo ${sym}: no valid price`);
    return px;
  }
  async getUsd(symbols: string[]) {
    const now = Date.now();
    const results = await Promise.allSettled(symbols.map((s) => this.one(s)));
    const out: Record<string, number> = {};
    results.forEach((r, i) => {
      const sym = symbols[i];
      if (r.status === "fulfilled") this.last.set(sym, { usd: r.value, at: now });
      const c = this.last.get(sym);
      if (!c || now - c.at > this.maxStaleMs) {
        throw new Error(r.status === "rejected" ? String(r.reason?.message ?? r.reason) : `no quote for ${sym}`);
      }
      out[sym] = c.usd;
    });
    return out;
  }
}

export class FallbackQuotes implements QuoteSource {
  constructor(private primary: QuoteSource, private fallback: QuoteSource, private onFallback: (e: unknown) => void = () => {}) {}
  get name() {
    return `${this.primary.name}→${this.fallback.name}`;
  }
  async getUsd(symbols: string[]) {
    try {
      return await this.primary.getUsd(symbols);
    } catch (e) {
      this.onFallback(e);
      return this.fallback.getUsd(symbols);
    }
  }
}

/** USD -> raw oracle price with expo -8. */
export const toRawPrice = (usd: number): bigint => BigInt(Math.round(usd * 1e8));
