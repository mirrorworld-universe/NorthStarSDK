/**
 * Portal Program Interface
 * Provides transaction instruction structures for Portal operations
 */

import { Address, address, getProgramDerivedAddress } from '@solana/addresses';

/**
 * Portal Program ID
 * Placeholder - replace with actual deployed program ID
 */
export const PORTAL_PROGRAM_ID: Address = address(
  'Portal1111111111111111111111111111111111111'
);

/**
 * Portal instruction discriminators
 */
export enum PortalInstructionKind {
  OpenSession = 0,
  CloseSession = 1,
  DepositFee = 2,
  Delegate = 3,
  Undelegate = 4,
}

/**
 * Portal instruction types
 */
export type PortalInstruction =
  | { kind: PortalInstructionKind.OpenSession; params: OpenSessionParams }
  | { kind: PortalInstructionKind.CloseSession; params: CloseSessionParams }
  | { kind: PortalInstructionKind.DepositFee; params: DepositFeeParams }
  | { kind: PortalInstructionKind.Delegate; params: DelegateParams }
  | { kind: PortalInstructionKind.Undelegate };

/**
 * OpenSession instruction parameters
 */
export interface OpenSessionParams {
  gridId: number;
  ttlSlots: bigint;
  feeCap: bigint;
}

/**
 * CloseSession instruction parameters
 */
export interface CloseSessionParams {
  gridId: number;
}

/**
 * DepositFee instruction parameters
 */
export interface DepositFeeParams {
  lamports: bigint;
}

/**
 * Delegate instruction parameters
 */
export interface DelegateParams {
  gridId: number;
}

/**
 * Session state account
 */
export interface Session {
  discriminator: number;
  owner: Uint8Array;
  gridId: bigint;
  ttlSlots: bigint;
  feeCap: bigint;
  createdAt: bigint;
  nonce: bigint;
  bump: number;
}

/**
 * FeeVault state account
 */
export interface FeeVault {
  discriminator: number;
  authority: Uint8Array;
  bump: number;
}

/**
 * DelegationRecord state account
 */
export interface DelegationRecord {
  discriminator: number;
  ownerProgram: Uint8Array;
  gridId: bigint;
  bump: number;
}

/**
 * DepositReceipt state account
 */
export interface DepositReceipt {
  discriminator: number;
  session: Uint8Array;
  recipient: Uint8Array;
  balance: bigint;
  bump: number;
}

/**
 * Session discriminator
 */
export const SESSION_DISCRIMINATOR = 1;

/**
 * FeeVault discriminator
 */
export const FEE_VAULT_DISCRIMINATOR = 2;

/**
 * DelegationRecord discriminator
 */
export const DELEGATION_RECORD_DISCRIMINATOR = 3;

/**
 * DepositReceipt discriminator
 */
export const DEPOSIT_RECEIPT_DISCRIMINATOR = 4;

function numberToLE(num: number, bytes: number): Uint8Array {
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) {
    arr[i] = num & 0xff;
    num = num >> 8;
  }
  return arr;
}

function bigintToLE(num: bigint, bytes: number): Uint8Array {
  const arr = new Uint8Array(bytes);
  let n = num;
  for (let i = 0; i < bytes; i++) {
    arr[i] = Number(n & BigInt(0xff));
    n = n >> BigInt(8);
  }
  return arr;
}

export class PortalProgram {
  /**
   * Derive Session PDA address
   * Seeds: ["session", owner, grid_id (8 bytes LE)]
   */
  static async deriveSessionPDA(
    owner: Address,
    gridId: number,
    programId: Address = PORTAL_PROGRAM_ID
  ): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
      programAddress: programId,
      seeds: ['session', owner, numberToLE(gridId, 8)],
    });
    return pda;
  }

  /**
   * Derive FeeVault PDA address
   * Seeds: ["fee_vault", owner]
   */
  static async deriveFeeVaultPDA(
    owner: Address,
    programId: Address = PORTAL_PROGRAM_ID
  ): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
      programAddress: programId,
      seeds: ['fee_vault', owner],
    });
    return pda;
  }

  /**
   * Derive DelegationRecord PDA address
   * Seeds: ["delegation", delegated_account]
   */
  static async deriveDelegationRecordPDA(
    delegatedAccount: Address,
    programId: Address = PORTAL_PROGRAM_ID
  ): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
      programAddress: programId,
      seeds: ['delegation', delegatedAccount],
    });
    return pda;
  }

  /**
   * Derive DepositReceipt PDA address
   * Seeds: ["deposit_receipt", session, recipient]
   */
  static async deriveDepositReceiptPDA(
    session: Address,
    recipient: Address,
    programId: Address = PORTAL_PROGRAM_ID
  ): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
      programAddress: programId,
      seeds: ['deposit_receipt', session, recipient],
    });
    return pda;
  }

  /**
   * Encode OpenSession instruction data
   */
  static encodeOpenSession(params: OpenSessionParams): Uint8Array {
    const data = new Uint8Array(1 + 8 + 8 + 8); // discriminator + grid_id + ttl_slots + fee_cap
    data[0] = PortalInstructionKind.OpenSession;
    const gridIdBytes = bigintToLE(BigInt(params.gridId), 8);
    const ttlSlotsBytes = bigintToLE(params.ttlSlots, 8);
    const feeCapBytes = bigintToLE(params.feeCap, 8);
    data.set(gridIdBytes, 1);
    data.set(ttlSlotsBytes, 9);
    data.set(feeCapBytes, 17);
    return data;
  }

  /**
   * Encode CloseSession instruction data
   */
  static encodeCloseSession(params: CloseSessionParams): Uint8Array {
    const data = new Uint8Array(1 + 8); // discriminator + grid_id
    data[0] = PortalInstructionKind.CloseSession;
    const gridIdBytes = bigintToLE(BigInt(params.gridId), 8);
    data.set(gridIdBytes, 1);
    return data;
  }

  /**
   * Encode DepositFee instruction data
   */
  static encodeDepositFee(params: DepositFeeParams): Uint8Array {
    const data = new Uint8Array(1 + 8); // discriminator + lamports
    data[0] = PortalInstructionKind.DepositFee;
    const lamportsBytes = bigintToLE(params.lamports, 8);
    data.set(lamportsBytes, 1);
    return data;
  }

  /**
   * Encode Delegate instruction data
   */
  static encodeDelegate(params: DelegateParams): Uint8Array {
    const data = new Uint8Array(1 + 8); // discriminator + grid_id
    data[0] = PortalInstructionKind.Delegate;
    const gridIdBytes = bigintToLE(BigInt(params.gridId), 8);
    data.set(gridIdBytes, 1);
    return data;
  }

  /**
   * Encode Undelegate instruction data
   */
  static encodeUndelegate(): Uint8Array {
    const data = new Uint8Array(1);
    data[0] = PortalInstructionKind.Undelegate;
    return data;
  }

  /**
   * Parse Session account data
   */
  static parseSession(data: Uint8Array): Session {
    return {
      discriminator: data[0],
      owner: data.slice(1, 33),
      gridId: BigInt(new Uint8Array(data.slice(33, 41)).reduce((acc, b, i) => acc + BigInt(b) << BigInt(8 * i), BigInt(0))),
      ttlSlots: BigInt(new Uint8Array(data.slice(41, 49)).reduce((acc, b, i) => acc + BigInt(b) << BigInt(8 * i), BigInt(0))),
      feeCap: BigInt(new Uint8Array(data.slice(49, 57)).reduce((acc, b, i) => acc + BigInt(b) << BigInt(8 * i), BigInt(0))),
      createdAt: BigInt(new Uint8Array(data.slice(57, 65)).reduce((acc, b, i) => acc + BigInt(b) << BigInt(8 * i), BigInt(0))),
      nonce: BigInt(new Uint8Array(data.slice(65, 81)).reduce((acc, b, i) => acc + BigInt(b) << BigInt(8 * i), BigInt(0))),
      bump: data[81],
    };
  }

  /**
   * Parse FeeVault account data
   */
  static parseFeeVault(data: Uint8Array): FeeVault {
    return {
      discriminator: data[0],
      authority: data.slice(1, 33),
      bump: data[33],
    };
  }

  /**
   * Parse DelegationRecord account data
   */
  static parseDelegationRecord(data: Uint8Array): DelegationRecord {
    return {
      discriminator: data[0],
      ownerProgram: data.slice(1, 33),
      gridId: BigInt(new Uint8Array(data.slice(33, 41)).reduce((acc, b, i) => acc + BigInt(b) << BigInt(8 * i), BigInt(0))),
      bump: data[41],
    };
  }

  /**
   * Parse DepositReceipt account data
   */
  static parseDepositReceipt(data: Uint8Array): DepositReceipt {
    return {
      discriminator: data[0],
      session: data.slice(1, 33),
      recipient: data.slice(33, 65),
      balance: BigInt(new Uint8Array(data.slice(65, 73)).reduce((acc, b, i) => acc + BigInt(b) << BigInt(8 * i), BigInt(0))),
      bump: data[73],
    };
  }
}
