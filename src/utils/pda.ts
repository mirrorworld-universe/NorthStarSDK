import { PublicKey } from "@solana/web3.js";
import { Hash32 } from "../programs/continuity";
import { PortalProgram } from "../programs/portal";

export function deriveSessionPDA(program: PublicKey): Promise<PublicKey> {
  return PortalProgram.deriveSessionPDA(program);
}
export function deriveSessionEpochPDA(program: PublicKey): Promise<PublicKey> {
  return PortalProgram.deriveSessionEpochPDA(program);
}
export function deriveFeeVaultPDA(program: PublicKey): Promise<PublicKey> {
  return PortalProgram.deriveFeeVaultPDA(program);
}
export function deriveDelegationRecordPDA(account: PublicKey, program: PublicKey): Promise<PublicKey> {
  return PortalProgram.deriveDelegationRecordPDA(account, program);
}
export function deriveDepositReceiptPDA(context: Hash32, recipient: PublicKey, program: PublicKey): Promise<PublicKey> {
  return PortalProgram.deriveDepositReceiptPDA(context, recipient, program);
}
export function deriveSessionBridgePDA(context: Hash32, mint: PublicKey, program: PublicKey): Promise<PublicKey> {
  return PortalProgram.deriveSessionBridgePDA(context, mint, program);
}
export function deriveIngressRecordPDA(context: Hash32, sequence: bigint, program: PublicKey): Promise<PublicKey> {
  return PortalProgram.deriveIngressRecordPDA(context, sequence, program);
}
