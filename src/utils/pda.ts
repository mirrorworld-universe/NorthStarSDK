/**
 * PDA Derivation Utilities for Portal Program (@solana/web3.js)
 */

import { PublicKey } from "@solana/web3.js";
import { toU64LE } from "./common";

export async function deriveSessionPDA(
  owner: PublicKey,
  gridId: number,
  portalProgramId: PublicKey,
): Promise<PublicKey> {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("session", "utf8"), owner.toBuffer(), toU64LE(gridId)],
    portalProgramId,
  );
  return pda;
}

export async function deriveFeeVaultPDA(
  owner: PublicKey,
  portalProgramId: PublicKey,
): Promise<PublicKey> {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_vault", "utf8"), owner.toBuffer()],
    portalProgramId,
  );
  return pda;
}

export async function deriveDelegationRecordPDA(
  delegatedAccount: PublicKey,
  portalProgramId: PublicKey,
): Promise<PublicKey> {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("delegation", "utf8"), delegatedAccount.toBuffer()],
    portalProgramId,
  );
  return pda;
}

export async function deriveDepositReceiptPDA(
  session: PublicKey,
  recipient: PublicKey,
  portalProgramId: PublicKey,
): Promise<PublicKey> {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("deposit_receipt", "utf8"),
      session.toBuffer(),
      recipient.toBuffer(),
    ],
    portalProgramId,
  );
  return pda;
}
