import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  assertIsTransactionWithBlockhashLifetime,
  assertIsSendableTransaction,
  sendAndConfirmTransactionFactory,
  generateKeyPairSigner,
  createKeyPairSignerFromPrivateKeyBytes,
  getSignatureFromTransaction,
  Address,
  Rpc,
  SolanaRpcApi,
  RpcSubscriptions,
  SolanaRpcSubscriptionsApi,
  TransactionSigner,
} from "@solana/kit";
import { NETWORKS } from "./config/networks";
import { AccountInfo, NorthStarConfig } from "./types";
import { EphemeralRollupReader } from "./readers/EphemeralRollupReader";
import { AccountResolver } from "./readers/AccountResolver";
import { PortalProgram } from "./programs/portal";

export type { Address, TransactionSigner };

export interface TransactionResult {
  signature: string;
  slot?: bigint;
}

export interface TransactionOptions {
  commitment?: "processed" | "confirmed" | "finalized";
}

/**
 * Main North Star SDK class
 * Provides unified interface for Ephemeral Rollup interactions
 */
export class NorthStarSDK {
  private rpc: Rpc<SolanaRpcApi>;
  private rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  private ephemeralRollupReader: EphemeralRollupReader;
  private accountResolver: AccountResolver;
  private config: NorthStarConfig;
  private portalProgramId: Address;
  private sendAndConfirmTransaction: ReturnType<
    typeof sendAndConfirmTransactionFactory
  >;

  /**
   * Initialize North Star SDK
   * @param config - SDK configuration
   */
  constructor(config: NorthStarConfig) {
    this.config = config;
    this.portalProgramId = config.portalProgramId || PortalProgram.PROGRAM_ID;

    const solanaRpc =
      config.customEndpoints?.solana || NETWORKS.solana[config.solanaNetwork];
    this.rpc = createSolanaRpc(solanaRpc);

    const wsUrl = solanaRpc
      .replace("https://", "wss://")
      .replace("http://", "ws://");
    this.rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);

    const ephemeralRollupRpc =
      config.customEndpoints?.ephemeralRollup ||
      NETWORKS.ephemeralRollup[config.solanaNetwork];
    this.ephemeralRollupReader = new EphemeralRollupReader(ephemeralRollupRpc);

    this.accountResolver = new AccountResolver(
      this.ephemeralRollupReader,
      this.rpc,
    );

    this.sendAndConfirmTransaction = sendAndConfirmTransactionFactory({
      rpc: this.rpc,
      rpcSubscriptions: this.rpcSubscriptions,
    });

    console.log("✓ North Star SDK initialized");
    console.log(`  Solana Network: ${config.solanaNetwork}`);
    console.log(`  Ephemeral Rollup RPC: ${ephemeralRollupRpc}`);
    console.log(`  Portal Program: ${this.portalProgramId}`);
  }

  /**
   * Generate a new keypair signer (for testing)
   */
  async generateKeyPair(): Promise<TransactionSigner> {
    return await generateKeyPairSigner();
  }

  /**
   * Create a keypair signer from base58 encoded private key
   * @param privateKeyBase58 - Base58 encoded private key
   */
  async createKeyPairFromBase58(
    privateKeyBase58: string,
  ): Promise<TransactionSigner> {
    const privateKeyBytes = Uint8Array.from(
      // Simple base58 decode for standard Solana private keys
      privateKeyBase58
        .split("")
        .map((c) =>
          "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".indexOf(
            c,
          ),
        ),
    );
    return await createKeyPairSignerFromPrivateKeyBytes(privateKeyBytes);
  }

  /**
   * Get account information using 2-tier fallback strategy
   * Priority: Ephemeral Rollup → Solana L1
   */
  async getAccountInfo(address: Address): Promise<AccountInfo> {
    return await this.accountResolver.resolve(address);
  }

  /**
   * Get multiple accounts in batch
   */
  async getMultipleAccounts(addresses: Address[]): Promise<AccountInfo[]> {
    return await this.accountResolver.resolveMultiple(addresses);
  }

  /**
   * Get Solana RPC instance
   */
  getRpc(): Rpc<SolanaRpcApi> {
    return this.rpc;
  }

  /**
   * Build (but don't send) an open session transaction
   */
  async buildOpenSession(
    signer: TransactionSigner,
    gridId: number,
    ttlSlots: number = 2000,
    feeCap: number = 1_000_000,
  ): Promise<{
    instructions: any[];
    feePayer: Address;
    blockhash: string;
    lastValidBlockHeight: bigint;
  }> {
    const sessionPDA = await PortalProgram.deriveSessionPDA(
      signer.address,
      gridId,
      this.portalProgramId,
    );
    const feeVaultPDA = await PortalProgram.deriveFeeVaultPDA(
      signer.address,
      this.portalProgramId,
    );

    const instruction = {
      version: 0,
      programAddress: this.portalProgramId,
      accounts: [
        { address: signer.address, role: 1 as const },
        { address: sessionPDA, role: 1 as const },
        { address: feeVaultPDA, role: 1 as const },
      ],
      data: PortalProgram.encodeOpenSession({
        gridId,
        ttlSlots: BigInt(ttlSlots),
        feeCap: BigInt(feeCap),
      }),
    };

    const { value: latestBlockhash } = await this.rpc
      .getLatestBlockhash()
      .send();

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(signer, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx) => appendTransactionMessageInstructions([instruction], tx),
    );

    return {
      instructions: [...transactionMessage.instructions],
      feePayer: signer.address,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    };
  }

  /**
   * Build (but don't send) a delegate transaction
   */
  async buildDelegate(
    signer: TransactionSigner,
    delegatedAccount: Address,
    gridId: number,
  ): Promise<{
    instructions: any[];
    feePayer: Address;
    blockhash: string;
    lastValidBlockHeight: bigint;
  }> {
    const delegationRecordPDA = await PortalProgram.deriveDelegationRecordPDA(
      delegatedAccount,
      this.portalProgramId,
    );

    const instruction = {
      version: 0,
      programAddress: this.portalProgramId,
      accounts: [
        { address: signer.address, role: 1 as const },
        { address: delegatedAccount, role: 1 as const },
        { address: delegationRecordPDA, role: 1 as const },
      ],
      data: PortalProgram.encodeDelegate({ gridId }),
    };

    const { value: latestBlockhash } = await this.rpc
      .getLatestBlockhash()
      .send();

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(signer, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx) => appendTransactionMessageInstructions([instruction], tx),
    );

    return {
      instructions: [...transactionMessage.instructions],
      feePayer: signer.address,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    };
  }

  /**
   * Build (but don't send) a deposit fee transaction
   */
  async buildDepositFee(
    signer: TransactionSigner,
    sessionOwner: Address,
    lamports: number,
  ): Promise<{
    instructions: any[];
    feePayer: Address;
    blockhash: string;
    lastValidBlockHeight: bigint;
  }> {
    const feeVaultPDA = await PortalProgram.deriveFeeVaultPDA(
      sessionOwner,
      this.portalProgramId,
    );

    const instruction = {
      version: 0,
      programAddress: this.portalProgramId,
      accounts: [
        { address: signer.address, role: 1 as const },
        { address: feeVaultPDA, role: 1 as const },
      ],
      data: PortalProgram.encodeDepositFee({ lamports: BigInt(lamports) }),
    };

    const { value: latestBlockhash } = await this.rpc
      .getLatestBlockhash()
      .send();

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(signer, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx) => appendTransactionMessageInstructions([instruction], tx),
    );

    return {
      instructions: [...transactionMessage.instructions],
      feePayer: signer.address,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    };
  }

  /**
   * Build (but don't send) an undelegate transaction
   */
  async buildUndelegate(
    signer: TransactionSigner,
    delegatedAccount: Address,
  ): Promise<{
    instructions: any[];
    feePayer: Address;
    blockhash: string;
    lastValidBlockHeight: bigint;
  }> {
    const delegationRecordPDA = await PortalProgram.deriveDelegationRecordPDA(
      delegatedAccount,
      this.portalProgramId,
    );

    const instruction = {
      version: 0,
      programAddress: this.portalProgramId,
      accounts: [
        { address: signer.address, role: 1 as const },
        { address: delegatedAccount, role: 1 as const },
        { address: delegationRecordPDA, role: 1 as const },
      ],
      data: PortalProgram.encodeUndelegate(),
    };

    const { value: latestBlockhash } = await this.rpc
      .getLatestBlockhash()
      .send();

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(signer, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx) => appendTransactionMessageInstructions([instruction], tx),
    );

    return {
      instructions: [...transactionMessage.instructions],
      feePayer: signer.address,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    };
  }

  /**
   * Build (but don't send) a close session transaction
   */
  async buildCloseSession(
    signer: TransactionSigner,
    gridId: number,
  ): Promise<{
    instructions: any[];
    feePayer: Address;
    blockhash: string;
    lastValidBlockHeight: bigint;
  }> {
    const sessionPDA = await PortalProgram.deriveSessionPDA(
      signer.address,
      gridId,
      this.portalProgramId,
    );
    const feeVaultPDA = await PortalProgram.deriveFeeVaultPDA(
      signer.address,
      this.portalProgramId,
    );

    const instruction = {
      version: 0,
      programAddress: this.portalProgramId,
      accounts: [
        { address: signer.address, role: 1 as const },
        { address: sessionPDA, role: 1 as const },
        { address: feeVaultPDA, role: 1 as const },
      ],
      data: PortalProgram.encodeCloseSession({ gridId }),
    };

    const { value: latestBlockhash } = await this.rpc
      .getLatestBlockhash()
      .send();

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(signer, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx) => appendTransactionMessageInstructions([instruction], tx),
    );

    return {
      instructions: [...transactionMessage.instructions],
      feePayer: signer.address,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    };
  }

  /**
   * Open a session for Portal operations
   * Creates a Session and FeeVault for the owner
   */
  async openSession(
    signer: TransactionSigner,
    gridId: number,
    ttlSlots: number = 2000,
    feeCap: number = 1_000_000,
  ): Promise<TransactionResult> {
    const sessionPDA = await PortalProgram.deriveSessionPDA(
      signer.address,
      gridId,
      this.portalProgramId,
    );
    const feeVaultPDA = await PortalProgram.deriveFeeVaultPDA(
      signer.address,
      this.portalProgramId,
    );

    const instruction = {
      version: 0,
      programAddress: this.portalProgramId,
      accounts: [
        { address: signer.address, role: 1 as const },
        { address: sessionPDA, role: 1 as const },
        { address: feeVaultPDA, role: 1 as const },
      ],
      data: PortalProgram.encodeOpenSession({
        gridId,
        ttlSlots: BigInt(ttlSlots),
        feeCap: BigInt(feeCap),
      }),
    };

    const { value: latestBlockhash } = await this.rpc
      .getLatestBlockhash()
      .send();

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(signer, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx) => appendTransactionMessageInstructions([instruction], tx),
    );

    const transaction =
      await signTransactionMessageWithSigners(transactionMessage);
    assertIsSendableTransaction(transaction);
    assertIsTransactionWithBlockhashLifetime(transaction);

    await this.sendAndConfirmTransaction(transaction, {
      commitment: "confirmed",
    });
    const signature = getSignatureFromTransaction(transaction);

    console.log(`✓ Session opened: ${sessionPDA}`);
    console.log(`  Signature: ${signature}`);

    return { signature };
  }

  /**
   * Delegate an account to another program via Portal
   */
  async delegate(
    signer: TransactionSigner,
    delegatedAccount: Address,
    gridId: number,
  ): Promise<TransactionResult> {
    const delegationRecordPDA = await PortalProgram.deriveDelegationRecordPDA(
      delegatedAccount,
      this.portalProgramId,
    );

    const instruction = {
      version: 0,
      programAddress: this.portalProgramId,
      accounts: [
        { address: signer.address, role: 1 as const },
        { address: delegatedAccount, role: 1 as const },
        { address: delegationRecordPDA, role: 1 as const },
      ],
      data: PortalProgram.encodeDelegate({ gridId }),
    };

    const { value: latestBlockhash } = await this.rpc
      .getLatestBlockhash()
      .send();

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(signer, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx) => appendTransactionMessageInstructions([instruction], tx),
    );

    const transaction =
      await signTransactionMessageWithSigners(transactionMessage);
    assertIsSendableTransaction(transaction);
    assertIsTransactionWithBlockhashLifetime(transaction);

    await this.sendAndConfirmTransaction(transaction, {
      commitment: "confirmed",
    });
    const signature = getSignatureFromTransaction(transaction);

    console.log(`✓ Account delegated: ${delegatedAccount}`);
    console.log(`  Signature: ${signature}`);

    return { signature };
  }

  /**
   * Deposit fees into a session's fee vault
   */
  async depositFee(
    signer: TransactionSigner,
    sessionOwner: Address,
    lamports: number,
  ): Promise<TransactionResult> {
    const feeVaultPDA = await PortalProgram.deriveFeeVaultPDA(
      sessionOwner,
      this.portalProgramId,
    );

    const instruction = {
      version: 0,
      programAddress: this.portalProgramId,
      accounts: [
        { address: signer.address, role: 1 as const },
        { address: feeVaultPDA, role: 1 as const },
      ],
      data: PortalProgram.encodeDepositFee({ lamports: BigInt(lamports) }),
    };

    const { value: latestBlockhash } = await this.rpc
      .getLatestBlockhash()
      .send();

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(signer, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx) => appendTransactionMessageInstructions([instruction], tx),
    );

    const transaction =
      await signTransactionMessageWithSigners(transactionMessage);
    assertIsSendableTransaction(transaction);
    assertIsTransactionWithBlockhashLifetime(transaction);

    await this.sendAndConfirmTransaction(transaction, {
      commitment: "confirmed",
    });
    const signature = getSignatureFromTransaction(transaction);

    console.log(`✓ Fee deposited: ${lamports} lamports to ${sessionOwner}`);
    console.log(`  Signature: ${signature}`);

    return { signature };
  }

  /**
   * Undelegate an account from Portal
   */
  async undelegate(
    signer: TransactionSigner,
    delegatedAccount: Address,
  ): Promise<TransactionResult> {
    const delegationRecordPDA = await PortalProgram.deriveDelegationRecordPDA(
      delegatedAccount,
      this.portalProgramId,
    );

    const instruction = {
      version: 0,
      programAddress: this.portalProgramId,
      accounts: [
        { address: signer.address, role: 1 as const },
        { address: delegatedAccount, role: 1 as const },
        { address: delegationRecordPDA, role: 1 as const },
      ],
      data: PortalProgram.encodeUndelegate(),
    };

    const { value: latestBlockhash } = await this.rpc
      .getLatestBlockhash()
      .send();

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(signer, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx) => appendTransactionMessageInstructions([instruction], tx),
    );

    const transaction =
      await signTransactionMessageWithSigners(transactionMessage);
    assertIsSendableTransaction(transaction);
    assertIsTransactionWithBlockhashLifetime(transaction);

    await this.sendAndConfirmTransaction(transaction, {
      commitment: "confirmed",
    });
    const signature = getSignatureFromTransaction(transaction);

    console.log(`✓ Account undelegated: ${delegatedAccount}`);
    console.log(`  Signature: ${signature}`);

    return { signature };
  }

  /**
   * Close an expired session
   */
  async closeSession(
    signer: TransactionSigner,
    gridId: number,
  ): Promise<TransactionResult> {
    const sessionPDA = await PortalProgram.deriveSessionPDA(
      signer.address,
      gridId,
      this.portalProgramId,
    );
    const feeVaultPDA = await PortalProgram.deriveFeeVaultPDA(
      signer.address,
      this.portalProgramId,
    );

    const instruction = {
      version: 0,
      programAddress: this.portalProgramId,
      accounts: [
        { address: signer.address, role: 1 as const },
        { address: sessionPDA, role: 1 as const },
        { address: feeVaultPDA, role: 1 as const },
      ],
      data: PortalProgram.encodeCloseSession({ gridId }),
    };

    const { value: latestBlockhash } = await this.rpc
      .getLatestBlockhash()
      .send();

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(signer, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx) => appendTransactionMessageInstructions([instruction], tx),
    );

    const transaction =
      await signTransactionMessageWithSigners(transactionMessage);
    assertIsSendableTransaction(transaction);
    assertIsTransactionWithBlockhashLifetime(transaction);

    await this.sendAndConfirmTransaction(transaction, {
      commitment: "confirmed",
    });
    const signature = getSignatureFromTransaction(transaction);

    console.log(`✓ Session closed: ${sessionPDA}`);
    console.log(`  Signature: ${signature}`);

    return { signature };
  }

  /**
   * Check health of all connected services
   */
  async checkHealth(): Promise<{
    solana: boolean;
    ephemeralRollup: boolean;
  }> {
    const [ephemeralRollupHealthy] = await Promise.all([
      this.ephemeralRollupReader.isHealthy(),
    ]);

    let solanaHealthy = false;
    try {
      await this.rpc.getSlot().send();
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

// Re-export types and Kit utilities for convenience
export * from "./types";
export { PORTAL_PROGRAM_ID, PortalProgram } from "./programs/portal";
export { createSolanaRpc } from "@solana/kit";
