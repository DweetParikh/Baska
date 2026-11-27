"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import Link from "next/link";
import { Badge, Card, EmptyState, Skeleton } from "@/components/ui";
import { explorerTx, fundById } from "@/lib/config";
import { fmtUsd, timeAgo } from "@/lib/format";
import { useTxs } from "@/lib/hooks";

const KIND = {
  deposit: { label: "Deposit", tone: "green" },
  redeem: { label: "Withdraw", tone: "gray" },
  redeem_in_kind: { label: "Redeem in kind", tone: "blue" },
} as const;

export default function ActivityPage() {
  const { publicKey, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const { data: txs, error } = useTxs(publicKey?.toBase58() ?? null);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Activity</h1>
        <p className="mt-2 text-soft">Your deposits and withdrawals, indexed from on-chain events (can lag by up to ~30 seconds).</p>
      </div>

      {!connected ? (
        <EmptyState
          title="Connect a wallet"
          body="Your activity is tied to your wallet address."
          action={
            <button onClick={() => setVisible(true)} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark">
              Connect wallet
            </button>
          }
        />
      ) : error ? (
        <EmptyState title="Couldn't load activity" body={String((error as Error).message)} />
      ) : !txs ? (
        <Skeleton className="h-48" />
      ) : txs.length === 0 ? (
        <EmptyState
          title="No activity yet"
          body="Deposit into a fund and it will show up here."
          action={
            <Link href="/markets" className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark">
              Browse markets
            </Link>
          }
        />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="tabular w-full text-sm">
            <thead className="border-b border-line bg-surface text-left text-xs text-muted">
              <tr>
                <th className="px-5 py-3 font-medium">When</th>
                <th className="px-3 py-3 font-medium">Type</th>
                <th className="px-3 py-3 font-medium">Market</th>
                <th className="px-3 py-3 text-right font-medium">USDC</th>
                <th className="px-3 py-3 text-right font-medium">Shares</th>
                <th className="px-5 py-3 text-right font-medium">Tx</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {txs.map((t) => (
                <tr key={`${t.sig}${t.kind}${t.shares}`} className="transition-colors hover:bg-elevated/60">
                  <td className="px-5 py-3 text-muted" title={t.ts}>
                    {timeAgo(t.ts)}
                  </td>
                  <td className="px-3 py-3">
                    <Badge tone={KIND[t.kind].tone}>{KIND[t.kind].label}</Badge>
                  </td>
                  <td className="px-3 py-3">
                    <Link href={`/funds/${t.fundId}`} className="hover:text-brand">
                      {fundById(t.fundId)?.name ?? `Fund ${t.fundId}`}
                    </Link>
                  </td>
                  <td className="px-3 py-3 text-right font-mono">{fmtUsd(t.usdc)}</td>
                  <td className="px-3 py-3 text-right font-mono">{Number(t.shares).toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                  <td className="px-5 py-3 text-right">
                    <a href={explorerTx(t.sig)} target="_blank" rel="noreferrer" className="font-mono text-brand hover:underline">
                      {t.sig.slice(0, 6)}…
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
