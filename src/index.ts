import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { AccountInfo, Address, NorthStarConfig } from "./types";
import { EphemeralRollupReader } from "./readers/EphemeralRollupReader";
import { AccountResolver } from "./readers/AccountResolver";
import { PortalProgram } from "./programs/portal";
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

export interface DelegateV1Signers {
  delegatedAccountSigner: Keypair;
  feePayerSigner?: Keypair;
}

/** openSession / closeSession: user is signed via signTransaction; optional local fee payer. */
export interface SessionV1Signers {
  feePayerSigner?: Keypair;
}

/** depositFee: depositor and fee payer; if depositorSigner is omitted, the wallet signs user. */
export interface DepositFeeV1Signers {
  depositorSigner?: Keypair;
  feePayerSigner?: Keypair;
}

/** undelegate: same as delegate (delegated account + optional fee payer). */
export type UndelegateV1Signers = DelegateV1Signers;

/** Wallet completes signatures on a partially locally-signed transaction; without local signers, this step completes user and any remaining signatures. */
export type WalletSignTransaction = (
  transaction: VersionedTransaction,
) => Promise<VersionedTransaction>;

const SYSTEM_PROGRAM_ID = SystemProgram.programId;

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

  constructor(config: NorthStarConfig) {
    this.config = config;
    this.portalProgramId = toPublicKey(config.portalProgramId);
    this.portal = new PortalProgram(this.portalProgramId);

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

  /**
   * Same flow as delegate_v1: local signers partial-sign first, then signTransaction (wallet), then on-chain confirmation.
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
  ): Promise<{
    instructions: TransactionInstruction[];
    feePayer: PublicKey;
    blockhash: string;
    lastValidBlockHeight: bigint;
  }> {
    const sessionPDA = await this.portal.deriveSessionPDA(
      signer.publicKey,
      gridId,
    );
    const feeVaultPDA = await this.portal.deriveFeeVaultPDA(signer.publicKey);

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
    delegatedAccount: PublicKey,
    gridId: number,
  ): Promise<{
    instructions: TransactionInstruction[];
    feePayer: PublicKey;
    blockhash: string;
    lastValidBlockHeight: bigint;
  }> {
    const delegationRecordPDA =
      await this.portal.deriveDelegationRecordPDA(delegatedAccount);

    const ix = new TransactionInstruction({
      programId: this.portalProgramId,
      keys: [
        { pubkey: signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: delegatedAccount, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: delegationRecordPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(this.portal.encodeDelegate({ gridId })),
    });

    const latestBlockhash = await this.rpc.getLatestBlockhash();

    return {
      instructions: [ix],
      feePayer: signer.publicKey,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: BigInt(latestBlockhash.lastValidBlockHeight),
    };
  }

  async buildDepositFee(
    signer: Keypair,
    sessionOwner: PublicKey,
    gridId: number,
    lamports: number,
  ): Promise<{
    instructions: TransactionInstruction[];
    feePayer: PublicKey;
    blockhash: string;
    lastValidBlockHeight: bigint;
  }> {
    const sessionPDA = await this.portal.deriveSessionPDA(sessionOwner, gridId);
    const depositReceiptPDA = await this.portal.deriveDepositReceiptPDA(
      sessionPDA,
      sessionOwner,
    );

    const ix = new TransactionInstruction({
      programId: this.portalProgramId,
      keys: [
        { pubkey: signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: sessionPDA, isSigner: false, isWritable: true },
        { pubkey: depositReceiptPDA, isSigner: false, isWritable: true },
        { pubkey: sessionOwner, isSigner: false, isWritable: false },
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

  async buildUndelegate(
    signer: Keypair,
    delegatedAccount: PublicKey,
  ): Promise<{
    instructions: TransactionInstruction[];
    feePayer: PublicKey;
    blockhash: string;
    lastValidBlockHeight: bigint;
  }> {
    const delegationRecordPDA =
      await this.portal.deriveDelegationRecordPDA(delegatedAccount);

    const ix = new TransactionInstruction({
      programId: this.portalProgramId,
      keys: [
        { pubkey: signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: delegatedAccount, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: delegationRecordPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
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
    gridId: number,
  ): Promise<{
    instructions: TransactionInstruction[];
    feePayer: PublicKey;
    blockhash: string;
    lastValidBlockHeight: bigint;
  }> {
    const sessionPDA = await this.portal.deriveSessionPDA(
      signer.publicKey,
      gridId,
    );
    const feeVaultPDA = await this.portal.deriveFeeVaultPDA(signer.publicKey);

    const ix = new TransactionInstruction({
      programId: this.portalProgramId,
      keys: [
        { pubkey: signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: sessionPDA, isSigner: false, isWritable: true },
        { pubkey: feeVaultPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(this.portal.encodeCloseSession({ gridId })),
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
  ): Promise<TransactionResult> {
    const sessionPDA = await this.portal.deriveSessionPDA(user, gridId);
    const feeVaultPDA = await this.portal.deriveFeeVaultPDA(user);

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
    ownerProgramId: PublicKey,
    signTransaction: WalletSignTransaction,
    signers: DelegateV1Signers,
    options: TransactionOptions = {},
  ): Promise<TransactionResult> {
    const delegatedAccount = signers.delegatedAccountSigner.publicKey;
    const delegationRecordPDA =
      await this.portal.deriveDelegationRecordPDA(delegatedAccount);

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
      ],
      data: Buffer.from(this.portal.encodeDelegate({ gridId })),
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

    console.log(`✓ Account delegated: ${delegatedAccount.toBase58()}`);
    console.log(`  Signature: ${signature}`);

    return { signature };
  }

  /** @deprecated Same as {@link delegate}; kept as an alias for backward compatibility. */
  async delegate_v1(
    user: PublicKey,
    gridId: number,
    ownerProgramId: PublicKey,
    signTransaction: WalletSignTransaction,
    signers: DelegateV1Signers,
    options: TransactionOptions = {},
  ): Promise<TransactionResult> {
    return this.delegate(user, gridId, ownerProgramId, signTransaction, signers, options);
  }

  async depositFee(
    user: PublicKey,
    sessionOwner: PublicKey,
    gridId: number,
    lamports: number,
    signTransaction: WalletSignTransaction,
    signers: DepositFeeV1Signers,
    options: TransactionOptions = {},
  ): Promise<TransactionResult> {
    const sessionPDA = await this.portal.deriveSessionPDA(sessionOwner, gridId);
    const depositReceiptPDA = await this.portal.deriveDepositReceiptPDA(
      sessionPDA,
      sessionOwner,
    );

    const ix = new TransactionInstruction({
      programId: this.portalProgramId,
      keys: [
        { pubkey: user, isSigner: true, isWritable: true },
        { pubkey: sessionPDA, isSigner: false, isWritable: true },
        { pubkey: depositReceiptPDA, isSigner: false, isWritable: true },
        { pubkey: sessionOwner, isSigner: false, isWritable: false },
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

    console.log(`✓ Fee deposited: ${lamports} lamports to ${sessionOwner.toBase58()}`);
    console.log(`  Signature: ${signature}`);

    return { signature };
  }

  async undelegate(
    user: PublicKey,
    signTransaction: WalletSignTransaction,
    signers: UndelegateV1Signers,
    options: TransactionOptions = {},
  ): Promise<TransactionResult> {
    const delegatedAccount = signers.delegatedAccountSigner.publicKey;
    const delegationRecordPDA =
      await this.portal.deriveDelegationRecordPDA(delegatedAccount);

    const ix = new TransactionInstruction({
      programId: this.portalProgramId,
      keys: [
        { pubkey: user, isSigner: true, isWritable: true },
        {
          pubkey: delegatedAccount,
          isSigner: true,
          isWritable: true,
        },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: delegationRecordPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
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
    gridId: number,
    signTransaction: WalletSignTransaction,
    signers: SessionV1Signers,
    options: TransactionOptions = {},
  ): Promise<TransactionResult> {
    const sessionPDA = await this.portal.deriveSessionPDA(user, gridId);
    const feeVaultPDA = await this.portal.deriveFeeVaultPDA(user);

    const ix = new TransactionInstruction({
      programId: this.portalProgramId,
      keys: [
        { pubkey: user, isSigner: true, isWritable: true },
        { pubkey: sessionPDA, isSigner: false, isWritable: true },
        { pubkey: feeVaultPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(this.portal.encodeCloseSession({ gridId })),
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
export { PortalProgram } from "./programs/portal";
export {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
  SystemProgram,
} from "@solana/web3.js";
