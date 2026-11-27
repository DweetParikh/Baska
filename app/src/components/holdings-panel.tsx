"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import type { FundDetail } from "@/lib/api";
import { bpsToPct, fmtUsd } from "@/lib/format";
import { Card } from "./ui";

const COLORS = ["#6558f5", "#35c6e8", "#42d6a4", "#f2b84b", "#ff647c", "#a78bfa", "#f472b6", "#94a3b8"];

export function HoldingsPanel({ fund }: { fund: FundDetail }) {
  const live = fund.holdings;
  const rows = live
    ? live.components.map((c) => ({ symbol: c.symbol, mint: c.mint, target: c.targetBps, actual: c.actualBps, value: Number(c.valueUsd) }))
    : fund.components.map((c) => ({ symbol: c.symbol, mint: c.mint, target: c.targetBps, actual: null as number | null, value: 0 }));

  // One colour per asset, shared by the donut and the table rows below.
  const colorOf = (symbol: string) => {
    if (symbol === "Idle USDC") return "var(--muted)";
    const i = rows.findIndex((r) => r.symbol === symbol);
    return COLORS[(i < 0 ? 0 : i) % COLORS.length];
  };
  const idle = live ? Number(live.idleUsdc) : 0;
  // Donut: live value by component (+ idle cash), or target weights if live data isn't available.
  const slices = live
    ? [...rows.map((r) => ({ name: r.symbol, v: r.value })), ...(idle > 0 ? [{ name: "Idle USDC", v: idle }] : [])].filter((s) => s.v > 0)
    : rows.map((r) => ({ name: r.symbol, v: r.target }));

  return (
    <Card>
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Holdings</h2>
        {live ? (
          <span className="text-xs text-muted">Live · prices {live.priceAgeSecs}s old</span>
        ) : (
          <span className="text-xs text-warn">Showing target weights (live data unavailable)</span>
        )}
      </div>
      <div className="mt-4 grid items-center gap-6 md:grid-cols-[200px_1fr]">
        <div className="h-48">
          {slices.length === 0 ? (
            <div className="grid h-full place-items-center text-sm text-muted">No holdings yet</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie stroke="var(--panel)" data={slices} dataKey="v" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2} isAnimationActive={false}>
                  {slices.map((s) => (
                    <Cell key={s.name} fill={colorOf(s.name)} />
                  ))}
                </Pie>
                <Tooltip formatter={(v) => (live ? fmtUsd(Number(v)) : bpsToPct(Number(v)))} contentStyle={{ borderRadius: 12, border: "1px solid var(--line)", background: "var(--elevated)", color: "var(--ink)", fontSize: 12, boxShadow: "none" }} itemStyle={{ color: "var(--ink)" }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted">
                <th className="pb-2 font-medium">Asset</th>
                <th className="pb-2 text-right font-medium">Target</th>
                <th className="pb-2 text-right font-medium">Actual</th>
                <th className="pb-2 text-right font-medium">Value</th>
              </tr>
            </thead>
            <tbody className="tabular divide-y divide-line">
              {rows.map((r) => {
                const drift = r.actual === null ? 0 : r.actual - r.target;
                return (
                  <tr key={r.mint}>
                    <td className="py-2 font-medium">
                      <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full align-baseline" style={{ background: colorOf(r.symbol) }} />
                      {r.symbol}
                    </td>
                    <td className="py-2 text-right">{bpsToPct(r.target)}</td>
                    <td className={`py-2 text-right ${Math.abs(drift) > 500 ? "text-warn" : ""}`}>{r.actual === null ? "—" : bpsToPct(r.actual)}</td>
                    <td className="py-2 text-right">{live ? fmtUsd(r.value) : "—"}</td>
                  </tr>
                );
              })}
              {live && (
                <tr className="text-muted">
                  <td className="py-2">
                    <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full align-baseline" style={{ background: colorOf("Idle USDC") }} />
                    Idle USDC
                  </td>
                  <td className="py-2 text-right">—</td>
                  <td className="py-2 text-right">{Number(live.navUsd) > 0 ? bpsToPct(Math.round((idle / Number(live.navUsd)) * 10_000)) : "—"}</td>
                  <td className="py-2 text-right">{fmtUsd(idle)}</td>
                </tr>
              )}
            </tbody>
          </table>
          {live && <p className="mt-2 text-xs text-muted">A keeper bot deploys idle USDC and rebalances toward target weights.</p>}
        </div>
      </div>
    </Card>
  );
}
