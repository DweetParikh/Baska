import { PublicKey } from "@solana/web3.js";
import deployment from "../generated/deployment.json";

export type DeployedFund = (typeof deployment.funds)[number];
export type DeployedStock = (typeof deployment.stocks)[number];

export const CLUSTER = deployment.cluster; // "devnet" | "localnet" | "mainnet-beta"
export const IS_MOCK = CLUSTER !== "mainnet-beta";
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? deployment.rpcUrl;
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export const PROGRAM_ID = new PublicKey(deployment.programId);
export const USDC_MINT = new PublicKey(deployment.usdcMint);
export const CONFIG_PDA = new PublicKey(deployment.config);
export const FUNDS: DeployedFund[] = deployment.funds;
export const STOCKS: DeployedStock[] = deployment.stocks;

export const fundById = (id: number) => FUNDS.find((f) => f.id === id);
export const stockByMint = (mint: string) => STOCKS.find((s) => s.mint === mint);

/** UI-only risk labels. Not on-chain, not advice. */
export const RISK: Record<number, { label: string; tone: "amber" | "red" | "blue" }> = {
  1: { label: "High", tone: "amber" },
  2: { label: "Very high", tone: "red" },
  3: { label: "Medium", tone: "blue" },
  4: { label: "Very high", tone: "red" },
};

const clusterParam = CLUSTER === "mainnet-beta" ? "" : `?cluster=${CLUSTER === "localnet" ? "custom" : CLUSTER}`;
export const explorerAddress = (a: string) => `https://explorer.solana.com/address/${a}${clusterParam}`;
export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}${clusterParam}`;

/** Oracle prices older than this are rejected on-chain (60s); warn a bit earlier. */
export const ORACLE_WARN_SECS = 50;

/**
 * UI-only presentation metadata for each fund (not on-chain). Keyed by fund id.
 * `category` drives the Markets filters; only "stocks" funds exist today, so Crypto and
 * Commodities show empty states rather than invented assets.
 */
export type Category = "stocks" | "crypto" | "commodities";
export const FUND_META: Record<number, { ticker: string; category: Category; marketType: string; about: string; color: string }> = {
  1: { ticker: "MAG7", category: "stocks", marketType: "Equity basket", color: "#6558F5", about: "Equal-weight exposure to seven mega-cap US technology companies in a single token: Apple, Microsoft, Alphabet, Amazon, NVIDIA, Meta and Tesla." },
  2: { ticker: "MEMS", category: "stocks", marketType: "Equity basket", color: "#35C6E8", about: "A concentrated basket of memory and semiconductor names: Micron, SanDisk and SK hynix. Higher volatility than a broad index." },
  3: { ticker: "SPXC", category: "stocks", marketType: "Index tracker", color: "#42D6A4", about: "A single-asset fund holding the SPDR S&P 500 ETF token. The lowest-risk fund here and a simple way to hold the US large-cap market." },
  4: { ticker: "SPCF", category: "stocks", marketType: "Thematic basket", color: "#F2B84B", about: "Thematic exposure to space and frontier technology: SpaceX-linked, Rocket Lab and AST SpaceMobile tokens. Very high risk." },
};
export const fundMeta = (id: number) => FUND_META[id] ?? { ticker: `F${id}`, category: "stocks" as Category, marketType: "Basket", color: "#6558F5", about: "" };
