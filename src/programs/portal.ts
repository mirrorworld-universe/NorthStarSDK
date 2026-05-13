/**
 * Portal Program Interface
 * Provides transaction instruction structures for Portal operations
 */


import { field, serialize, variant } from "@dao-xyz/borsh";
import { PublicKey } from "@solana/web3.js";
import { readU64LE, readU128LE } from "../utils/common";

/**
 * Portal instruction parameters
 */
export interface OpenSessionParams {
  gridId: number | bigint;
  ttlSlots: bigint;
  feeCap: bigint;
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
  gridId: number | bigint;
}

/**
 * Instruction variants for borsh serialization
 */

@variant(0)
class OpenSessionInstruction {
  @field({ type: "u64" })
  gridId!: bigint;

  @field({ type: "u64" })
  ttlSlots!: bigint;

  @field({ type: "u64" })
  feeCap!: bigint;

  constructor(params: OpenSessionParams) {
    this.gridId = BigInt(params.gridId);
    this.ttlSlots = params.ttlSlots;
    this.feeCap = params.feeCap;
  }
}

@variant(1)
class CloseSessionInstruction {}

@variant(2)
class DepositFeeInstruction {
  @field({ type: "u64" })
  lamports!: bigint;

  constructor(params: DepositFeeParams) {
    this.lamports = params.lamports;
  }
}

@variant(3)
class DelegateInstruction {
  @field({ type: "u64" })
  gridId!: bigint;

  constructor(params: DelegateParams) {
    this.gridId = BigInt(params.gridId);
  }
}

@variant(4)
class UndelegateInstruction { }

/**
 * Session state account
 */
export interface Session {
  discriminator: number;
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

function assertAccountDataLength(
  data: Uint8Array,
  expected: number,
  accountName: string,
) {
  if (data.length < expected) {
    throw new Error(
      `Invalid ${accountName} data length: got ${data.length}, expected >= ${expected}`,
    );
  }
}



export class PortalProgram {
  private readonly defaultProgramId: PublicKey;

  constructor(defaultProgramId: PublicKey) {
    this.defaultProgramId = defaultProgramId;
  }

  getProgramId(): PublicKey {
    return this.defaultProgramId;
  }

  async deriveSessionPDA(): Promise<PublicKey> {
    return PortalProgram.deriveSessionPDA(this.defaultProgramId);
  }

  async deriveFeeVaultPDA(): Promise<PublicKey> {
    return PortalProgram.deriveFeeVaultPDA(this.defaultProgramId);
  }

  async deriveDelegationRecordPDA(delegatedAccount: PublicKey): Promise<PublicKey> {
    return PortalProgram.deriveDelegationRecordPDA(
      delegatedAccount,
      this.defaultProgramId,
    );
  }

  async deriveDepositReceiptPDA(
    session: PublicKey,
    recipient: PublicKey,
  ): Promise<PublicKey> {
    return PortalProgram.deriveDepositReceiptPDA(
      session,
      recipient,
      this.defaultProgramId,
    );
  }

  encodeOpenSession(params: OpenSessionParams): Uint8Array {
    return PortalProgram.encodeOpenSession(params);
  }

  encodeCloseSession(): Uint8Array {
    return PortalProgram.encodeCloseSession();
  }

  encodeDepositFee(params: DepositFeeParams): Uint8Array {
    return PortalProgram.encodeDepositFee(params);
  }

  encodeDelegate(params: DelegateParams): Uint8Array {
    return PortalProgram.encodeDelegate(params);
  }

  encodeUndelegate(): Uint8Array {
    return PortalProgram.encodeUndelegate();
  }

  parseSession(data: Uint8Array): Session {
    return PortalProgram.parseSession(data);
  }

  parseFeeVault(data: Uint8Array): FeeVault {
    return PortalProgram.parseFeeVault(data);
  }

  parseDelegationRecord(data: Uint8Array): DelegationRecord {
    return PortalProgram.parseDelegationRecord(data);
  }

  parseDepositReceipt(data: Uint8Array): DepositReceipt {
    return PortalProgram.parseDepositReceipt(data);
  }

  /**
   * Derive global Session PDA address.
   * Seeds: ["session"]
   */
  static async deriveSessionPDA(
    programId: PublicKey,
  ): Promise<PublicKey> {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("session", "utf8")],
      programId,
    );
    return pda;
  }

  /**
   * Derive global FeeVault PDA address.
   * Seeds: ["fee_vault"]
   */
  static async deriveFeeVaultPDA(
    programId: PublicKey,
  ): Promise<PublicKey> {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("fee_vault", "utf8")],
      programId,
    );
    return pda;
  }

  /**
   * Derive DelegationRecord PDA address
   * Seeds: ["delegation", delegated_account]
   */
  static async deriveDelegationRecordPDA(
    delegatedAccount: PublicKey,
    programId: PublicKey,
  ): Promise<PublicKey> {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("delegation", "utf8"), delegatedAccount.toBuffer()],
      programId,
    );
    return pda;
  }

  /**
   * Derive DepositReceipt PDA address
   * Seeds: ["deposit_receipt", session, recipient]
   */
  static async deriveDepositReceiptPDA(
    session: PublicKey,
    recipient: PublicKey,
    programId: PublicKey,
  ): Promise<PublicKey> {
    const [pda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("deposit_receipt", "utf8"),
        session.toBuffer(),
        recipient.toBuffer(),
      ],
      programId,
    );
    return pda;
  }

  /**
   * Encode OpenSession instruction data (borsh serialized)
   */
  static encodeOpenSession(params: OpenSessionParams): Uint8Array {
    return serialize(new OpenSessionInstruction(params));
  }

  /**
   * Encode CloseSession instruction data (borsh serialized)
   */
  static encodeCloseSession(): Uint8Array {
    return serialize(new CloseSessionInstruction());
  }

  /**
   * Encode DepositFee instruction data (borsh serialized)
   */
  static encodeDepositFee(params: DepositFeeParams): Uint8Array {
    return serialize(new DepositFeeInstruction(params));
  }

  /**
   * Encode Delegate instruction data (borsh serialized)
   */
  static encodeDelegate(params: DelegateParams): Uint8Array {
    return serialize(new DelegateInstruction(params));
  }

  /**
   * Encode Undelegate instruction data (borsh serialized)
   */
  static encodeUndelegate(): Uint8Array {
    return serialize(new UndelegateInstruction());
  }

  /**
   * Parse Session account data
   */
  static parseSession(data: Uint8Array): Session {
    assertAccountDataLength(data, 50, "Session");
    return {
      discriminator: data[0],
      gridId: readU64LE(data, 1),
      ttlSlots: readU64LE(data, 9),
      feeCap: readU64LE(data, 17),
      createdAt: readU64LE(data, 25),
      nonce: readU128LE(data, 33),
      bump: data[49],
    };
  }

  /**
   * Parse FeeVault account data
   */
  static parseFeeVault(data: Uint8Array): FeeVault {
    assertAccountDataLength(data, 34, "FeeVault");
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
    assertAccountDataLength(data, 42, "DelegationRecord");
    return {
      discriminator: data[0],
      ownerProgram: data.slice(1, 33),
      gridId: readU64LE(data, 33),
      bump: data[41],
    };
  }

  /**
   * Parse DepositReceipt account data
   */
  static parseDepositReceipt(data: Uint8Array): DepositReceipt {
    assertAccountDataLength(data, 74, "DepositReceipt");
    return {
      discriminator: data[0],
      session: data.slice(1, 33),
      recipient: data.slice(33, 65),
      balance: readU64LE(data, 65),
      bump: data[73],
    };
  }
}
