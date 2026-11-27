// Client-side mirrors of programs/baska_vault/src/math.rs. Display-only: the program is the
// source of truth, and every quote is re-checked on-chain (min_shares_out / min_usdc_out).

/** Shares permanently locked at fund creation. While supply <= this, a deposit mints 1:1. */
export const DEAD_SHARES = 1_000n;

export function quoteDeposit(amount: bigint, supply: bigint, navUsd6: bigint): bigint | null {
  if (supply <= DEAD_SHARES) return amount; // first real deposit: 1 share = $1
  if (navUsd6 <= 0n) return null;
  return (amount * supply) / navUsd6;
}

export function quoteRedeemUsdc(shares: bigint, supply: bigint, navUsd6: bigint): bigint | null {
  if (supply <= 0n) return null;
  return (shares * navUsd6) / supply;
}

export const proRata = (balance: bigint, shares: bigint, supply: bigint): bigint =>
  supply <= 0n ? 0n : (balance * shares) / supply;

/** Apply a slippage tolerance (bps) to a quoted output to get the on-chain minimum. */
export const withSlippage = (amount: bigint, bps: number): bigint => (amount * (10_000n - BigInt(bps))) / 10_000n;
