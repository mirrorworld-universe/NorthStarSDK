import {
  Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, SystemProgram,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { AccountInfo, Address, NorthStarConfig, NorthStarSyncStatus } from "./types";
import { EphemeralRollupReader } from "./readers/EphemeralRollupReader";
import { AccountResolver } from "./readers/AccountResolver";
import { checkedHash, checkedInteger, Hash32 } from "./programs/continuity";
import { PortalProgram, WITHDRAWAL_SINK } from "./programs/portal";
import { TokenBridgeProgram } from "./programs/tokenBridge";
import { sameBytes, SessionManager, SessionSnapshot } from "./session/SessionManager";
import { ErTransactionOptions, submitErTransaction } from "./solana/erTransaction";
import {
  getVersionedTxSignatureBase58, sendRawVersionedTransaction,
  signVersionedTransaction, toPublicKey,
} from "./solana/kitCompat";

export { getVersionedTxSignatureBase58, signVersionedTransaction, toPublicKey } from "./solana/kitCompat";
export { TOKEN_BRIDGE_PROGRAM_ID, TokenBridgeProgram } from "./programs/tokenBridge";
export { PortalProgram, SESSION_DISCRIMINATOR, SESSION_LEN } from "./programs/portal";
export type { Session, DepositReceipt, SessionBridge } from "./programs/portal";
export { sessionCommitment } from "./programs/continuity";
export { calculateErVrfDeadlineSlots } from "./solana/erVrfDeadline";
export type { ErVrfDeadlineBudget, VrfDeadlineLimits } from "./solana/erVrfDeadline";
export type { ErTransactionOptions } from "./solana/erTransaction";
export type { Hash32, SessionIdentity } from "./programs/continuity";
export type { SessionSnapshot } from "./session/SessionManager";
export * from "./types";
export { Connection, Keypair, PublicKey, TransactionInstruction, VersionedTransaction, SystemProgram } from "@solana/web3.js";

export type TransactionSigner = Keypair;
export interface TransactionResult { signature: string; slot?: bigint; }
export interface TransactionOptions {
  commitment?: "processed" | "confirmed" | "finalized";
  skipPreflight?: boolean;
  maxAttempts?: number;
  intervalMs?: number;
}
export interface DelegateAccount { delegatedAccountSigner: Keypair; ownerProgramId: PublicKey; }
export interface DelegateSigners { delegations: DelegateAccount[]; feePayerSigner?: Keypair; }
export interface SessionSigners { feePayerSigner?: Keypair; }
export interface DepositFeeSigners { depositorSigner?: Keypair; feePayerSigner?: Keypair; }
export interface OpenSessionConfig { validator?: PublicKey; settlementIntervalSlots?: number | bigint; }
export type WalletSignTransaction = (transaction: VersionedTransaction) => Promise<VersionedTransaction>;
export interface ErSolWithdrawalParams { erSource: PublicKey; l1Recipient: PublicKey; lamports: number | bigint; }
export interface TokenIngressContext { session: PublicKey; sessionContext: Hash32; sequence: bigint; }
export interface TransactionPlan {
  instructions: TransactionInstruction[];
  feePayer: PublicKey;
  blockhash: string;
  lastValidBlockHeight: bigint;
}

function unavailable(operation: string): never {
  throw new Error(`${operation} has no continuity lifecycle binding; no transaction is signed`);
}

export function encodeSystemProgramAssignData(newProgramOwner: PublicKey): Uint8Array {
  const data = new Uint8Array(36);
  new DataView(data.buffer).setUint32(0, 1, true);
  data.set(newProgramOwner.toBytes(), 4);
  return data;
}

export class NorthStarSDK {
  private readonly rpc: Connection;
  private readonly ephemeral_rpc: Connection;
  private readonly ephemeralRollupReader: EphemeralRollupReader;
  private readonly config: NorthStarConfig;
  private readonly portalProgramId: PublicKey;
  public readonly accountResolver: AccountResolver;
  public readonly portal: PortalProgram;
  public readonly tokenBridge: TokenBridgeProgram;

  constructor(config: NorthStarConfig) {
    checkedHash(bs58.decode(config.l1GenesisHash), "L1 genesis");
    this.config = {
      ...config,
      checkpointProfile: checkedHash(config.checkpointProfile, "checkpoint profile"),
      customEndpoints: { ...config.customEndpoints },
    };
    this.portalProgramId = toPublicKey(config.portalProgramId);
    checkedHash(this.portalProgramId.toBytes(), "Portal program");
    const bridge = toPublicKey(config.tokenBridgeProgramId);
    checkedHash(bridge.toBytes(), "token bridge program");
    this.portal = new PortalProgram(this.portalProgramId);
    this.tokenBridge = new TokenBridgeProgram(bridge);
    this.rpc = new Connection(config.customEndpoints.solana, "confirmed");
    this.ephemeral_rpc = new Connection(config.customEndpoints.ephemeralRollup, {
      commitment: "confirmed", disableRetryOnRateLimit: true,
    });
    this.ephemeralRollupReader = new EphemeralRollupReader(config.customEndpoints.ephemeralRollup);
    this.accountResolver = new AccountResolver(this.ephemeralRollupReader, this.rpc);
  }

  private sessionManager(): SessionManager {
    return new SessionManager(this.rpc, this.portal, this.config.l1GenesisHash, this.config.checkpointProfile);
  }

  async getSessionSnapshot(): Promise<SessionSnapshot> {
    return this.sessionManager().getSession();
  }

  async getExecutionSession(): Promise<SessionSnapshot> {
    const snapshot = await this.getSessionSnapshot();
    await this.assertErSession(snapshot);
    return snapshot;
  }

  private async assertErSession(snapshot: SessionSnapshot): Promise<void> {
    const status = await this.ephemeralRollupReader.getSyncStatus();
    if (status.isSyncing || status.latestSyncedSlot < status.latestL1Slot || status.checkpointError != null) {
      throw new Error("ER runtime is syncing or has a checkpoint error");
    }
    const address = await this.ephemeralRollupReader.getSessionPda();
    if (!address?.equals(snapshot.address)) throw new Error("ER session differs from L1");
    const account = await this.ephemeral_rpc.getAccountInfo(snapshot.address, "confirmed");
    if (!account || account.executable || !account.owner.equals(this.portalProgramId)) {
      throw new Error("ER session account is missing or has the wrong owner");
    }
    const state = this.portal.parseSession(account.data);
    if (!sameBytes(this.portal.sessionContext(snapshot.address, state), snapshot.context)) {
      throw new Error("ER session incarnation differs from L1");
    }
  }

  async generateKeyPair(): Promise<Keypair> { return Keypair.generate(); }
  async createKeyPairFromBase58(value: string): Promise<Keypair> {
    const bytes = bs58.decode(value.trim());
    if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
    if (bytes.length === 32) return Keypair.fromSeed(bytes);
    throw new Error(`Private key decodes to ${bytes.length} bytes; expected 32 or 64`);
  }
  async getAccountInfo(address: PublicKey, source: "ephemeral" | "solana"): Promise<AccountInfo> {
    return this.accountResolver.resolve(address, source);
  }
  async getMultipleAccounts(addresses: PublicKey[], source: "ephemeral" | "solana"): Promise<AccountInfo[]> {
    return this.accountResolver.resolveMultiple(addresses, source);
  }
  getRpc(): Connection { return this.rpc; }
  getEphemeralRpc(): Connection { return this.ephemeral_rpc; }
  getPortalProgramId(): PublicKey { return this.portalProgramId; }
  async getEphemeralRollupSyncStatus(): Promise<NorthStarSyncStatus> {
    return this.ephemeralRollupReader.getSyncStatus();
  }

  private async openInstruction(
    user: PublicKey, gridId: number | bigint, ttlSlots: number | bigint,
    feeCap: number | bigint, options: OpenSessionConfig,
  ): Promise<TransactionInstruction> {
    await this.sessionManager().verifyNetwork();
    return new TransactionInstruction({
      programId: this.portalProgramId,
      keys: [
        { pubkey: user, isSigner: true, isWritable: true },
        { pubkey: await this.portal.deriveSessionPDA(), isSigner: false, isWritable: true },
        { pubkey: await this.portal.deriveFeeVaultPDA(), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: await this.portal.deriveSessionEpochPDA(), isSigner: false, isWritable: true },
      ],
      data: Buffer.from(this.portal.encodeOpenSession({
        gridId, ttlSlots, feeCap, validator: options.validator ?? user,
        settlementIntervalSlots: options.settlementIntervalSlots,
        l1Genesis: bs58.decode(this.config.l1GenesisHash), profile: this.config.checkpointProfile,
      })),
    });
  }

  private async depositInstruction(user: PublicKey, amount: number | bigint, recipient: PublicKey): Promise<TransactionInstruction> {
    const snapshot = await this.getSessionSnapshot();
    return new TransactionInstruction({
      programId: this.portalProgramId,
      keys: [
        { pubkey: user, isSigner: true, isWritable: true },
        { pubkey: snapshot.address, isSigner: false, isWritable: true },
        { pubkey: await this.portal.deriveDepositReceiptPDA(snapshot.context, recipient), isSigner: false, isWritable: true },
        { pubkey: recipient, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: await this.portal.deriveIngressRecordPDA(snapshot.context, snapshot.nextSequence), isSigner: false, isWritable: true },
      ],
      data: Buffer.from(this.portal.encodeDepositFee({ lamports: checkedInteger(amount, 64, "deposit") })),
    });
  }

  private async plan(feePayer: PublicKey, instructions: TransactionInstruction[]): Promise<TransactionPlan> {
    const latest = await this.rpc.getLatestBlockhash();
    return {
      feePayer, instructions, blockhash: latest.blockhash,
      lastValidBlockHeight: checkedInteger(latest.lastValidBlockHeight, 64, "block height")
    };
  }

  async buildOpenSession(
    signer: Keypair, gridId: number | bigint, ttlSlots: number | bigint = 2000,
    feeCap: number | bigint = 1_000_000, options: OpenSessionConfig = {},
  ): Promise<TransactionPlan> {
    return this.plan(signer.publicKey, [await this.openInstruction(signer.publicKey, gridId, ttlSlots, feeCap, options)]);
  }

  async buildDepositFee(signer: Keypair, amount: number | bigint, recipient = signer.publicKey): Promise<TransactionPlan> {
    return this.plan(signer.publicKey, [await this.depositInstruction(signer.publicKey, amount, recipient)]);
  }

  private async walletDelegations(user: PublicKey, grid: number | bigint, delegations: DelegateAccount[]): Promise<{
    instructions: TransactionInstruction[]; buffers: Keypair[];
  }> {
    if (delegations.length === 0) throw new Error("Delegation requires at least one account");
    if (delegations.length > 2) throw new Error("Wallet delegation accepts at most two accounts per transaction");
    const snapshot = await this.getSessionSnapshot();
    const gridId = checkedInteger(grid, 64, "grid id");
    if (gridId !== snapshot.state.gridId) throw new Error("Delegation grid differs from the session");
    const addresses = delegations.map(value => value.delegatedAccountSigner.publicKey.toBase58());
    if (new Set(addresses).size !== addresses.length) throw new Error("Delegation accounts must be distinct");
    const instructions: TransactionInstruction[] = [];
    const buffers: Keypair[] = [];
    const rent = await this.rpc.getMinimumBalanceForRentExemption(0);
    checkedInteger(rent, 64, "buffer rent");
    for (const [index, delegation] of delegations.entries()) {
      if (!delegation.ownerProgramId.equals(SystemProgram.programId)) {
        throw new Error("Program-owned accounts require delegation CPI from their owner program");
      }
      const address = delegation.delegatedAccountSigner.publicKey;
      const account = await this.rpc.getAccountInfo(address, "confirmed");
      if (!account || account.executable || account.data.length !== 0 ||
        (!account.owner.equals(SystemProgram.programId) && !account.owner.equals(this.portalProgramId))) {
        throw new Error("Wallet delegation requires an existing empty system account or a pre-staged Portal account");
      }
      const buffer = Keypair.generate();
      buffers.push(buffer);
      instructions.push(SystemProgram.createAccount({
        fromPubkey: user, newAccountPubkey: buffer.publicKey,
        lamports: rent, space: 0, programId: SystemProgram.programId
      }));
      if (account.owner.equals(SystemProgram.programId)) {
        instructions.push(SystemProgram.assign({ accountPubkey: address, programId: this.portalProgramId }));
      }
      const sequence = checkedInteger(snapshot.nextSequence + BigInt(index), 64, "input sequence");
      instructions.push(new TransactionInstruction({
        programId: this.portalProgramId,
        keys: [
          { pubkey: user, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: snapshot.address, isSigner: false, isWritable: true },
          { pubkey: address, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: await this.portal.deriveDelegationRecordPDA(address), isSigner: false, isWritable: true },
          { pubkey: buffer.publicKey, isSigner: false, isWritable: false },
          { pubkey: await this.portal.deriveIngressRecordPDA(snapshot.context, sequence), isSigner: false, isWritable: true },
        ],
        data: Buffer.from(this.portal.encodeDelegate({ gridId })),
      }));
    }
    return { instructions, buffers };
  }

  async buildDelegate(signer: Keypair, grid: number | bigint, delegations: DelegateAccount[]): Promise<TransactionPlan & { buffers: Keypair[] }> {
    const value = await this.walletDelegations(signer.publicKey, grid, delegations);
    return { ...await this.plan(signer.publicKey, value.instructions), buffers: value.buffers };
  }

  async buildRegisterSessionBridgeInstruction(params: {
    payer: PublicKey; session: PublicKey; mint: PublicKey; vault?: PublicKey;
    bridgeProgram?: PublicKey; tokenProgram: PublicKey;
  }): Promise<TransactionInstruction> {
    const snapshot = await this.getSessionSnapshot();
    const bridge = params.bridgeProgram ?? this.tokenBridge.programId;
    if (!params.session.equals(snapshot.address) || !params.payer.equals(snapshot.state.authority) || !bridge.equals(this.tokenBridge.programId)) {
      throw new Error("Bridge registration differs from the configured session authority or bridge program");
    }
    const registry = await this.portal.deriveSessionBridgePDA(snapshot.context, params.mint);
    const vault = this.tokenBridge.deriveVaultPDA(registry);
    if (params.vault && !params.vault.equals(vault)) throw new Error("Bridge vault is not canonical");
    return new TransactionInstruction({
      programId: this.portalProgramId,
      keys: [
        { pubkey: params.payer, isSigner: true, isWritable: true },
        { pubkey: snapshot.address, isSigner: false, isWritable: false },
        { pubkey: registry, isSigner: false, isWritable: true },
        { pubkey: params.mint, isSigner: false, isWritable: false },
        { pubkey: bridge, isSigner: false, isWritable: false },
        { pubkey: params.tokenProgram, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(this.portal.encodeRegisterSessionBridge({ mint: params.mint, bridgeProgram: bridge, vault, tokenProgram: params.tokenProgram })),
    });
  }

  async buildInitializeTokenVaultInstruction(params: { payer: PublicKey; sessionBridge: PublicKey; vaultTokenAccount: PublicKey }): Promise<TransactionInstruction> {
    return new TransactionInstruction({
      programId: this.tokenBridge.programId,
      keys: [
        { pubkey: params.payer, isSigner: true, isWritable: true },
        { pubkey: this.tokenBridge.deriveVaultPDA(params.sessionBridge), isSigner: false, isWritable: true },
        { pubkey: params.sessionBridge, isSigner: false, isWritable: false },
        { pubkey: this.portalProgramId, isSigner: false, isWritable: false },
        { pubkey: params.vaultTokenAccount, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ], data: Buffer.from(this.tokenBridge.encodeInitializeVault()),
    });
  }

  async buildInitializeErTokenAccountInstruction(params: { payer: PublicKey; sessionBridge: PublicKey; owner: PublicKey }): Promise<TransactionInstruction> {
    return new TransactionInstruction({
      programId: this.tokenBridge.programId,
      keys: [
        { pubkey: params.payer, isSigner: true, isWritable: true },
        { pubkey: this.tokenBridge.deriveErTokenAccountPDA(params.sessionBridge, params.owner), isSigner: false, isWritable: true },
        { pubkey: params.sessionBridge, isSigner: false, isWritable: false },
        { pubkey: this.portalProgramId, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ], data: Buffer.from(this.tokenBridge.encodeInitializeErTokenAccount(params.owner)),
    });
  }

  private tokenBinding(context: Hash32, mint: PublicKey, registry: PublicKey, owner: PublicKey, account: PublicKey): void {
    const expected = PublicKey.findProgramAddressSync([Buffer.from("session_bridge_v2"), checkedHash(context, "session context"), mint.toBytes()], this.portalProgramId)[0];
    if (!expected.equals(registry) || !this.tokenBridge.deriveErTokenAccountPDA(registry, owner).equals(account)) {
      throw new Error("Token registry or ER account differs from the session context and owner");
    }
  }

  private ingressAddress(params: TokenIngressContext): PublicKey {
    const session = PublicKey.findProgramAddressSync([Buffer.from("session")], this.portalProgramId)[0];
    if (!params.session.equals(session) || params.sequence <= 0n) throw new Error("Invalid token input session or sequence");
    return PublicKey.findProgramAddressSync([Buffer.from("ingress_v2"), checkedHash(params.sessionContext, "session context"),
    uintSequence(params.sequence)], this.portalProgramId)[0];
  }

  buildTokenBridgeDepositInstruction(params: TokenIngressContext & {
    payer: PublicKey; owner: PublicKey; vault: PublicKey; erTokenAccount: PublicKey; sessionBridge: PublicKey;
    sourceTokenAccount: PublicKey; vaultTokenAccount: PublicKey; mint: PublicKey; tokenProgram: PublicKey;
    amount: number | bigint; decimals: number;
  }): TransactionInstruction {
    this.tokenBinding(params.sessionContext, params.mint, params.sessionBridge, params.owner, params.erTokenAccount);
    if (!params.vault.equals(this.tokenBridge.deriveVaultPDA(params.sessionBridge))) throw new Error("Token vault is not canonical");
    const delegation = PublicKey.findProgramAddressSync([Buffer.from("delegation"), params.erTokenAccount.toBytes()], this.portalProgramId)[0];
    const request = PublicKey.findProgramAddressSync([Buffer.from("undelegation_request"), params.erTokenAccount.toBytes()], this.portalProgramId)[0];
    return new TransactionInstruction({
      programId: this.tokenBridge.programId,
      keys: [
        { pubkey: params.payer, isSigner: true, isWritable: true },
        { pubkey: params.owner, isSigner: true, isWritable: false },
        { pubkey: params.vault, isSigner: false, isWritable: true },
        { pubkey: params.erTokenAccount, isSigner: false, isWritable: true },
        { pubkey: params.sessionBridge, isSigner: false, isWritable: false },
        { pubkey: this.portalProgramId, isSigner: false, isWritable: false },
        { pubkey: params.sourceTokenAccount, isSigner: false, isWritable: true },
        { pubkey: params.vaultTokenAccount, isSigner: false, isWritable: true },
        { pubkey: params.mint, isSigner: false, isWritable: false },
        { pubkey: params.tokenProgram, isSigner: false, isWritable: false },
        { pubkey: this.tokenBridge.deriveDepositReceiptPDA(params.sessionBridge, params.erTokenAccount), isSigner: false, isWritable: true },
        { pubkey: delegation, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: request, isSigner: false, isWritable: false },
        { pubkey: params.session, isSigner: false, isWritable: true },
        { pubkey: this.tokenBridge.deriveOriginPDA(params.erTokenAccount), isSigner: false, isWritable: false },
        { pubkey: this.ingressAddress(params), isSigner: false, isWritable: true },
      ], data: Buffer.from(this.tokenBridge.encodeDeposit(params.amount, params.decimals)),
    });
  }

  buildDelegateErTokenAccountInstruction(params: TokenIngressContext & {
    payer: PublicKey; owner: PublicKey; erTokenAccount: PublicKey; sessionBridge: PublicKey; mint: PublicKey; gridId: number | bigint;
  }): TransactionInstruction {
    this.tokenBinding(params.sessionContext, params.mint, params.sessionBridge, params.owner, params.erTokenAccount);
    const delegation = PublicKey.findProgramAddressSync([Buffer.from("delegation"), params.erTokenAccount.toBytes()], this.portalProgramId)[0];
    return new TransactionInstruction({
      programId: this.tokenBridge.programId,
      keys: [
        { pubkey: params.payer, isSigner: true, isWritable: true },
        { pubkey: params.owner, isSigner: true, isWritable: false },
        { pubkey: params.erTokenAccount, isSigner: false, isWritable: true },
        { pubkey: this.tokenBridge.programId, isSigner: false, isWritable: false },
        { pubkey: params.sessionBridge, isSigner: false, isWritable: false },
        { pubkey: this.portalProgramId, isSigner: false, isWritable: false },
        { pubkey: params.session, isSigner: false, isWritable: true },
        { pubkey: delegation, isSigner: false, isWritable: true },
        { pubkey: this.tokenBridge.deriveBufferPDA(params.erTokenAccount), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: this.tokenBridge.deriveDepositReceiptPDA(params.sessionBridge, params.erTokenAccount), isSigner: false, isWritable: false },
        { pubkey: this.tokenBridge.deriveOriginPDA(params.erTokenAccount), isSigner: false, isWritable: true },
        { pubkey: this.ingressAddress(params), isSigner: false, isWritable: true },
      ], data: Buffer.from(this.tokenBridge.encodeDelegateErTokenAccount(params.gridId)),
    });
  }

  buildTokenBridgeTransferInstruction(params: { authority: PublicKey; sourceErTokenAccount: PublicKey; destinationErTokenAccount: PublicKey; amount: number | bigint }): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.tokenBridge.programId,
      keys: [
        { pubkey: params.authority, isSigner: true, isWritable: false },
        { pubkey: params.sourceErTokenAccount, isSigner: false, isWritable: true },
        { pubkey: params.destinationErTokenAccount, isSigner: false, isWritable: true },
      ], data: Buffer.from(this.tokenBridge.encodeTransfer(params.amount)),
    });
  }

  buildTokenBridgeStartWithdrawalInstruction(params: {
    owner: PublicKey; erTokenAccount: PublicKey; sessionBridge: PublicKey; sessionContext: Hash32;
    destinationTokenAccount: PublicKey; tokenProgram: PublicKey; mint: PublicKey; amount: number | bigint; decimals: number;
  }): TransactionInstruction {
    this.tokenBinding(params.sessionContext, params.mint, params.sessionBridge, params.owner, params.erTokenAccount);
    return new TransactionInstruction({
      programId: this.tokenBridge.programId,
      keys: [
        { pubkey: params.owner, isSigner: true, isWritable: false },
        { pubkey: params.erTokenAccount, isSigner: false, isWritable: true },
        { pubkey: params.sessionBridge, isSigner: false, isWritable: false },
        { pubkey: this.portalProgramId, isSigner: false, isWritable: false },
        { pubkey: params.destinationTokenAccount, isSigner: false, isWritable: false },
        { pubkey: params.tokenProgram, isSigner: false, isWritable: false },
        { pubkey: params.mint, isSigner: false, isWritable: false },
      ], data: Buffer.from(this.tokenBridge.encodeStartWithdrawal(params.amount, params.decimals)),
    });
  }

  async buildErSolWithdrawalInstructions(params: ErSolWithdrawalParams): Promise<TransactionInstruction[]> {
    await this.getExecutionSession();
    return [new TransactionInstruction({
      programId: this.portalProgramId,
      keys: [
        { pubkey: params.erSource, isSigner: true, isWritable: true },
        { pubkey: params.l1Recipient, isSigner: false, isWritable: false },
        { pubkey: WITHDRAWAL_SINK, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      ], data: Buffer.from(this.portal.encodeStartWithdrawal({ lamports: checkedInteger(params.lamports, 64, "withdrawal") })),
    })];
  }

  async buildErSolWithdrawal(recipient: PublicKey, amount: number | bigint): Promise<TransactionInstruction> {
    return (await this.buildErSolWithdrawalInstructions({ erSource: recipient, l1Recipient: recipient, lamports: amount }))[0];
  }

  async confirmSignature(signature: string, options: TransactionOptions = {}): Promise<void> {
    const attempts = options.maxAttempts ?? 20;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const status = (await this.rpc.getSignatureStatuses([signature])).value?.[0];
      if (status?.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
      const commitment = status?.confirmationStatus;
      if (commitment === "finalized" || commitment === "confirmed" && options.commitment !== "finalized" ||
        commitment === "processed" && options.commitment === "processed") return;
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, options.intervalMs ?? 1000));
    }
    throw new Error(`Transaction confirmation timeout: ${signature}`);
  }

  async sendAndConfirmTransactionWithoutWebsocket(transaction: VersionedTransaction, options: TransactionOptions = {}): Promise<{ signature: string }> {
    await sendRawVersionedTransaction(this.rpc, transaction, { commitment: options.commitment ?? "confirmed", skipPreflight: options.skipPreflight ?? false });
    const signature = getVersionedTxSignatureBase58(transaction);
    await this.confirmSignature(signature, options);
    return { signature };
  }

  async sendAndConfirmErTransaction(transaction: VersionedTransaction, options: ErTransactionOptions = {}): Promise<TransactionResult> {
    let expected: SessionSnapshot | undefined;
    return submitErTransaction(this.ephemeral_rpc, transaction, async () => {
      const snapshot = await this.getExecutionSession();
      if (expected && (!snapshot.address.equals(expected.address) || !sameBytes(snapshot.context, expected.context))) {
        throw new Error("ER session changed while confirming the saved transaction");
      }
      expected = snapshot;
    }, options);
  }

  private async sendTx(
    payer: PublicKey, instructions: TransactionInstruction[], wallet: WalletSignTransaction,
    signers: Keypair[], options: TransactionOptions,
  ): Promise<TransactionResult> {
    const latest = await this.rpc.getLatestBlockhash();
    const message = new TransactionMessage({ payerKey: payer, recentBlockhash: latest.blockhash, instructions }).compileToV0Message();
    const unique = [...new Map(signers.map(signer => [signer.publicKey.toBase58(), signer])).values()];
    const partial = signVersionedTransaction(new VersionedTransaction(message), unique);
    return this.sendAndConfirmTransactionWithoutWebsocket(await wallet(partial), options);
  }

  async openSession(
    user: PublicKey, grid: number | bigint, ttlSlots: number | bigint = 2000, feeCap: number | bigint = 1_000_000,
    wallet: WalletSignTransaction, signers: SessionSigners, options: TransactionOptions = {}, openOptions: OpenSessionConfig = {},
  ): Promise<TransactionResult> {
    const instruction = await this.openInstruction(user, grid, ttlSlots, feeCap, openOptions);
    return this.sendTx(signers.feePayerSigner?.publicKey ?? user, [instruction], wallet,
      signers.feePayerSigner ? [signers.feePayerSigner] : [], options);
  }

  async depositFee(
    user: PublicKey, amount: number | bigint, wallet: WalletSignTransaction,
    signers: DepositFeeSigners, options: TransactionOptions = {}, recipient = user,
  ): Promise<TransactionResult> {
    if (signers.depositorSigner && !signers.depositorSigner.publicKey.equals(user)) throw new Error("Depositor signer differs from the payer");
    const instruction = await this.depositInstruction(user, amount, recipient);
    return this.sendTx(signers.feePayerSigner?.publicKey ?? user, [instruction], wallet,
      [signers.depositorSigner, signers.feePayerSigner].filter((value): value is Keypair => value !== undefined), options);
  }

  async delegate(user: PublicKey, grid: number | bigint, wallet: WalletSignTransaction, signers: DelegateSigners, options: TransactionOptions = {}): Promise<TransactionResult> {
    const value = await this.walletDelegations(user, grid, signers.delegations);
    const local = [signers.feePayerSigner, ...value.buffers, ...signers.delegations.map(delegation => delegation.delegatedAccountSigner)]
      .filter((signer): signer is Keypair => signer !== undefined);
    return this.sendTx(signers.feePayerSigner?.publicKey ?? user, value.instructions, wallet, local, options);
  }

  buildTokenBridgeWithdrawInstruction(...parameters: unknown[]): never { return unavailable("Immediate token withdrawal"); }
  buildRequestErTokenAccountUndelegationInstruction(...parameters: unknown[]): never { return unavailable("Token undelegation"); }
  buildUndelegateErTokenAccountInstruction(...parameters: unknown[]): never { return unavailable("Token undelegation"); }
  async getUndelegationRequest(...parameters: unknown[]): Promise<never> { return unavailable("Undelegation"); }
  async buildRequestUndelegation(...parameters: unknown[]): Promise<never> { return unavailable("Undelegation"); }
  async buildUndelegate(...parameters: unknown[]): Promise<never> { return unavailable("Undelegation"); }
  async buildCloseSession(...parameters: unknown[]): Promise<never> { return unavailable("CloseSession"); }
  async requestUndelegation(...parameters: unknown[]): Promise<never> { return unavailable("Undelegation"); }
  async undelegate(...parameters: unknown[]): Promise<never> { return unavailable("Undelegation"); }
  async closeSession(...parameters: unknown[]): Promise<never> { return unavailable("CloseSession"); }

  async checkHealth(): Promise<{ solana: boolean; ephemeralRollup: boolean }> {
    const ephemeralRollup = await this.ephemeralRollupReader.isHealthy();
    try { await this.rpc.getSlot(); return { solana: true, ephemeralRollup }; }
    catch { return { solana: false, ephemeralRollup }; }
  }
}

function uintSequence(value: bigint): Uint8Array {
  const data = new Uint8Array(8);
  new DataView(data.buffer).setBigUint64(0, checkedInteger(value, 64, "input sequence"), true);
  return data;
}
