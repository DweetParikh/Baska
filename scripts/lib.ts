import * as anchor from "@anchor-lang/core";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { makeConnection } from "../keeper/src/rpc";

export const ROOT = path.join(__dirname, "..");
export const KEYS_DIR = path.join(ROOT, "keys");
export const DEPLOY_DIR = path.join(ROOT, "deployments");

export const env = (k: string, d: string) => process.env[k] ?? d;
export const CLUSTER = env("CLUSTER", "devnet");
export const RPC_URL = env("RPC_URL", "https://api.devnet.solana.com");

export function loadKeypairFile(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

/** Service keys live in keys/ (gitignored). Created on first use. */
export function loadOrCreateKey(name: "faucet" | "keeper" | "oracle"): Keypair {
  const p = path.join(KEYS_DIR, `${name}.json`);
  if (fs.existsSync(p)) return loadKeypairFile(p);
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  const kp = Keypair.generate();
  fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}

export const adminKeypairPath = () => env("ADMIN_KEYPAIR", path.join(os.homedir(), ".config", "solana", "id.json"));

export function makeProgram(signer: Keypair, conn = makeConnection(RPC_URL)) {
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(signer), { commitment: "confirmed" });
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const idl = require("../target/idl/baska_vault.json");
  const program: any = new anchor.Program(idl, provider);
  return { conn, provider, program };
}

// ------------------------------------------------------------------ deployment file

export interface Deployment {
  cluster: string;
  rpcUrl: string;
  programId: string;
  config: string;
  usdcMint: string;
  liquidityAuthority: string;
  service: { admin: string; keeper: string; oracle: string; faucet: string };
  stocks: { symbol: string; mint: string; decimals: number; feed: string; baseUsd: number }[];
  funds: {
    id: number;
    name: string;
    address: string;
    shareMint: string;
    usdcVault: string;
    components: { symbol: string; mint: string; vault: string; priceFeed: string; targetBps: number }[];
  }[];
  updatedAt: string;
}

export const deploymentPath = (cluster = CLUSTER) => path.join(DEPLOY_DIR, `${cluster}.json`);

export function loadDeployment(cluster = CLUSTER): Deployment | null {
  const p = deploymentPath(cluster);
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, "utf8")) as Deployment) : null;
}

export function saveDeployment(d: Deployment) {
  fs.mkdirSync(DEPLOY_DIR, { recursive: true });
  d.updatedAt = new Date().toISOString();
  fs.writeFileSync(deploymentPath(d.cluster), JSON.stringify(d, null, 2) + "\n");
  // mint -> ticker map consumed by the API (SYMBOLS_FILE)
  fs.writeFileSync(
    path.join(DEPLOY_DIR, `${d.cluster}.symbols.json`),
    JSON.stringify(Object.fromEntries(d.stocks.map((s) => [s.mint, s.symbol])), null, 2) + "\n"
  );
}

/**
 * Send instructions as a v0 transaction using a freshly created address lookup table.
 * Needed for create_fund on funds with many components: 25 accounts + ~300 bytes of data
 * sits right at the 1232-byte legacy limit.
 */
export async function sendV0WithAlt(
  conn: Connection,
  payer: Keypair,
  ixs: TransactionInstruction[],
  extraSigners: Keypair[],
  altAddresses: PublicKey[]
): Promise<string> {
  const slot = await conn.getSlot("finalized");
  const [createIx, altKey] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: slot,
  });
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    lookupTable: altKey,
    authority: payer.publicKey,
    payer: payer.publicKey,
    addresses: altAddresses,
  });
  await sendAndConfirmTransaction(conn, new Transaction().add(createIx, extendIx), [payer], { commitment: "confirmed" });

  let alt: AddressLookupTableAccount | null = null;
  for (let i = 0; i < 40 && !alt; i++) {
    const r = (await conn.getAddressLookupTable(altKey, { commitment: "confirmed" })).value;
    if (r && r.state.addresses.length === altAddresses.length) alt = r;
    else await sleep(500);
  }
  if (!alt) throw new Error("address lookup table did not become available");
  // Entries are usable from the slot after they were added.
  const s0 = await conn.getSlot("confirmed");
  while ((await conn.getSlot("confirmed")) <= s0) await sleep(300);

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message([alt]);
  const tx = new VersionedTransaction(msg);
  tx.sign([payer, ...extraSigners]);
  const sig = await conn.sendTransaction(tx, { maxRetries: 5 });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

/**
 * Send + confirm by polling getSignatureStatuses over plain HTTP. web3.js's default confirmation
 * opens a WebSocket subscription, which the public devnet RPC rate-limits (and a rejected
 * subscription can surface as an unhandled rejection that kills the process).
 */
export async function sendPolling(conn: Connection, tx: Transaction, signers: Keypair[], timeoutMs = 60_000): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return sig;
    if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) throw new Error(`transaction ${sig} expired before confirming`);
    await sleep(1200);
  }
  throw new Error(`timed out confirming ${sig}`);
}

export const pk = (s: string) => new PublicKey(s);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function log(msg: string, extra?: Record<string, unknown>) {
  console.log(extra ? `${msg} ${JSON.stringify(extra)}` : msg);
}
