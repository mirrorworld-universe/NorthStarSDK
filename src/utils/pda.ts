/**
 * PDA Derivation Utilities for Portal Program
 * Uses Anza Kit's getProgramDerivedAddress
 */

import { Address, getProgramDerivedAddress } from "@solana/addresses";
import { toU64LE } from "./common";

/**
 * Derive SessionPDA address using Kit's PDA derivation
 * Seeds: ["session", owner, grid_id (8 bytes LE)]
 */
export async function deriveSessionPDA(
  owner: Address,
  gridId: number,
  portalProgramId: Address,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: portalProgramId,
    seeds: ["session", owner, toU64LE(gridId)],
  });
  return pda;
}

/**
 * Derive FeeVaultPDA address using Kit's PDA derivation
 * Seeds: ["fee_vault", owner]
 */
export async function deriveFeeVaultPDA(
  owner: Address,
  portalProgramId: Address,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: portalProgramId,
    seeds: ["fee_vault", owner],
  });
  return pda;
}

/**
 * Derive DelegationRecordPDA address using Kit's PDA derivation
 * Seeds: ["delegation", delegated_account]
 */
export async function deriveDelegationRecordPDA(
  delegatedAccount: Address,
  portalProgramId: Address,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: portalProgramId,
    seeds: ["delegation", delegatedAccount],
  });
  return pda;
}

/**
 * Derive DepositReceiptPDA address using Kit's PDA derivation
 * Seeds: ["deposit_receipt", session, recipient]
 */
export async function deriveDepositReceiptPDA(
  session: Address,
  recipient: Address,
  portalProgramId: Address,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: portalProgramId,
    seeds: ["deposit_receipt", session, recipient],
  });
  return pda;
}
