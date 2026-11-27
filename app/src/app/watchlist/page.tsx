"use client";

import Link from "next/link";
import { MarketTable } from "@/components/market-table";
import { EmptyState, ErrorState } from "@/components/ui";
import { useFunds } from "@/lib/hooks";
import { useWatchlist } from "@/lib/watchlist";

export default function WatchlistPage() {
  const { data: funds, error, refetch } = useFunds();
  const { ids } = useWatchlist();
  const rows = funds?.filter((f) => ids.includes(f.id));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Watchlist</h1>
        <p className="mt-2 text-soft">Markets you have starred. Saved in this browser only.</p>
      </div>
      {error ? (
        <ErrorState error={error} retry={() => refetch()} />
      ) : funds && ids.length === 0 ? (
        <EmptyState
          title="Nothing on your watchlist"
          body="Tap the star next to any market to keep it here."
          action={
            <Link href="/markets" className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark">
              Browse markets
            </Link>
          }
        />
      ) : (
        <MarketTable funds={rows} loading={!funds} onClear={() => {}} />
      )}
    </div>
  );
}
