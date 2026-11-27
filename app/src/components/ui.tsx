import { Info } from "lucide-react";
import { fmtPct } from "@/lib/format";

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-line bg-panel p-5 shadow-[var(--shadow)] ${className}`}>{children}</div>;
}

/** Label with an explanatory tooltip (hover or keyboard focus). */
export function Tip({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <span className="group relative inline-flex items-center gap-1">
      {children}
      <span tabIndex={0} aria-label={text} className="cursor-help text-muted outline-none hover:text-soft focus-visible:text-soft">
        <Info size={12} />
      </span>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-0 z-20 mb-2 hidden w-52 max-w-[calc(100vw-3rem)] rounded-lg border border-line bg-elevated px-2.5 py-2 text-xs font-normal normal-case leading-snug tracking-normal text-soft shadow-lg group-focus-within:block group-hover:block"
      >
        {text}
      </span>
    </span>
  );
}

export function Stat({ label, value, sub, tip }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tip?: string }) {
  return (
    <div>
      <div className="text-xs font-medium text-soft">{tip ? <Tip text={tip}>{label}</Tip> : label}</div>
      <div className="tabular mt-1 font-mono text-lg font-semibold">{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </div>
  );
}

const TONES = {
  amber: "bg-warn/10 text-warn ring-warn/25",
  red: "bg-down/10 text-down ring-down/25",
  blue: "bg-accent/10 text-accent ring-accent/25",
  gray: "bg-elevated text-soft ring-line",
  green: "bg-up/10 text-up ring-up/25",
  brand: "bg-brand/10 text-brand ring-brand/25",
};
export function Badge({ children, tone = "gray" }: { children: React.ReactNode; tone?: keyof typeof TONES }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]}`}>{children}</span>;
}

/** Signed % with an arrow; muted dash when there is no history yet. */
export function Change({ value, className = "" }: { value: number | null | undefined; className?: string }) {
  if (value === null || value === undefined)
    return (
      <span className={`font-mono text-muted ${className}`} title="Not enough history yet">
        —
      </span>
    );
  const up = value >= 0;
  return (
    <span className={`tabular inline-flex items-center gap-1 font-mono font-medium ${up ? "text-up" : "text-down"} ${className}`}>
      <span aria-hidden className="text-[9px]">
        {up ? "▲" : "▼"}
      </span>
      {Math.abs(value).toFixed(2)}%<span className="sr-only">{up ? " up" : " down"}</span>
    </span>
  );
}

export function PerfBadge({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="text-center">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
      <Change value={value} className="text-sm" />
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-elevated ${className}`} />;
}

const NOTICE = {
  info: "border-accent/30 bg-accent/10 text-ink",
  warn: "border-warn/30 bg-warn/10 text-ink",
  error: "border-down/30 bg-down/10 text-ink",
};
export function Notice({ tone = "info", children }: { tone?: keyof typeof NOTICE; children: React.ReactNode }) {
  return <div className={`rounded-xl border px-3 py-2 text-sm ${NOTICE[tone]}`}>{children}</div>;
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: React.ReactNode }) {
  return (
    <div className="grid place-items-center rounded-2xl border border-dashed border-line px-6 py-14 text-center">
      <div className="font-semibold">{title}</div>
      {body && <p className="mt-1 max-w-sm text-sm text-soft">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <Card className="border-down/40">
      <div className="font-semibold">Couldn&apos;t load data</div>
      <div className="mt-1 text-sm text-soft">{String((error as Error)?.message ?? error)}</div>
      {retry && (
        <button onClick={retry} className="mt-3 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark">
          Retry
        </button>
      )}
    </Card>
  );
}
