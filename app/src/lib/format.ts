/** "123.456789" -> 123456789n (6-decimal fixed point, same convention as the API). */
export function toBase6(s: string | null | undefined): bigint {
  if (!s) return 0n;
  const neg = s.startsWith("-");
  const [w, f = ""] = (neg ? s.slice(1) : s).split(".");
  const v = BigInt(w || "0") * 1_000_000n + BigInt((f + "000000").slice(0, 6));
  return neg ? -v : v;
}

export function fromBase6(v: bigint): string {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(7, "0");
  return `${neg ? "-" : ""}${s.slice(0, -6)}.${s.slice(-6)}`;
}

/** User-typed decimal ("12.5") -> base units for a token with `decimals`. null if invalid. */
export function parseAmount(input: string, decimals = 6): bigint | null {
  const t = input.trim();
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
  const [w, f = ""] = t.split(".");
  if (f.length > decimals) return null;
  return BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals));
}

/** base units -> display string, trimmed trailing zeros (max `maxFrac` fraction digits). */
export function formatUnits(v: bigint, decimals: number, maxFrac = 4): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  const w = whole.toLocaleString("en-US");
  return `${neg ? "-" : ""}${w}${frac ? "." + frac : ""}`;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
export const fmtUsd = (s: string | number | null | undefined) =>
  s === null || s === undefined || s === "" ? "—" : usd.format(typeof s === "number" ? s : Number(s));

export const fmtNav = (s: string | null | undefined) => (s ? `$${Number(s).toFixed(4)}` : "—");

export const fmtPct = (n: number | null | undefined, digits = 2) =>
  n === null || n === undefined ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;

export const bpsToPct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

export const shortAddr = (a: string, n = 4) => `${a.slice(0, n)}…${a.slice(-n)}`;

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
