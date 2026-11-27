/** Turn program errors / simulation logs into something a user can act on. */

const MESSAGES: Record<string, string> = {
  GlobalPaused: "The protocol is paused.",
  FundPaused: "This fund is paused. You can still redeem in kind.",
  DepositTooSmall: "That's below this fund's minimum deposit.",
  TvlCapExceeded: "This fund has reached its beta deposit cap.",
  SlippageExceeded: "The price moved while you were signing. Try again.",
  ZeroAmount: "Amount is too small.",
  ZeroNav: "The fund has no value to price against right now.",
  InsufficientIdleUsdc: "Not enough idle USDC in the fund. Use “Redeem in kind” instead.",
  OracleStale: "Prices are stale (market closed or feed down). Deposits and USDC withdrawals are paused; in-kind redemption still works.",
  OracleConfidence: "Price feed is too uncertain right now. Try again shortly.",
  OracleMismatch: "Price feed mismatch.",
  InvalidPrice: "Price feed returned an invalid price.",
  OracleNotConfigured: "This build has no price oracle configured.",
  Unauthorized: "Only the admin can do that.",
};

export function friendlyError(e: unknown, logs?: string[] | null): string {
  const text = [String((e as any)?.message ?? e ?? ""), ...(logs ?? [])].join("\n");
  const m = /Error Code: (\w+)/.exec(text) ?? /custom program error: (0x[0-9a-f]+)/i.exec(text);
  if (m && MESSAGES[m[1]]) return MESSAGES[m[1]];
  if (/User rejected|rejected the request|declined/i.test(text)) return "You cancelled the request in your wallet.";
  if (/insufficient funds|0x1\b/i.test(text) && /lamports|SOL|insufficient/i.test(text)) return "Not enough SOL for network fees. Get devnet SOL from faucet.solana.com.";
  if (/blockhash not found|expired/i.test(text)) return "The transaction expired. Please try again.";
  if (/429|Too Many Requests/i.test(text)) return "The RPC is rate-limiting requests. Wait a few seconds and retry.";
  if (/AccountNotFound|could not find account/i.test(text)) return "An account is missing. If this is your first deposit, get test USDC first.";
  return text.split("\n")[0].slice(0, 200) || "Something went wrong.";
}
