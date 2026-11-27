"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { useToast } from "@/components/toast";
import { Badge, Card, ErrorState, Notice, Skeleton, Stat } from "@/components/ui";
import { api } from "@/lib/api";
import { explorerTx, fundById } from "@/lib/config";
import { friendlyError } from "@/lib/errors";
import { fmtNav, fmtPct, fmtUsd, timeAgo } from "@/lib/format";
import { usePortfolio, useTxs } from "@/lib/hooks";

const KIND = {
  deposit: { label: "Deposit", tone: "green" },
  redeem: { label: "Withdraw", tone: "gray" },
  redeem_in_kind: { label: "Redeem in kind", tone: "blue" },
} as const;

export default function PortfolioPage() {
  const { publicKey, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const wallet = publicKey?.toBase58() ?? null;
  const { data: pf, error, refetch, isLoading } = usePortfolio(wallet);
  const { data: txs } = useTxs(wallet);
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  if (!connected) {
    return (
      <Card className="mx-auto max-w-lg text-center">
        <h1 className="text-2xl font-bold">Your portfolio</h1>
        <p className="mt-2 text-muted">Connect a wallet to see your positions, value and profit &amp; loss.</p>
        <button onClick={() => setVisible(true)} className="mt-5 rounded-xl bg-brand px-5 py-3 font-semibold text-white hover:bg-brand-dark">
          Connect wallet
        </button>
      </Card>
    );
  }

  const faucet = async () => {
    setBusy(true);
    try {
      const r = await api.faucet(wallet!);
      toast.push({ tone: "success", title: `Received ${Number(r.amountUsdc).toLocaleString()} test USDC`, href: explorerTx(r.signature) });
      qc.invalidateQueries({ queryKey: ["balances"] });
    } catch (e) {
      toast.push({ tone: "error", title: "Faucet failed", body: friendlyError(e) }, 12_000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-3xl font-bold tracking-tight">Portfolio</h1>
        <button onClick={faucet} disabled={busy} className="rounded-xl border border-line bg-panel px-4 py-2 text-sm font-semibold hover:border-muted disabled:opacity-50">
          {busy ? "Requesting…" : "Get 1,000 test USDC"}
        </button>
      </div>

      {error ? (
        <ErrorState error={error} retry={() => refetch()} />
      ) : isLoading || !pf ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <Card>
            <div className="grid grid-cols-3 gap-5">
              <Stat label="Value" value={fmtUsd(pf.totals.valueUsd)} />
              <Stat label="Cost basis" value={fmtUsd(pf.totals.costBasis)} />
              <Stat
                label="P&L"
                value={<span className={Number(pf.totals.pnlUsd) >= 0 ? "text-up" : "text-down"}>{fmtUsd(pf.totals.pnlUsd)}</span>}
              />
            </div>
          </Card>

          {pf.positions.length === 0 ? (
            <Card className="text-center">
              <p className="text-muted">You don&apos;t hold any fund shares yet.</p>
              <Link href="/markets" className="mt-3 inline-block rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark">
                Browse funds
              </Link>
            </Card>
          ) : (
            <Card className="overflow-x-auto p-0">
              <table className="tabular w-full text-sm">
                <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-5 py-3 font-medium">Fund</th>
                    <th className="px-3 py-3 text-right font-medium">Shares</th>
                    <th className="px-3 py-3 text-right font-medium">NAV</th>
                    <th className="px-3 py-3 text-right font-medium">Value</th>
                    <th className="px-3 py-3 text-right font-medium">Cost basis</th>
                    <th className="px-5 py-3 text-right font-medium">P&amp;L</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {pf.positions.map((p) => (
                    <tr key={p.fundId} className="hover:bg-surface">
                      <td className="px-5 py-3 font-medium">
                        <Link href={`/funds/${p.fundId}`} className="text-brand hover:underline">
                          {p.fundName}
                        </Link>
                      </td>
                      <td className="px-3 py-3 text-right">{Number(p.shares).toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                      <td className="px-3 py-3 text-right">{fmtNav(p.navPerShare)}</td>
                      <td className="px-3 py-3 text-right">{fmtUsd(p.valueUsd)}</td>
                      <td className="px-3 py-3 text-right">{fmtUsd(p.costBasis)}</td>
                      <td className={`px-5 py-3 text-right ${p.pnlUsd !== null && Number(p.pnlUsd) < 0 ? "text-down" : "text-up"}`}>
                        {fmtUsd(p.pnlUsd)} <span className="text-xs">({fmtPct(p.pnlPct)})</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
          <Notice tone="info">
            Positions are indexed from on-chain events and can lag a transaction by up to ~30 seconds. P&amp;L uses NAV × shares against your
            weighted-average cost basis. Shares moved by plain token transfers aren&apos;t tracked.
          </Notice>
        </>
      )}

      <section>
        <h2 className="text-lg font-semibold">History</h2>
        <Card className="mt-3 overflow-x-auto p-0">
          {!txs ? (
            <div className="p-5">
              <Skeleton className="h-16" />
            </div>
          ) : txs.length === 0 ? (
            <div className="p-5 text-sm text-muted">No transactions yet.</div>
          ) : (
            <table className="tabular w-full text-sm">
              <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-5 py-3 font-medium">When</th>
                  <th className="px-3 py-3 font-medium">Type</th>
                  <th className="px-3 py-3 font-medium">Fund</th>
                  <th className="px-3 py-3 text-right font-medium">USDC</th>
                  <th className="px-3 py-3 text-right font-medium">Shares</th>
                  <th className="px-5 py-3 text-right font-medium">Tx</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {txs.map((t) => {
                  const k = KIND[t.kind];
                  return (
                    <tr key={`${t.sig}${t.kind}${t.shares}`}>
                      <td className="px-5 py-3 text-muted" title={t.ts}>
                        {timeAgo(t.ts)}
                      </td>
                      <td className="px-3 py-3">
                        <Badge tone={k.tone}>{k.label}</Badge>
                      </td>
                      <td className="px-3 py-3">{fundById(t.fundId)?.name ?? `Fund ${t.fundId}`}</td>
                      <td className="px-3 py-3 text-right">{fmtUsd(t.usdc)}</td>
                      <td className="px-3 py-3 text-right">{Number(t.shares).toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                      <td className="px-5 py-3 text-right">
                        <a href={explorerTx(t.sig)} target="_blank" rel="noreferrer" className="text-brand hover:underline">
                          {t.sig.slice(0, 6)}…
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      </section>
    </div>
  );
}
