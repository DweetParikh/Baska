// Bigint mirror of programs/baska_vault/src/math.rs + nav.rs. Keep in sync:
// the planner relies on these producing exactly what the program will compute.

const pow10 = (e: number) => 10n ** BigInt(e);

/** USD value (6 decimals) of `balance` base units priced at `price * 10^expo` USD/token. */
export function valueUsd6(balance: bigint, decimals: number, price: bigint, expo: number): bigint {
  const num = balance * price;
  const e = expo + 6 - decimals;
  if (e >= 0) return num * pow10(e);
  if (-e > 38) return 0n;
  return num / pow10(-e);
}

/** Base units of a component worth `usdc` (USD6). Floor. */
export function stockForUsdc(usdc: bigint, decimals: number, price: bigint, expo: number): bigint {
  const k = decimals - 6 - expo;
  if (k >= 0) return (usdc * pow10(k)) / price;
  if (-k > 38) return 0n;
  return usdc / (price * pow10(-k));
}

export const applyFeeBps = (amount: bigint, feeBps: number): bigint =>
  (amount * (10_000n - BigInt(feeBps))) / 10_000n;

/** Sum of |actual - target| in bps over components; idle cash is not a target. */
export function driftBps(values: bigint[], targetsBps: number[], total: bigint): bigint {
  if (total === 0n) return 0n;
  let d = 0n;
  for (let i = 0; i < values.length; i++) {
    const actual = (values[i] * 10_000n) / total;
    const target = BigInt(targetsBps[i]);
    d += actual > target ? actual - target : target - actual;
  }
  return d;
}
