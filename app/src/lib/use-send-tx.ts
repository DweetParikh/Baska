"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";
import { useCallback } from "react";
import { useToast } from "@/components/toast";
import { explorerTx } from "./config";
import { friendlyError } from "./errors";
import { confirmByPolling, simulate } from "./tx";

/**
 * simulate -> wallet signs & sends -> poll for confirmation, with toasts.
 * Throws an Error with a user-readable message on any failure.
 */
export function useSendTx() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const toast = useToast();

  return useCallback(
    async (tx: Transaction, title: string): Promise<string> => {
      if (!publicKey) throw new Error("Connect your wallet first.");
      const sim = await simulate(connection, tx, publicKey);
      if (!sim.ok) throw new Error(friendlyError(sim.err, sim.logs));
      tx.recentBlockhash = undefined as unknown as string; // let the wallet adapter attach a FRESH blockhash
      const sig = await sendTransaction(tx, connection);
      const pending = toast.push({ tone: "info", title: `${title} submitted`, body: "Waiting for confirmation…", href: explorerTx(sig) }, 0);
      try {
        await confirmByPolling(connection, sig);
      } finally {
        toast.dismiss(pending);
      }
      toast.push({ tone: "success", title: `${title} confirmed`, href: explorerTx(sig) });
      return sig;
    },
    [connection, publicKey, sendTransaction, toast]
  );
}
