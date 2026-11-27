"use client";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { RPC_URL } from "@/lib/config";
import { ThemeProvider } from "./theme";
import { ToastProvider } from "./toast";
import "@solana/wallet-adapter-react-ui/styles.css";

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: false } },
      })
  );
  return (
    <QueryClientProvider client={client}>
      <ConnectionProvider endpoint={RPC_URL} config={{ commitment: "confirmed" }}>
        {/* Wallet Standard wallets (Phantom, Solflare, Backpack...) are auto-detected. */}
        <WalletProvider wallets={[]} autoConnect>
          <WalletModalProvider>
            <ThemeProvider>
              <ToastProvider>{children}</ToastProvider>
            </ThemeProvider>
          </WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </QueryClientProvider>
  );
}
