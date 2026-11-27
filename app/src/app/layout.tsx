import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Header } from "@/components/header";
import { Providers } from "@/components/providers";
import { THEME_INIT_SCRIPT } from "@/components/theme";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jbmono", display: "swap" });

export const metadata: Metadata = {
  title: "Baska — on-chain mutual funds of tokenized stocks",
  description: "Deposit USDC into a fund, receive shares, hold a basket of tokenized stocks on Solana.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable} dark`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-screen">
        <Providers>
          <Header />
          <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">{children}</main>
          <footer className="mx-auto max-w-7xl border-t border-line px-4 py-6 text-xs leading-relaxed text-muted sm:px-6">
            Baska is a devnet demo. Returns are not guaranteed; share prices follow the value of the underlying tokenized stocks and can fall.
            Nothing here is investment advice.
          </footer>
        </Providers>
      </body>
    </html>
  );
}
