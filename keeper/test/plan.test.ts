import { expect } from "chai";
import { applySwap, currentDrift, planSwap, valuate, FundState, PlanOptions } from "../src/plan";

const USDC = 1_000_000n;
const OPTS: PlanOptions = {
  minIdleUsdc: 10n * USDC,
  maxTradeUsdc: 10_000n * USDC,
  driftToleranceBps: 500,
  slippageBps: 50,
  venueFeeBps: 10,
};

// $200 token with 9 decimals, $50 token with 6 decimals (raw price = usd * 1e8, expo -8)
const comp = (index: number, targetBps: number, decimals: number, usd: bigint, balance = 0n) => ({
  index,
  targetBps,
  decimals,
  balance,
  price: usd * 100_000_000n,
  expo: -8,
});
const fund = (idle: bigint, a = 0n, b = 0n): FundState => ({
  idleUsdc: idle,
  components: [comp(0, 5000, 9, 200n, a), comp(1, 5000, 6, 50n, b)],
});

describe("keeper planner", () => {
  it("does nothing for an empty fund", () => {
    expect(planSwap(fund(0n), OPTS)).to.equal(null);
  });

  it("deploys idle USDC into the most underweight component, capped at its deficit", () => {
    const s = fund(1_000n * USDC);
    const w = planSwap(s, OPTS)!;
    expect(w.kind).to.equal("buy");
    expect(w.index).to.equal(0); // tie -> lowest index
    expect(w.amountIn).to.equal(500n * USDC); // deficit = 50% of $1000
    expect(w.minOut < w.expectedOut).to.equal(true);
  });

  it("then fills the other component, and then stops", () => {
    let s = fund(1_000n * USDC);
    const steps: number[] = [];
    for (let i = 0; i < 6; i++) {
      const w = planSwap(s, OPTS);
      if (!w) break;
      steps.push(w.index);
      s = applySwap(s, w);
    }
    expect(steps.slice(0, 2)).to.deep.equal([0, 1]);
    expect(currentDrift(s) <= 20n).to.equal(true); // within fee rounding
  });

  it("respects maxTradeUsdc", () => {
    const w = planSwap(fund(1_000n * USDC), { ...OPTS, maxTradeUsdc: 100n * USDC })!;
    expect(w.amountIn).to.equal(100n * USDC);
  });

  it("ignores dust below minIdleUsdc", () => {
    expect(planSwap(fund(5n * USDC), OPTS)).to.equal(null);
  });

  it("trims an overweight component after a price jump, and never oversells", () => {
    // 2.5 AAPL ($500) + 10 MU ($500); AAPL doubles to $400 -> $1000 vs $500
    const s = fund(0n, 2_500_000_000n, 10_000_000n);
    s.components[0].price = 400n * 100_000_000n;
    const w = planSwap(s, OPTS)!;
    expect(w.kind).to.equal("sell");
    expect(w.index).to.equal(0);
    expect(w.amountIn <= s.components[0].balance).to.equal(true);
    const after = applySwap(s, w);
    expect(currentDrift(after) < currentDrift(s)).to.equal(true);
  });

  it("leaves small drift alone (inside tolerance)", () => {
    // 52/48 split is 200 bps off, tolerance is 500
    const s = fund(0n, 2_600_000_000n, 9_600_000n);
    expect(planSwap(s, OPTS)).to.equal(null);
  });

  it("never proposes a swap that increases drift (mirrors the on-chain post-condition)", () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let n = 0; n < 500; n++) {
      const idle = BigInt(Math.floor(rnd() * 5000)) * USDC;
      const a = BigInt(Math.floor(rnd() * 5e9));
      const b = BigInt(Math.floor(rnd() * 5e7));
      const s = fund(idle, a, b);
      s.components[0].price = BigInt(50 + Math.floor(rnd() * 600)) * 100_000_000n;
      const w = planSwap(s, OPTS);
      if (!w) continue;
      const after = applySwap(s, w);
      expect(currentDrift(after) <= currentDrift(s), `state ${n}: ${w.reason}`).to.equal(true);
      // NAV never falls by more than the venue fee on the traded amount
      const floor = (valuate(s).total * 9_900n) / 10_000n; // max_slippage_bps = 100
      expect(valuate(after).total >= floor).to.equal(true);
    }
  });
});
