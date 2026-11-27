import { API_URL } from "./config";

export interface Performance {
  "1d": number | null;
  "7d": number | null;
  "30d": number | null;
}
export interface FundSummary {
  id: number;
  address: string;
  name: string;
  shareMint: string;
  mgmtFeeBps: number;
  navPerShare: string | null;
  tvlUsd: string | null;
  totalShares: string | null;
  updatedAt: string | null;
  /** Indexed deposits + redemptions (USDC) in the last 24h. */
  volume24hUsd?: string;
  /** Wallets currently holding shares. */
  holders?: number;
  performance: Performance;
  components: { mint: string; symbol: string; targetBps: number }[];
}
export interface Holdings {
  navUsd: string;
  /** Share supply from the SAME snapshot as navUsd (6 decimals). Always quote with both. */
  totalShares: string;
  idleUsdc: string;
  priceAgeSecs: number;
  components: { mint: string; symbol: string; balance: string; valueUsd: string; targetBps: number; actualBps: number }[];
}
export interface FundDetail extends FundSummary {
  holdings: Holdings | null;
  holdingsError?: string;
  links: { fund: string; shareMint: string };
}
export interface NavPoint {
  ts: string;
  navPerShare: string;
  tvlUsd: string;
}
export interface PortfolioPosition {
  fundId: number;
  fundName: string;
  shares: string;
  costBasis: string;
  navPerShare: string | null;
  valueUsd: string | null;
  pnlUsd: string | null;
  pnlPct: number | null;
}
export interface Portfolio {
  wallet: string;
  positions: PortfolioPosition[];
  totals: { valueUsd: string; costBasis: string; pnlUsd: string };
}
export interface TxRow {
  sig: string;
  fundId: number;
  kind: "deposit" | "redeem" | "redeem_in_kind";
  usdc: string;
  shares: string;
  slot: string;
  ts: string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, init);
  } catch {
    throw new ApiError(0, "Can't reach the Baska API. Is it running?");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body?.message ?? body?.error ?? `request failed (${res.status})`);
  return body as T;
}

export const api = {
  funds: () => request<{ funds: FundSummary[] }>("/funds").then((r) => r.funds),
  fund: (id: number, opts: { fresh?: boolean } = {}) => request<FundDetail>(`/funds/${id}${opts.fresh ? "?fresh=1" : ""}`),
  nav: (id: number, range: string) => request<{ points: NavPoint[] }>(`/funds/${id}/nav?range=${range}`).then((r) => r.points),
  portfolio: (wallet: string) => request<Portfolio>(`/portfolio/${wallet}`),
  txs: (wallet: string, limit = 50) => request<{ txs: TxRow[] }>(`/portfolio/${wallet}/txs?limit=${limit}`).then((r) => r.txs),
  faucet: (wallet: string) =>
    request<{ amountUsdc: string; signature: string }>("/faucet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet }),
    }),
};
