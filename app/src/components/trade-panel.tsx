"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, FundDetail } from "@/lib/api";
import { explorerTx, fundById, ORACLE_WARN_SECS, stockByMint } from "@/lib/config";
import { friendlyError } from "@/lib/errors";
import { formatUnits, fmtUsd, parseAmount, toBase6 } from "@/lib/format";
import { useBalances, useOnchainFund, useProgram } from "@/lib/hooks";
import { proRata, quoteDeposit, quoteRedeemUsdc, withSlippage } from "@/lib/quote";
import { buildDeposit, buildRedeemInKind, buildRedeemUsdc } from "@/lib/tx";
import { useSendTx } from "@/lib/use-send-tx";
import { useToast } from "./toast";
import { Card, Notice } from "./ui";

const SLIPPAGE_BPS = 50; // 0.5%: the on-chain min_shares_out / min_usdc_out

export function TradePanel({ fundId, detail, refreshDetail }: { fundId: number; detail: FundDetail; refreshDetail: () => Promise<unknown> }) {
  const fund = fundById(fundId)!;
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const sendAndConfirm = useSendTx();
  const program = useProgram();
  const toast = useToast();
  const qc = useQueryClient();

  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const [mode, setMode] = useState<"usdc" | "kind">("usdc");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const onchain = useOnchainFund(fund).data;
  const bal = useBalances(fund, publicKey).data;
  const h = detail.holdings;

  const nav = toBase6(h?.navUsd);
  const supply = toBase6(h?.totalShares);
  const idle = toBase6(h?.idleUsdc);
  const stale = !h || h.priceAgeSecs > ORACLE_WARN_SECS;
  const paused = onchain?.paused ?? false;
  const usdcBal = bal?.usdc ?? 0n;
  const shareBal = bal?.shares ?? 0n;
  const amt = parseAmount(amount);

  // ----------------------------------------------------------------- quotes + validation
  const depositQuote = amt && h ? quoteDeposit(amt, supply, nav) : null;
  const redeemQuote = amt && h ? quoteRedeemUsdc(amt, supply, nav) : null;

  let issue: string | null = null;
  if (amount && amt === null) issue = "Enter a valid amount (max 6 decimals).";
  else if (tab === "deposit") {
    if (paused) issue = "This fund is paused. Deposits are disabled.";
    else if (stale) issue = "Prices are stale (market closed or feed down). Deposits are paused until they refresh.";
    else if (amt !== null) {
      if (onchain && amt < onchain.minDeposit) issue = `Minimum deposit is ${fmtUsd(Number(onchain.minDeposit) / 1e6)}.`;
      else if (amt > usdcBal) issue = "Not enough USDC in your wallet.";
      else if (onchain && nav + amt > onchain.maxTvl) issue = "This fund has reached its beta deposit cap.";
      else if (!depositQuote || depositQuote === 0n) issue = "Amount is too small.";
    }
  } else if (amt !== null) {
    if (amt > shareBal) issue = "You don't own that many shares.";
    else if (mode === "usdc") {
      if (paused) issue = "This fund is paused. Use “Redeem in kind”.";
      else if (stale) issue = "Prices are stale. Use “Redeem in kind”, which needs no price.";
      else if (redeemQuote !== null && redeemQuote > idle) issue = `Only ${fmtUsd(Number(idle) / 1e6)} of USDC is idle in the fund. Use “Redeem in kind” or a smaller amount.`;
      else if (!redeemQuote || redeemQuote === 0n) issue = "Amount is too small.";
    }
  }
  const maxUnits = tab === "deposit" ? usdcBal : shareBal;
  const pct = amt !== null && maxUnits > 0n ? Math.min(100, Number((amt * 100n) / maxUnits)) : 0;
  const setPercent = (v: number) => setAmount(v === 0 ? "" : formatUnits((maxUnits * BigInt(v)) / 100n, 6, 6).replace(/,/g, ""));
  const ready = connected && amt !== null && amt > 0n && !issue && !busy;

  // ----------------------------------------------------------------------------- actions
  async function refreshAll() {
    await qc.invalidateQueries({ queryKey: ["balances"] });
    await qc.invalidateQueries({ queryKey: ["onchain-fund"] });
    // The indexer picks the transaction up within ~30s; poll the portfolio a few times.
    for (const ms of [0, 8_000, 20_000]) setTimeout(() => qc.invalidateQueries({ queryKey: ["portfolio"] }).then(() => qc.invalidateQueries({ queryKey: ["txs"] })), ms);
    await refreshDetail();
  }

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    try {
      await fn();
      setAmount("");
      await refreshAll();
    } catch (e) {
      toast.push({ tone: "error", title: `${label} failed`, body: friendlyError(e) }, 12_000);
    } finally {
      setBusy(null);
    }
  }

  const submit = () => {
    if (!publicKey || !amt) return;
    if (tab === "deposit") {
      return run("Deposit", async () => {
        const fresh = await api.fund(fundId, { fresh: true }); // never quote against a cached NAV
        if (!fresh.holdings) throw new Error("Live prices are unavailable right now. Try again shortly.");
        const q = quoteDeposit(amt, toBase6(fresh.holdings.totalShares), toBase6(fresh.holdings.navUsd));
        if (!q) throw new Error("Couldn't price this deposit.");
        await sendAndConfirm(await buildDeposit(program, publicKey, fund, amt, withSlippage(q, SLIPPAGE_BPS)), "Deposit");
      });
    }
    if (mode === "usdc") {
      return run("Withdrawal", async () => {
        const fresh = await api.fund(fundId, { fresh: true });
        if (!fresh.holdings) throw new Error("Live prices are unavailable right now. Try again shortly.");
        const q = quoteRedeemUsdc(amt, toBase6(fresh.holdings.totalShares), toBase6(fresh.holdings.navUsd));
        if (!q) throw new Error("Couldn't price this withdrawal.");
        await sendAndConfirm(await buildRedeemUsdc(program, publicKey, fund, amt, withSlippage(q, SLIPPAGE_BPS)), "Withdrawal");
      });
    }
    return run("Redemption", async () => {
      const { setup, main } = await buildRedeemInKind(connection, program, publicKey, fund, amt);
      if (setup) {
        toast.push({ tone: "info", title: "Step 1 of 2", body: "Creating token accounts to receive each asset." });
        await sendAndConfirm(setup, "Token accounts");
      }
      await sendAndConfirm(main, "Redemption");
    });
  };

  const getTestUsdc = () =>
    run("Test USDC", async () => {
      const r = await api.faucet(publicKey!.toBase58());
      toast.push({ tone: "success", title: `Received ${Number(r.amountUsdc).toLocaleString()} test USDC`, href: explorerTx(r.signature) });
    });

  // ------------------------------------------------------------------------------ render
  const inKindPreview = h && amt && supply > 0n && mode === "kind" && tab === "withdraw" && amt <= shareBal;

  return (
    <Card className="lg:sticky lg:top-24">
      <div className="flex gap-1 rounded-xl bg-elevated p-1">
        {(["deposit", "withdraw"] as const).map((t) => (
          <button
            key={t}
            onClick={() => {
              setTab(t);
              setAmount("");
            }}
            className={`flex-1 rounded-lg py-2 text-sm font-semibold capitalize ${tab === t ? "bg-panel shadow-sm" : "text-muted hover:text-ink"}`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "withdraw" && (
        <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
          {([
            ["usdc", "Receive USDC", "From the idle buffer"],
            ["kind", "Redeem in kind", "Always available"],
          ] as const).map(([m, title, sub]) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`rounded-xl border p-2.5 text-left ${mode === m ? "border-brand bg-brand/10" : "border-line hover:border-muted"}`}
            >
              <div className="font-semibold">{title}</div>
              <div className="text-xs text-muted">{sub}</div>
            </button>
          ))}
        </div>
      )}

      <div className="mt-4">
        <div className="flex items-center justify-between text-xs text-muted">
          <label htmlFor="amount" className="font-medium">
            {tab === "deposit" ? "Amount (USDC)" : "Shares to redeem"}
          </label>
          {connected && (
            <button
              className="font-medium text-brand hover:underline"
              onClick={() => setAmount(formatUnits(tab === "deposit" ? usdcBal : shareBal, 6, 6).replace(/,/g, ""))}
            >
              Max: {formatUnits(tab === "deposit" ? usdcBal : shareBal, 6, 2)}
            </button>
          )}
        </div>
        <input
          id="amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="tabular mt-1 w-full rounded-xl border border-line bg-surface px-3 py-3 font-mono text-lg font-semibold outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
        />
      </div>

      {connected && maxUnits > 0n && (
        <div className="mt-3">
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={pct}
            aria-label="Percentage of balance"
            onChange={(e) => setPercent(Number(e.target.value))}
            className="slider block w-full"
            style={{ "--pct": `${pct}%` } as React.CSSProperties}
          />
          <div className="mt-2 flex justify-between">
            {[0, 25, 50, 75, 100].map((v) => (
              <button
                key={v}
                onClick={() => setPercent(v)}
                className={`rounded-md px-2 py-0.5 font-mono text-xs transition ${pct === v ? "bg-brand/15 text-brand" : "text-muted hover:text-ink"}`}
              >
                {v}%
              </button>
            ))}
          </div>
        </div>
      )}

      {/* preview */}
      <div className="tabular mt-3 space-y-1 text-sm">
        {tab === "deposit" && amt && depositQuote ? (
          <>
            <Row k="You receive ≈" v={`${formatUnits(depositQuote, 6, 4)} shares`} />
            <Row k={`Minimum (${SLIPPAGE_BPS / 100}% slippage)`} v={`${formatUnits(withSlippage(depositQuote, SLIPPAGE_BPS), 6, 4)} shares`} />
          </>
        ) : null}
        {tab === "withdraw" && mode === "usdc" && amt && redeemQuote ? (
          <>
            <Row k="You receive ≈" v={fmtUsd(Number(redeemQuote) / 1e6)} />
            <Row k="Idle USDC available" v={fmtUsd(Number(idle) / 1e6)} />
          </>
        ) : null}
        {inKindPreview && h ? (
          <>
            <Row k="USDC" v={fmtUsd(Number(proRata(idle, amt!, supply)) / 1e6)} />
            {h.components.map((c) => {
              const dec = stockByMint(c.mint)?.decimals ?? 6;
              return <Row key={c.mint} k={c.symbol} v={formatUnits(proRata(BigInt(c.balance), amt!, supply), dec, 4)} />;
            })}
          </>
        ) : null}
      </div>

      {issue && (
        <div className="mt-3">
          <Notice tone="warn">{issue}</Notice>
        </div>
      )}
      {tab === "withdraw" && mode === "kind" && (paused || stale) && (
        <div className="mt-3">
          <Notice tone="info">In-kind redemption works even while the fund is paused or prices are stale.</Notice>
        </div>
      )}

      {connected && tab === "deposit" && usdcBal < 1_000_000n && (
        <div className="mt-3">
          <Notice tone="info">
            You have no USDC.{" "}
            <button onClick={getTestUsdc} disabled={!!busy} className="font-semibold underline disabled:opacity-50">
              Get 1,000 test USDC
            </button>{" "}
            (devnet mock, free).
          </Notice>
        </div>
      )}

      <button
        onClick={connected ? submit : () => setVisible(true)}
        disabled={connected && !ready}
        className="mt-4 w-full rounded-xl bg-brand py-3 text-base font-semibold text-white shadow-sm transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:bg-elevated disabled:text-muted"
      >
        {busy ? `${busy}…` : !connected ? "Connect wallet" : tab === "deposit" ? "Deposit" : mode === "usdc" ? "Withdraw USDC" : "Redeem in kind"}
      </button>

      {tab === "deposit" && (
        <p className="mt-3 text-xs leading-relaxed text-muted">
          <strong>Not guaranteed.</strong> Share price tracks the underlying tokenized stocks and can fall. Tokenized stocks may have eligibility
          restrictions. You can always redeem in kind.
        </p>
      )}
    </Card>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted">{k}</span>
      <span className="font-medium">{v}</span>
    </div>
  );
}
