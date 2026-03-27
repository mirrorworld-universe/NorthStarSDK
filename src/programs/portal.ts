/**
 * Portal Program Interface
 * Provides transaction instruction structures for Portal operations
 */

import { deserialize, field, serialize, variant } from "@dao-xyz/borsh";
import {
  Address,
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
} from "@solana/addresses";

/**
 * Portal Program ID
 * Default program ID for Portal on local test setup
 */
const DEFAULT_PORTAL_PROGRAM_ID: Address = address(
  "5TeWSsjg2gbxCyWVniXeCmwM7UtHTCK7svzJr5xYJzHf",
);

/**
 * Get the Portal Program ID
 */
export function getPortalProgramId(): Address {
  return DEFAULT_PORTAL_PROGRAM_ID;
}

export const PORTAL_PROGRAM_ID: Address = DEFAULT_PORTAL_PROGRAM_ID;

/**
 * Portal instruction parameters
 */
export interface OpenSessionParams {
  gridId: number | bigint;
  ttlSlots: bigint;
  feeCap: bigint;
}

/**
 * CloseSession instruction parameters
 */
export interface CloseSessionParams {
  gridId: number | bigint;
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
class CloseSessionInstruction {
  @field({ type: "u64" })
  gridId!: bigint;

  constructor(params: CloseSessionParams) {
    this.gridId = BigInt(params.gridId);
  }
}

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
class UndelegateInstruction {}

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
  nonce: Uint8Array;
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

export class PortalProgram {
  /**
   * Portal Program ID
   */
  static get PROGRAM_ID(): Address {
    return DEFAULT_PORTAL_PROGRAM_ID;
  }

  /**
   * Derive Session PDA address
   * Seeds: ["session", owner, grid_id (8 bytes LE)]
   */
  static async deriveSessionPDA(
    owner: Address,
    gridId: number,
    programId: Address = PORTAL_PROGRAM_ID,
  ): Promise<Address> {
    const addressEncoder = getAddressEncoder();
    const gridIdBytes = new Uint8Array(8);
    for (let i = 0; i < 8; i++) {
      gridIdBytes[i] = (gridId >> (8 * i)) & 0xff;
    }
    const [pda] = await getProgramDerivedAddress({
      programAddress: programId,
      seeds: ["session", addressEncoder.encode(owner), gridIdBytes],
    });
    return pda;
  }

  /**
   * Derive FeeVault PDA address
   * Seeds: ["fee_vault", owner]
   */
  static async deriveFeeVaultPDA(
    owner: Address,
    programId: Address = PORTAL_PROGRAM_ID,
  ): Promise<Address> {
    const addressEncoder = getAddressEncoder();
    const [pda] = await getProgramDerivedAddress({
      programAddress: programId,
      seeds: ["fee_vault", addressEncoder.encode(owner)],
    });
    return pda;
  }

  /**
   * Derive DelegationRecord PDA address
   * Seeds: ["delegation", delegated_account]
   */
  static async deriveDelegationRecordPDA(
    delegatedAccount: Address,
    programId: Address = PORTAL_PROGRAM_ID,
  ): Promise<Address> {
    const addressEncoder = getAddressEncoder();
    const [pda] = await getProgramDerivedAddress({
      programAddress: programId,
      seeds: ["delegation", addressEncoder.encode(delegatedAccount)],
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
    programId: Address = PORTAL_PROGRAM_ID,
  ): Promise<Address> {
    const addressEncoder = getAddressEncoder();
    const [pda] = await getProgramDerivedAddress({
      programAddress: programId,
      seeds: [
        "deposit_receipt",
        addressEncoder.encode(session),
        addressEncoder.encode(recipient),
      ],
    });
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
  static encodeCloseSession(params: CloseSessionParams): Uint8Array {
    return serialize(new CloseSessionInstruction(params));
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
    return {
      discriminator: data[0],
      owner: data.slice(1, 33),
      gridId: BigInt(
        new Uint8Array(data.slice(33, 41)).reduce(
          (acc, b, i) => (acc + BigInt(b)) << BigInt(8 * i),
          BigInt(0),
        ),
      ),
      ttlSlots: BigInt(
        new Uint8Array(data.slice(41, 49)).reduce(
          (acc, b, i) => (acc + BigInt(b)) << BigInt(8 * i),
          BigInt(0),
        ),
      ),
      feeCap: BigInt(
        new Uint8Array(data.slice(49, 57)).reduce(
          (acc, b, i) => (acc + BigInt(b)) << BigInt(8 * i),
          BigInt(0),
        ),
      ),
      createdAt: BigInt(
        new Uint8Array(data.slice(57, 65)).reduce(
          (acc, b, i) => (acc + BigInt(b)) << BigInt(8 * i),
          BigInt(0),
        ),
      ),
      nonce: data.slice(65, 81),
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
      gridId: BigInt(
        new Uint8Array(data.slice(33, 41)).reduce(
          (acc, b, i) => (acc + BigInt(b)) << BigInt(8 * i),
          BigInt(0),
        ),
      ),
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
      balance: BigInt(
        new Uint8Array(data.slice(65, 73)).reduce(
          (acc, b, i) => (acc + BigInt(b)) << BigInt(8 * i),
          BigInt(0),
        ),
      ),
      bump: data[73],
    };
  }
}
