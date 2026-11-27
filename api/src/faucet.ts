import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";
import { Cache } from "./cache";

export class FaucetError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export interface FaucetDeps {
  conn: Connection;
  /** Must be the mock USDC mint authority. Also pays the recipient's ATA rent. */
  payer: Keypair;
  usdcMint: PublicKey;
  /** USDC base units (6 dec) per request. */
  amount: bigint;
  cooldownSecs: number;
  cache: Cache;
}

/**
 * Mints MOCK USDC on devnet/localnet. Never enable on mainnet: this only works if the
 * server holds the mint authority, which cannot be true of real USDC.
 */
export class Faucet {
  constructor(private d: FaucetDeps) {}

  /** Fail fast at startup if this key can't actually mint. */
  async assertCanMint() {
    const m = await getMint(this.d.conn, this.d.usdcMint);
    if (!m.mintAuthority?.equals(this.d.payer.publicKey)) {
      throw new Error(`faucet key ${this.d.payer.publicKey.toBase58()} is not the authority of mint ${this.d.usdcMint.toBase58()}`);
    }
  }

  get amount() {
    return this.d.amount;
  }

  async drip(wallet: PublicKey): Promise<{ signature: string; amount: bigint; ata: string }> {
    const key = `faucet:${wallet.toBase58()}`;
    if (await this.d.cache.get(key)) {
      throw new FaucetError(429, "cooldown", `this wallet already received test USDC in the last ${Math.round(this.d.cooldownSecs / 60)} minutes`);
    }
    // Reserve first so concurrent requests for one wallet can't both pay out.
    await this.d.cache.set(key, "1", this.d.cooldownSecs);
    try {
      const ata = getAssociatedTokenAddressSync(this.d.usdcMint, wallet, true, TOKEN_PROGRAM_ID);
      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(this.d.payer.publicKey, ata, wallet, this.d.usdcMint),
        createMintToCheckedInstruction(this.d.usdcMint, ata, this.d.payer.publicKey, this.d.amount, 6)
      );
      const signature = await sendAndConfirmTransaction(this.d.conn, tx, [this.d.payer], { commitment: "confirmed" });
      return { signature, amount: this.d.amount, ata: ata.toBase58() };
    } catch (e) {
      await this.d.cache.del(key); // don't punish the user for our failure
      throw new FaucetError(502, "mint_failed", `could not mint test USDC: ${String((e as Error).message).split("\n")[0]}`);
    }
  }
}
