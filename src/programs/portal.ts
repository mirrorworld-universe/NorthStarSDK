/**
 * Portal Program Interface
 * Provides transaction instruction structures for Portal operations
 */


import { field, serialize, variant } from "@dao-xyz/borsh";
import { PublicKey } from "@solana/web3.js";
import { readU64LE, readU128LE, toU64LE } from "../utils/common";

/**
 * Portal instruction parameters
 */
export interface OpenSessionParams {
  gridId: number | bigint;
  ttlSlots: number | bigint;
  feeCap: number | bigint;
  validator: PublicKey;
  settlementIntervalSlots?: number | bigint;
}

/**
 * DepositFee instruction parameters
 */
export interface DepositFeeParams {
  lamports: bigint;
}

export interface StartWithdrawalParams {
  lamports: bigint;
}

/**
 * Delegate instruction parameters
 */
export interface DelegateParams {
  gridId: number | bigint;
}

export interface RegisterSessionBridgeParams {
  mint: PublicKey;
  bridgeProgram: PublicKey;
  vault: PublicKey;
  tokenProgram: PublicKey;
}

/**
 * Instruction variants for borsh serialization
 */

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

@variant(13)
class StartWithdrawalInstruction {
  @field({ type: "u64" })
  lamports!: bigint;

  constructor(params: StartWithdrawalParams) {
    this.lamports = params.lamports;
  }
}

/**
 * Session state account
 */
export interface Session {
  discriminator: Uint8Array;
  gridId: bigint;
  ttlSlots: bigint;
  feeCap: bigint;
  createdAt: bigint;
  nonce: bigint;
  authority: PublicKey;
  validator: PublicKey;
  settlementIntervalSlots: bigint;
  lastSettledL1Slot: bigint;
  lastSettledErSlot: bigint;
  settlementStatus: number;
  settlementErSlot: bigint;
  settlementChecksum: Uint8Array;
  settlementAccumulator: Uint8Array;
  settlementStartedL1Slot: bigint;
  bump: number;
}

/**
 * FeeVault state account
 */
export interface FeeVault {
  discriminator: Uint8Array;
  authority: Uint8Array;
  bump: number;
}

/**
 * DelegationRecord state account
 */
export interface DelegationRecord {
  discriminator: Uint8Array;
  ownerProgram: Uint8Array;
  gridId: bigint;
  bump: number;
}

/**
 * DepositReceipt state account
 */
export interface DepositReceipt {
  discriminator: Uint8Array;
  session: Uint8Array;
  recipient: Uint8Array;
  balance: bigint;
  withdrawn: bigint;
  bump: number;
}

export interface SessionBridge {
  discriminator: Uint8Array;
  session: PublicKey;
  mint: PublicKey;
  bridgeProgram: PublicKey;
  vault: PublicKey;
  tokenProgram: PublicKey;
  bump: number;
}

export const SESSION_DISCRIMINATOR = Uint8Array.from([
  243, 81, 72, 115, 214, 188, 72, 144,
]);
export const FEE_VAULT_DISCRIMINATOR = Uint8Array.from([
  192, 178, 69, 232, 58, 149, 157, 132,
]);
export const DELEGATION_RECORD_DISCRIMINATOR = Uint8Array.from([
  203, 185, 161, 226, 129, 251, 132, 155,
]);
export const DEPOSIT_RECEIPT_DISCRIMINATOR = Uint8Array.from([
  64, 175, 24, 183, 138, 109, 70, 78,
]);
export const SESSION_BRIDGE_DISCRIMINATOR = Uint8Array.from([
  145, 47, 8, 254, 118, 119, 114, 215,
]);

export const SESSION_LEN = 226;
export const DEPOSIT_RECEIPT_LEN = 89;
export const SESSION_BRIDGE_LEN = 169;
export const WITHDRAWAL_SINK = new PublicKey(
  "NS19999999999999999999999999999999999999999",
);

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

function assertAccountDiscriminator(
  data: Uint8Array,
  expected: Uint8Array,
  accountName: string,
) {
  if (
    !data
      .slice(0, expected.length)
      .every((byte, index) => byte === expected[index])
  ) {
    throw new Error(`Invalid ${accountName} discriminator`);
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

  async deriveCheckpointCursorPDA(session: PublicKey): Promise<PublicKey> {
    return PortalProgram.deriveCheckpointCursorPDA(
      session,
      this.defaultProgramId,
    );
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

  withdrawalSink(): PublicKey {
    return WITHDRAWAL_SINK;
  }

  async deriveSessionBridgePDA(
    session: PublicKey,
    mint: PublicKey,
  ): Promise<PublicKey> {
    return PortalProgram.deriveSessionBridgePDA(
      session,
      mint,
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

  encodeStartWithdrawal(params: StartWithdrawalParams): Uint8Array {
    return PortalProgram.encodeStartWithdrawal(params);
  }

  encodeDelegate(params: DelegateParams): Uint8Array {
    return PortalProgram.encodeDelegate(params);
  }

  encodeUndelegate(): Uint8Array {
    return PortalProgram.encodeUndelegate();
  }

  encodeRegisterSessionBridge(params: RegisterSessionBridgeParams): Uint8Array {
    return PortalProgram.encodeRegisterSessionBridge(params);
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

  parseSessionBridge(data: Uint8Array): SessionBridge {
    return PortalProgram.parseSessionBridge(data);
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
   * Derive CheckpointCursor PDA address.
   * Seeds: ["checkpoint_cursor", session]
   */
  static async deriveCheckpointCursorPDA(
    session: PublicKey,
    programId: PublicKey,
  ): Promise<PublicKey> {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("checkpoint_cursor", "utf8"), session.toBuffer()],
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
   * Derive SessionBridge discovery PDA.
   * Seeds: ["session_bridge", session, mint]
   */
  static async deriveSessionBridgePDA(
    session: PublicKey,
    mint: PublicKey,
    programId: PublicKey,
  ): Promise<PublicKey> {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("session_bridge", "utf8"), session.toBuffer(), mint.toBuffer()],
      programId,
    );
    return pda;
  }

  /**
   * Encode OpenSession instruction data (borsh serialized)
   */
  static encodeOpenSession(params: OpenSessionParams): Uint8Array {
    const data = new Uint8Array(1 + 8 + 8 + 8 + 32 + 8);
    data[0] = 0;
    data.set(toU64LE(params.gridId), 1);
    data.set(toU64LE(params.ttlSlots), 9);
    data.set(toU64LE(params.feeCap), 17);
    data.set(params.validator.toBytes(), 25);
    data.set(toU64LE(params.settlementIntervalSlots ?? 10n), 57);
    return data;
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

  static encodeStartWithdrawal(params: StartWithdrawalParams): Uint8Array {
    return serialize(new StartWithdrawalInstruction(params));
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

  static encodeRegisterSessionBridge(
    params: RegisterSessionBridgeParams,
  ): Uint8Array {
    const data = new Uint8Array(1 + 32 * 4);
    data[0] = 22;
    data.set(params.mint.toBytes(), 1);
    data.set(params.bridgeProgram.toBytes(), 33);
    data.set(params.vault.toBytes(), 65);
    data.set(params.tokenProgram.toBytes(), 97);
    return data;
  }

  /**
   * Parse Session account data
   */
  static parseSession(data: Uint8Array): Session {
    assertAccountDataLength(data, SESSION_LEN, "Session");
    assertAccountDiscriminator(data, SESSION_DISCRIMINATOR, "Session");
    return {
      discriminator: data.slice(0, 8),
      gridId: readU64LE(data, 8),
      ttlSlots: readU64LE(data, 16),
      feeCap: readU64LE(data, 24),
      createdAt: readU64LE(data, 32),
      nonce: readU128LE(data, 40),
      authority: new PublicKey(data.slice(56, 88)),
      validator: new PublicKey(data.slice(88, 120)),
      settlementIntervalSlots: readU64LE(data, 120),
      lastSettledL1Slot: readU64LE(data, 128),
      lastSettledErSlot: readU64LE(data, 136),
      settlementStatus: data[144],
      settlementErSlot: readU64LE(data, 145),
      settlementChecksum: data.slice(153, 185),
      settlementAccumulator: data.slice(185, 217),
      settlementStartedL1Slot: readU64LE(data, 217),
      bump: data[225],
    };
  }

  /**
   * Parse FeeVault account data
   */
  static parseFeeVault(data: Uint8Array): FeeVault {
    assertAccountDataLength(data, 41, "FeeVault");
    assertAccountDiscriminator(data, FEE_VAULT_DISCRIMINATOR, "FeeVault");
    return {
      discriminator: data.slice(0, 8),
      authority: data.slice(8, 40),
      bump: data[40],
    };
  }

  /**
   * Parse DelegationRecord account data
   */
  static parseDelegationRecord(data: Uint8Array): DelegationRecord {
    assertAccountDataLength(data, 49, "DelegationRecord");
    assertAccountDiscriminator(
      data,
      DELEGATION_RECORD_DISCRIMINATOR,
      "DelegationRecord",
    );
    return {
      discriminator: data.slice(0, 8),
      ownerProgram: data.slice(8, 40),
      gridId: readU64LE(data, 40),
      bump: data[48],
    };
  }

  /**
   * Parse DepositReceipt account data
   */
  static parseDepositReceipt(data: Uint8Array): DepositReceipt {
    assertAccountDataLength(data, DEPOSIT_RECEIPT_LEN, "DepositReceipt");
    assertAccountDiscriminator(
      data,
      DEPOSIT_RECEIPT_DISCRIMINATOR,
      "DepositReceipt",
    );
    return {
      discriminator: data.slice(0, 8),
      session: data.slice(8, 40),
      recipient: data.slice(40, 72),
      balance: readU64LE(data, 72),
      withdrawn: readU64LE(data, 80),
      bump: data[88],
    };
  }

  static parseSessionBridge(data: Uint8Array): SessionBridge {
    assertAccountDataLength(data, SESSION_BRIDGE_LEN, "SessionBridge");
    assertAccountDiscriminator(
      data,
      SESSION_BRIDGE_DISCRIMINATOR,
      "SessionBridge",
    );
    return {
      discriminator: data.slice(0, 8),
      session: new PublicKey(data.slice(8, 40)),
      mint: new PublicKey(data.slice(40, 72)),
      bridgeProgram: new PublicKey(data.slice(72, 104)),
      vault: new PublicKey(data.slice(104, 136)),
      tokenProgram: new PublicKey(data.slice(136, 168)),
      bump: data[168],
    };
  }
}
