import { PublicKey } from "@solana/web3.js";
import { readU64LE, readU128LE } from "../utils/common";
import { checkedHash, concatBytes, Hash32, sessionCommitment, uintLE } from "./continuity";

export interface OpenSessionParams {
  gridId: number | bigint;
  ttlSlots: number | bigint;
  feeCap: number | bigint;
  validator: PublicKey;
  settlementIntervalSlots?: number | bigint;
  l1Genesis: Hash32;
  profile: Hash32;
}
export interface DepositFeeParams { lamports: bigint; }
export interface StartWithdrawalParams { lamports: bigint; }
export interface DelegateParams { gridId: number | bigint; }
export interface RegisterSessionBridgeParams {
  mint: PublicKey;
  bridgeProgram: PublicKey;
  vault: PublicKey;
  tokenProgram: PublicKey;
}

interface SessionBase {
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
export interface Session extends SessionBase {
  l1Genesis: Hash32;
  profile: Hash32;
  ingressCount: bigint;
  ingressRoot: Hash32;
  consumedIngressCount: bigint;
  consumedIngressRoot: Hash32;
}
export interface FeeVault { discriminator: Uint8Array; authority: Uint8Array; bump: number; }
export interface DelegationRecord { discriminator: Uint8Array; ownerProgram: Uint8Array; gridId: bigint; bump: number; }
export interface UndelegationRequest {
  discriminator: Uint8Array;
  session: PublicKey;
  delegatedAccount: PublicKey;
  ownerProgram: PublicKey;
  authority: PublicKey;
  requestedAtL1Slot: bigint;
  approved: boolean;
  bump: number;
}
export interface DepositReceipt {
  discriminator: Uint8Array;
  session: Uint8Array;
  recipient: Uint8Array;
  balance: bigint;
  withdrawn: bigint;
  bump: number;
  sessionContext: Hash32;
  totalDeposited: bigint;
}
export interface SessionBridge {
  discriminator: Uint8Array;
  session: PublicKey;
  mint: PublicKey;
  bridgeProgram: PublicKey;
  vault: PublicKey;
  tokenProgram: PublicKey;
  bump: number;
  sessionContext: Hash32;
}

const BASE_SESSION_DISCRIMINATOR = Uint8Array.from([243, 81, 72, 115, 214, 188, 72, 144]);
const BASE_RECEIPT_DISCRIMINATOR = Uint8Array.from([64, 175, 24, 183, 138, 109, 70, 78]);
const BASE_BRIDGE_DISCRIMINATOR = Uint8Array.from([145, 47, 8, 254, 118, 119, 114, 215]);
export const SESSION_DISCRIMINATOR = Uint8Array.from(Buffer.from("NSSESS02"));
export const DEPOSIT_RECEIPT_DISCRIMINATOR = Uint8Array.from(Buffer.from("NSRECP02"));
export const SESSION_BRIDGE_DISCRIMINATOR = Uint8Array.from(Buffer.from("NSBRDG02"));
export const FEE_VAULT_DISCRIMINATOR = Uint8Array.from([192, 178, 69, 232, 58, 149, 157, 132]);
export const DELEGATION_RECORD_DISCRIMINATOR = Uint8Array.from([203, 185, 161, 226, 129, 251, 132, 155]);
export const UNDELEGATION_REQUEST_DISCRIMINATOR = Uint8Array.from([141, 66, 225, 119, 110, 101, 37, 38]);
export const SESSION_LEN = 378;
export const DEPOSIT_RECEIPT_LEN = 137;
export const SESSION_BRIDGE_LEN = 209;
export const UNDELEGATION_REQUEST_LEN = 146;
export const WITHDRAWAL_SINK = new PublicKey("NS19999999999999999999999999999999999999999");

function exact(data: Uint8Array, length: number, discriminator: Uint8Array, name: string): void {
  if (!(data instanceof Uint8Array) || data.length !== length) throw new Error(`Invalid ${name} data length`);
  if (!discriminator.every((byte, index) => data[index] === byte)) throw new Error(`Invalid ${name} discriminator`);
}
function zero(data: Uint8Array): boolean { return data.every(byte => byte === 0); }
function unsupported(operation: string): never {
  throw new Error(`${operation} has no continuity lifecycle binding; no legacy instruction is emitted`);
}
function sessionBase(data: Uint8Array): SessionBase {
  exact(data, 226, BASE_SESSION_DISCRIMINATOR, "embedded session");
  if (data[144] > 1) throw new Error("Invalid session settlement status");
  return {
    discriminator: Uint8Array.from(data.subarray(0, 8)), gridId: readU64LE(data, 8), ttlSlots: readU64LE(data, 16),
    feeCap: readU64LE(data, 24), createdAt: readU64LE(data, 32), nonce: readU128LE(data, 40),
    authority: new PublicKey(data.subarray(56, 88)), validator: new PublicKey(data.subarray(88, 120)),
    settlementIntervalSlots: readU64LE(data, 120), lastSettledL1Slot: readU64LE(data, 128), lastSettledErSlot: readU64LE(data, 136),
    settlementStatus: data[144], settlementErSlot: readU64LE(data, 145), settlementChecksum: Uint8Array.from(data.subarray(153, 185)),
    settlementAccumulator: Uint8Array.from(data.subarray(185, 217)), settlementStartedL1Slot: readU64LE(data, 217), bump: data[225],
  };
}

export class PortalProgram {
  constructor(private readonly defaultProgramId: PublicKey) { }
  getProgramId(): PublicKey { return this.defaultProgramId; }
  async deriveSessionPDA(): Promise<PublicKey> { return PortalProgram.deriveSessionPDA(this.defaultProgramId); }
  async deriveSessionEpochPDA(): Promise<PublicKey> { return PortalProgram.deriveSessionEpochPDA(this.defaultProgramId); }
  async deriveFeeVaultPDA(): Promise<PublicKey> { return PortalProgram.deriveFeeVaultPDA(this.defaultProgramId); }
  async deriveCheckpointCursorPDA(session: PublicKey): Promise<PublicKey> { return PortalProgram.deriveCheckpointCursorPDA(session, this.defaultProgramId); }
  async deriveDelegationRecordPDA(account: PublicKey): Promise<PublicKey> { return PortalProgram.deriveDelegationRecordPDA(account, this.defaultProgramId); }
  async deriveUndelegationRequestPDA(account: PublicKey): Promise<PublicKey> { return PortalProgram.deriveUndelegationRequestPDA(account, this.defaultProgramId); }
  async deriveDepositReceiptPDA(context: Hash32, recipient: PublicKey): Promise<PublicKey> { return PortalProgram.deriveDepositReceiptPDA(context, recipient, this.defaultProgramId); }
  async deriveSessionBridgePDA(context: Hash32, mint: PublicKey): Promise<PublicKey> { return PortalProgram.deriveSessionBridgePDA(context, mint, this.defaultProgramId); }
  async deriveIngressRecordPDA(context: Hash32, sequence: bigint): Promise<PublicKey> { return PortalProgram.deriveIngressRecordPDA(context, sequence, this.defaultProgramId); }
  sessionContext(session: PublicKey, state: Session): Hash32 { return PortalProgram.sessionContext(session, state, this.defaultProgramId); }
  withdrawalSink(): PublicKey { return WITHDRAWAL_SINK; }
  encodeOpenSession(params: OpenSessionParams): Uint8Array { return PortalProgram.encodeOpenSession(params); }
  encodeCloseSession(): Uint8Array { return PortalProgram.encodeCloseSession(); }
  encodeDepositFee(params: DepositFeeParams): Uint8Array { return PortalProgram.encodeDepositFee(params); }
  encodeStartWithdrawal(params: StartWithdrawalParams): Uint8Array { return PortalProgram.encodeStartWithdrawal(params); }
  encodeDelegate(params: DelegateParams): Uint8Array { return PortalProgram.encodeDelegate(params); }
  encodeUndelegate(): Uint8Array { return PortalProgram.encodeUndelegate(); }
  encodeRequestUndelegation(): Uint8Array { return PortalProgram.encodeRequestUndelegation(); }
  encodeRegisterSessionBridge(params: RegisterSessionBridgeParams): Uint8Array { return PortalProgram.encodeRegisterSessionBridge(params); }
  parseSession(data: Uint8Array): Session { return PortalProgram.parseSession(data); }
  parseFeeVault(data: Uint8Array): FeeVault { return PortalProgram.parseFeeVault(data); }
  parseDelegationRecord(data: Uint8Array): DelegationRecord { return PortalProgram.parseDelegationRecord(data); }
  parseUndelegationRequest(data: Uint8Array): UndelegationRequest { return PortalProgram.parseUndelegationRequest(data); }
  parseDepositReceipt(data: Uint8Array): DepositReceipt { return PortalProgram.parseDepositReceipt(data); }
  parseSessionBridge(data: Uint8Array): SessionBridge { return PortalProgram.parseSessionBridge(data); }

  static async deriveSessionPDA(program: PublicKey): Promise<PublicKey> {
    return PublicKey.findProgramAddressSync([Buffer.from("session")], program)[0];
  }
  static async deriveSessionEpochPDA(program: PublicKey): Promise<PublicKey> {
    return PublicKey.findProgramAddressSync([Buffer.from("session_epoch_v2")], program)[0];
  }
  static async deriveFeeVaultPDA(program: PublicKey): Promise<PublicKey> {
    return PublicKey.findProgramAddressSync([Buffer.from("fee_vault")], program)[0];
  }
  static async deriveCheckpointCursorPDA(session: PublicKey, program: PublicKey): Promise<PublicKey> {
    return PublicKey.findProgramAddressSync([Buffer.from("checkpoint_cursor"), session.toBuffer()], program)[0];
  }
  static async deriveDelegationRecordPDA(account: PublicKey, program: PublicKey): Promise<PublicKey> {
    return PublicKey.findProgramAddressSync([Buffer.from("delegation"), account.toBuffer()], program)[0];
  }
  static async deriveUndelegationRequestPDA(account: PublicKey, program: PublicKey): Promise<PublicKey> {
    void account; void program; return unsupported("Undelegation");
  }
  static async deriveDepositReceiptPDA(context: Hash32, recipient: PublicKey, program: PublicKey): Promise<PublicKey> {
    return PublicKey.findProgramAddressSync([Buffer.from("deposit_receipt_v2"), checkedHash(context, "session context"), recipient.toBytes()], program)[0];
  }
  static async deriveSessionBridgePDA(context: Hash32, mint: PublicKey, program: PublicKey): Promise<PublicKey> {
    return PublicKey.findProgramAddressSync([Buffer.from("session_bridge_v2"), checkedHash(context, "session context"), mint.toBytes()], program)[0];
  }
  static async deriveIngressRecordPDA(context: Hash32, sequence: bigint, program: PublicKey): Promise<PublicKey> {
    if (sequence === 0n) throw new Error("Input sequence must be positive");
    return PublicKey.findProgramAddressSync([Buffer.from("ingress_v2"), checkedHash(context, "session context"), uintLE(sequence, 64, "input sequence")], program)[0];
  }
  static sessionContext(session: PublicKey, state: Session, portal: PublicKey): Hash32 {
    return sessionCommitment({
      portal, session, l1Genesis: state.l1Genesis, profile: state.profile, nonce: state.nonce,
      gridId: state.gridId, validator: state.validator
    });
  }
  static encodeOpenSession(params: OpenSessionParams): Uint8Array {
    return concatBytes(Uint8Array.of(31), uintLE(params.gridId, 64, "grid id"), uintLE(params.ttlSlots, 64, "TTL"),
      uintLE(params.feeCap, 64, "fee cap"), checkedHash(params.validator.toBytes(), "validator"),
      uintLE(params.settlementIntervalSlots ?? 10n, 64, "settlement interval"),
      checkedHash(params.l1Genesis, "L1 genesis"), checkedHash(params.profile, "checkpoint profile"));
  }
  static encodeDepositFee(params: DepositFeeParams): Uint8Array {
    if (params.lamports <= 0n) throw new RangeError("Deposit must be positive");
    return concatBytes(Uint8Array.of(33), uintLE(params.lamports, 64, "deposit"));
  }
  static encodeDelegate(params: DelegateParams): Uint8Array {
    return concatBytes(Uint8Array.of(32), uintLE(params.gridId, 64, "grid id"));
  }
  static encodeRegisterSessionBridge(params: RegisterSessionBridgeParams): Uint8Array {
    return concatBytes(Uint8Array.of(36), checkedHash(params.mint.toBytes(), "mint"),
      checkedHash(params.bridgeProgram.toBytes(), "bridge program"), checkedHash(params.vault.toBytes(), "vault"),
      checkedHash(params.tokenProgram.toBytes(), "token program"));
  }
  static encodeStartWithdrawal(params: StartWithdrawalParams): Uint8Array {
    if (params.lamports <= 0n) throw new RangeError("Withdrawal must be positive");
    return concatBytes(Uint8Array.of(13), uintLE(params.lamports, 64, "withdrawal"));
  }
  static encodeCloseSession(): Uint8Array { return unsupported("CloseSession"); }
  static encodeUndelegate(): Uint8Array { return unsupported("Undelegation"); }
  static encodeRequestUndelegation(): Uint8Array { return unsupported("Undelegation"); }

  static parseSession(data: Uint8Array): Session {
    exact(data, SESSION_LEN, SESSION_DISCRIMINATOR, "Session");
    const base = sessionBase(data.subarray(8, 234));
    if (base.nonce === 0n) throw new Error("Session nonce must be nonzero");
    checkedHash(base.validator.toBytes(), "validator");
    const state = {
      ...base, discriminator: Uint8Array.from(data.subarray(0, 8)),
      l1Genesis: checkedHash(data.subarray(234, 266), "L1 genesis"), profile: checkedHash(data.subarray(266, 298), "checkpoint profile"),
      ingressCount: readU64LE(data, 298), ingressRoot: Uint8Array.from(data.subarray(306, 338)),
      consumedIngressCount: readU64LE(data, 338), consumedIngressRoot: Uint8Array.from(data.subarray(346, 378))
    };
    if (state.consumedIngressCount > state.ingressCount || (state.ingressCount === 0n) !== zero(state.ingressRoot)
      || (state.consumedIngressCount === 0n) !== zero(state.consumedIngressRoot)) throw new Error("Invalid input prefix");
    return state;
  }
  static parseFeeVault(data: Uint8Array): FeeVault {
    exact(data, 41, FEE_VAULT_DISCRIMINATOR, "FeeVault");
    return { discriminator: Uint8Array.from(data.subarray(0, 8)), authority: Uint8Array.from(data.subarray(8, 40)), bump: data[40] };
  }
  static parseDelegationRecord(data: Uint8Array): DelegationRecord {
    exact(data, 49, DELEGATION_RECORD_DISCRIMINATOR, "DelegationRecord");
    return { discriminator: Uint8Array.from(data.subarray(0, 8)), ownerProgram: Uint8Array.from(data.subarray(8, 40)), gridId: readU64LE(data, 40), bump: data[48] };
  }
  static parseUndelegationRequest(data: Uint8Array): UndelegationRequest { void data; return unsupported("Undelegation"); }
  static parseDepositReceipt(data: Uint8Array): DepositReceipt {
    exact(data, DEPOSIT_RECEIPT_LEN, DEPOSIT_RECEIPT_DISCRIMINATOR, "DepositReceipt");
    const base = data.subarray(8, 97); exact(base, 89, BASE_RECEIPT_DISCRIMINATOR, "embedded receipt");
    const state = {
      discriminator: Uint8Array.from(data.subarray(0, 8)), session: Uint8Array.from(base.subarray(8, 40)),
      recipient: Uint8Array.from(base.subarray(40, 72)), balance: readU64LE(base, 72), withdrawn: readU64LE(base, 80), bump: base[88],
      sessionContext: checkedHash(data.subarray(97, 129), "receipt context"), totalDeposited: readU64LE(data, 129)
    };
    if (state.balance + state.withdrawn > state.totalDeposited) throw new Error("Invalid receipt totals");
    return state;
  }
  static parseSessionBridge(data: Uint8Array): SessionBridge {
    exact(data, SESSION_BRIDGE_LEN, SESSION_BRIDGE_DISCRIMINATOR, "SessionBridge");
    const base = data.subarray(8, 177); exact(base, 169, BASE_BRIDGE_DISCRIMINATOR, "embedded registry");
    return {
      discriminator: Uint8Array.from(data.subarray(0, 8)), session: new PublicKey(base.subarray(8, 40)),
      mint: new PublicKey(base.subarray(40, 72)), bridgeProgram: new PublicKey(base.subarray(72, 104)),
      vault: new PublicKey(base.subarray(104, 136)), tokenProgram: new PublicKey(base.subarray(136, 168)), bump: base[168],
      sessionContext: checkedHash(data.subarray(177, 209), "registry context")
    };
  }
}
