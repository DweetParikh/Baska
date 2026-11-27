import * as anchor from "@anchor-lang/core";
import { BN } from "@anchor-lang/core";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import { ComputeBudgetProgram, Connection, PublicKey } from "@solana/web3.js";
import { ComponentState, FundState, Swap } from "./plan";

export interface PriceQuote {
  price: bigint;
  expo: number;
  conf: bigint;
  publishTime: number; // unix seconds
}

/** Swap this out for a Pyth Hermes / Sunrise-backed provider on mainnet. */
export interface MarketDataProvider {
  getPrices(feeds: PublicKey[]): Promise<PriceQuote[]>;
}

/** Reads the admin-writable MockPriceFeed accounts (localnet / devnet). */
export class MockFeedProvider implements MarketDataProvider {
  constructor(private program: any) {}
  async getPrices(feeds: PublicKey[]): Promise<PriceQuote[]> {
    const rows = await this.program.account.mockPriceFeed.fetchMultiple(feeds);
    return rows.map((r: any, i: number) => {
      if (!r) throw new Error(`price feed ${feeds[i].toBase58()} not found`);
      return {
        price: BigInt(r.price.toString()),
        expo: r.expo as number,
        conf: BigInt(r.conf.toString()),
        publishTime: Number(r.publishTime.toString()),
      };
    });
  }
}

export interface FundSnapshot {
  id: number;
  key: PublicKey;
  paused: boolean;
  state: FundState;
  /** Share mint supply, read in the same RPC call (same slot) as the balances in `state`. */
  shareSupply: bigint;
  /** Oldest oracle age in seconds (vs. the chain clock), for staleness gating. */
  maxPriceAgeSecs: number;
  /** Raw on-chain Fund account (components[].mint/vault/priceFeed). */
  account: any;
}

export const liquidityAuthority = (programId: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("mock_liquidity")], programId)[0];

export async function chainNow(conn: Connection): Promise<number> {
  const slot = await conn.getSlot();
  return (await conn.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
}

export async function snapshotFund(
  conn: Connection,
  program: any,
  market: MarketDataProvider,
  fundKey: PublicKey
): Promise<FundSnapshot> {
  const f = await program.account.fund.fetch(fundKey);
  const n = f.numComponents as number;
  const comps = f.components.slice(0, n);

  // ATOMIC balances: the USDC vault, every component vault and the share mint are read in ONE
  // RPC call, so they all come from the same slot. Reading them separately lets a swap land
  // between reads (cash counted before the swap, the bought stock after it), which inflated NAV by
  // the size of the swap in an earlier version.
  const keys = [f.usdcVault, ...comps.map((c: any) => c.vault), f.shareMint] as PublicKey[];
  const [infos, quotes, now] = await Promise.all([
    conn.getMultipleAccountsInfo(keys, "confirmed"),
    market.getPrices(comps.map((c: any) => c.priceFeed)),
    chainNow(conn),
  ]);
  keys.forEach((k, i) => {
    if (!infos[i]) throw new Error(`account ${k.toBase58()} not found`);
  });
  const usdc = unpackAccount(keys[0], infos[0]!);
  const balances = comps.map((_: any, i: number) => unpackAccount(keys[i + 1], infos[i + 1]!));
  const shareSupply = unpackMint(keys[keys.length - 1], infos[keys.length - 1]!).supply;

  const components: ComponentState[] = comps.map((c: any, i: number) => ({
    index: i,
    targetBps: c.targetWeightBps,
    decimals: c.decimals,
    balance: balances[i].amount,
    price: quotes[i].price,
    expo: quotes[i].expo,
  }));
  const maxPriceAgeSecs = Math.max(...quotes.map((q) => now - q.publishTime));

  return {
    id: Number(f.id.toString()),
    key: fundKey,
    paused: f.paused,
    state: { idleUsdc: usdc.amount, components },
    shareSupply,
    maxPriceAgeSecs,
    account: f,
  };
}

export async function sendSwap(
  program: any,
  usdcMint: PublicKey,
  snap: FundSnapshot,
  swap: Swap
): Promise<string> {
  const f = snap.account;
  const comps = f.components.slice(0, f.numComponents);
  const c = comps[swap.index];
  const liqAuth = liquidityAuthority(program.programId);

  const remaining = comps.flatMap((x: any) => [
    { pubkey: x.vault, isWritable: false, isSigner: false },
    { pubkey: x.priceFeed, isWritable: false, isSigner: false },
  ]);

  return program.methods
    .executeSwap(
      swap.kind === "buy" ? { buy: {} } : { sell: {} },
      swap.index,
      new BN(swap.amountIn.toString()),
      new BN(swap.minOut.toString())
    )
    .accounts({
      keeper: program.provider.publicKey,
      fund: snap.key,
      usdcMint,
      usdcVault: f.usdcVault,
      componentMint: c.mint,
      componentVault: c.vault,
      liquidityAuthority: liqAuth,
      liquidityUsdc: getAssociatedTokenAddressSync(usdcMint, liqAuth, true),
      liquidityStock: getAssociatedTokenAddressSync(c.mint, liqAuth, true),
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .remainingAccounts(remaining)
    // execute_swap values the whole fund twice (before/after); a 7-component fund needs more than 200k CU.
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
    .rpc();
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  tries = 3,
  baseMs = 500,
  log: (m: string) => void = () => {}
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      // Program-level rejections are deterministic: retrying cannot help.
      const msg = String((e as any)?.message ?? e);
      if (/Error Code:|custom program error/.test(msg)) throw e;
      log(`attempt ${i + 1}/${tries} failed: ${msg.split("\n")[0]}`);
      await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
    }
  }
  throw last;
}

export { anchor };
