/**
 * Helpers for building v0 transactions with @solana/web3.js (replaces @solana/kit flows).
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

export function toPublicKey(
  key: PublicKey | string,
): PublicKey {
  return key instanceof PublicKey ? key : new PublicKey(key);
}

export function getVersionedTxSignatureBase58(tx: VersionedTransaction): string {
  const sig = tx.signatures[0];
  if (!sig) {
    throw new Error("Transaction has no signature");
  }
  return bs58.encode(sig);
}

export async function sendRawVersionedTransaction(
  connection: Connection,
  tx: VersionedTransaction,
  options: {
    commitment?: "processed" | "confirmed" | "finalized";
    skipPreflight?: boolean;
  } = {},
): Promise<void> {
  const commitment = options.commitment ?? "confirmed";
  const skipPreflight = options.skipPreflight ?? true;
  await connection.sendRawTransaction(Buffer.from(tx.serialize()), {
    skipPreflight,
    preflightCommitment: commitment,
  });
}

export function buildAndSignVersionedTransaction(
  payer: Keypair,
  recentBlockhash: string,
  instructions: TransactionInstruction[],
): VersionedTransaction {
  const messageV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(messageV0);
  tx.sign([payer]);
  return tx;
}

export function buildVersionedTransactionUnsigned(
  payerKey: PublicKey,
  recentBlockhash: string,
  instructions: TransactionInstruction[],
): VersionedTransaction {
  const messageV0 = new TransactionMessage({
    payerKey,
    recentBlockhash,
    instructions,
  }).compileToV0Message();
  return new VersionedTransaction(messageV0);
}

/** Partially sign with given keypairs (e.g. delegated account before wallet signs fee payer). */
export function signVersionedTransaction(
  tx: VersionedTransaction,
  signers: Keypair[],
): VersionedTransaction {
  tx.sign(signers);
  return tx;
}

export const SYSTEM_PROGRAM_ID = SystemProgram.programId;
