import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { AccountInfo, Address, NorthStarConfig, NorthStarSyncStatus } from "./types";
import { EphemeralRollupReader } from "./readers/EphemeralRollupReader";
import { AccountResolver } from "./readers/AccountResolver";
import { PortalProgram, WITHDRAWAL_SINK } from "./programs/portal";
import {
  TOKEN_BRIDGE_PROGRAM_ID,
  TokenBridgeProgram,
} from "./programs/tokenBridge";
import {
  getVersionedTxSignatureBase58,
  sendRawVersionedTransaction,
  signVersionedTransaction,
  toPublicKey,
} from "./solana/kitCompat";

export {
  getVersionedTxSignatureBase58,
  signVersionedTransaction,
  toPublicKey,
} from "./solana/kitCompat";
export {
  TOKEN_BRIDGE_PROGRAM_ID,
  TokenBridgeProgram,
} from "./programs/tokenBridge";

/** @solana/web3.js Keypair used wherever a transaction signer is required. */
export type TransactionSigner = Keypair;
export type { Address };

export interface TransactionResult {
  signature: string;
  slot?: bigint;
}

export interface TransactionOptions {
  commitment?: "processed" | "confirmed" | "finalized";
  skipPreflight?: boolean;
  maxAttempts?: number;
  intervalMs?: number;
}

export interface DelegateAccount {
  delegatedAccountSigner: Keypair;
  ownerProgramId: PublicKey;
}

export interface DelegateV1Signers {
  delegations: DelegateAccount[];
  feePayerSigner?: Keypair;
}

/** openSession / closeSession: user is signed via signTransaction; optional local fee payer. */
export interface SessionV1Signers {
  feePayerSigner?: Keypair;
}

export interface OpenSessionConfig {
  validator?: PublicKey;
  settlementIntervalSlots?: number;
}

/** depositFee: depositor and fee payer; if depositorSigner is omitted, the wallet signs user. */
export interface DepositFeeV1Signers {
  depositorSigner?: Keypair;
  feePayerSigner?: Keypair;
}

/** undelegate: one delegated account + optional fee payer. */
export interface UndelegateV1Signers {
  delegatedAccountSigner: Keypair;
  feePayerSigner?: Keypair;
}

/** Wallet completes signatures on a partially locally-signed transaction; without local signers, this step completes user and any remaining signatures. */
export type WalletSignTransaction = (
  transaction: VersionedTransaction,
) => Promise<VersionedTransaction>;

const SYSTEM_PROGRAM_ID = SystemProgram.programId;
const MAX_DELEGATIONS_PER_PORTAL_DELEGATE_IX = 3;

export interface ErSolWithdrawalParams {
  erSource: PublicKey;
  l1Recipient: PublicKey;
  lamports: number;
}

export function encodeSystemProgramAssignData(newProgramOwner: PublicKey): Uint8Array {
  const data = new Uint8Array(4 + 32);
  new DataView(data.buffer).setUint32(0, 1, true);
  data.set(newProgramOwner.toBuffer(), 4);
  return data;
}

/**
 * Main North Star SDK class
 * Provides unified interface for Ephemeral Rollup interactions
 */
export class NorthStarSDK {
  private rpc: Connection;
  private ephemeral_rpc: Connection;
  private ephemeralRollupReader: EphemeralRollupReader;
  public accountResolver: AccountResolver;
  private config: NorthStarConfig;
  private portalProgramId: PublicKey;
  public readonly portal: PortalProgram;
  public readonly tokenBridge: TokenBridgeProgram;

  constructor(config: NorthStarConfig) {
    this.config = config;
    this.portalProgramId = toPublicKey(config.portalProgramId);
    this.portal = new PortalProgram(this.portalProgramId);
    this.tokenBridge = new TokenBridgeProgram();

    const solanaRpc = config.customEndpoints.solana;
    this.rpc = new Connection(solanaRpc, "confirmed");

    const ephemeralRollupRpc = config.customEndpoints.ephemeralRollup;
    this.ephemeral_rpc = new Connection(ephemeralRollupRpc, "confirmed");
    this.ephemeralRollupReader = new EphemeralRollupReader(ephemeralRollupRpc);

    this.accountResolver = new AccountResolver(
      this.ephemeralRollupReader,
      this.rpc,
    );

    console.log("✓ North Star SDK initialized");
    console.log(`  Solana Network: ${solanaRpc}`);
    console.log(`  Ephemeral Rollup RPC: ${ephemeralRollupRpc}`);
    console.log(`  Portal Program: ${this.portalProgramId.toBase58()}`);
  }

  async generateKeyPair(): Promise<Keypair> {
    return Keypair.generate();
  }

  async createKeyPairFromBase58(privateKeyBase58: string): Promise<Keypair> {
    const bytes = Uint8Array.from(bs58.decode(privateKeyBase58.trim()));
    if (bytes.length === 64) {
      return Keypair.fromSecretKey(bytes);
    }
    if (bytes.length === 32) {
      return Keypair.fromSeed(bytes);
    }
    throw new Error(
      `Private key decodes to ${bytes.length} bytes; expected 32 or 64.`,
    );
  }

  async getAccountInfo(
    address: PublicKey,
    search_source: "ephemeral" | "solana",
  ): Promise<AccountInfo> {
    return await this.accountResolver.resolve(address, search_source);
  }

  async getMultipleAccounts(
    addresses: PublicKey[],
    search_source: "ephemeral" | "solana",
  ): Promise<AccountInfo[]> {
    return await this.accountResolver.resolveMultiple(addresses, search_source);
  }

  /** Solana L1 JSON-RPC connection (@solana/web3.js). */
  getRpc(): Connection {
    return this.rpc;
  }

  /** Ephemeral Rollup JSON-RPC connection (@solana/web3.js). */
  getEphemeralRpc(): Connection {
    return this.ephemeral_rpc;
  }

  getPortalProgramId(): PublicKey {
    return this.portalProgramId;
  }

  async buildRegisterSessionBridgeInstruction(params: {
    authority: PublicKey;
    session: PublicKey;
    mint: PublicKey;
    vault?: PublicKey;
    bridgeProgram?: PublicKey;
    tokenProgram: PublicKey;
  }): Promise<TransactionInstruction> {
    const bridgeProgram = params.bridgeProgram ?? TOKEN_BRIDGE_PROGRAM_ID;
    const sessionBridge = await this.portal.deriveSessionBridgePDA(
      params.session,
      params.mint,
    );
    const vault = params.vault ?? this.tokenBridge.deriveVaultPDA(sessionBridge);
    return new TransactionInstruction({
      programId: this.portalProgramId,
      keys: [
        { pubkey: params.authority, isSigner: true, isWritable: true },
        { pubkey: params.session, isSigner: false, isWritable: false },
        { pubkey: sessionBridge, isSigner: false, isWritable: true },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(
        this.portal.encodeRegisterSessionBridge({
          mint: params.mint,
          bridgeProgram,
          vault,
          tokenProgram: params.tokenProgram,
        }),
      ),
    });
  }

  async buildInitializeTokenVaultInstruction(params: {
    payer: PublicKey;
    sessionBridge: PublicKey;
    vaultTokenAccount: PublicKey;
  }): Promise<TransactionInstruction> {
    return new TransactionInstruction({
      programId: this.tokenBridge.programId,
      keys: [
        { pubkey: params.payer, isSigner: true, isWritable: true },
        {
          pubkey: this.tokenBridge.deriveVaultPDA(params.sessionBridge),
          isSigner: false,
          isWritable: true,
        },
        { pubkey: params.sessionBridge, isSigner: false, isWritable: false },
        { pubkey: this.portalProgramId, isSigner: false, isWritable: false },
        { pubkey: params.vaultTokenAccount, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(this.tokenBridge.encodeInitializeVault()),
    });
  }

  async buildInitializeErTokenAccountInstruction(params: {
    payer: PublicKey;
    sessionBridge: PublicKey;
    owner: PublicKey;
  }): Promise<TransactionInstruction> {
    return new TransactionInstruction({
      programId: this.tokenBridge.programId,
      keys: [
        { pubkey: params.payer, isSigner: true, isWritable: true },
        {
          pubkey: this.tokenBridge.deriveErTokenAccountPDA(
            params.sessionBridge,
            params.owner,
          ),
          isSigner: false,
          isWritable: true,
        },
        { pubkey: params.sessionBridge, isSigner: false, isWritable: false },
        { pubkey: this.portalProgramId, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(
        this.tokenBridge.encodeInitializeErTokenAccount(params.owner),
      ),
    });
  }

  buildTokenBridgeDepositInstruction(params: {
    owner: PublicKey;
    vault: PublicKey;
    erTokenAccount: PublicKey;
    sessionBridge: PublicKey;
    sourceTokenAccount: PublicKey;
    vaultTokenAccount: PublicKey;
    mint: PublicKey;
    tokenProgram: PublicKey;
    amount: number | bigint;
    decimals: number;
  }): TransactionInstruction {
    const depositReceipt = this.tokenBridge.deriveDepositReceiptPDA(
      params.sessionBridge,
      params.erTokenAccount,
    );
    const [delegationRecord] = PublicKey.findProgramAddressSync(
      [Buffer.from("delegation", "utf8"), params.erTokenAccount.toBuffer()],
      this.portalProgramId,
    );
    return new TransactionInstruction({
      programId: this.tokenBridge.programId,
      keys: [
        { pubkey: params.owner, isSigner: true, isWritable: true },
        { pubkey: params.vault, isSigner: false, isWritable: true },
        { pubkey: params.erTokenAccount, isSigner: false, isWritable: true },
        { pubkey: params.sessionBridge, isSigner: false, isWritable: false },
        { pubkey: this.portalProgramId, isSigner: false, isWritable: false },
        { pubkey: params.sourceTokenAccount, isSigner: false, isWritable: true },
        { pubkey: params.vaultTokenAccount, isSigner: false, isWritable: true },
        { pubkey: params.mint, isSigner: false, isWritable: false },
        { pubkey: params.tokenProgram, isSigner: false, isWritable: false },
        { pubkey: depositReceipt, isSigner: false, isWritable: true },
        { pubkey: delegationRecord, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(
        this.tokenBridge.encodeDeposit(params.amount, params.decimals),
      ),
    });
  }

  buildTokenBridgeTransferInstruction(params: {
    authority: PublicKey;
    sourceErTokenAccount: PublicKey;
    destinationErTokenAccount: PublicKey;
    amount: number | bigint;
  }): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.tokenBridge.programId,
      keys: [
        { pubkey: params.authority, isSigner: true, isWritable: false },
        { pubkey: params.sourceErTokenAccount, isSigner: false, isWritable: true },
        {
          pubkey: params.destinationErTokenAccount,
          isSigner: false,
          isWritable: true,
        },
      ],
      data: Buffer.from(this.tokenBridge.encodeTransfer(params.amount)),
    });
  }

  buildTokenBridgeStartWithdrawalInstruction(params: {
    owner: PublicKey;
    erTokenAccount: PublicKey;
    sessionBridge: PublicKey;
    destinationTokenAccount: PublicKey;
    tokenProgram: PublicKey;
    amount: number | bigint;
    decimals: number;
  }): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.tokenBridge.programId,
      keys: [
        { pubkey: params.owner, isSigner: true, isWritable: false },
        { pubkey: params.erTokenAccount, isSigner: false, isWritable: true },
        { pubkey: params.sessionBridge, isSigner: false, isWritable: false },
        { pubkey: this.portalProgramId, isSigner: false, isWritable: false },
        {
          pubkey: params.destinationTokenAccount,
          isSigner: false,
          isWritable: false,
        },
        { pubkey: params.tokenProgram, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(
        this.tokenBridge.encodeStartWithdrawal(params.amount, params.decimals),
      ),
    });
  }

  buildTokenBridgeWithdrawInstruction(params: {
    owner: PublicKey;
    vault: PublicKey;
    erTokenAccount: PublicKey;
    sessionBridge: PublicKey;
    vaultTokenAccount: PublicKey;
    destinationTokenAccount: PublicKey;
    mint: PublicKey;
    tokenProgram: PublicKey;
    amount: number | bigint;
    decimals: number;
  }): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.tokenBridge.programId,
      keys: [
        { pubkey: params.owner, isSigner: true, isWritable: false },
        { pubkey: params.vault, isSigner: false, isWritable: true },
        { pubkey: params.erTokenAccount, isSigner: false, isWritable: true },
        { pubkey: params.sessionBridge, isSigner: false, isWritable: false },
        { pubkey: this.portalProgramId, isSigner: false, isWritable: false },
        { pubkey: params.vaultTokenAccount, isSigner: false, isWritable: true },
        { pubkey: params.destinationTokenAccount, isSigner: false, isWritable: true },
        { pubkey: params.mint, isSigner: false, isWritable: false },
        { pubkey: params.tokenProgram, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(
        this.tokenBridge.encodeWithdraw(params.amount, params.decimals),
      ),
    });
  }

  buildDelegateErTokenAccountInstruction(params: {
    payer: PublicKey;
    erTokenAccount: PublicKey;
    sessionBridge: PublicKey;
    session: PublicKey;
    gridId: number | bigint;
  }): TransactionInstruction {
    const [delegationRecord] = PublicKey.findProgramAddressSync(
      [Buffer.from("delegation", "utf8"), params.erTokenAccount.toBuffer()],
      this.portalProgramId,
    );
    const buffer = this.tokenBridge.deriveBufferPDA(params.erTokenAccount);
    return new TransactionInstruction({
      programId: this.tokenBridge.programId,
      keys: [
        { pubkey: params.payer, isSigner: true, isWritable: true },
        { pubkey: params.erTokenAccount, isSigner: false, isWritable: true },
        { pubkey: this.tokenBridge.programId, isSigner: false, isWritable: false },
        { pubkey: params.sessionBridge, isSigner: false, isWritable: false },
        { pubkey: this.portalProgramId, isSigner: false, isWritable: false },
        { pubkey: params.session, isSigner: false, isWritable: false },
        { pubkey: delegationRecord, isSigner: false, isWritable: true },
        { pubkey: buffer, isSigner: false, isWritable: true },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(this.tokenBridge.encodeDelegateErTokenAccount(params.gridId)),
    });
  }

  buildUndelegateErTokenAccountInstruction(params: {
    authority: PublicKey;
    erTokenAccount: PublicKey;
    session: PublicKey;
  }): TransactionInstruction {
    const [delegationRecord] = PublicKey.findProgramAddressSync(
      [Buffer.from("delegation", "utf8"), params.erTokenAccount.toBuffer()],
      this.portalProgramId,
    );
    const buffer = this.tokenBridge.deriveBufferPDA(params.erTokenAccount);
    return new TransactionInstruction({
      programId: this.tokenBridge.programId,
      keys: [
        { pubkey: params.authority, isSigner: true, isWritable: true },
        { pubkey: params.erTokenAccount, isSigner: false, isWritable: true },
        { pubkey: this.tokenBridge.programId, isSigner: false, isWritable: false },
        { pubkey: this.portalProgramId, isSigner: false, isWritable: false },
        { pubkey: params.session, isSigner: false, isWritable: false },
        { pubkey: delegationRecord, isSigner: false, isWritable: true },
        { pubkey: buffer, isSigner: false, isWritable: true },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(this.tokenBridge.encodeUndelegateErTokenAccount()),
    });
  }

  /** Get the ER node's L1 sync cursor. */
  async getEphemeralRollupSyncStatus(): Promise<NorthStarSyncStatus> {
    return await this.ephemeralRollupReader.getSyncStatus();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async confirmSignature(
    signature: string,
    options: TransactionOptions = {},
  ): Promise<void> {
    const commitment: string = options.commitment || "confirmed";
    const maxAttempts = options.maxAttempts ?? 20;
    const intervalMs = options.intervalMs ?? 1000;

    for (let i = 0; i < maxAttempts; i++) {
      const statuses = await this.rpc.getSignatureStatuses([signature]);
      const status = statuses.value?.[0];

      if (status?.err) {
        throw new Error(
          `Transaction failed on-chain: status.err ${JSON.stringify(status.err)}`,
        );
      }

      const cs = status?.confirmationStatus;
      if (!cs) {
        await this.sleep(intervalMs);
        continue;
      }
      if (cs === "finalized") {
        return;
      }
      if (commitment === "confirmed" && cs === "confirmed") {
        return;
      }
      if (
        commitment === "processed" &&
        (cs === "processed" || cs === "confirmed" || cs === "finalized")
      ) {
        return;
      }

      await this.sleep(intervalMs);
    }

    throw new Error(
      `Transaction confirmation timeout (HTTP polling): ${String(signature)}`,
    );
  }

  private async sendTransactionWithoutConfirming(
    transaction: VersionedTransaction,
    options: { commitment?: string; skipPreflight?: boolean },
  ): Promise<void> {
    await sendRawVersionedTransaction(this.rpc, transaction, {
      commitment: (options.commitment as any) ?? "confirmed",
      skipPreflight: options.skipPreflight ?? true,
    });
  }

  async sendAndConfirmTransactionWithoutWebsocket(
    transaction: VersionedTransaction,
    options: TransactionOptions = {},
  ): Promise<{ signature: string }> {
    const commitment = options.commitment || "confirmed";
    const skipPreflight = options.skipPreflight ?? true;
    await this.sendTransactionWithoutConfirming(transaction, {
      commitment,
      skipPreflight,
    });
    const signature = getVersionedTxSignatureBase58(transaction);
    await this.confirmSignature(signature, options);
    return { signature };
  }

  private dedupeSigners(signers: Keypair[]): Keypair[] {
    const seen = new Set<string>();
    const out: Keypair[] = [];
    for (const k of signers) {
      const b = k.publicKey.toBase58();
      if (!seen.has(b)) {
        seen.add(b);
        out.push(k);
      }
    }
    return out;
  }

  /** Collects all defined Keypairs from a signers object via Object.keys (skips undefined). */
  private keypairsFromSignersRecord(signers: object): Keypair[] {
    const rec = signers as Record<string, Keypair | undefined>;
    const out: Keypair[] = [];
    for (const k of Object.keys(rec)) {
      const kp = rec[k];
      if (kp) out.push(kp);
    }
    return out;
  }

  private async buildDelegateInstructions(
    user: PublicKey,
    gridId: number,
    delegations: DelegateAccount[],
    buffers: Keypair[],
  ): Promise<TransactionInstruction[]> {
    if (delegations.length !== buffers.length) {
      throw new Error("delegate buffers must match delegations");
    }

    const sessionPDA = await this.portal.deriveSessionPDA();
    const instructions: TransactionInstruction[] = [];
    for (
      let offset = 0;
      offset < delegations.length;
      offset += MAX_DELEGATIONS_PER_PORTAL_DELEGATE_IX
    ) {
      const keys = [
        { pubkey: user, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: sessionPDA, isSigner: false, isWritable: false },
      ];
      const chunk = delegations.slice(
        offset,
        offset + MAX_DELEGATIONS_PER_PORTAL_DELEGATE_IX,
      );
      for (let i = 0; i < chunk.length; i++) {
        const delegationIndex = offset + i;
        const delegation = chunk[i];
        const delegatedAccount = delegation.delegatedAccountSigner.publicKey;
        const delegationRecordPDA =
          await this.portal.deriveDelegationRecordPDA(delegatedAccount);
        keys.push(
          { pubkey: delegatedAccount, isSigner: true, isWritable: true },
          { pubkey: delegation.ownerProgramId, isSigner: false, isWritable: false },
          { pubkey: delegationRecordPDA, isSigner: false, isWritable: true },
          {
            pubkey: buffers[delegationIndex].publicKey,
            isSigner: false,
            isWritable: false,
          },
        );
      }

      instructions.push(
        new TransactionInstruction({
          programId: this.portalProgramId,
          keys,
          data: Buffer.from(this.portal.encodeDelegate({ gridId })),
        }),
      );
    }
    return instructions;
  }

  /**
   * Local signers partial-sign first, then signTransaction (wallet), then on-chain confirmation.
   */
  private async sendTxV1(
    payerKey: PublicKey,
    instructions: TransactionInstruction[],
    signTransaction: WalletSignTransaction,
    localSigners: Keypair[],
    options: TransactionOptions,
  ): Promise<TransactionResult> {
    const latestBlockhash = await this.rpc.getLatestBlockhash();
    const messageV0 = new TransactionMessage({
      payerKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions,
    }).compileToV0Message();
    let tx = new VersionedTransaction(messageV0);
    tx = signVersionedTransaction(tx, this.dedupeSigners(localSigners));
    tx = await signTransaction(tx);
    const signature = getVersionedTxSignatureBase58(tx);
    console.log(`sending tx with signature: ${signature}`);
    return this.sendAndConfirmTransactionWithoutWebsocket(tx, options);
  }

  async buildOpenSession(
    signer: Keypair,
    gridId: number,
    ttlSlots: number = 2000,
    feeCap: number = 1_000_000,
    openSessionConfig: OpenSessionConfig = {},
  ): Promise<{
    instructions: TransactionInstruction[];
    feePayer: PublicKey;
    blockhash: string;
    lastValidBlockHeight: bigint;
  }> {
    const sessionPDA = await this.portal.deriveSessionPDA();
    const feeVaultPDA = await this.portal.deriveFeeVaultPDA();

    const ix = new TransactionInstruction({
      programId: this.portalProgramId,
      keys: [
        { pubkey: signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: sessionPDA, isSigner: false, isWritable: true },
        { pubkey: feeVaultPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(
        this.portal.encodeOpenSession({
          gridId,
          ttlSlots: BigInt(ttlSlots),
          feeCap: BigInt(feeCap),
          validator: openSessionConfig.validator ?? signer.publicKey,
          settlementIntervalSlots: BigInt(
            openSessionConfig.settlementIntervalSlots ?? 10,
          ),
        }),
      ),
    });

    const latestBlockhash = await this.rpc.getLatestBlockhash();

    return {
      instructions: [ix],
      feePayer: signer.publicKey,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: BigInt(latestBlockhash.lastValidBlockHeight),
    };
  }

  async buildDelegate(
    signer: Keypair,
    gridId: number,
    delegations: DelegateAccount[],
  ): Promise<{
    instructions: TransactionInstruction[];
    feePayer: PublicKey;
    blockhash: string;
    lastValidBlockHeight: bigint;
    buffers: Keypair[];
  }> {
    if (delegations.length === 0) {
      throw new Error("delegate requires at least one delegation");
    }

    const bufferRent = await this.rpc.getMinimumBalanceForRentExemption(0);
    const buffers = delegations.map(() => Keypair.generate());
    const createBufferIxs = delegations.map((delegation, index) =>
      SystemProgram.createAccount({
        fromPubkey: signer.publicKey,
        newAccountPubkey: buffers[index].publicKey,
        lamports: bufferRent,
        space: 0,
        programId: delegation.ownerProgramId,
      }),
    );

    const delegateIxs = await this.buildDelegateInstructions(
      signer.publicKey,
      gridId,
      delegations,
      buffers,
    );

    const latestBlockhash = await this.rpc.getLatestBlockhash();

    return {
      instructions: [...createBufferIxs, ...delegateIxs],
      feePayer: signer.publicKey,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: BigInt(latestBlockhash.lastValidBlockHeight),
      buffers,
    };
  }

  async buildDepositFee(
    signer: Keypair,
    lamports: number,
    recipient: PublicKey = signer.publicKey,
  ): Promise<{
    instructions: TransactionInstruction[];
    feePayer: PublicKey;
    blockhash: string;
    lastValidBlockHeight: bigint;
  }> {
    const sessionPDA = await this.portal.deriveSessionPDA();
    const depositReceiptPDA = await this.portal.deriveDepositReceiptPDA(
      sessionPDA,
      recipient,
    );

    const ix = new TransactionInstruction({
      programId: this.portalProgramId,
      keys: [
        { pubkey: signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: sessionPDA, isSigner: false, isWritable: false },
        { pubkey: depositReceiptPDA, isSigner: false, isWritable: true },
        { pubkey: recipient, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(
        this.portal.encodeDepositFee({ lamports: BigInt(lamports) }),
      ),
    });

    const latestBlockhash = await this.rpc.getLatestBlockhash();

    return {
      instructions: [ix],
      feePayer: signer.publicKey,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: BigInt(latestBlockhash.lastValidBlockHeight),
    };
  }

  async buildErSolWithdrawalInstructions({
    erSource,
    l1Recipient,
    lamports,
  }: ErSolWithdrawalParams): Promise<TransactionInstruction[]> {
    return [
      new TransactionInstruction({
        programId: this.portalProgramId,
        keys: [
          { pubkey: erSource, isSigner: true, isWritable: true },
          { pubkey: l1Recipient, isSigner: false, isWritable: false },
          { pubkey: WITHDRAWAL_SINK, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(
          this.portal.encodeStartWithdrawal({ lamports: BigInt(lamports) }),
        ),
      }),
    ];
  }

  async buildErSolWithdrawal(
    recipient: PublicKey,
    lamports: number,
  ): Promise<TransactionInstruction> {
    const [transferIx] = await this.buildErSolWithdrawalInstructions({
      erSource: recipient,
      l1Recipient: recipient,
      lamports,
    });
    return transferIx;
  }

  async buildUndelegate(
    signer: Keypair,
    delegatedAccount: PublicKey,
    ownerProgramId: PublicKey,
  ): Promise<{
    instructions: TransactionInstruction[];
    feePayer: PublicKey;
    blockhash: string;
    lastValidBlockHeight: bigint;
  }> {
    const delegationRecordPDA =
      await this.portal.deriveDelegationRecordPDA(delegatedAccount);
    const sessionPDA = await this.portal.deriveSessionPDA();

    const ix = new TransactionInstruction({
      programId: this.portalProgramId,
      keys: [
        { pubkey: signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: delegatedAccount, isSigner: false, isWritable: true },
        { pubkey: ownerProgramId, isSigner: false, isWritable: false },
        { pubkey: delegationRecordPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: sessionPDA, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(this.portal.encodeUndelegate()),
    });

    const latestBlockhash = await this.rpc.getLatestBlockhash();

    return {
      instructions: [ix],
      feePayer: signer.publicKey,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: BigInt(latestBlockhash.lastValidBlockHeight),
    };
  }

  async buildCloseSession(
    signer: Keypair,
  ): Promise<{
    instructions: TransactionInstruction[];
    feePayer: PublicKey;
    blockhash: string;
    lastValidBlockHeight: bigint;
  }> {
    const sessionPDA = await this.portal.deriveSessionPDA();
    const feeVaultPDA = await this.portal.deriveFeeVaultPDA();
    const checkpointCursorPDA =
      await this.portal.deriveCheckpointCursorPDA(sessionPDA);

    const ix = new TransactionInstruction({
      programId: this.portalProgramId,
      keys: [
        { pubkey: signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: sessionPDA, isSigner: false, isWritable: true },
        { pubkey: feeVaultPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: checkpointCursorPDA, isSigner: false, isWritable: true },
      ],
      data: Buffer.from(this.portal.encodeCloseSession()),
    });

    const latestBlockhash = await this.rpc.getLatestBlockhash();

    return {
      instructions: [ix],
      feePayer: signer.publicKey,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: BigInt(latestBlockhash.lastValidBlockHeight),
    };
  }

  async openSession(
    user: PublicKey,
    gridId: number,
    ttlSlots: number = 2000,
    feeCap: number = 1_000_000,
    signTransaction: WalletSignTransaction,
    signers: SessionV1Signers,
    options: TransactionOptions = {},
    openSessionConfig: OpenSessionConfig = {},
  ): Promise<TransactionResult> {
    const sessionPDA = await this.portal.deriveSessionPDA();
    const feeVaultPDA = await this.portal.deriveFeeVaultPDA();

    const ix = new TransactionInstruction({
      programId: this.portalProgramId,
      keys: [
        { pubkey: user, isSigner: true, isWritable: true },
        { pubkey: sessionPDA, isSigner: false, isWritable: true },
        { pubkey: feeVaultPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(
        this.portal.encodeOpenSession({
          gridId,
          ttlSlots: BigInt(ttlSlots),
          feeCap: BigInt(feeCap),
          validator: openSessionConfig.validator ?? user,
          settlementIntervalSlots: BigInt(
            openSessionConfig.settlementIntervalSlots ?? 10,
          ),
        }),
      ),
    });

    const feePayer = signers.feePayerSigner?.publicKey ?? user;

    const localSigners = this.keypairsFromSignersRecord(signers);

    const { signature } = await this.sendTxV1(
      feePayer,
      [ix],
      signTransaction,
      localSigners,
      options,
    );

    console.log(`✓ Session opened, sessionPDA: ${sessionPDA.toBase58()}`);
    console.log(`  Signature: ${signature}`);

    return { signature };
  }

  async delegate(
    user: PublicKey,
    gridId: number,
    signTransaction: WalletSignTransaction,
    signers: DelegateV1Signers,
    options: TransactionOptions = {},
  ): Promise<TransactionResult> {
    if (signers.delegations.length === 0) {
      throw new Error("delegate requires at least one delegation");
    }

    const bufferRent = await this.rpc.getMinimumBalanceForRentExemption(0);
    const buffers = signers.delegations.map(() => Keypair.generate());
    const createBufferIxs = signers.delegations.map((delegation, index) =>
      SystemProgram.createAccount({
        fromPubkey: user,
        newAccountPubkey: buffers[index].publicKey,
        lamports: bufferRent,
        space: 0,
        programId: delegation.ownerProgramId,
      }),
    );

    const delegateIxs = await this.buildDelegateInstructions(
      user,
      gridId,
      signers.delegations,
      buffers,
    );

    const feePayer = signers.feePayerSigner?.publicKey ?? user;

    const localSigners = [
      signers.feePayerSigner,
      ...signers.delegations.map((delegation) => delegation.delegatedAccountSigner),
      ...buffers,
    ].filter((signer): signer is Keypair => signer !== undefined);

    const { signature } = await this.sendTxV1(
      feePayer,
      [...createBufferIxs, ...delegateIxs],
      signTransaction,
      localSigners,
      options,
    );

    console.log(`✓ Delegated ${signers.delegations.length} account(s)`);
    console.log(`  Signature: ${signature}`);

    return { signature };
  }

  async depositFee(
    user: PublicKey,
    lamports: number,
    signTransaction: WalletSignTransaction,
    signers: DepositFeeV1Signers,
    options: TransactionOptions = {},
    recipient: PublicKey = user,
  ): Promise<TransactionResult> {
    const sessionPDA = await this.portal.deriveSessionPDA();
    const depositReceiptPDA = await this.portal.deriveDepositReceiptPDA(
      sessionPDA,
      recipient,
    );

    const ix = new TransactionInstruction({
      programId: this.portalProgramId,
      keys: [
        { pubkey: user, isSigner: true, isWritable: true },
        { pubkey: sessionPDA, isSigner: false, isWritable: false },
        { pubkey: depositReceiptPDA, isSigner: false, isWritable: true },
        { pubkey: recipient, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(
        this.portal.encodeDepositFee({ lamports: BigInt(lamports) }),
      ),
    });

    const feePayer = signers.feePayerSigner?.publicKey ?? user;


    const localSigners = this.keypairsFromSignersRecord(signers);

    const { signature } = await this.sendTxV1(
      feePayer,
      [ix],
      signTransaction,
      localSigners,
      options,
    );

    console.log(`✓ Fee deposited: ${lamports} lamports to ${recipient.toBase58()}`);
    console.log(`  Signature: ${signature}`);

    return { signature };
  }

  async undelegate(
    user: PublicKey,
    ownerProgramId: PublicKey,
    signTransaction: WalletSignTransaction,
    signers: UndelegateV1Signers,
    options: TransactionOptions = {},
  ): Promise<TransactionResult> {
    const delegatedAccount = signers.delegatedAccountSigner.publicKey;
    const delegationRecordPDA =
      await this.portal.deriveDelegationRecordPDA(delegatedAccount);
    const sessionPDA = await this.portal.deriveSessionPDA();

    const ix = new TransactionInstruction({
      programId: this.portalProgramId,
      keys: [
        { pubkey: user, isSigner: true, isWritable: true },
        {
          pubkey: delegatedAccount,
          isSigner: true,
          isWritable: true,
        },
        { pubkey: ownerProgramId, isSigner: false, isWritable: false },
        { pubkey: delegationRecordPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: sessionPDA, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(this.portal.encodeUndelegate()),
    });

    const feePayer = signers.feePayerSigner?.publicKey ?? user;

    const localSigners = this.keypairsFromSignersRecord(signers);

    const { signature } = await this.sendTxV1(
      feePayer,
      [ix],
      signTransaction,
      localSigners,
      options,
    );

    console.log(`✓ Account undelegated: ${delegatedAccount.toBase58()}`);
    console.log(`  Signature: ${signature}`);

    return { signature };
  }

  async closeSession(
    user: PublicKey,
    signTransaction: WalletSignTransaction,
    signers: SessionV1Signers,
    options: TransactionOptions = {},
  ): Promise<TransactionResult> {
    const sessionPDA = await this.portal.deriveSessionPDA();
    const feeVaultPDA = await this.portal.deriveFeeVaultPDA();
    const checkpointCursorPDA =
      await this.portal.deriveCheckpointCursorPDA(sessionPDA);

    const ix = new TransactionInstruction({
      programId: this.portalProgramId,
      keys: [
        { pubkey: user, isSigner: true, isWritable: true },
        { pubkey: sessionPDA, isSigner: false, isWritable: true },
        { pubkey: feeVaultPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: checkpointCursorPDA, isSigner: false, isWritable: true },
      ],
      data: Buffer.from(this.portal.encodeCloseSession()),
    });

    const feePayer = signers.feePayerSigner?.publicKey ?? user;
    if (
      signers.feePayerSigner &&
      !signers.feePayerSigner.publicKey.equals(feePayer)
    ) {
      throw new Error("signers.feePayerSigner must match fee payer pubkey");
    }

    const localSigners = this.keypairsFromSignersRecord(signers);

    const { signature } = await this.sendTxV1(
      feePayer,
      [ix],
      signTransaction,
      localSigners,
      options,
    );

    console.log(`✓ Session closed: ${sessionPDA.toBase58()}`);
    console.log(`  Signature: ${signature}`);

    return { signature };
  }

  async checkHealth(): Promise<{
    solana: boolean;
    ephemeralRollup: boolean;
  }> {
    const [ephemeralRollupHealthy] = await Promise.all([
      this.ephemeralRollupReader.isHealthy(),
    ]);

    let solanaHealthy = false;
    try {
      await this.rpc.getSlot();
      solanaHealthy = true;
    } catch {
      solanaHealthy = false;
    }

    return {
      solana: solanaHealthy,
      ephemeralRollup: ephemeralRollupHealthy,
    };
  }
}

export * from "./types";
export {
  PortalProgram,
  SESSION_DISCRIMINATOR,
  SESSION_LEN,
} from "./programs/portal";
export {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
  SystemProgram,
} from "@solana/web3.js";
