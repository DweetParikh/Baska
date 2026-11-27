import Link from "next/link";

/** Three stacked, offset layers: a "bundle" of assets in one mark. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect width="32" height="32" rx="9" fill="var(--brand)" />
      <rect x="8" y="8" width="13" height="5" rx="2.5" fill="#fff" />
      <rect x="11" y="13.5" width="13" height="5" rx="2.5" fill="#fff" fillOpacity="0.72" />
      <rect x="8" y="19" width="13" height="5" rx="2.5" fill="#fff" fillOpacity="0.45" />
    </svg>
  );
}

export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5" aria-label="Baska home">
      <LogoMark />
      <span className="text-[17px] font-semibold tracking-tight">
        Bask<span className="text-brand">a</span>
      </span>
    </Link>
  );
}
