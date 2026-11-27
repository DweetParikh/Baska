"use client";

import { ArrowDown, ArrowUp, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import type { FundSummary } from "@/lib/api";
import { fundMeta } from "@/lib/config";
import { fmtUsd } from "@/lib/format";
import { AssetLogo, StarButton } from "./asset-bits";
import { Change, EmptyState, Skeleton } from "./ui";

export type SortKey = "trending" | "volume" | "liquidity" | "name";
export const SORTS: { key: SortKey; label: string }[] = [
  { key: "trending", label: "Trending" },
  { key: "volume", label: "24H volume" },
  { key: "liquidity", label: "Liquidity" },
  { key: "name", label: "Name (A–Z)" },
];

const n = (s: string | null | undefined) => Number(s ?? 0);
const compact = (v: number) =>
  v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : fmtUsd(v);

/** Trending = most 24H volume, then biggest absolute 1D move, then liquidity. */
export function sortFunds(funds: FundSummary[], key: SortKey): FundSummary[] {
  const by: Record<SortKey, (a: FundSummary, b: FundSummary) => number> = {
    trending: (a, b) =>
      n(b.volume24hUsd) - n(a.volume24hUsd) || Math.abs(b.performance["1d"] ?? 0) - Math.abs(a.performance["1d"] ?? 0) || n(b.tvlUsd) - n(a.tvlUsd),
    volume: (a, b) => n(b.volume24hUsd) - n(a.volume24hUsd),
    liquidity: (a, b) => n(b.tvlUsd) - n(a.tvlUsd),
    name: (a, b) => a.name.localeCompare(b.name),
  };
  return [...funds].sort(by[key]);
}

const HEAD = "px-4 py-3 text-xs font-medium text-muted";

export function MarketTable({ funds, loading, onClear }: { funds: FundSummary[] | undefined; loading: boolean; onClear: () => void }) {
  const router = useRouter();
  const go = (id: number) => router.push(`/funds/${id}`);

  if (loading) {
    return (
      <div className="space-y-2" aria-busy>
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
    );
  }
  if (!funds || funds.length === 0) {
    return (
      <EmptyState
        title="No markets match"
        body="Nothing here yet. Try another category or clear your search."
        action={
          <button onClick={onClear} className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm font-medium hover:bg-elevated">
            <Search size={14} /> Reset filters
          </button>
        }
      />
    );
  }

  return (
    <>
      {/* desktop / tablet */}
      <div className="hidden overflow-hidden rounded-2xl border border-line bg-panel md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-surface text-left">
              <th className={`${HEAD} w-12`}>#</th>
              <th className={HEAD}>Asset</th>
              <th className={`${HEAD} hidden lg:table-cell`}>Symbol</th>
              <th className={`${HEAD} hidden xl:table-cell`}>Market type</th>
              <th className={`${HEAD} text-right`}>Price</th>
              <th className={`${HEAD} text-right`}>24H</th>
              <th className={`${HEAD} hidden text-right lg:table-cell`}>24H volume</th>
              <th className={`${HEAD} text-right`}>Liquidity</th>
              <th className={`${HEAD} w-12`}>
                <span className="sr-only">Watch</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {funds.map((f, i) => {
              const m = fundMeta(f.id);
              return (
                <tr
                  key={f.id}
                  tabIndex={0}
                  onClick={() => go(f.id)}
                  onKeyDown={(e) => e.key === "Enter" && go(f.id)}
                  className="group cursor-pointer transition-colors hover:bg-elevated/60 focus-visible:bg-elevated/60"
                >
                  <td className="tabular px-4 py-3.5 font-mono text-muted">{i + 1}</td>
                  <td className="px-4 py-3.5">
                    <div className="flex items-center gap-3">
                      <AssetLogo fundId={f.id} />
                      <div className="min-w-0">
                        <div className="truncate font-semibold group-hover:text-brand">{f.name}</div>
                        <div className="truncate text-xs text-muted lg:hidden">{m.ticker}</div>
                      </div>
                    </div>
                  </td>
                  <td className="hidden px-4 py-3.5 font-mono text-soft lg:table-cell">{m.ticker}</td>
                  <td className="hidden px-4 py-3.5 text-soft xl:table-cell">
                    <span className="rounded-md bg-elevated px-2 py-0.5 text-xs">{m.marketType}</span>
                  </td>
                  <td className="tabular px-4 py-3.5 text-right font-mono font-medium">{f.navPerShare ? `$${Number(f.navPerShare).toFixed(4)}` : "—"}</td>
                  <td className="px-4 py-3.5 text-right">
                    <Change value={f.performance["1d"]} />
                  </td>
                  <td className="tabular hidden px-4 py-3.5 text-right font-mono text-soft lg:table-cell">{compact(n(f.volume24hUsd))}</td>
                  <td className="tabular px-4 py-3.5 text-right font-mono text-soft">{compact(n(f.tvlUsd))}</td>
                  <td className="px-2 py-3.5">
                    <StarButton fundId={f.id} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* mobile cards */}
      <ul className="space-y-2 md:hidden">
        {funds.map((f) => {
          const m = fundMeta(f.id);
          return (
            <li key={f.id}>
              <button onClick={() => go(f.id)} className="w-full rounded-2xl border border-line bg-panel p-4 text-left transition active:bg-elevated">
                <div className="flex items-center gap-3">
                  <AssetLogo fundId={f.id} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">{f.name}</div>
                    <div className="font-mono text-xs text-muted">{m.ticker}</div>
                  </div>
                  <div className="text-right">
                    <div className="tabular font-mono font-medium">{f.navPerShare ? `$${Number(f.navPerShare).toFixed(4)}` : "—"}</div>
                    <Change value={f.performance["1d"]} className="text-xs" />
                  </div>
                </div>
                <div className="mt-3 flex justify-between border-t border-line pt-3 text-xs text-muted">
                  <span>
                    Vol <span className="tabular font-mono text-soft">{compact(n(f.volume24hUsd))}</span>
                  </span>
                  <span>
                    Liquidity <span className="tabular font-mono text-soft">{compact(n(f.tvlUsd))}</span>
                  </span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function SortIcon({ dir }: { dir: "asc" | "desc" }) {
  return dir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />;
}
