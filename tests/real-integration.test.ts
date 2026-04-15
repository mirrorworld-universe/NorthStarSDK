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

let skipPreflight = true;
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

const EPHEMERAL_ROLLUP_RPC = "https://ephemeral.devnet.sonic.game";
const VALIDATOR_RPC = "https://api.devnet.sonic.game";

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

    portalUser = Keypair.generate();
    delegatedAccount = Keypair.generate();
    closeSessionOwner = Keypair.generate();

    console.log("\n=== Test Setup ===");
    console.log("Portal owner:", portalUser.publicKey.toBase58());
    console.log("Delegated account:", delegatedAccount.publicKey.toBase58());
    console.log("Close-session owner:", closeSessionOwner.publicKey.toBase58());

    try {
      const fundingSigner = await loadFundingSignerFromEnv();
      console.log(
        "Funding transfers from",
        fundingSigner.publicKey.toBase58(),
        "(override with TRANSFER_SOURCE_ADDRESS)",
      );

      await transferLamportsFromFunding(
        sdk,
        rpc,
        fundingSigner,
        portalUser.publicKey,
        200_000_000n,
      );
      console.log("✓ Transferred 2 SOL to portal owner");

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
    const sessionPDA = await sdk.portal.deriveSessionPDA(portalUser.publicKey, gridId);
    const feeVaultPDA = await sdk.portal.deriveFeeVaultPDA(portalUser.publicKey);

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
    );

    console.log("✓ Session opened");
    console.log("  Signature:", signature);

    await new Promise((resolve) => setTimeout(resolve, 2000));

    let sessionInfo = await rpc.getAccountInfo(sessionPDA);

    console.log("Session info:", sessionInfo);
    expect(sessionInfo != null).toBe(true);
    expect(sessionInfo).not.toBeNull();
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
        SYSTEM_PROGRAM_ID,
        walletSignLocal(portalUser),
        { delegatedAccountSigner: delegatedAccount },
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

    const sessionPDA = await sdk.portal.deriveSessionPDA(portalUser.publicKey, gridId);

    console.log("Session PDA:", sessionPDA.toBase58());

    const depositReceiptPDA = await sdk.portal.deriveDepositReceiptPDA(
      sessionPDA,
      portalUser.publicKey,
    );

    await sdk.depositFee(
      portalUser.publicKey,
      portalUser.publicKey,
      gridId,
      500_000,
      walletSignLocal(portalUser),
      { depositorSigner: portalUser },
      {
        commitment: "confirmed",
        skipPreflight: skipPreflight,
      },
    );

    await sleep(1500);

    const receiptInfo = await rpc.getAccountInfo(depositReceiptPDA);
    expect(receiptInfo).not.toBeNull();
    console.log("Receipt info:", receiptInfo);
    const raw = accountDataToBytes(receiptInfo!.data);
    const receiptState = sdk.portal.parseDepositReceipt(raw);
    expect(receiptState.balance).toBeGreaterThanOrEqual(500_000n);
    console.log("✓ Deposit receipt balance:", receiptState.balance.toString());
  }, 60000);

  test("Step 4: Undelegate - should assign account back and clear delegation record", async () => {
    console.log("\n=== Step 4: Undelegate ===");

    const delegationRecordPDA =
      await sdk.portal.deriveDelegationRecordPDA(delegatedAccount.publicKey);

    await sdk.undelegate(
      portalUser.publicKey,
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

  test("Step 5: Close Session - should close after TTL (separate owner, short TTL)", async () => {
    console.log("\n=== Step 5: Close Session (short TTL) ===");

    const closeGridId = 1;
    const ttlSlots = 15n;
    const sessionPDA = await sdk.portal.deriveSessionPDA(
      closeSessionOwner.publicKey,
      closeGridId,
    );
    const feeVaultPDA = await sdk.portal.deriveFeeVaultPDA(closeSessionOwner.publicKey);

    await sdk.openSession(
      closeSessionOwner.publicKey,
      closeGridId,
      Number(ttlSlots),
      1_000_000,
      walletSignLocal(closeSessionOwner),
      {},
      {
        commitment: "confirmed",
        skipPreflight: skipPreflight,
      },
    );

    await sleep(1000);
    console.log("Session PDA:", sessionPDA.toBase58());
    const sessionAccount = await rpc.getAccountInfo(sessionPDA);
    expect(sessionAccount).not.toBeNull();
    const sessRaw = accountDataToBytes(sessionAccount!.data);
    console.log("Session raw:", sessRaw);
    const sessionState = sdk.portal.parseSession(sessRaw);
    console.log("Session state:", sessionState);
    const expireAfter = sessionState.createdAt + sessionState.ttlSlots + 1n;

    console.log("Waiting until slot >", expireAfter.toString(), "(session expiry)...");
    const maxWaitMs = 120_000;
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const slot = await rpc.getSlot("confirmed");
      const s = BigInt(slot);
      if (s > expireAfter) {
        console.log("✓ Current slot", s.toString(), "past expiry");
        break;
      }
      await sleep(400);
    }

    const slotNow = BigInt(await rpc.getSlot("confirmed"));
    expect(slotNow > expireAfter).toBe(true);

    await sdk.closeSession(
      closeSessionOwner.publicKey,
      closeGridId,
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
  }, 180000);

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
