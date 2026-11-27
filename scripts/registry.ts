// Demo fund definitions. Tickers are LABELS for mock tokens on devnet: the real tokenized
// stocks (Backpack Securities / Sunrise) don't exist there, and the guide says to verify the
// live ticker list before mainnet. Base prices are rough placeholders for the simulator.

export const STOCK_DECIMALS = 8;

export const STOCKS: { symbol: string; baseUsd: number }[] = [
  { symbol: "AAPL", baseUsd: 230 },
  { symbol: "MSFT", baseUsd: 450 },
  { symbol: "GOOGL", baseUsd: 190 },
  { symbol: "AMZN", baseUsd: 210 },
  { symbol: "NVDA", baseUsd: 140 },
  { symbol: "META", baseUsd: 600 },
  { symbol: "TSLA", baseUsd: 330 },
  { symbol: "MU", baseUsd: 100 },
  { symbol: "SNDK", baseUsd: 60 },
  { symbol: "SKHY", baseUsd: 200 },
  { symbol: "SPY", baseUsd: 600 },
  { symbol: "SPCX", baseUsd: 25 },
  { symbol: "RKLB", baseUsd: 30 },
  { symbol: "ASTS", baseUsd: 40 },
];

export const FUNDS: { id: number; name: string; components: { symbol: string; bps: number }[] }[] = [
  {
    id: 1,
    name: "Mag7 Index",
    components: [
      { symbol: "AAPL", bps: 1429 },
      { symbol: "MSFT", bps: 1429 },
      { symbol: "GOOGL", bps: 1429 },
      { symbol: "AMZN", bps: 1429 },
      { symbol: "NVDA", bps: 1428 },
      { symbol: "META", bps: 1428 },
      { symbol: "TSLA", bps: 1428 },
    ],
  },
  {
    id: 2,
    name: "Memory & Semis",
    components: [
      { symbol: "MU", bps: 4000 },
      { symbol: "SNDK", bps: 3500 },
      { symbol: "SKHY", bps: 2500 },
    ],
  },
  { id: 3, name: "S&P Core", components: [{ symbol: "SPY", bps: 10000 }] },
  {
    id: 4,
    name: "Space & Frontier",
    components: [
      { symbol: "SPCX", bps: 5000 },
      { symbol: "RKLB", bps: 2500 },
      { symbol: "ASTS", bps: 2500 },
    ],
  },
];

for (const f of FUNDS) {
  const sum = f.components.reduce((a, c) => a + c.bps, 0);
  if (sum !== 10_000) throw new Error(`fund ${f.name}: weights sum to ${sum}, expected 10000`);
}
