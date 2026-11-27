import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: path.resolve(process.cwd()),
    // @anchor-lang/core's browser bundle contains a dead `require("fs")` (Wallet.local() reads
    // ANCHOR_WALLET in Node only). Stub it out for the browser build.
    resolveAlias: { fs: { browser: "./src/lib/empty.ts" } },
  },
};

export default nextConfig;
