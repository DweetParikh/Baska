import Link from "next/link";
import type { FundSummary } from "@/lib/api";
import { RISK } from "@/lib/config";
import { bpsToPct, fmtNav, fmtUsd } from "@/lib/format";
import { Badge, Card, PerfBadge, Stat } from "./ui";

export function FundCard({ fund }: { fund: FundSummary }) {
  const risk = RISK[fund.id];
  return (
    <Link href={`/funds/${fund.id}`} className="group block">
      <Card className="h-full transition group-hover:border-brand group-hover:shadow-md">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-lg font-semibold">{fund.name}</h3>
          {risk && <Badge tone={risk.tone}>{risk.label} risk</Badge>}
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {fund.components.map((c) => (
            <span key={c.mint} className="rounded-md bg-elevated px-1.5 py-0.5 text-xs font-medium text-soft">
              {c.symbol}
              <span className="ml-1 text-muted">{bpsToPct(c.targetBps)}</span>
            </span>
          ))}
        </div>
        <div className="mt-5 grid grid-cols-3 gap-3">
          <Stat label="NAV / share" value={fmtNav(fund.navPerShare)} />
          <Stat label="TVL" value={fmtUsd(fund.tvlUsd)} />
          <Stat label="Mgmt fee" value={bpsToPct(fund.mgmtFeeBps)} sub="per year" />
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3 border-t border-line pt-3">
          <PerfBadge label="1D" value={fund.performance["1d"]} />
          <PerfBadge label="7D" value={fund.performance["7d"]} />
          <PerfBadge label="30D" value={fund.performance["30d"]} />
        </div>
      </Card>
    </Link>
  );
}
