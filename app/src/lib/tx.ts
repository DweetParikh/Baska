import { BN } from "@anchor-lang/core";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import { CONFIG_PDA, DeployedFund, USDC_MINT } from "./config";

// All builders return UNSIGNED legacy transactions with feePayer set. The blockhash is attached at
// simulate/send time. No compute-budget instruction: the heaviest instruction (a 7-component swap)
// measured 47,910 CU on devnet, far below the 200k default, and omitting it saves tx bytes.

const pk = (s: string) => new PublicKey(s);
export const userAta = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner);

/** [vault_0, feed_0, vault_1, feed_1, ...] in component order, as the program expects. */
export const oracleAccounts = (f: DeployedFund) =>
  f.components.flatMap((c) => [
    { pubkey: pk(c.vault), isWritable: false, isSigner: false },
    { pubkey: pk(c.priceFeed), isWritable: false, isSigner: false },
  ]);

function fundAccounts(f: DeployedFund, user: PublicKey) {
  return {
    user,
    fund: pk(f.address),
    usdcMint: USDC_MINT,
    shareMint: pk(f.shareMint),
    usdcVault: pk(f.usdcVault),
    userUsdc: userAta(USDC_MINT, user),
    userShares: userAta(pk(f.shareMint), user),
    tokenProgram: TOKEN_PROGRAM_ID,
  };
}

const toTx = (user: PublicKey, ixs: TransactionInstruction[]) => {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = user;
  return tx;
};
const bn = (v: bigint) => new BN(v.toString());

export async function buildDeposit(program: any, user: PublicKey, f: DeployedFund, amount: bigint, minSharesOut: bigint) {
  const a = fundAccounts(f, user);
  const ix = await program.methods
    .deposit(bn(amount), bn(minSharesOut))
    .accounts(a)
    .remainingAccounts(oracleAccounts(f))
    .instruction();
  return toTx(user, [createAssociatedTokenAccountIdempotentInstruction(user, a.userShares, user, a.shareMint), ix]);
}

export async function buildRedeemUsdc(program: any, user: PublicKey, f: DeployedFund, shares: bigint, minUsdcOut: bigint) {
  const ix = await program.methods
    .redeemUsdc(bn(shares), bn(minUsdcOut))
    .accounts(fundAccounts(f, user))
    .remainingAccounts(oracleAccounts(f))
    .instruction();
  return toTx(user, [ix]);
}

/**
 * redeem_in_kind delivers every component token, so the user needs a token account for each.
 * Creating them in the same transaction overflows the 1232-byte limit on a 7-component fund, so
 * missing accounts go in a separate `setup` transaction that must be sent first.
 */
export async function buildRedeemInKind(
  connection: Connection,
  program: any,
  user: PublicKey,
  f: DeployedFund,
  shares: bigint
): Promise<{ setup: Transaction | null; main: Transaction }> {
  const dests = f.components.map((c) => userAta(pk(c.mint), user));
  const infos = await connection.getMultipleAccountsInfo(dests);
  const missing = f.components.map((c, i) => ({ c, ata: dests[i], missing: !infos[i] })).filter((x) => x.missing);

  const setup = missing.length
    ? toTx(user, missing.map((m) => createAssociatedTokenAccountIdempotentInstruction(user, m.ata, user, pk(m.c.mint))))
    : null;

  const remaining = f.components.flatMap((c, i) => [
    { pubkey: pk(c.mint), isWritable: false, isSigner: false },
    { pubkey: pk(c.vault), isWritable: true, isSigner: false },
    { pubkey: dests[i], isWritable: true, isSigner: false },
  ]);
  const ix = await program.methods
    .redeemInKind(bn(shares))
    .accounts(fundAccounts(f, user))
    .remainingAccounts(remaining)
    .instruction();
  return { setup, main: toTx(user, [ix]) };
}

export async function buildSetPaused(program: any, admin: PublicKey, f: DeployedFund, paused: boolean) {
  const ix = await program.methods
    .setPaused(paused)
    .accounts({ admin, config: CONFIG_PDA, fund: pk(f.address) })
    .instruction();
  return toTx(admin, [ix]);
}

export async function buildSetGlobalPaused(program: any, admin: PublicKey, paused: boolean) {
  const ix = await program.methods.setGlobalPaused(paused).accounts({ admin, config: CONFIG_PDA }).instruction();
  return toTx(admin, [ix]);
}

// ----------------------------------------------------------------------------------------------

export interface SimResult {
  ok: boolean;
  err: unknown;
  logs: string[];
  unitsConsumed: number | null;
}

/** Dry-run without signatures, so the user sees failures BEFORE the wallet prompt. */
export async function simulate(connection: Connection, tx: Transaction, payer: PublicKey): Promise<SimResult> {
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer;
  const vtx = new VersionedTransaction(tx.compileMessage());
  const r = await connection.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  return { ok: !r.value.err, err: r.value.err, logs: r.value.logs ?? [], unitsConsumed: r.value.unitsConsumed ?? null };
}

/**
 * Confirm by polling over HTTP. web3.js's default confirmation opens a WebSocket, which public
 * RPCs rate-limit (HTTP 429) and which can fail silently behind some proxies.
 */
export async function confirmByPolling(connection: Connection, sig: string, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const st = (await connection.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return;
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error("Timed out waiting for confirmation. Check the explorer; it may still land.");
}
