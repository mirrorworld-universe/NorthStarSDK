import {
  createSolanaRpc,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  assertIsTransactionWithBlockhashLifetime,
  assertIsSendableTransaction,
  generateKeyPairSigner,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  getSignatureFromTransaction,
  getAddressEncoder,
  address,
  sendTransactionWithoutConfirmingFactory,
  AccountRole,
  Address,
  Rpc,
  SolanaRpcApi,
  TransactionSigner,
  partiallySignTransactionMessageWithSigners,
} from "@solana/kit";
import bs58 from "bs58";
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
  skipPreflight?: boolean;
  maxAttempts?: number;
  intervalMs?: number;
}

export interface DelegateV1Signers {
  delegatedAccountSigner: TransactionSigner;
  feePayerSigner?: TransactionSigner;
}

/** 钱包对「已本地部分签名」的交易做最终签名；不传 signers。无 feePayerSigner 时，该签名同时承担用户/fee payer 角色。 */
export type DelegateV1WalletSignTransaction = (transaction: any) => Promise<any>;

const SYSTEM_PROGRAM_ID = address("11111111111111111111111111111111");

export function encodeSystemProgramAssignData(newProgramOwner: Address): Uint8Array {
  const addressEncoder = getAddressEncoder();
  const data = new Uint8Array(4 + 32);
  new DataView(data.buffer).setUint32(0, 1, true);
  data.set(addressEncoder.encode(newProgramOwner), 4);
  return data;
}

/**
 * Main North Star SDK class
 * Provides unified interface for Ephemeral Rollup interactions
 */
export class NorthStarSDK {
  private rpc: Rpc<SolanaRpcApi>;
  private ephemeral_rpc: Rpc<SolanaRpcApi>;
  private ephemeralRollupReader: EphemeralRollupReader;
  public accountResolver: AccountResolver;
  private config: NorthStarConfig;
  private portalProgramId: Address;
  public readonly portal: PortalProgram;
  private sendTransactionWithoutConfirming: ReturnType<
    typeof sendTransactionWithoutConfirmingFactory
  >;

  /**
   * Initialize North Star SDK
   * @param config - SDK configuration
   */
  constructor(config: NorthStarConfig) {
    this.config = config;
    this.portalProgramId = config.portalProgramId;
    this.portal = new PortalProgram(this.portalProgramId);

    const solanaRpc =
      config.customEndpoints.solana;
    this.rpc = createSolanaRpc(solanaRpc);


    const ephemeralRollupRpc =
      config.customEndpoints.ephemeralRollup;
    this.ephemeral_rpc = createSolanaRpc(ephemeralRollupRpc);
    this.ephemeralRollupReader = new EphemeralRollupReader(ephemeralRollupRpc);

    this.accountResolver = new AccountResolver(
      this.ephemeralRollupReader,
      this.rpc,
    );

    this.sendTransactionWithoutConfirming = sendTransactionWithoutConfirmingFactory(
      {
      rpc: this.rpc,
      },
    );

    console.log("✓ North Star SDK initialized");
    console.log(`  Solana Network: ${solanaRpc}`);
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
    const bytes = Uint8Array.from(bs58.decode(privateKeyBase58.trim()));
    if (bytes.length === 64) {
      return await createKeyPairSignerFromBytes(bytes);
    }
    if (bytes.length === 32) {
      return await createKeyPairSignerFromPrivateKeyBytes(bytes);
    }
    throw new Error(
      `Private key decodes to ${bytes.length} bytes; expected 32 or 64.`,
    );
  }

  /**
   * Get account information using 2-tier fallback strategy
   * Priority: Ephemeral Rollup → Solana L1
   */
  async getAccountInfo(address: Address, search_source: 'ephemeral' | 'solana'): Promise<AccountInfo> {
    return await this.accountResolver.resolve(address, search_source);
  }

  /**
   * Get multiple accounts in batch
   */
  async getMultipleAccounts(addresses: Address[], search_source: 'ephemeral' | 'solana'): Promise<AccountInfo[]> {
    return await this.accountResolver.resolveMultiple(addresses, search_source);
  }

  /**
   * Get Solana RPC instance
   */
  getRpc(): Rpc<SolanaRpcApi> {
    return this.rpc;
  }

  /**
   * Get Ephemeral Rollup RPC instance
   */
  getEphemeralRpc(): Rpc<SolanaRpcApi> {
    return this.ephemeral_rpc;
  }

  getPortalProgramId(): Address {
    return this.portalProgramId;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async confirmSignature(
    signature: string,
    options: TransactionOptions = {},
  ): Promise<void> {
    const commitment = options.commitment || "confirmed";
    const maxAttempts = options.maxAttempts ?? 20;
    const intervalMs = options.intervalMs ?? 1000;

    for (let i = 0; i < maxAttempts; i++) {
      const statuses = await (this.rpc as any)
        .getSignatureStatuses([signature])
        .send();
      const status = statuses?.value?.[0];

      if (status?.err) {
        throw new Error(
          `Transaction failed on-chain: status.err ${JSON.stringify(status.err)}`,
        );
      }

      if (
        status &&
        (status.confirmationStatus === commitment ||
          status.confirmationStatus === "finalized" ||
          (commitment === "processed" &&
            (status.confirmationStatus === "confirmed" ||
              status.confirmationStatus === "finalized")))
      ) {
        return;
      }

      await this.sleep(intervalMs);
    }

    throw new Error(
      `Transaction confirmation timeout (HTTP polling): ${String(signature)}`,
    );
  }

  async sendAndConfirmTransactionWithoutWebsocket(
    transaction: any,
    options: TransactionOptions = {},
  ): Promise<{ signature: string }> {
    const commitment = options.commitment || "confirmed";
    const skipPreflight = options.skipPreflight ?? true;
    await this.sendTransactionWithoutConfirming(transaction, {
      commitment,
      skipPreflight,
    });
    const signature = getSignatureFromTransaction(transaction);
    await this.confirmSignature(signature, options);
    return { signature };
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
    const sessionPDA = await this.portal.deriveSessionPDA(signer.address, gridId);
    const feeVaultPDA = await this.portal.deriveFeeVaultPDA(signer.address);

    const instruction = {
      version: 0,
      programAddress: this.portalProgramId,
      accounts: [
        { address: signer.address, role: 1 as const },
        { address: sessionPDA, role: 1 as const },
        { address: feeVaultPDA, role: 1 as const },
        { address: SYSTEM_PROGRAM_ID, role: 0 as const },
      ],
      data: this.portal.encodeOpenSession({
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
    const delegationRecordPDA =
      await this.portal.deriveDelegationRecordPDA(delegatedAccount);

    const instruction = {
      version: 0,
      programAddress: this.portalProgramId,
      accounts: [
        { address: signer.address, role: 1 as const },
        { address: delegatedAccount, role: 1 as const },
        { address: SYSTEM_PROGRAM_ID, role: 0 as const },
        { address: delegationRecordPDA, role: 1 as const },
        { address: SYSTEM_PROGRAM_ID, role: 0 as const },
      ],
      data: this.portal.encodeDelegate({ gridId }),
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
    gridId: number,
    lamports: number,
  ): Promise<{
    instructions: any[];
    feePayer: Address;
    blockhash: string;
    lastValidBlockHeight: bigint;
  }> {
    const sessionPDA = await this.portal.deriveSessionPDA(sessionOwner, gridId);
    const depositReceiptPDA = await this.portal.deriveDepositReceiptPDA(
      sessionPDA,
      sessionOwner,
    );

    const instruction = {
      version: 0,
      programAddress: this.portalProgramId,
      accounts: [
        { address: signer.address, role: 1 as const },
        { address: sessionPDA, role: 1 as const },
        { address: depositReceiptPDA, role: 1 as const },
        { address: sessionOwner, role: 0 as const },
        { address: SYSTEM_PROGRAM_ID, role: 0 as const },
      ],
      data: this.portal.encodeDepositFee({ lamports: BigInt(lamports) }),
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
    const delegationRecordPDA =
      await this.portal.deriveDelegationRecordPDA(delegatedAccount);

    const instruction = {
      version: 0,
      programAddress: this.portalProgramId,
      accounts: [
        { address: signer.address, role: 1 as const },
        { address: delegatedAccount, role: 1 as const },
        { address: SYSTEM_PROGRAM_ID, role: 0 as const },
        { address: delegationRecordPDA, role: 1 as const },
        { address: SYSTEM_PROGRAM_ID, role: 0 as const },
      ],
      data: this.portal.encodeUndelegate(),
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
    const sessionPDA = await this.portal.deriveSessionPDA(signer.address, gridId);
    const feeVaultPDA = await this.portal.deriveFeeVaultPDA(signer.address);

    const instruction = {
      version: 0,
      programAddress: this.portalProgramId,
      accounts: [
        { address: signer.address, role: 1 as const },
        { address: sessionPDA, role: 1 as const },
        { address: feeVaultPDA, role: 1 as const },
        { address: SYSTEM_PROGRAM_ID, role: 0 as const },
      ],
      data: this.portal.encodeCloseSession({ gridId }),
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
    options: TransactionOptions = {},
  ): Promise<TransactionResult> {
    const sessionPDA = await this.portal.deriveSessionPDA(signer.address, gridId);
    const feeVaultPDA = await this.portal.deriveFeeVaultPDA(signer.address);

    const instruction = {
      version: 0,
      programAddress: this.portalProgramId,
      accounts: [
        { address: signer.address, role: 1 as const },
        { address: sessionPDA, role: 1 as const },
        { address: feeVaultPDA, role: 1 as const },
        { address: SYSTEM_PROGRAM_ID, role: 0 as const },
      ],
      data: this.portal.encodeOpenSession({
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

    const { signature } = await this.sendAndConfirmTransactionWithoutWebsocket(
      transaction,
      options,
    );

    console.log(`✓ Session opened: ${sessionPDA}`);
    console.log(`  Signature: ${signature}`);

    return { signature };
  }

  /**
   * Delegate an account to another program via Portal
   */
  async delegate(
    signer: TransactionSigner,
    delegatedAccountSigner: TransactionSigner,
    gridId: number,
    ownerProgramId: Address,
    options: TransactionOptions = {},
  ): Promise<TransactionResult> {
    const delegatedAccount = delegatedAccountSigner.address;
    const delegationRecordPDA =
      await this.portal.deriveDelegationRecordPDA(delegatedAccount);

    const delegateInstruction = {
      version: 0,
      programAddress: this.portalProgramId,
      accounts: [
        { address: signer.address, role: 1 as const },
        {
          address: delegatedAccount,
          role: AccountRole.WRITABLE_SIGNER,
          signer: delegatedAccountSigner,
        },
        { address: ownerProgramId, role: 0 as const },
        { address: delegationRecordPDA, role: 1 as const },
        { address: SYSTEM_PROGRAM_ID, role: 0 as const },
      ],
      data: this.portal.encodeDelegate({ gridId }),
    };

    const { value: latestBlockhash } = await this.rpc
      .getLatestBlockhash()
      .send();

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(signer, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx) => appendTransactionMessageInstructions([delegateInstruction], tx),
    );

    const transaction =
      await signTransactionMessageWithSigners(transactionMessage);
    assertIsSendableTransaction(transaction);
    assertIsTransactionWithBlockhashLifetime(transaction);

    const { signature } = await this.sendAndConfirmTransactionWithoutWebsocket(
      transaction,
      options,
    );

    console.log(`✓ Account delegated: ${delegatedAccount}`);
    console.log(`  Signature: ${signature}`);

    return { signature };
  }


  async delegate_v1(
    user: Address,
    gridId: number,
    ownerProgramId: Address,
    signTransaction: DelegateV1WalletSignTransaction,
    signers: DelegateV1Signers,
    options: TransactionOptions = {},
  ): Promise<TransactionResult> {
    const delegatedAccount = signers.delegatedAccountSigner.address;
    const delegationRecordPDA =
      await this.portal.deriveDelegationRecordPDA(delegatedAccount);

    const delegateInstruction = {
      version: 0,
      programAddress: this.portalProgramId,
      accounts: [
        { address: user, role: 1 as const },
        {
          address: delegatedAccount,
          role: AccountRole.WRITABLE_SIGNER,
          signer: signers.delegatedAccountSigner,
        },
        { address: ownerProgramId, role: 0 as const },
        { address: delegationRecordPDA, role: 1 as const },
        { address: SYSTEM_PROGRAM_ID, role: 0 as const },
      ],
      data: this.portal.encodeDelegate({ gridId }),
    };

    const { value: latestBlockhash } = await this.rpc
      .getLatestBlockhash()
      .send();

    const transactionMessageWithoutFeePayer = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx) => appendTransactionMessageInstructions([delegateInstruction], tx),
    );

    // 1) 设置 fee payer 公钥：有本地 fee payer 密钥则用 signer，否则仅 pubkey（由后续钱包 signTransaction 补签）
    let transactionMessageWithFeePayer: any;
    if (signers.feePayerSigner) {
      if (signers.feePayerSigner.address !== user) {
        throw new Error("signers.feePayerSigner address must match user");
      }
      transactionMessageWithFeePayer = setTransactionMessageFeePayerSigner(
        signers.feePayerSigner,
        transactionMessageWithoutFeePayer,
      );
    } else {
      transactionMessageWithFeePayer = {
        ...transactionMessageWithoutFeePayer,
        feePayer: user,
      };
    }

    // 2) 用 signers 里嵌入的私钥做部分签名（含 delegated；若有 feePayerSigner 则一并签）
    const transactionPartiallySigned =
      await partiallySignTransactionMessageWithSigners(
        transactionMessageWithFeePayer,
      );

    // 3) 钱包始终再签一次；无 feePayerSigner 时，该步同时是用户/fee payer 签名
    const transaction = await signTransaction(transactionPartiallySigned);
    assertIsSendableTransaction(transaction);
    assertIsTransactionWithBlockhashLifetime(transaction);

    const { signature } = await this.sendAndConfirmTransactionWithoutWebsocket(
      transaction,
      options,
    );

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
    gridId: number,
    lamports: number,
    options: TransactionOptions = {},
  ): Promise<TransactionResult> {
    const sessionPDA = await this.portal.deriveSessionPDA(sessionOwner, gridId);
    const depositReceiptPDA = await this.portal.deriveDepositReceiptPDA(
      sessionPDA,
      sessionOwner,
    );

    const instruction = {
      version: 0,
      programAddress: this.portalProgramId,
      accounts: [
        { address: signer.address, role: 1 as const },
        { address: sessionPDA, role: 1 as const },
        { address: depositReceiptPDA, role: 1 as const },
        { address: sessionOwner, role: 0 as const },
        { address: SYSTEM_PROGRAM_ID, role: 0 as const },
      ],
      data: this.portal.encodeDepositFee({ lamports: BigInt(lamports) }),
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

    const { signature } = await this.sendAndConfirmTransactionWithoutWebsocket(
      transaction,
      options,
    );

    console.log(`✓ Fee deposited: ${lamports} lamports to ${sessionOwner}`);
    console.log(`  Signature: ${signature}`);

    return { signature };
  }

  /**
   * Undelegate an account from Portal
   */
  async undelegate(
    signer: TransactionSigner,
    delegatedAccountSigner: TransactionSigner,
    options: TransactionOptions = {},
  ): Promise<TransactionResult> {
    const delegatedAccount = delegatedAccountSigner.address;
    const delegationRecordPDA =
      await this.portal.deriveDelegationRecordPDA(delegatedAccount);

    const instruction = {
      version: 0,
      programAddress: this.portalProgramId,
      accounts: [
        { address: signer.address, role: 1 as const },
        {
          address: delegatedAccount,
          role: AccountRole.WRITABLE_SIGNER,
          signer: delegatedAccountSigner,
        },
        { address: SYSTEM_PROGRAM_ID, role: 0 as const },
        { address: delegationRecordPDA, role: 1 as const },
        { address: SYSTEM_PROGRAM_ID, role: 0 as const },
      ],
      data: this.portal.encodeUndelegate(),
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

    const { signature } = await this.sendAndConfirmTransactionWithoutWebsocket(
      transaction,
      options,
    );

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
    options: TransactionOptions = {},
  ): Promise<TransactionResult> {
    const sessionPDA = await this.portal.deriveSessionPDA(signer.address, gridId);
    const feeVaultPDA = await this.portal.deriveFeeVaultPDA(signer.address);

    const instruction = {
      version: 0,
      programAddress: this.portalProgramId,
      accounts: [
        { address: signer.address, role: 1 as const },
        { address: sessionPDA, role: 1 as const },
        { address: feeVaultPDA, role: 1 as const },
        { address: SYSTEM_PROGRAM_ID, role: 0 as const },
      ],
      data: this.portal.encodeCloseSession({ gridId }),
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

    const { signature } = await this.sendAndConfirmTransactionWithoutWebsocket(
      transaction,
      options,
    );

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
export { PortalProgram } from "./programs/portal";
export { createSolanaRpc } from "@solana/kit";
