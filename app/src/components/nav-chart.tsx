"use client";

import { useId, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useNav } from "@/lib/hooks";
import { Change, Skeleton } from "./ui";

const RANGES = [
  ["1d", "24H"],
  ["7d", "7D"],
  ["30d", "30D"],
  ["90d", "90D"],
  ["1y", "1Y"],
  ["all", "ALL"],
] as const;
type Range = (typeof RANGES)[number][0];

const AXIS = { fontSize: 11, fill: "var(--muted)", fontFamily: "var(--font-jbmono), monospace" };

export function NavChart({ fundId }: { fundId: number }) {
  const [range, setRange] = useState<Range>("7d");
  const { data, isLoading, error } = useNav(fundId, range);
  const gid = useId().replace(/:/g, "");

  const points = (data ?? []).map((p) => ({ t: Date.parse(p.ts), nav: Number(p.navPerShare) }));
  const first = points[0]?.nav;
  const last = points[points.length - 1]?.nav;
  const delta = first && last ? ((last - first) / first) * 100 : null;
  const colour = delta !== null && delta < 0 ? "var(--down)" : "var(--up)"; // follows the move over the selected range

  // Label ticks by the span the data actually covers, not the selected range.
  const span = points.length > 1 ? points[points.length - 1].t - points[0].t : 0;
  const fmtTick = (t: number) =>
    span < 36 * 3_600_000
      ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : span > 400 * 86_400_000
        ? new Date(t).toLocaleDateString([], { month: "short", year: "2-digit" })
        : new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });

  return (
    <section className="rounded-2xl border border-line bg-panel p-5 shadow-[var(--shadow)]" aria-label="NAV chart">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h2 className="font-semibold">NAV per share</h2>
          {delta !== null && (
            <span className="text-sm text-muted">
              <Change value={delta} /> <span className="ml-1">over range</span>
            </span>
          )}
        </div>
        <div role="tablist" aria-label="Chart range" className="flex gap-0.5 rounded-lg bg-elevated p-0.5">
          {RANGES.map(([r, label]) => (
            <button
              key={r}
              role="tab"
              aria-selected={range === r}
              onClick={() => setRange(r)}
              className={`rounded-md px-2.5 py-1 font-mono text-xs font-medium transition ${range === r ? "bg-panel text-ink shadow-sm" : "text-muted hover:text-ink"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 h-72 sm:h-80">
        {isLoading ? (
          <Skeleton className="h-full w-full" />
        ) : error ? (
          <div className="grid h-full place-items-center text-sm text-muted">Couldn&apos;t load the chart.</div>
        ) : points.length < 2 ? (
          <div className="grid h-full place-items-center px-6 text-center text-sm text-muted">
            Not enough history for this range yet. NAV is recorded every few minutes and after each deposit or withdrawal.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={points} margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={colour} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={colour} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={fmtTick} tick={AXIS} axisLine={false} tickLine={false} minTickGap={48} tickMargin={8} />
              <YAxis orientation="right" domain={["auto", "auto"]} tickFormatter={(v) => `$${Number(v).toFixed(4)}`} tick={AXIS} axisLine={false} tickLine={false} width={72} />
              <Tooltip
                cursor={{ stroke: "var(--muted)", strokeDasharray: "3 3" }}
                labelFormatter={(t) => new Date(Number(t)).toLocaleString()}
                formatter={(v) => [`$${Number(v).toFixed(4)}`, "NAV / share"]}
                contentStyle={{ borderRadius: 12, border: "1px solid var(--line)", background: "var(--elevated)", color: "var(--ink)", fontSize: 12, boxShadow: "none" }}
                labelStyle={{ color: "var(--soft)" }}
                itemStyle={{ color: "var(--ink)" }}
              />
              <Area type="monotone" dataKey="nav" stroke={colour} strokeWidth={2} fill={`url(#${gid})`} dot={false} activeDot={{ r: 4, strokeWidth: 0, fill: colour }} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}
