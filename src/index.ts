import { createSolanaRpc, Rpc, SolanaRpcApi } from '@solana/rpc';
import { Address } from '@solana/addresses';
import { NETWORKS } from './config/networks';
import { AccountInfo, NorthStarConfig } from './types';
import { EphemeralRollupReader } from './readers/EphemeralRollupReader';
import { AccountResolver } from './readers/AccountResolver';
import { TransactionBuilder } from './builders/TransactionBuilder';
import { SessionManager } from './session/SessionManager';
import { PORTAL_PROGRAM_ID } from './programs/portal';

/**
 * Main North Star SDK class
 * Provides unified interface for Ephemeral Rollup interactions
 */
export class NorthStarSDK {
  private rpc: Rpc<SolanaRpcApi>;
  private ephemeralRollupReader: EphemeralRollupReader;
  private accountResolver: AccountResolver;
  private transactionBuilder: TransactionBuilder;
  private sessionManager: SessionManager;
  private config: NorthStarConfig;
  private portalProgramId: Address;

  /**
   * Initialize North Star SDK
   * @param config - SDK configuration
   */
  constructor(config: NorthStarConfig) {
    this.config = config;
    this.portalProgramId = config.portalProgramId || PORTAL_PROGRAM_ID;

    const solanaRpc =
      config.customEndpoints?.solana ||
      NETWORKS.solana[config.solanaNetwork];
    this.rpc = createSolanaRpc(solanaRpc);

    const ephemeralRollupRpc =
      config.customEndpoints?.ephemeralRollup ||
      NETWORKS.ephemeralRollup[config.solanaNetwork];
    this.ephemeralRollupReader = new EphemeralRollupReader(ephemeralRollupRpc);

    this.accountResolver = new AccountResolver(
      this.ephemeralRollupReader,
      this.rpc
    );

    this.transactionBuilder = new TransactionBuilder(this.rpc, this.portalProgramId);

    this.sessionManager = new SessionManager(this.portalProgramId);

    console.log('✓ North Star SDK initialized');
    console.log(`  Solana Network: ${config.solanaNetwork}`);
    console.log(`  Ephemeral Rollup RPC: ${ephemeralRollupRpc}`);
    console.log(`  Portal Program: ${this.portalProgramId}`);
  }

  /**
   * Get account information using 2-tier fallback strategy
   * Priority: Ephemeral Rollup → Solana L1
   *
   * @param address - Account address
   * @returns Account information with source indicator
   */
  async getAccountInfo(address: Address): Promise<AccountInfo> {
    return await this.accountResolver.resolve(address);
  }

  /**
   * Get multiple accounts in batch
   * @param addresses - Array of account addresses
   * @returns Array of account information
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
   * Open a session for Portal operations
   * Builds a transaction to create a Session and FeeVault
   *
   * @param owner - Session owner address
   * @param gridId - Target grid ID
   * @param ttlSlots - Time to live in slots (default: 2000)
   * @param feeCap - Maximum fee budget in lamports (default: 1_000_000)
   * @returns Prepared transaction data
   */
  async openSession(
    owner: Address,
    gridId: number,
    ttlSlots: number = 2000,
    feeCap: number = 1_000_000
  ): Promise<any> {
    return await this.transactionBuilder.buildOpenSessionTx(
      owner,
      gridId,
      BigInt(ttlSlots),
      BigInt(feeCap)
    );
  }

  /**
   * Delegate an account to another program via Portal
   * Builds a transaction to create a DelegationRecord
   *
   * @param owner - Account owner address
   * @param delegatedAccount - Account to delegate
   * @param gridId - Target grid ID
   * @returns Prepared transaction data
   */
  async delegate(
    owner: Address,
    delegatedAccount: Address,
    gridId: number
  ): Promise<any> {
    return await this.transactionBuilder.buildDelegateTx(
      owner,
      delegatedAccount,
      gridId
    );
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
export * from './types';
export * from './programs/portal';
export { Address } from '@solana/addresses';
export { createSolanaRpc } from '@solana/rpc';
