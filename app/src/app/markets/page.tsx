"use client";

import { ChevronDown, Search } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { MarketTable, SORTS, SortKey, sortFunds } from "@/components/market-table";
import { Change, ErrorState, Skeleton } from "@/components/ui";
import { Category, fundMeta } from "@/lib/config";
import { fmtUsd } from "@/lib/format";
import { useFunds } from "@/lib/hooks";

type Tab = "trending" | "all" | Category;
const TABS: { key: Tab; label: string }[] = [
  { key: "trending", label: "Trending" },
  { key: "all", label: "All Markets" },
  { key: "stocks", label: "Stocks" },
  { key: "crypto", label: "Crypto" },
  { key: "commodities", label: "Commodities" },
];
const TRENDING_COUNT = 10;

export default function MarketsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Markets />
    </Suspense>
  );
}

function Markets() {
  const params = useSearchParams();
  const { data: funds, error, refetch } = useFunds();
  const [tab, setTab] = useState<Tab>("all");
  const [sort, setSort] = useState<SortKey>("liquidity");
  const [q, setQ] = useState(params.get("q") ?? "");

  const counts = useMemo(() => {
    const all = funds ?? [];
    const c: Record<Tab, number> = {
      trending: Math.min(TRENDING_COUNT, all.length),
      all: all.length,
      stocks: 0,
      crypto: 0,
      commodities: 0,
    };
    for (const f of all) c[fundMeta(f.id).category]++;
    return c;
  }, [funds]);

  const visible = useMemo(() => {
    if (!funds) return undefined;
    const needle = q.trim().toLowerCase();
    let rows = funds.filter((f) => {
      if (tab !== "trending" && tab !== "all" && fundMeta(f.id).category !== tab) return false;
      if (!needle) return true;
      return f.name.toLowerCase().includes(needle) || fundMeta(f.id).ticker.toLowerCase().includes(needle) || f.components.some((c) => c.symbol.toLowerCase() === needle);
    });
    rows = sortFunds(rows, tab === "trending" ? "trending" : sort);
    return tab === "trending" ? rows.slice(0, TRENDING_COUNT) : rows;
  }, [funds, tab, sort, q]);

  const totals = useMemo(() => {
    const all = funds ?? [];
    const withMove = all.filter((f) => f.performance["1d"] !== null);
    return {
      volume: all.reduce((s, f) => s + Number(f.volume24hUsd ?? 0), 0),
      liquidity: all.reduce((s, f) => s + Number(f.tvlUsd ?? 0), 0),
      move: withMove.length ? withMove.reduce((s, f) => s + f.performance["1d"]!, 0) / withMove.length : null,
    };
  }, [funds]);

  const reset = () => {
    setQ("");
    setTab("all");
  };

  return (
    <div className="space-y-8">
      <div>
        <nav aria-label="Breadcrumb" className="text-sm text-muted">
          <Link href="/" className="hover:text-ink">
            Home
          </Link>
          <span className="mx-2">/</span>
          <span className="text-soft">Markets</span>
        </nav>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight">Markets</h1>
        <p className="mt-2 max-w-2xl text-soft">
          Explore digital assets, tokenized equities, and emerging markets. Discover opportunities and trade seamlessly through Baska.
        </p>
      </div>

      {/* overview */}
      <section aria-label="Market overview" className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-4">
        {[
          ["24H volume", funds ? fmtUsd(totals.volume) : null, "Deposits + redemptions indexed in the last 24 hours."],
          ["Total liquidity", funds ? fmtUsd(totals.liquidity) : null, "Total value held across all fund vaults."],
          ["Listed assets", funds ? String(funds.length) : null, "Funds currently open for trading."],
        ].map(([label, value, tip]) => (
          <div key={label} className="bg-panel px-5 py-4" title={tip ?? undefined}>
            <div className="text-xs font-medium text-soft">{label}</div>
            <div className="tabular mt-1 font-mono text-xl font-semibold">{value ?? <Skeleton className="mt-1 h-6 w-24" />}</div>
          </div>
        ))}
        <div className="bg-panel px-5 py-4" title="Average 24H NAV change across funds with enough history.">
          <div className="text-xs font-medium text-soft">Market movement (24H)</div>
          <div className="mt-1 text-xl">{funds ? <Change value={totals.move} /> : <Skeleton className="mt-1 h-6 w-24" />}</div>
        </div>
      </section>

      {/* filters */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div role="tablist" aria-label="Market category" className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`flex shrink-0 items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition ${
                tab === t.key ? "border-brand bg-brand text-white" : "border-line bg-panel text-soft hover:border-muted hover:text-ink"
              }`}
            >
              {t.label}
              <span className={`tabular rounded-full px-1.5 font-mono text-[11px] ${tab === t.key ? "bg-white/20" : "bg-elevated text-muted"}`}>{funds ? counts[t.key] : "–"}</span>
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          <label className="relative flex-1 lg:w-72 lg:flex-none">
            <span className="sr-only">Search by name or ticker</span>
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name or ticker"
              className="h-10 w-full rounded-xl border border-line bg-panel pl-9 pr-3 text-sm outline-none transition placeholder:text-muted focus:border-brand"
            />
          </label>
          <label className="relative">
            <span className="sr-only">Sort by</span>
            <select
              value={tab === "trending" ? "trending" : sort}
              disabled={tab === "trending"}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="h-10 appearance-none rounded-xl border border-line bg-panel py-0 pl-3 pr-9 text-sm font-medium outline-none transition focus:border-brand disabled:opacity-60"
            >
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
            <ChevronDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted" />
          </label>
        </div>
      </div>

      {error ? <ErrorState error={error} retry={() => refetch()} /> : <MarketTable funds={visible} loading={!funds} onClear={reset} />}

      {funds && (tab === "crypto" || tab === "commodities") && visible?.length === 0 && (
        <p className="text-center text-xs text-muted">Baska only lists tokenized-stock funds on this deployment. {tab === "crypto" ? "Crypto" : "Commodity"} markets are not available yet.</p>
      )}
    </div>
  );
}
