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
  AccountRole,
  Address,
  address,
  generateKeyPairSigner,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  signTransactionMessageWithSigners,
  assertIsTransactionWithBlockhashLifetime,
  assertIsSendableTransaction,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  KeyPairSigner,
} from "@solana/kit";
import bs58 from "bs58";
import { NorthStarSDK, PORTAL_PROGRAM_ID, PortalProgram } from "../src";
import { config } from "dotenv";
config();

let skipPreflight = true;
const SYSTEM_PROGRAM_ID = address("11111111111111111111111111111111");

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Normalize common account `data` shapes to a Uint8Array. */
function accountDataToBytes(data: any): Uint8Array {
  if (data instanceof Uint8Array) return data;
  // Convention: plain strings are bs58-encoded account data.
  if (typeof data === "string") return Uint8Array.from(bs58.decode(data));
  // if (Array.isArray(data) && typeof data[0] === "string") {
  //   // RPC tuple format: ["<base64>", "base64"]
  //   return Buffer.from(data[0], "base64");
  // }
  // return new Uint8Array(data as ArrayBuffer);
  console.error("Invalid account data: ", data);
  throw new Error("Invalid account data");
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 0; i < 8; i++) {
    v |= BigInt(data[offset + i]) << BigInt(8 * i);
  }
  return v;
}
// validator rpc: https://api.devnet.sonic.game    8899
// ephemeral rollup rpc: https://ephemeral.devnet.sonic.game  8910
// portal program id: address("5TeWSsjg2gbxCyWVniXeCmwM7UtHTCK7svzJr5xYJzHf")
// const PORTAL_PROGRAM_ID = address("B519Ej1JFgxWknbUyfSCQ2QX8xTaWP8CAUKFLw2GtgBD");
// const PORTAL_PROGRAM_ID = address("B519Ej1JFgxWknbUyfSCQ2QX8xTaWP8CAUKFLw2GtgBD");
const EPHEMERAL_ROLLUP_RPC = "https://ephemeral.devnet.sonic.game";
const VALIDATOR_RPC = "https://api.devnet.sonic.game";

/** Default funding wallet (devnet); override with TRANSFER_SOURCE_ADDRESS */
const DEFAULT_TRANSFER_SOURCE_ADDRESS =
  "A8WbfsEkdnFwsxvtDBXuirUnXjriAwQWkc6trVWsTgK5";

function getTransferSourceAddress(): Address {
  const raw = process.env.TRANSFER_SOURCE_ADDRESS?.trim();
  return address(raw || DEFAULT_TRANSFER_SOURCE_ADDRESS);
}

async function loadFundingSignerFromEnv(): Promise<KeyPairSigner> {
  const secret = process.env.TRANSFER_SOURCE_PRIVATE_KEY?.trim();
  if (!secret) {
    throw new Error(
      "TRANSFER_SOURCE_PRIVATE_KEY is required in .env (base58-encoded 32-byte seed or 64-byte keypair).",
    );
  }
  const bytes = Uint8Array.from(bs58.decode(secret));
  let signer: KeyPairSigner;
  if (bytes.length === 64) {
    signer = await createKeyPairSignerFromBytes(bytes);
  } else if (bytes.length === 32) {
    signer = await createKeyPairSignerFromPrivateKeyBytes(bytes);
  } else {
    throw new Error(
      `TRANSFER_SOURCE_PRIVATE_KEY decodes to ${bytes.length} bytes; expected 32 or 64.`,
    );
  }
  const expected = getTransferSourceAddress();
  if (signer.address !== expected) {
    throw new Error(
      `Funding keypair address ${String(signer.address)} does not match TRANSFER_SOURCE_ADDRESS ${String(expected)}`,
    );
  }
  return signer;
}

/** System Program `Transfer` instruction (bincode-style: u32 LE index 2 + u64 LE lamports). */
function encodeSystemProgramTransfer(lamports: bigint): Uint8Array {
  const data = new Uint8Array(4 + 8);
  new DataView(data.buffer).setUint32(0, 2, true);
  new DataView(data.buffer).setBigUint64(4, lamports, true);
  return data;
}

type SolanaRpc = ReturnType<typeof createSolanaRpc>;
async function transferLamportsFromFunding(
  sdk: NorthStarSDK,
  rpc: SolanaRpc,
  fundingSigner: KeyPairSigner,
  to: Address,
  lamports: bigint,
): Promise<void> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const instruction = {
    programAddress: SYSTEM_PROGRAM_ID,
    accounts: [
      { address: fundingSigner.address, role: AccountRole.WRITABLE_SIGNER },
      { address: to, role: AccountRole.WRITABLE },
    ],
    data: encodeSystemProgramTransfer(lamports),
  };

  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(fundingSigner, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions([instruction], tx),
  );

  const transaction =
    await signTransactionMessageWithSigners(transactionMessage);
  assertIsSendableTransaction(transaction);
  assertIsTransactionWithBlockhashLifetime(transaction);

  await sdk.sendAndConfirmTransactionWithoutWebsocket(transaction, {
    commitment: "confirmed",
    skipPreflight: true,
  });
}

describe("Real Integration Tests", () => {

  let sdk: NorthStarSDK;
  let rpc: ReturnType<typeof createSolanaRpc>;
  let portalOwner: KeyPairSigner;
  let delegatedAccount: KeyPairSigner;
  /** Separate fee payer for close_session: short TTL + wait for slot expiry; avoids fee_vault conflict with the main flow. */
  let closeSessionOwner: KeyPairSigner;
  const gridId = 1;

  beforeAll(async () => {
    rpc = createSolanaRpc(VALIDATOR_RPC);

    sdk = new NorthStarSDK({
      solanaNetwork: "localnet",
      customEndpoints: {
        solana: VALIDATOR_RPC,
        ephemeralRollup: EPHEMERAL_ROLLUP_RPC,
      },
    });

    portalOwner = await generateKeyPairSigner();
    delegatedAccount = await generateKeyPairSigner();
    closeSessionOwner = await generateKeyPairSigner();

    console.log("\n=== Test Setup ===");
    console.log("Portal owner:", portalOwner.address);
    console.log("Delegated account:", delegatedAccount.address);
    console.log("Close-session owner:", closeSessionOwner.address);

    try {
      const fundingSigner = await loadFundingSignerFromEnv();
      console.log(
        "Funding transfers from",
        getTransferSourceAddress(),
        "(override with TRANSFER_SOURCE_ADDRESS)",
      );

      await transferLamportsFromFunding(
        sdk,
        rpc,
        fundingSigner,
        portalOwner.address,
        200_000_000n,
      );
      console.log("✓ Transferred 2 SOL to portal owner");

      await transferLamportsFromFunding(
        sdk,
        rpc,
        fundingSigner,
        delegatedAccount.address,
        100_000_000n,
      );
      console.log("✓ Transferred 1 SOL to delegated account");

      await transferLamportsFromFunding(
        sdk,
        rpc,
        fundingSigner,
        closeSessionOwner.address,
        200_000_000n,
      );
      console.log("✓ Transferred 2 SOL to close-session owner");

      await sleep(500);

      const balance = await rpc.getBalance(portalOwner.address).send();
      console.log("Portal owner balance:", balance);

      const delegatedBalance = await rpc.getBalance(delegatedAccount.address).send();
      console.log("Delegated account balance:", delegatedBalance);
    } catch (e: any) {
      console.log("⚠ Funding transfer failed:", String(e));
      throw e;
    }
  }, 60000);

  test("Step 1: Open Session - should create session and fee vault accounts", async () => {
    console.log("\n=== Step 1: Open Session ===");
    const sessionPDA = await PortalProgram.deriveSessionPDA(
      portalOwner.address,
      gridId,
    );
    const feeVaultPDA = await PortalProgram.deriveFeeVaultPDA(portalOwner.address);

    const { signature } = await sdk.openSession(
      portalOwner,
      gridId,
      2000,
      1_000_000,
      {
        commitment: "confirmed",
        skipPreflight: skipPreflight,
      },
    );

    console.log("✓ Session opened");
    console.log("  Signature:", signature);

    // Wait a bit for the transaction to be processed
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Retry getting account info with retries
    let sessionInfo = await rpc.getAccountInfo(sessionPDA).send();

    console.log("Session info:", sessionInfo);
    expect(sessionInfo != null).toBe(true);
    expect(sessionInfo!.value != null).toBe(true);
    console.log("✓ Session account exists on-chain");

    // Retry getting account info with retries
    let feeVaultInfo = await rpc.getAccountInfo(feeVaultPDA).send();

    console.log("FeeVault info:", feeVaultInfo);
    expect(feeVaultInfo != null).toBe(true);
    expect(feeVaultInfo!.value != null).toBe(true);
    console.log("✓ FeeVault account exists on-chain");
  }, 60000);

  test(
    "Step 2: Delegate Account - should create delegation record",
    async () => {
      console.log("\n=== Step 2: Delegate Account ===");
      const delegationRecordPDA = await PortalProgram.deriveDelegationRecordPDA(
        delegatedAccount.address,
      );

      console.log("Delegated account (keypair):", delegatedAccount.address);
      console.log("Delegation record PDA:", delegationRecordPDA);

      const { signature } = await sdk.delegate(
        portalOwner,
        delegatedAccount,
        gridId,
        {
          commitment: "confirmed",
          skipPreflight: skipPreflight,
        },
      );
      console.log("Signature:", signature);
      console.log("✓ Delegation created");
      // Wait a bit for the transaction to be processed
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Retry getting account info with retries
      let delegationInfo = await rpc.getAccountInfo(delegationRecordPDA).send();

      console.log("Delegation info:", delegationInfo);
      // != null simultaneously excludes null and undefined.
      expect(delegationInfo != null).toBe(true);
      expect(delegationInfo!.value != null).toBe(true);
      console.log("✓ Delegation record exists on-chain");
    },
    60000,
  );

  test("Step 3: Deposit Fee - should create or top up deposit receipt", async () => {

    console.log("\n=== Step 3: Deposit Fee ===");

    const sessionPDA = await PortalProgram.deriveSessionPDA(
      portalOwner.address,
      gridId,
    );

    console.log("Session PDA:", sessionPDA);

    const depositReceiptPDA = await PortalProgram.deriveDepositReceiptPDA(
      sessionPDA,
      portalOwner.address,
    );

    await sdk.depositFee(portalOwner, portalOwner.address, gridId, 500_000, {
      commitment: "confirmed",
      skipPreflight: skipPreflight,
    });

    await sleep(1500);

    const receiptInfo = await rpc.getAccountInfo(depositReceiptPDA).send();
    expect(receiptInfo?.value).not.toBeNull();
    console.log("Receipt info:", receiptInfo);
    const raw = accountDataToBytes(receiptInfo!.value!.data);
    const receiptState = PortalProgram.parseDepositReceipt(raw);
    expect(receiptState.balance).toBeGreaterThanOrEqual(500_000n);
    console.log("✓ Deposit receipt balance:", receiptState.balance.toString());
  }, 60000);

  test("Step 4: Undelegate - should assign account back and clear delegation record", async () => {
    console.log("\n=== Step 4: Undelegate ===");

    const delegationRecordPDA = await PortalProgram.deriveDelegationRecordPDA(
      delegatedAccount.address,
    );

    await sdk.undelegate(portalOwner, delegatedAccount, {
      commitment: "confirmed",
      skipPreflight: skipPreflight,
    });

    await sleep(1500);

    const delegatedInfo = await rpc
      .getAccountInfo(delegatedAccount.address)
      .send();
    expect(delegatedInfo?.value?.owner).toBe(SYSTEM_PROGRAM_ID);

    const recordInfo = await rpc.getAccountInfo(delegationRecordPDA).send();
    const recordData = recordInfo?.value?.data;
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
    const sessionPDA = await PortalProgram.deriveSessionPDA(
      closeSessionOwner.address,
      closeGridId,
    );
    const feeVaultPDA = await PortalProgram.deriveFeeVaultPDA(
      closeSessionOwner.address,
    );

    await sdk.openSession(
      closeSessionOwner,
      closeGridId,
      Number(ttlSlots),
      1_000_000,
      {
      commitment: "confirmed",
      skipPreflight: skipPreflight,
      },
    );

    await sleep(1000);
    console.log("Session PDA:", sessionPDA);
    const sessionAccount = await rpc.getAccountInfo(sessionPDA).send();
    expect(sessionAccount?.value).not.toBeNull();
    const sessRaw = accountDataToBytes(sessionAccount!.value!.data);
    console.log("Session raw:", sessRaw);
    const sessionState = PortalProgram.parseSession(sessRaw);
    console.log("Session state:", sessionState);
    const expireAfter = sessionState.createdAt + sessionState.ttlSlots + 1n;

    console.log("Waiting until slot >", expireAfter.toString(), "(session expiry)...");
    const maxWaitMs = 120_000;
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const slot = await (rpc as any).getSlot({ commitment: "confirmed" }).send();
      const s = BigInt(slot);
      if (s > expireAfter) {
        console.log("✓ Current slot", s.toString(), "past expiry");
        break;
      }
      await sleep(400);
    }

    const slotNow = BigInt(
      await (rpc as any).getSlot({ commitment: "confirmed" }).send(),
    );
    expect(slotNow > expireAfter).toBe(true);

    await sdk.closeSession(closeSessionOwner, closeGridId, {
      commitment: "confirmed",
      skipPreflight: skipPreflight,
    });

    await sleep(1500);

    const sessionAfter = await rpc.getAccountInfo(sessionPDA).send();
    const vaultAfter = await rpc.getAccountInfo(feeVaultPDA).send();
    console.log("Session after:", sessionAfter);
    console.log("Fee vault after:", vaultAfter);
    expect(sessionAfter?.value).toBeNull();
    expect(vaultAfter?.value).toBeNull();
    console.log("✓ Session and fee vault closed");
  }, 180000);

  test.skip("Step 6: Verify ER RPC is running after session opened", async () => {
    console.log("\n=== Step 6: Verify ER RPC ===");

    const erSdk = new NorthStarSDK({
      solanaNetwork: "devnet",
      customEndpoints: {
        ephemeralRollup: EPHEMERAL_ROLLUP_RPC,
      },
    });

    const health = await erSdk.checkHealth();
    console.log("Health check:", health);

    // ER should be running now that session was opened
    // Note: This may fail if ER takes time to start
  }, 30000);

});

function safeStringify(obj: any): string {
  try {
    return JSON.stringify(obj, (_, v) => typeof v === 'bigint' ? v.toString() : v);
  } catch (e) {
    return "Error stringifying object";
  }
}
