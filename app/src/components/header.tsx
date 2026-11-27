"use client";

import { Menu, Search, X } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CLUSTER, IS_MOCK } from "@/lib/config";
import { Logo } from "./logo";
import { ThemeToggle } from "./theme";

// The wallet button renders differently on the server and client; load it client-side only.
const WalletMultiButton = dynamic(() => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton), {
  ssr: false,
  loading: () => <div className="h-[38px] w-32 animate-pulse rounded-[10px] bg-elevated" />,
});

const LINKS = [
  { href: "/markets", label: "Markets" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/watchlist", label: "Watchlist" },
  { href: "/activity", label: "Activity" },
  { href: "/docs", label: "Docs" },
];

export function Header() {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState("");
  useEffect(() => setOpen(false), [path]);

  const isActive = (href: string) => path === href || path.startsWith(href + "/") || (href === "/markets" && path.startsWith("/funds"));

  return (
    <>
      {IS_MOCK && (
        <div className="border-b border-warn/25 bg-warn/10 px-4 py-1.5 text-center text-xs font-medium text-warn">
          {CLUSTER === "localnet" ? "Localnet" : "Devnet"} demo — mock tokens with no real value. Prices are real market quotes; set your wallet to{" "}
          {CLUSTER === "localnet" ? "localnet" : "Devnet"}.
        </div>
      )}
      <header className="sticky top-0 z-30 border-b border-line bg-canvas/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-10">
            <Logo />
            <nav className="hidden items-center gap-1 lg:flex" aria-label="Main">
              {LINKS.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  aria-current={isActive(l.href) ? "page" : undefined}
                  className={`relative rounded-lg px-3 py-2 text-sm font-medium transition-colors ${isActive(l.href) ? "text-ink" : "text-soft hover:text-ink"}`}
                >
                  {l.label}
                  {isActive(l.href) && <span className="absolute inset-x-3 -bottom-[17px] h-0.5 rounded-full bg-brand" />}
                </Link>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-2">
            {searching ? (
              <form
                className="hidden items-center md:flex"
                onSubmit={(e) => {
                  e.preventDefault();
                  router.push(`/markets?q=${encodeURIComponent(q)}`);
                  setSearching(false);
                }}
              >
                <input
                  autoFocus
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onBlur={() => !q && setSearching(false)}
                  onKeyDown={(e) => e.key === "Escape" && setSearching(false)}
                  placeholder="Search markets…"
                  aria-label="Search markets"
                  className="h-9 w-56 rounded-lg border border-line bg-surface px-3 text-sm outline-none placeholder:text-muted focus:border-brand"
                />
              </form>
            ) : (
              <button
                onClick={() => setSearching(true)}
                aria-label="Search"
                className="hidden h-9 w-9 place-items-center rounded-lg border border-line text-soft transition hover:bg-elevated hover:text-ink md:grid"
              >
                <Search size={16} />
              </button>
            )}
            <ThemeToggle />
            <WalletMultiButton />
            <button
              onClick={() => setOpen((o) => !o)}
              aria-label={open ? "Close menu" : "Open menu"}
              aria-expanded={open}
              className="grid h-9 w-9 place-items-center rounded-lg border border-line text-soft lg:hidden"
            >
              {open ? <X size={18} /> : <Menu size={18} />}
            </button>
          </div>
        </div>

        {open && (
          <nav className="border-t border-line bg-canvas px-4 py-3 lg:hidden" aria-label="Mobile">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={`block rounded-lg px-3 py-3 text-base font-medium ${isActive(l.href) ? "bg-elevated text-ink" : "text-soft"}`}
              >
                {l.label}
              </Link>
            ))}
          </nav>
        )}
      </header>
    </>
  );
}
