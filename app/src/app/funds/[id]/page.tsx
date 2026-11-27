"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AssetLogo, CopyButton, StarButton } from "@/components/asset-bits";
import { HoldingsPanel } from "@/components/holdings-panel";
import { NavChart } from "@/components/nav-chart";
import { TradePanel } from "@/components/trade-panel";
import { Badge, Card, Change, EmptyState, ErrorState, Notice, Skeleton, Stat } from "@/components/ui";
import { api } from "@/lib/api";
import { CLUSTER, explorerAddress, fundById, fundMeta, ORACLE_WARN_SECS, PROGRAM_ID, RISK } from "@/lib/config";
import { bpsToPct, fmtUsd, shortAddr, timeAgo } from "@/lib/format";
import { useFundDetail, useOnchainFund } from "@/lib/hooks";

export default function FundPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const fund = Number.isInteger(id) ? fundById(id) : undefined;

  if (!fund) {
    return (
      <EmptyState
        title="Market not found"
        body={`There is no market “${params.id}” in this deployment.`}
        action={
          <Link href="/markets" className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark">
            Back to markets
          </Link>
        }
      />
    );
  }
  return <FundView id={id} />;
}

function FundView({ id }: { id: number }) {
  const fund = fundById(id)!;
  const meta = fundMeta(id);
  const qc = useQueryClient();
  const { data: d, error, refetch } = useFundDetail(id);
  const { data: onchain } = useOnchainFund(fund);
  const risk = RISK[id];

  const refreshDetail = async () => {
    const fresh = await api.fund(id, { fresh: true });
    qc.setQueryData(["fund", id], fresh);
    await qc.invalidateQueries({ queryKey: ["funds"] });
    await qc.invalidateQueries({ queryKey: ["nav", id] });
  };

  if (error) return <ErrorState error={error} retry={() => refetch()} />;
  if (!d)
    return (
      <div className="space-y-5" aria-busy>
        <Skeleton className="h-24" />
        <div className="grid gap-5 lg:grid-cols-[1fr_400px]">
          <div className="space-y-5">
            <Skeleton className="h-96" />
            <Skeleton className="h-48" />
          </div>
          <Skeleton className="h-[34rem]" />
        </div>
      </div>
    );

  const stale = !d.holdings || d.holdings.priceAgeSecs > ORACLE_WARN_SECS;
  const tvl = Number(d.tvlUsd ?? 0);
  const idle = d.holdings ? Number(d.holdings.idleUsdc) : null;

  return (
    <div className="space-y-6">
      {/* header */}
      <div>
        <nav aria-label="Breadcrumb" className="text-sm text-muted">
          <Link href="/" className="hover:text-ink">
            Home
          </Link>
          <span className="mx-2">/</span>
          <Link href="/markets" className="hover:text-ink">
            Markets
          </Link>
          <span className="mx-2">/</span>
          <span className="text-soft">{meta.ticker}</span>
        </nav>

        <div className="mt-4 flex flex-wrap items-start justify-between gap-5">
          <div className="flex items-center gap-4">
            <AssetLogo fundId={id} size={56} />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{d.name}</h1>
                <StarButton fundId={id} />
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-soft">
                <span className="font-mono font-medium text-ink">{meta.ticker}</span>
                <Badge tone="brand">{meta.marketType}</Badge>
                <span>Solana · {CLUSTER === "mainnet-beta" ? "Mainnet" : CLUSTER === "localnet" ? "Localnet" : "Devnet"}</span>
                {risk && <Badge tone={risk.tone}>{risk.label} risk</Badge>}
                {onchain?.paused && <Badge tone="red">Paused</Badge>}
                <span className="inline-flex items-center gap-1 font-mono text-xs text-muted">
                  {shortAddr(d.shareMint, 5)}
                  <CopyButton value={d.shareMint} label="Copy share mint address" />
                </span>
              </div>
            </div>
          </div>

          <div className="text-left sm:text-right">
            <div className="tabular font-mono text-4xl font-semibold tracking-tight">{d.navPerShare ? `$${Number(d.navPerShare).toFixed(4)}` : "—"}</div>
            <div className="mt-1 flex items-center gap-2 sm:justify-end">
              <Change value={d.performance["1d"]} className="text-base" />
              <span className="text-xs text-muted">24H · {d.updatedAt ? `updated ${timeAgo(d.updatedAt)}` : "no data yet"}</span>
            </div>
          </div>
        </div>
      </div>

      {onchain?.paused && <Notice tone="warn">This fund is paused: deposits and USDC withdrawals are disabled. You can still redeem in kind.</Notice>}
      {!onchain?.paused && stale && (
        <Notice tone="warn">
          Prices are stale (market closed or the price feed is down), so deposits and USDC withdrawals are paused. In-kind redemption still works.
          {d.holdingsError ? ` (${d.holdingsError})` : ""}
        </Notice>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          <NavChart fundId={id} />
        </div>

        {/* mobile/tablet: directly under the chart; desktop: sticky right column */}
        <div className="lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <TradePanel fundId={id} detail={d} refreshDetail={refreshDetail} />
        </div>

        <div className="min-w-0 space-y-6 lg:col-start-1 lg:row-start-2">
          <Card>
            <h2 className="font-semibold">Statistics</h2>
            <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4 [&>div]:border-l [&>div]:border-line [&>div]:pl-4 [&>div:nth-child(2n+1)]:border-l-0 [&>div:nth-child(2n+1)]:pl-0 sm:[&>div:nth-child(2n+1)]:border-l sm:[&>div:nth-child(2n+1)]:pl-4 sm:[&>div:nth-child(4n+1)]:border-l-0 sm:[&>div:nth-child(4n+1)]:pl-0">
              <Stat label="Market cap" tip="Value of everything the fund holds (NAV × shares). For a fund this equals TVL." value={fmtUsd(tvl)} />
              <Stat label="FDV" tip="Fully diluted valuation. Fund shares have no pending emissions, so FDV equals market cap." value={fmtUsd(tvl)} />
              <Stat label="Liquidity" tip="Idle USDC in the fund, available for instant USDC withdrawals." value={idle === null ? "—" : fmtUsd(idle)} />
              <Stat label="24H volume" tip="Deposits plus redemptions over the last 24 hours." value={fmtUsd(d.volume24hUsd ?? "0")} />
              <Stat label="24H change" tip="Change in NAV per share over the last 24 hours." value={<Change value={d.performance["1d"]} className="text-lg" />} />
              <Stat label="Circulating supply" tip="Fund shares currently outstanding." value={d.totalShares ? Number(d.totalShares).toLocaleString("en-US", { maximumFractionDigits: 2 }) : "—"} />
              <Stat label="Total supply" tip="Total fund shares ever minted and still outstanding (includes 0.001 permanently locked shares)." value={d.totalShares ? Number(d.totalShares).toLocaleString("en-US", { maximumFractionDigits: 2 }) : "—"} />
              <Stat label="Holders" tip="Wallets that currently hold fund shares, as seen by the indexer." value={d.holders ?? "—"} />
            </dl>
            <div className="mt-5 grid grid-cols-3 gap-4 border-t border-line pt-4 text-center">
              {(["1d", "7d", "30d"] as const).map((k) => (
                <div key={k}>
                  <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{k}</div>
                  <Change value={d.performance[k]} className="text-sm" />
                </div>
              ))}
            </div>
          </Card>

          <HoldingsPanel fund={d} />

          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <h2 className="font-semibold">About</h2>
              <p className="mt-3 text-sm leading-relaxed text-soft">{meta.about}</p>
              <p className="mt-3 text-sm leading-relaxed text-soft">
                Each share represents a pro-rata claim on the fund&apos;s vault. Share price (NAV) is the vault&apos;s total value divided by shares outstanding. A keeper bot
                deploys idle USDC and rebalances toward target weights.
              </p>
              <div className="mt-4 flex flex-wrap gap-3 text-sm">
                <a href={d.links.fund} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-medium text-brand hover:underline">
                  Fund on Explorer <ExternalLink size={13} />
                </a>
                <a href={d.links.shareMint} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-medium text-brand hover:underline">
                  Share mint <ExternalLink size={13} />
                </a>
              </div>
            </Card>

            <Card>
              <h2 className="font-semibold">Token details</h2>
              <dl className="mt-3 divide-y divide-line text-sm">
                {[
                  ["Name", d.name],
                  ["Symbol", meta.ticker],
                  ["Network", `Solana ${CLUSTER === "mainnet-beta" ? "Mainnet" : CLUSTER === "localnet" ? "Localnet" : "Devnet"}`],
                  ["Category", meta.marketType],
                  ["Management fee", `${bpsToPct(d.mgmtFeeBps)} per year`],
                  ["Components", String(d.components.length)],
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3 py-2">
                    <dt className="text-soft">{k}</dt>
                    <dd className="text-right font-medium">{v}</dd>
                  </div>
                ))}
                {[
                  ["Share mint", d.shareMint],
                  ["Fund account", d.address],
                  ["Program", PROGRAM_ID.toBase58()],
                  ["USDC vault", fund.usdcVault],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between gap-3 py-2">
                    <dt className="text-soft">{k}</dt>
                    <dd className="flex items-center gap-1">
                      <a href={explorerAddress(v)} target="_blank" rel="noreferrer" className="font-mono text-xs text-brand hover:underline">
                        {shortAddr(v, 5)}
                      </a>
                      <CopyButton value={v} label={`Copy ${k.toLowerCase()}`} />
                    </dd>
                  </div>
                ))}
              </dl>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
