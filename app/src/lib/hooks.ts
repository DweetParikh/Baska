"use client";

import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "./api";
import { CONFIG_PDA, DeployedFund, USDC_MINT } from "./config";
import { makeProgram } from "./program";
import { userAta } from "./tx";

export function useProgram() {
  const { connection } = useConnection();
  return useMemo(() => makeProgram(connection), [connection]);
}

export const useFunds = () => useQuery({ queryKey: ["funds"], queryFn: api.funds, refetchInterval: 20_000 });

export const useFundDetail = (id: number) =>
  useQuery({ queryKey: ["fund", id], queryFn: () => api.fund(id), refetchInterval: 15_000 });

export const useNav = (id: number, range: string) =>
  useQuery({ queryKey: ["nav", id, range], queryFn: () => api.nav(id, range), refetchInterval: 60_000 });

export const usePortfolio = (wallet: string | null) =>
  useQuery({ queryKey: ["portfolio", wallet], queryFn: () => api.portfolio(wallet!), enabled: !!wallet, refetchInterval: 15_000 });

export const useTxs = (wallet: string | null) =>
  useQuery({ queryKey: ["txs", wallet], queryFn: () => api.txs(wallet!), enabled: !!wallet, refetchInterval: 15_000 });

/** Fund parameters that only exist on-chain (paused flag, deposit limits). Read directly, never cached by the API. */
export function useOnchainFund(fund: DeployedFund) {
  const program = useProgram();
  return useQuery({
    queryKey: ["onchain-fund", fund.id],
    refetchInterval: 15_000,
    queryFn: async () => {
      const f = await program.account.fund.fetch(new PublicKey(fund.address));
      return {
        paused: f.paused as boolean,
        minDeposit: BigInt(f.minDeposit.toString()),
        maxTvl: BigInt(f.maxTvl.toString()),
      };
    },
  });
}

export function useGlobalConfig() {
  const program = useProgram();
  return useQuery({
    queryKey: ["config"],
    refetchInterval: 30_000,
    queryFn: async () => {
      const c = await program.account.globalConfig.fetch(CONFIG_PDA);
      return {
        admin: (c.admin as PublicKey).toBase58(),
        keeper: (c.keeper as PublicKey).toBase58(),
        paused: c.paused as boolean,
        maxSlippageBps: c.maxSlippageBps as number,
      };
    },
  });
}

async function tokenBalance(connection: ReturnType<typeof useConnection>["connection"], ata: PublicKey): Promise<bigint> {
  try {
    return BigInt((await connection.getTokenAccountBalance(ata)).value.amount);
  } catch {
    return 0n; // account doesn't exist yet
  }
}

/** The connected wallet's USDC and fund-share balances (base units). */
export function useBalances(fund: DeployedFund, wallet: PublicKey | null) {
  const { connection } = useConnection();
  return useQuery({
    queryKey: ["balances", fund.id, wallet?.toBase58()],
    enabled: !!wallet,
    refetchInterval: 15_000,
    queryFn: async () => ({
      usdc: await tokenBalance(connection, userAta(USDC_MINT, wallet!)),
      shares: await tokenBalance(connection, userAta(new PublicKey(fund.shareMint), wallet!)),
    }),
  });
}
