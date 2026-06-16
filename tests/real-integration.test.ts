/**
 * Real Integration Tests
 * End-to-end tests that send actual transactions to a running validator.
 *
 * These tests require:
 * - A Solana validator running with --portal flag set
 * - Portal program deployed at the configured program ID
 * - Solana RPC accessible (default: http://localhost:8899)
 * - Funding: set TRANSFER_SOURCE_PRIVATE_KEY (base58) in .env; optional
 *   TRANSFER_SOURCE_ADDRESS (default A8WbfsEkdnFwsxvtDBXuirUnXjriAwQWkc6trVWsTgK5) must match the keypair.
 *
 * Run with: npm run test:integration
 */

import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { NorthStarSDK, encodeSystemProgramAssignData } from "../src";
import { signVersionedTransaction } from "../src/solana/kitCompat";
import { config } from "dotenv";
config();

let skipPreflight = process.env.SKIP_PREFLIGHT !== "false";
const SYSTEM_PROGRAM_ID = SystemProgram.programId;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Mimics a web wallet: completes missing signatures locally with the given keypairs (for delegate / undelegate, etc.). */
function walletSignLocal(...keypairs: Keypair[]) {
  return async (tx: VersionedTransaction) =>
    signVersionedTransaction(tx, keypairs);
}

/** Normalize common account `data` shapes to a Uint8Array. */
function accountDataToBytes(data: any): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (Buffer.isBuffer(data)) return new Uint8Array(data);
  if (typeof data === "string") return Uint8Array.from(bs58.decode(data));
  console.error("Invalid account data: ", data);
  throw new Error("Invalid account data");
}

const EPHEMERAL_ROLLUP_RPC =
  process.env.EPHEMERAL_ROLLUP_RPC ?? "http://localhost:8910";
const VALIDATOR_RPC = process.env.VALIDATOR_RPC ?? "http://localhost:8899";

function getPortalProgramId(): PublicKey {
  const raw = process.env.PORTAL_PROGRAM_ID!.trim();
  return new PublicKey(raw);
}

const PORTAL_PROGRAM_ID = getPortalProgramId();

async function loadFundingSignerFromEnv(): Promise<Keypair> {
  const secret = process.env.TRANSFER_SOURCE_PRIVATE_KEY?.trim();
  if (!secret) {
    throw new Error(
      "TRANSFER_SOURCE_PRIVATE_KEY is required in .env (base58-encoded 32-byte seed or 64-byte keypair).",
    );
  }
  const bytes = Uint8Array.from(bs58.decode(secret));
  if (bytes.length === 64) {
    return Keypair.fromSecretKey(bytes);
  }
  if (bytes.length === 32) {
    return Keypair.fromSeed(bytes);
  }
  throw new Error(
    `TRANSFER_SOURCE_PRIVATE_KEY decodes to ${bytes.length} bytes; expected 32 or 64.`,
  );
}

type SolanaConnection = ReturnType<NorthStarSDK["getRpc"]>;

async function transferLamportsFromFunding(
  sdk: NorthStarSDK,
  connection: SolanaConnection,
  fundingSigner: Keypair,
  to: PublicKey,
  lamports: bigint,
): Promise<void> {
  const { blockhash } = await connection.getLatestBlockhash();
  const ix = SystemProgram.transfer({
    fromPubkey: fundingSigner.publicKey,
    toPubkey: to,
    lamports: Number(lamports),
  });
  const messageV0 = new TransactionMessage({
    payerKey: fundingSigner.publicKey,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(messageV0);
  tx.sign([fundingSigner]);

  await sdk.sendAndConfirmTransactionWithoutWebsocket(tx, {
    commitment: "confirmed",
    skipPreflight: true,
  });
}

async function assignAccountOwnerAndConfirm(
  sdk: NorthStarSDK,
  connection: SolanaConnection,
  feePayerSigner: Keypair,
  accountSigner: Keypair,
  currentOwnerProgramId: PublicKey,
  newOwnerProgramId: PublicKey,
): Promise<void> {
  const { blockhash } = await connection.getLatestBlockhash();
  const ix = new TransactionInstruction({
    programId: currentOwnerProgramId,
    keys: [
      {
        pubkey: accountSigner.publicKey,
        isSigner: true,
        isWritable: true,
      },
    ],
    data: Buffer.from(encodeSystemProgramAssignData(newOwnerProgramId)),
  });

  const messageV0 = new TransactionMessage({
    payerKey: feePayerSigner.publicKey,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(messageV0);
  tx.sign([feePayerSigner, accountSigner]);

  await sdk.sendAndConfirmTransactionWithoutWebsocket(tx, {
    commitment: "confirmed",
    skipPreflight: skipPreflight,
  });
}

describe("Real Integration Tests", () => {
  let sdk: NorthStarSDK;
  let rpc: SolanaConnection;
  let portalUser: Keypair;
  let delegatedAccount: Keypair;
  let closeSessionOwner: Keypair;
  let withdrawalL1Recipient: PublicKey;
  let validatorIdentity: PublicKey;
  const gridId = 1;

  beforeAll(async () => {
    sdk = new NorthStarSDK({
      portalProgramId: PORTAL_PROGRAM_ID,
      customEndpoints: {
        solana: VALIDATOR_RPC,
        ephemeralRollup: EPHEMERAL_ROLLUP_RPC,
      },
    });
    rpc = sdk.getRpc();
    const identityResponse = await (rpc as any)._rpcRequest("getIdentity", []);
    validatorIdentity = new PublicKey(identityResponse.result.identity);


    try {
      const fundingSigner = await loadFundingSignerFromEnv();
      console.log(
        "Funding transfers from",
        fundingSigner.publicKey.toBase58(),
        "(override with TRANSFER_SOURCE_ADDRESS)",
      );


    portalUser = fundingSigner;
    // portalUser = Keypair.generate();
    delegatedAccount = Keypair.generate();
    closeSessionOwner = Keypair.generate();
    withdrawalL1Recipient = Keypair.generate().publicKey;

    console.log("\n=== Test Setup ===");
    console.log("Portal owner:", portalUser.publicKey.toBase58());
    console.log("Delegated account:", delegatedAccount.publicKey.toBase58());
    console.log("Close-session owner:", closeSessionOwner.publicKey.toBase58());
    console.log("Withdrawal L1 recipient:", withdrawalL1Recipient.toBase58());

    

      // await transferLamportsFromFunding(
      //   sdk,
      //   rpc,
      //   fundingSigner,
      //   portalUser.publicKey,
      //   200_000_000n,
      // );
      // console.log("✓ Transferred 2 SOL to portal owner");

      await transferLamportsFromFunding(
        sdk,
        rpc,
        fundingSigner,
        delegatedAccount.publicKey,
        100_000_000n,
      );
      console.log("✓ Transferred 1 SOL to delegated account");

      await transferLamportsFromFunding(
        sdk,
        rpc,
        fundingSigner,
        closeSessionOwner.publicKey,
        200_000_000n,
      );
      console.log("✓ Transferred 2 SOL to close-session owner");

      await transferLamportsFromFunding(
        sdk,
        rpc,
        fundingSigner,
        withdrawalL1Recipient,
        2_000_000n,
      );
      console.log("✓ Pre-funded withdrawal L1 recipient without its signature");

      await sleep(500);

      const balance = await rpc.getBalance(portalUser.publicKey);
      console.log("Portal owner balance:", balance);

      const delegatedBalance = await rpc.getBalance(delegatedAccount.publicKey);
      console.log("Delegated account balance:", delegatedBalance);
    } catch (e: any) {
      console.log("⚠ Funding transfer failed:", String(e));
      throw e;
    }
  }, 60000);

  test("Step 1: Open Session - should create session and fee vault accounts", async () => {
    console.log("\n=== Step 1: Open Session ===");
    const sessionPDA = await sdk.portal.deriveSessionPDA();
    const feeVaultPDA = await sdk.portal.deriveFeeVaultPDA();
    let sessionInfo = await rpc.getAccountInfo(sessionPDA);

    let should_create_session = true;

    if (sessionInfo) {
      console.log("Existing global session found, closing it before test setup");
      await sdk.closeSession(
        portalUser.publicKey,
        walletSignLocal(portalUser),
        {},
        {
          commitment: "confirmed",
          skipPreflight: skipPreflight,
        },
      );
      console.log("✓ Existing session closed");
      should_create_session = true;
    }

    await sleep(1000);

    if(should_create_session) {
      const { signature } = await sdk.openSession(
        portalUser.publicKey,
        gridId,
        2000,
        1_000_000,
        walletSignLocal(portalUser),
        {},
        {
          commitment: "confirmed",
          skipPreflight: skipPreflight,
        },
        {
          validator: validatorIdentity,
          settlementIntervalSlots: 10,
        },
      );
      console.log("✓ Session created");
      console.log("  Signature:", signature);
    }

    sessionInfo = await rpc.getAccountInfo(sessionPDA);

    await new Promise((resolve) => setTimeout(resolve, 2000));



    console.log("Session info:", sessionInfo);
    expect(sessionInfo != null).toBe(true);
    // expect(sessionInfo).not.toBeNull();
    console.log("✓ Session account exists on-chain");

    let feeVaultInfo = await rpc.getAccountInfo(feeVaultPDA);

    console.log("FeeVault info:", feeVaultInfo);
    expect(feeVaultInfo != null).toBe(true);
    expect(feeVaultInfo).not.toBeNull();
    console.log("✓ FeeVault account exists on-chain");
  }, 60000);


  test(
    "Step 2: Delegate Account - should create delegation record",
    async () => {
      console.log("\n=== Step 2: Delegate Account ===");
      const delegationRecordPDA =
        await sdk.portal.deriveDelegationRecordPDA(delegatedAccount.publicKey);

      console.log("Delegated account (keypair):", delegatedAccount.publicKey.toBase58());
      console.log("Delegation record PDA:", delegationRecordPDA.toBase58());

      await assignAccountOwnerAndConfirm(
        sdk,
        rpc,
        portalUser,
        delegatedAccount,
        SYSTEM_PROGRAM_ID,
        PORTAL_PROGRAM_ID,
      );
      console.log("✓ Assign executed and confirmed");

      const { signature } = await sdk.delegate(
        portalUser.publicKey,
        gridId,
        walletSignLocal(portalUser),
        {
          delegations: [
            {
              delegatedAccountSigner: delegatedAccount,
              ownerProgramId: SYSTEM_PROGRAM_ID,
            },
          ],
        },
        {
          commitment: "confirmed",
          skipPreflight: skipPreflight,
        },
      );
      console.log("Signature:", signature);
      console.log("✓ Delegation created");
      await new Promise((resolve) => setTimeout(resolve, 2000));

      let delegationInfo = await rpc.getAccountInfo(delegationRecordPDA);

      console.log("Delegation info:", delegationInfo);
      expect(delegationInfo != null).toBe(true);
      expect(delegationInfo).not.toBeNull();
      console.log("✓ Delegation record exists on-chain");
    },
    60000,
  );


  test("Step 3: Deposit Fee - should create or top up deposit receipt", async () => {
    console.log("\n=== Step 3: Deposit Fee ===");

    const sessionPDA = await sdk.portal.deriveSessionPDA();

    console.log("Session PDA:", sessionPDA.toBase58());

    const depositReceiptPDA = await sdk.portal.deriveDepositReceiptPDA(
      sessionPDA,
      portalUser.publicKey,
    );
    const withdrawalSinkPDA = await sdk.portal.deriveWithdrawalSinkPDA(
      sessionPDA,
      portalUser.publicKey,
    );

    await sdk.depositFee(
      portalUser.publicKey,
      4_000_000,
      walletSignLocal(portalUser),
      { depositorSigner: portalUser },
      {
        commitment: "confirmed",
        skipPreflight: skipPreflight,
      },
      portalUser.publicKey,
    );

    await sleep(1500);

    const receiptInfo = await rpc.getAccountInfo(depositReceiptPDA);
    expect(receiptInfo).not.toBeNull();
    console.log("Receipt info:", receiptInfo);
    const raw = accountDataToBytes(receiptInfo!.data);
    const receiptState = sdk.portal.parseDepositReceipt(raw);
    expect(new PublicKey(receiptState.session).equals(sessionPDA)).toBe(true);
    expect(new PublicKey(receiptState.recipient).equals(portalUser.publicKey)).toBe(
      true,
    );
    expect(receiptState.withdrawn).toBe(0n);
    expect(BigInt(receiptInfo!.lamports)).toBeGreaterThanOrEqual(4_000_000n);
    const sinkInfo = await rpc.getAccountInfo(withdrawalSinkPDA);
    expect(sinkInfo).not.toBeNull();
    console.log("✓ Deposit receipt lamports:", receiptInfo!.lamports);
  }, 60000);


  test("Step 4: ER SOL withdrawal - should transfer to withdrawal sink", async () => {
    console.log("\n=== Step 4: ER SOL Withdrawal ===");

    const erRpc = sdk.getEphemeralRpc();
    const sessionPDA = await sdk.portal.deriveSessionPDA();
    const withdrawalSinkPDA = await sdk.portal.deriveWithdrawalSinkPDA(
      sessionPDA,
      portalUser.publicKey,
    );
    const sinkBefore = await erRpc.getBalance(withdrawalSinkPDA, "processed");
    const l1BalanceBefore = await rpc.getBalance(withdrawalL1Recipient);
    const depositReceiptPDA = await sdk.portal.deriveDepositReceiptPDA(
      sessionPDA,
      portalUser.publicKey,
    );
    const withdrawLamports = 1_000_000;
    const instructions = await sdk.buildErSolWithdrawalInstructions({
      erSource: portalUser.publicKey,
      l1Recipient: withdrawalL1Recipient,
      lamports: withdrawLamports,
      sessionPDA,
    });
    const { blockhash } = await erRpc.getLatestBlockhash("processed");
    const messageV0 = new TransactionMessage({
      payerKey: portalUser.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();
    const tx = new VersionedTransaction(messageV0);
    tx.sign([portalUser]);

    const signature = await erRpc.sendRawTransaction(Buffer.from(tx.serialize()), {
      skipPreflight,
    });
    console.log("ER withdrawal signature:", signature);
    await sleep(1500);

    const sinkAfter = await erRpc.getBalance(withdrawalSinkPDA, "processed");
    expect(sinkAfter - sinkBefore).toBe(withdrawLamports);
    console.log("✓ Withdrawal sink credited:", sinkAfter - sinkBefore);

    let settledReceiptWithdrawn = 0n;
    let l1BalanceAfterSettlement = l1BalanceBefore;
    for (let attempt = 0; attempt < 30; attempt++) {
      await sleep(1000);
      const receiptInfo = await rpc.getAccountInfo(depositReceiptPDA);
      if (receiptInfo == null) continue;
      const receiptState = sdk.portal.parseDepositReceipt(
        accountDataToBytes(receiptInfo.data),
      );
      settledReceiptWithdrawn = receiptState.withdrawn;
      l1BalanceAfterSettlement = await rpc.getBalance(withdrawalL1Recipient);
      if (settledReceiptWithdrawn >= BigInt(withdrawLamports)) break;
    }

    expect(settledReceiptWithdrawn).toBeGreaterThanOrEqual(BigInt(withdrawLamports));
    expect(l1BalanceAfterSettlement).toBeGreaterThan(l1BalanceBefore);
    expect(withdrawalL1Recipient.equals(portalUser.publicKey)).toBe(false);
    console.log(
      "✓ L1 payout observed:",
      l1BalanceAfterSettlement - l1BalanceBefore,
      "withdrawn:",
      settledReceiptWithdrawn.toString(),
    );
  }, 60000);

  test("Step 5: Undelegate - should assign account back and clear delegation record", async () => {
    console.log("\n=== Step 5: Undelegate ===");

    const delegationRecordPDA =
      await sdk.portal.deriveDelegationRecordPDA(delegatedAccount.publicKey);

    await sdk.undelegate(
      portalUser.publicKey,
      SYSTEM_PROGRAM_ID,
      walletSignLocal(portalUser),
      { delegatedAccountSigner: delegatedAccount },
      {
        commitment: "confirmed",
        skipPreflight: skipPreflight,
      },
    );

    await sleep(1500);

    const delegatedInfo = await rpc.getAccountInfo(delegatedAccount.publicKey);
    expect(delegatedInfo?.owner.equals(SYSTEM_PROGRAM_ID)).toBe(true);

    const recordInfo = await rpc.getAccountInfo(delegationRecordPDA);
    const recordData = recordInfo?.data;
    if (recordData != null) {
      const raw = accountDataToBytes(recordData);
      expect(raw.every((b) => b === 0)).toBe(true);
    }
    console.log("✓ Undelegate completed");
  }, 60000);

  test("Step 6: Close Session - any signer can close active global session", async () => {
    console.log("\n=== Step 6: Close Global Session ===");

    const sessionPDA = await sdk.portal.deriveSessionPDA();
    const feeVaultPDA = await sdk.portal.deriveFeeVaultPDA();

    await sdk.closeSession(
      closeSessionOwner.publicKey,
      walletSignLocal(closeSessionOwner),
      {},
      {
        commitment: "confirmed",
        skipPreflight: skipPreflight,
      },
    );

    await sleep(1500);

    const sessionAfter = await rpc.getAccountInfo(sessionPDA);
    const vaultAfter = await rpc.getAccountInfo(feeVaultPDA);
    console.log("Session after:", sessionAfter);
    console.log("Fee vault after:", vaultAfter);
    expect(sessionAfter).toBeNull();
    expect(vaultAfter).toBeNull();
    console.log("✓ Session and fee vault closed");
  }, 60000);

  test.skip("Step 6: Verify ER RPC is running after session opened", async () => {
    console.log("\n=== Step 6: Verify ER RPC ===");

    const erSdk = new NorthStarSDK({
      portalProgramId: PORTAL_PROGRAM_ID,
      customEndpoints: {
        solana: VALIDATOR_RPC,
        ephemeralRollup: EPHEMERAL_ROLLUP_RPC,
      },
    });

    const health = await erSdk.checkHealth();
    console.log("Health check:", health);
  }, 30000);
});
