import { PublicKey } from "@solana/web3.js";
import { MarketDataProvider, PriceQuote } from "../../keeper/src/chain";
import { Cache } from "./cache";

/**
 * Cache-through price service. Wraps any MarketDataProvider (mock feeds on
 * devnet, Pyth Hermes / Sunrise on mainnet) with a short TTL so a burst of API
 * requests and the NAV snapshotter share one upstream read.
 *
 * Quotes keep their original `publishTime`, so staleness checks downstream stay
 * honest even when served from cache.
 */
export class CachedMarketData implements MarketDataProvider {
  constructor(
    private inner: MarketDataProvider,
    private cache: Cache,
    private ttlSecs = 8
  ) {}

  async getPrices(feeds: PublicKey[]): Promise<PriceQuote[]> {
    const out: (PriceQuote | undefined)[] = new Array(feeds.length);
    const missing: number[] = [];

    await Promise.all(
      feeds.map(async (f, i) => {
        const hit = await this.cache.get(`price:${f.toBase58()}`);
        if (hit) {
          const j = JSON.parse(hit);
          out[i] = { price: BigInt(j.price), expo: j.expo, conf: BigInt(j.conf), publishTime: j.publishTime };
        } else {
          missing.push(i);
        }
      })
    );

    if (missing.length) {
      const fresh = await this.inner.getPrices(missing.map((i) => feeds[i]));
      await Promise.all(
        fresh.map(async (q, k) => {
          const i = missing[k];
          out[i] = q;
          await this.cache.set(
            `price:${feeds[i].toBase58()}`,
            JSON.stringify({ price: q.price.toString(), expo: q.expo, conf: q.conf.toString(), publishTime: q.publishTime }),
            this.ttlSecs
          );
        })
      );
    }
    return out as PriceQuote[];
  }
}
