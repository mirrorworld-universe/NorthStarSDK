/**
 * Transaction Builder
 * Constructs Solana transactions for Portal operations
 */

import { Connection, PublicKey } from "@solana/web3.js";
import {
  PortalProgram,
  OpenSessionParams,
  CloseSessionParams,
  DepositFeeParams,
  DelegateParams,
} from "../programs/portal";
import { ReadTransactionParams } from "../types";

export class TransactionBuilder {
  private connection: Connection;
  private portalProgramId: PublicKey;
  private readonly systemProgramId: PublicKey = new PublicKey(
    "11111111111111111111111111111111",
  );

  constructor(
    connection: Connection,
    portalProgramId: PublicKey,
  ) {
    this.connection = connection;
    this.portalProgramId = portalProgramId;
  }

  /**
   * Build a transaction to read via Portal delegate instruction
   * Constructs a Solana transaction for reading account data via Portal
   *
   * @param params - Transaction parameters
   * @returns Prepared transaction data structure
   */
  async buildReadTx(params: ReadTransactionParams): Promise<any> {
    const { gridId, accountAddress, sessionPDA } = params;

    const latestBlockhash = await this.connection.getLatestBlockhash();

    const delegateParams: DelegateParams = { gridId };
    const delegateInstruction = PortalProgram.encodeDelegate(delegateParams);

    return {
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      instructions: [
        {
          programPublicKey: this.portalProgramId,
          accounts: [{ address: accountAddress, role: 1 }],
          data: delegateInstruction,
        },
      ],
    };
  }

  /**
   * Build a transaction to open a session
   * Creates a transaction for session initialization
   *
   * @param owner - Session owner address
   * @param gridId - Target grid ID
   * @param ttlSlots - Time to live in slots
   * @param feeCap - Maximum fee budget in lamports
   * @returns Prepared transaction data
   */
  async buildOpenSessionTx(
    owner: PublicKey,
    gridId: number,
    ttlSlots: bigint = BigInt(2000),
    feeCap: bigint = BigInt(1_000_000),
  ): Promise<any> {
    const latestBlockhash = await this.connection.getLatestBlockhash();

    const sessionPDA = await PortalProgram.deriveSessionPDA(
      owner,
      gridId,
      this.portalProgramId,
    );
    const feeVaultPDA = await PortalProgram.deriveFeeVaultPDA(
      owner,
      this.portalProgramId,
    );

    const openSessionParams: OpenSessionParams = {
      gridId,
      ttlSlots,
      feeCap,
    };

    return {
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      feePayer: owner,
      instructions: [
        {
          programPublicKey: this.portalProgramId,
          accounts: [
            { address: owner, role: 1 },
            { address: sessionPDA, role: 1 },
            { address: feeVaultPDA, role: 1 },
            { address: this.systemProgramId, role: 0 },
          ],
          data: PortalProgram.encodeOpenSession(openSessionParams),
        },
      ],
    };
  }

  /**
   * Build a transaction to close an expired session
   *
   * @param owner - Session owner address
   * @param gridId - Grid ID
   * @returns Prepared transaction data
   */
  async buildCloseSessionTx(owner: PublicKey, gridId: number): Promise<any> {
    const latestBlockhash = await this.connection.getLatestBlockhash();

    const sessionPDA = await PortalProgram.deriveSessionPDA(
      owner,
      gridId,
      this.portalProgramId,
    );
    const feeVaultPDA = await PortalProgram.deriveFeeVaultPDA(
      owner,
      this.portalProgramId,
    );

    const closeSessionParams: CloseSessionParams = { gridId };

    return {
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      feePayer: owner,
      instructions: [
        {
          programPublicKey: this.portalProgramId,
          accounts: [
            { address: owner, role: 1 },
            { address: sessionPDA, role: 1 },
            { address: feeVaultPDA, role: 1 },
            { address: this.systemProgramId, role: 0 },
          ],
          data: PortalProgram.encodeCloseSession(closeSessionParams),
        },
      ],
    };
  }

  /**
   * Build a transaction to deposit fees into a session's fee vault
   *
   * @param depositor - The account depositing fees
   * @param sessionOwner - The session owner (fee vault authority)
   * @param lamports - Amount of lamports to deposit
   * @returns Prepared transaction data
   */
  async buildDepositFeeTx(
    depositor: PublicKey,
    sessionOwner: PublicKey,
    gridId: number,
    lamports: bigint,
  ): Promise<any> {
    const latestBlockhash = await this.connection.getLatestBlockhash();

    const sessionPDA = await PortalProgram.deriveSessionPDA(
      sessionOwner,
      gridId,
      this.portalProgramId,
    );
    const depositReceiptPDA = await PortalProgram.deriveDepositReceiptPDA(
      sessionPDA,
      sessionOwner,
      this.portalProgramId,
    );

    const depositFeeParams: DepositFeeParams = { lamports };

    return {
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      feePayer: depositor,
      instructions: [
        {
          programPublicKey: this.portalProgramId,
          accounts: [
            { address: depositor, role: 1 },
            { address: sessionPDA, role: 1 },
            { address: depositReceiptPDA, role: 1 },
            { address: sessionOwner, role: 0 },
            { address: this.systemProgramId, role: 0 },
          ],
          data: PortalProgram.encodeDepositFee(depositFeeParams),
        },
      ],
    };
  }

  /**
   * Build a transaction to delegate an account to another program
   *
   * @param owner - Account owner
   * @param delegatedAccount - Account to delegate
   * @param gridId - Target grid ID
   * @returns Prepared transaction data
   */
  async buildDelegateTx(
    owner: PublicKey,
    delegatedAccount: PublicKey,
    gridId: number,
  ): Promise<any> {
    const latestBlockhash = await this.connection.getLatestBlockhash();

    const delegationRecordPDA = await PortalProgram.deriveDelegationRecordPDA(
      delegatedAccount,
      this.portalProgramId,
    );

    const delegateParams: DelegateParams = { gridId };

    return {
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      feePayer: owner,
      instructions: [
        {
          programPublicKey: this.portalProgramId,
          accounts: [
            { address: owner, role: 1 },
            { address: delegatedAccount, role: 1 },
            { address: this.systemProgramId, role: 0 },
            { address: delegationRecordPDA, role: 1 },
            { address: this.systemProgramId, role: 0 },
          ],
          data: PortalProgram.encodeDelegate(delegateParams),
        },
      ],
    };
  }

  /**
   * Build a transaction to undelegate an account
   *
   * @param owner - Account owner
   * @param delegatedAccount - Account to undelegate
   * @returns Prepared transaction data
   */
  async buildUndelegateTx(
    owner: PublicKey,
    delegatedAccount: PublicKey,
  ): Promise<any> {
    const latestBlockhash = await this.connection.getLatestBlockhash();

    const delegationRecordPDA = await PortalProgram.deriveDelegationRecordPDA(
      delegatedAccount,
      this.portalProgramId,
    );

    return {
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      feePayer: owner,
      instructions: [
        {
          programPublicKey: this.portalProgramId,
          accounts: [
            { address: owner, role: 1 },
            { address: delegatedAccount, role: 1 },
            { address: this.systemProgramId, role: 0 },
            { address: delegationRecordPDA, role: 1 },
            { address: this.systemProgramId, role: 0 },
          ],
          data: PortalProgram.encodeUndelegate(),
        },
      ],
    };
  }
}
