/**
 * PDA Derivation Utilities for Portal Program (@solana/web3.js)
 */

import { PublicKey } from "@solana/web3.js";

export async function deriveSessionPDA(
  portalProgramId: PublicKey,
): Promise<PublicKey> {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("session", "utf8")],
    portalProgramId,
  );
  return pda;
}

export async function deriveFeeVaultPDA(
  portalProgramId: PublicKey,
): Promise<PublicKey> {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_vault", "utf8")],
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

export async function deriveWithdrawalSinkPDA(
  session: PublicKey,
  recipient: PublicKey,
  portalProgramId: PublicKey,
): Promise<PublicKey> {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("withdrawal_sink", "utf8"),
      session.toBuffer(),
      recipient.toBuffer(),
    ],
    portalProgramId,
  );
  return pda;
}
