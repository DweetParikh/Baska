// 6-decimal fixed-point helpers (USDC and share amounts both use 6 decimals).

/** bigint micro-units -> "123.456789" */
export function fromBase6(v: bigint): string {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(7, "0");
  return `${neg ? "-" : ""}${s.slice(0, -6)}.${s.slice(-6)}`;
}

/** "123.456789" (or anything with toFixed, e.g. Prisma Decimal) -> bigint micro-units */
export function toBase6(d: string | { toFixed(n: number): string }): bigint {
  const s = typeof d === "string" ? d : d.toFixed(6);
  const neg = s.startsWith("-");
  const [whole, frac = ""] = (neg ? s.slice(1) : s).split(".");
  const micro = BigInt(whole || "0") * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
  return neg ? -micro : micro;
}

export function decodeName(bytes: number[] | Uint8Array): string {
  const arr = Array.from(bytes);
  const end = arr.indexOf(0);
  return Buffer.from(end < 0 ? arr : arr.slice(0, end)).toString("utf8");
}
