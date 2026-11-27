import { Commitment, Connection } from "@solana/web3.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The public devnet RPC rate-limits aggressively: HTTP 429 both globally and per method, and 429
 * on WebSockets. This (1) spaces requests out and (2) retries 429s with exponential backoff, so
 * long-running processes survive on it. Local validators get no throttle and no retries needed.
 *
 * RPC_MIN_INTERVAL_MS overrides the gap (default 500ms for remote RPCs). For anything beyond a
 * demo use a dedicated RPC (Helius / QuickNode free tier) and set RPC_MIN_INTERVAL_MS=0.
 */
export function makeConnection(url: string, commitment: Commitment = "confirmed"): Connection {
  const local = /127\.0\.0\.1|localhost/.test(url);
  const gap = Number(process.env.RPC_MIN_INTERVAL_MS ?? (local ? "0" : "500"));
  let nextAt = 0;

  const throttled = async (input: any, init?: any) => {
    for (let attempt = 0; ; attempt++) {
      const now = Date.now();
      const wait = Math.max(0, nextAt - now);
      nextAt = Math.max(now, nextAt) + gap;
      if (wait) await sleep(wait);
      const res = await fetch(input, init);
      if (res.status !== 429 || attempt >= 8) return res;
      // Back off for everyone, not just this request.
      const backoff = Math.min(1000 * 2 ** attempt, 15_000);
      nextAt = Math.max(nextAt, Date.now() + backoff);
      await sleep(backoff);
    }
  };

  return new Connection(url, {
    commitment,
    fetch: gap > 0 ? (throttled as typeof fetch) : undefined,
    disableRetryOnRateLimit: gap > 0, // we handle 429s ourselves
  });
}
