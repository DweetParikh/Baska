"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useToast } from "@/components/toast";
import { Badge, Card, ErrorState, Notice, Skeleton } from "@/components/ui";
import { explorerAddress, FUNDS } from "@/lib/config";
import { friendlyError } from "@/lib/errors";
import { shortAddr } from "@/lib/format";
import { useGlobalConfig, useOnchainFund, useProgram } from "@/lib/hooks";
import { buildSetGlobalPaused, buildSetPaused } from "@/lib/tx";
import { useSendTx } from "@/lib/use-send-tx";
import type { DeployedFund } from "@/lib/config";

export default function AdminPage() {
  const { publicKey, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const { data: cfg, error, refetch } = useGlobalConfig();
  const program = useProgram();
  const send = useSendTx();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  if (error) return <ErrorState error={error} retry={() => refetch()} />;
  if (!cfg) return <Skeleton className="h-48" />;

  const isAdmin = !!publicKey && publicKey.toBase58() === cfg.admin;

  async function act(label: string, build: () => Promise<import("@solana/web3.js").Transaction>) {
    setBusy(label);
    try {
      await send(await build(), label);
      await qc.invalidateQueries({ queryKey: ["config"] });
      await qc.invalidateQueries({ queryKey: ["onchain-fund"] });
    } catch (e) {
      toast.push({ tone: "error", title: `${label} failed`, body: friendlyError(e) }, 12_000);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">Admin</h1>

      {!connected ? (
        <Card className="max-w-lg">
          <p className="text-muted">Connect the admin wallet to manage the protocol.</p>
          <button onClick={() => setVisible(true)} className="mt-4 rounded-xl bg-brand px-5 py-3 font-semibold text-white hover:bg-brand-dark">
            Connect wallet
          </button>
        </Card>
      ) : !isAdmin ? (
        <Notice tone="warn">
          This wallet ({shortAddr(publicKey!.toBase58(), 5)}) is not the protocol admin. Controls are read-only; the program also rejects
          anyone else on-chain.
        </Notice>
      ) : (
        <Notice tone="info">Connected as admin. Every action is simulated before it reaches your wallet.</Notice>
      )}

      <Card>
        <h2 className="font-semibold">Protocol</h2>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <Item k="Admin" v={cfg.admin} link />
          <Item k="Keeper (can run execute_swap)" v={cfg.keeper} link />
          <Item k="Max swap slippage" v={`${cfg.maxSlippageBps / 100}% of NAV`} />
          <Item k="Global status" v={cfg.paused ? "PAUSED" : "Active"} />
        </dl>
        <div className="mt-4">
          <button
            disabled={!isAdmin || !!busy}
            onClick={() => act(cfg.paused ? "Unpause protocol" : "Pause protocol", () => buildSetGlobalPaused(program, publicKey!, !cfg.paused))}
            className={`rounded-xl px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-elevated disabled:text-muted ${cfg.paused ? "bg-up hover:opacity-90" : "bg-down hover:opacity-90"}`}
          >
            {busy?.includes("protocol") ? "Working…" : cfg.paused ? "Unpause protocol" : "Pause protocol"}
          </button>
          <p className="mt-2 text-xs text-muted">Pausing blocks deposits, USDC withdrawals and swaps. In-kind redemption is never pausable.</p>
        </div>
      </Card>

      <Card className="overflow-x-auto p-0">
        <div className="border-b border-line px-5 py-3 font-semibold">Funds</div>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-line">
            {FUNDS.map((f) => (
              <FundRow key={f.id} fund={f} isAdmin={isAdmin} busy={busy} onToggle={(paused) => act(`${paused ? "Pause" : "Unpause"} ${f.name}`, () => buildSetPaused(program, publicKey!, f, paused))} />
            ))}
          </tbody>
        </table>
      </Card>

      <Notice tone="info">
        Not in this UI yet: creating funds (needs vault setup done by the seed script) and rebalancing, which the keeper bot performs
        automatically; only the configured keeper key can call <code>execute_swap</code>. On mainnet, admin and keeper should be multisigs.
      </Notice>
    </div>
  );
}

function FundRow({ fund, isAdmin, busy, onToggle }: { fund: DeployedFund; isAdmin: boolean; busy: string | null; onToggle: (paused: boolean) => void }) {
  const { data } = useOnchainFund(fund);
  const paused = data?.paused ?? false;
  return (
    <tr>
      <td className="px-5 py-3">
        <div className="font-medium">{fund.name}</div>
        <a href={explorerAddress(fund.address)} target="_blank" rel="noreferrer" className="font-mono text-xs text-brand hover:underline">
          {shortAddr(fund.address, 5)}
        </a>
      </td>
      <td className="px-3 py-3 text-xs text-muted">
        {data ? `min deposit $${Number(data.minDeposit) / 1e6} · cap $${(Number(data.maxTvl) / 1e6).toLocaleString()}` : "…"}
      </td>
      <td className="px-3 py-3">{data ? <Badge tone={paused ? "red" : "green"}>{paused ? "Paused" : "Active"}</Badge> : null}</td>
      <td className="px-5 py-3 text-right">
        <button
          disabled={!isAdmin || !!busy || !data}
          onClick={() => onToggle(!paused)}
          className="rounded-lg border border-line px-3 py-1.5 text-sm font-semibold hover:border-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          {paused ? "Unpause" : "Pause"}
        </button>
      </td>
    </tr>
  );
}

function Item({ k, v, link }: { k: string; v: string; link?: boolean }) {
  return (
    <div className="flex justify-between gap-3 rounded-lg bg-surface px-3 py-2">
      <dt className="text-muted">{k}</dt>
      <dd className="font-medium">
        {link ? (
          <a href={explorerAddress(v)} target="_blank" rel="noreferrer" className="font-mono text-xs text-brand hover:underline">
            {shortAddr(v, 5)}
          </a>
        ) : (
          v
        )}
      </dd>
    </div>
  );
}
