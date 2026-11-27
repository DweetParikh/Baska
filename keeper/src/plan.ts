import { applyFeeBps, driftBps, stockForUsdc, valueUsd6 } from "./math";

export interface ComponentState {
  index: number;
  targetBps: number;
  decimals: number;
  balance: bigint; // vault balance, base units
  price: bigint; // raw oracle price
  expo: number; // oracle exponent
}

export interface FundState {
  idleUsdc: bigint; // USDC base units (6 dec)
  components: ComponentState[];
}

export interface PlanOptions {
  /** Don't bother swapping unless at least this much USDC is idle. */
  minIdleUsdc: bigint;
  /** Hard cap on the USD size of a single swap. */
  maxTradeUsdc: bigint;
  /** Rebalance (sell) only when a component is this many bps over target. */
  driftToleranceBps: number;
  /** Slack applied to the expected output to form `min_amount_out`. */
  slippageBps: number;
  /** Fee the venue takes from output (mock DEX = 10 bps). */
  venueFeeBps: number;
}

export interface Swap {
  kind: "buy" | "sell";
  index: number;
  amountIn: bigint; // USDC for buys, component base units for sells
  minOut: bigint;
  expectedOut: bigint;
  reason: string;
}

export interface Valuation {
  total: bigint;
  values: bigint[];
}

export function valuate(s: FundState): Valuation {
  const values = s.components.map((c) => valueUsd6(c.balance, c.decimals, c.price, c.expo));
  return { total: values.reduce((a, b) => a + b, s.idleUsdc), values };
}

const min = (...xs: bigint[]) => xs.reduce((a, b) => (a < b ? a : b));

/**
 * Pick at most ONE swap for this tick, or null when the fund is in balance.
 *
 * Only ever returns swaps the program's post-conditions will accept: buys never
 * exceed a component's deficit and sells never exceed its excess, so weight drift
 * cannot increase. Deploying idle cash takes priority over trimming overweights.
 */
export function planSwap(s: FundState, o: PlanOptions): Swap | null {
  const { total, values } = valuate(s);
  if (total === 0n) return null;

  // deficit > 0: underweight (USD6). deficit < 0: overweight.
  const deficits = s.components.map(
    (c, i) => (BigInt(c.targetBps) * total) / 10_000n - values[i]
  );

  // 1) Deploy idle USDC into the most underweight component.
  if (s.idleUsdc >= o.minIdleUsdc) {
    let best = -1;
    for (let i = 0; i < deficits.length; i++) {
      if (deficits[i] > 0n && (best < 0 || deficits[i] > deficits[best])) best = i;
    }
    if (best >= 0) {
      const usdcIn = min(s.idleUsdc, deficits[best], o.maxTradeUsdc);
      if (usdcIn > 0n) {
        const c = s.components[best];
        const gross = stockForUsdc(usdcIn, c.decimals, c.price, c.expo);
        const expectedOut = applyFeeBps(gross, o.venueFeeBps);
        if (expectedOut > 0n) {
          return {
            kind: "buy",
            index: c.index,
            amountIn: usdcIn,
            expectedOut,
            minOut: applyFeeBps(expectedOut, o.slippageBps),
            reason: `deploy idle USDC into underweight component ${c.index}`,
          };
        }
      }
    }
  }

  // 2) Trim the most overweight component back toward target (proceeds sit idle
  //    and are redeployed on the next tick).
  const drifts = s.components.map((c, i) => (values[i] * 10_000n) / total - BigInt(c.targetBps));
  let worst = -1;
  for (let i = 0; i < drifts.length; i++) {
    if (drifts[i] > BigInt(o.driftToleranceBps) && (worst < 0 || drifts[i] > drifts[worst])) worst = i;
  }
  if (worst >= 0) {
    const c = s.components[worst];
    const excessUsdc = min(-deficits[worst], o.maxTradeUsdc);
    const units = min(stockForUsdc(excessUsdc, c.decimals, c.price, c.expo), c.balance);
    if (units > 0n) {
      const gross = valueUsd6(units, c.decimals, c.price, c.expo);
      const expectedOut = applyFeeBps(gross, o.venueFeeBps);
      if (expectedOut > 0n) {
        return {
          kind: "sell",
          index: c.index,
          amountIn: units,
          expectedOut,
          minOut: applyFeeBps(expectedOut, o.slippageBps),
          reason: `trim overweight component ${c.index} (${drifts[worst]} bps over target)`,
        };
      }
    }
  }

  return null;
}

/** Apply a swap to a state exactly as the venue would (used by tests / dry runs). */
export function applySwap(s: FundState, w: Swap): FundState {
  const components = s.components.map((c) => ({ ...c }));
  const c = components[w.index];
  let idleUsdc = s.idleUsdc;
  if (w.kind === "buy") {
    idleUsdc -= w.amountIn;
    c.balance += w.expectedOut;
  } else {
    c.balance -= w.amountIn;
    idleUsdc += w.expectedOut;
  }
  return { idleUsdc, components };
}

export function currentDrift(s: FundState): bigint {
  const { total, values } = valuate(s);
  return driftBps(values, s.components.map((c) => c.targetBps), total);
}
