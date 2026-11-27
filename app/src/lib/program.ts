import { AnchorProvider, Program, Wallet } from "@anchor-lang/core";
import { Connection, Keypair } from "@solana/web3.js";
import idl from "../generated/baska_vault.json";

/**
 * Read-only program handle. We only use it to decode accounts and to BUILD instructions; the
 * user's wallet signs and sends, so the provider wallet here is a throwaway.
 */
export function makeProgram(connection: Connection): any {
  const provider = new AnchorProvider(connection, new Wallet(Keypair.generate()), { commitment: "confirmed" });
  return new Program(idl as any, provider);
}
