"use client";

import Link from "next/link";
import { FundCard } from "@/components/fund-card";
import { Card, ErrorState, Skeleton, Stat } from "@/components/ui";
import { fmtUsd } from "@/lib/format";
import { useFunds } from "@/lib/hooks";

const STEPS = [
  ["1", "Deposit USDC", "Pick a fund and deposit USDC. You receive fund shares priced at the fund's current net asset value."],
  ["2", "The fund holds the basket", "A keeper bot swaps the cash into tokenized stocks at the fund's target weights and rebalances over time."],
  ["3", "Redeem any time", "Withdraw as USDC from the idle buffer, or redeem in kind to receive your share of every asset. In-kind always works."],
];

export default function Home() {
  const { data: funds, error, refetch } = useFunds();
  const tvl = funds?.reduce((s, f) => s + Number(f.tvlUsd ?? 0), 0);

  return (
    <div className="space-y-12">
      <section className="grid gap-8 py-6 md:grid-cols-[1.4fr_1fr] md:items-center">
        <div>
          <h1 className="text-4xl font-bold tracking-tight md:text-5xl">Mutual funds of tokenized stocks, on Solana.</h1>
          <p className="mt-4 max-w-xl text-lg text-muted">
            Deposit USDC into a fund and get a diversified basket in one transaction. Share price is the fund&apos;s net asset value. There is no
            promised yield: performance comes from the underlying stocks.
          </p>
          <div className="mt-6 flex gap-3">
            <Link href="/markets" className="rounded-xl bg-brand px-5 py-3 font-semibold text-white shadow-sm hover:bg-brand-dark">
              Browse funds
            </Link>
            <Link href="/portfolio" className="rounded-xl border border-line bg-panel px-5 py-3 font-semibold hover:border-muted">
              My portfolio
            </Link>
          </div>
        </div>
        <Card>
          <div className="grid grid-cols-2 gap-5">
            <Stat label="Total value locked" value={funds ? fmtUsd(tvl) : <Skeleton className="h-7 w-24" />} />
            <Stat label="Funds" value={funds ? funds.length : <Skeleton className="h-7 w-8" />} />
          </div>
          <p className="mt-4 border-t border-line pt-3 text-xs text-muted">Devnet demo: mock tokens with no real value, priced from real market quotes.</p>
        </Card>
      </section>

      <section>
        <h2 className="text-xl font-semibold">How it works</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          {STEPS.map(([n, t, d]) => (
            <Card key={n}>
              <div className="grid h-8 w-8 place-items-center rounded-full bg-brand/10 text-sm font-bold text-brand">{n}</div>
              <h3 className="mt-3 font-semibold">{t}</h3>
              <p className="mt-1 text-sm text-muted">{d}</p>
            </Card>
          ))}
        </div>
      </section>

      <section>
        <div className="flex items-end justify-between">
          <h2 className="text-xl font-semibold">Funds</h2>
          <Link href="/markets" className="text-sm font-medium text-brand hover:underline">
            View all →
          </Link>
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {error ? (
            <div className="md:col-span-2">
              <ErrorState error={error} retry={() => refetch()} />
            </div>
          ) : !funds ? (
            [0, 1].map((i) => <Skeleton key={i} className="h-56" />)
          ) : (
            funds.slice(0, 4).map((f) => <FundCard key={f.id} fund={f} />)
          )}
        </div>
      </section>
    </div>
  );
}
