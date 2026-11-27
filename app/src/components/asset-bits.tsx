"use client";

import { Check, Copy, Star } from "lucide-react";
import { useState } from "react";
import { fundMeta } from "@/lib/config";
import { useWatchlist } from "@/lib/watchlist";

/** Monogram logo tinted with the fund's colour (stand-in until real asset art exists). */
export function AssetLogo({ fundId, size = 36 }: { fundId: number; size?: number }) {
  const m = fundMeta(fundId);
  return (
    <span
      className="grid shrink-0 place-items-center rounded-xl font-mono text-[11px] font-semibold"
      style={{ width: size, height: size, background: `${m.color}22`, color: m.color, boxShadow: `inset 0 0 0 1px ${m.color}44` }}
      aria-hidden
    >
      {m.ticker.slice(0, 3)}
    </span>
  );
}

export function CopyButton({ value, label = "Copy address" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={done ? "Copied" : label}
      title={done ? "Copied" : label}
      onClick={async (e) => {
        e.preventDefault();
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {}
      }}
      className="grid h-6 w-6 place-items-center rounded-md text-muted transition hover:bg-elevated hover:text-ink"
    >
      {done ? <Check size={13} className="text-up" /> : <Copy size={13} />}
    </button>
  );
}

export function StarButton({ fundId, className = "" }: { fundId: number; className?: string }) {
  const { has, toggle } = useWatchlist();
  const on = has(fundId);
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? "Remove from watchlist" : "Add to watchlist"}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle(fundId);
      }}
      className={`grid h-8 w-8 place-items-center rounded-lg transition hover:bg-elevated ${on ? "text-warn" : "text-muted hover:text-soft"} ${className}`}
    >
      <Star size={16} fill={on ? "currentColor" : "none"} />
    </button>
  );
}
