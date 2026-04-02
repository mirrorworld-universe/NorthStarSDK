/**
 * Real Integration Tests
 * End-to-end tests that send actual transactions to a running validator.
 *
 * These tests require:
 * - A Solana validator running with --portal flag set
 * - Portal program deployed at the configured program ID
 * - Solana RPC accessible (default: http://localhost:8899)
 *
 * Run with: npm run test:integration
 */

import {
  AccountRole,
  address,
  generateKeyPairSigner,
  createSolanaRpc,
  signTransactionMessageWithSigners,
  assertIsTransactionWithBlockhashLifetime,
  assertIsSendableTransaction,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  sendTransactionWithoutConfirmingFactory,
  getSignatureFromTransaction,
  getAddressEncoder,
  getProgramDerivedAddress,
  KeyPairSigner,
} from "@solana/kit";
import bs58 from "bs58";
import { NorthStarSDK, PORTAL_PROGRAM_ID, PortalProgram } from "../src";

let skipPreflight = true;
const SYSTEM_PROGRAM_ID = address("11111111111111111111111111111111");
const TOKEN_PROGRAM_ID = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 将常见账户数据输入统一转换为 Uint8Array */
function accountDataToBytes(data: any): Uint8Array {
  if (data instanceof Uint8Array) return data;
  // 业务约定：纯字符串输入按 bs58 解码
  if (typeof data === "string") return Uint8Array.from(bs58.decode(data));
  // if (Array.isArray(data) && typeof data[0] === "string") {
  //   // RPC 常见格式：["<base64>", "base64"]
  //   return Uint8Array.from(bs58.decode(data[0]));
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

describe("Real Integration Tests", () => {
  const PORTAL_PROGRAM_ID = address(
    "5TeWSsjg2gbxCyWVniXeCmwM7UtHTCK7svzJr5xYJzHf",
  );

  let sdk: NorthStarSDK;
  let rpc: ReturnType<typeof createSolanaRpc>;
  let sendTransactionWithoutConfirming: ReturnType<
    typeof sendTransactionWithoutConfirmingFactory
  >;
  let portalOwner: KeyPairSigner;
  let delegatedAccount: KeyPairSigner;
  /** 单独 owner，用于 close_session（需短 TTL + 等 slot 过期；与主流程的 fee_vault 不冲突） */
  let closeSessionOwner: KeyPairSigner;
  const gridId = 1;

  beforeAll(async () => {
    rpc = createSolanaRpc("http://127.0.0.1:8899");
    sendTransactionWithoutConfirming = sendTransactionWithoutConfirmingFactory({
      rpc,
    });

    sdk = new NorthStarSDK({
      solanaNetwork: "localnet",
      customEndpoints: {
        ephemeralRollup: "http://127.0.0.1:8910",
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
      // Use direct RPC call for airdrop (faucet)
      // Note: Must use number for lamports, not BigInt
      await (rpc as any).requestAirdrop(portalOwner.address, 2000000000).send();
      console.log("✓ Airdropped 2 SOL to portal owner");

      await (rpc as any)
        .requestAirdrop(delegatedAccount.address, 1000000000)
        .send();
      console.log("✓ Airdropped 1 SOL to delegated account");

      await (rpc as any)
        .requestAirdrop(closeSessionOwner.address, 2000000000)
        .send();
      console.log("✓ Airdropped 2 SOL to close-session owner");

       // Wait for airdrop to be confirmed
       await sleep(1000);

      const balance = await rpc.getBalance(portalOwner.address).send();
      console.log("Portal owner balance:", balance);

      const delegatedBalance = await rpc.getBalance(delegatedAccount.address).send();
      console.log("Delegated account balance:", delegatedBalance);

     
    } catch (e: any) {
      console.log("⚠ Airdrop failed, trying to continue anyway:", String(e));
    }
  }, 60000);

  test("Step 1: Open Session - should create session and fee vault accounts", async () => {
    console.log("\n=== Step 1: Open Session ===");

    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

    const sessionPDA = await deriveSessionPDA(portalOwner.address, gridId);
    const feeVaultPDA = await deriveFeeVaultPDA(portalOwner.address);

    console.log("Session PDA:", sessionPDA);
    console.log("FeeVault PDA:", feeVaultPDA);

    const instruction = {
      programAddress: PORTAL_PROGRAM_ID,
      accounts: [
        { address: portalOwner.address, role: 1 as const },
        { address: sessionPDA, role: 1 as const },
        { address: feeVaultPDA, role: 1 as const },
        {
          address: SYSTEM_PROGRAM_ID,
          role: 0 as const,
        },
      ],
      data: PortalProgram.encodeOpenSession({
        gridId,
        ttlSlots: 2000n,
        feeCap: 1_000_000n,
      }),
    };

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(portalOwner, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx) => appendTransactionMessageInstructions([instruction], tx),
    );

    const transaction =
      await signTransactionMessageWithSigners(transactionMessage);
    assertIsSendableTransaction(transaction);
    assertIsTransactionWithBlockhashLifetime(transaction);

    try {
      await sendAndConfirmTransactionWithoutWebsocket(transaction, {
        commitment: "confirmed",
        skipPreflight: skipPreflight,
      });
    } catch (e) {
      console.log("Transaction error (may have succeeded):", String(e));
      throw e;
    }
    const signature = getSignatureFromTransaction(transaction);

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

    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

    const delegationRecordPDA = await deriveDelegationRecordPDA(
      delegatedAccount.address,
    );

    // System Program `Assign`: 将 delegated account 的 owner 设为 Portal Program（需 delegated 私钥签名）
    const assignToPortalInstruction = {
      programAddress: SYSTEM_PROGRAM_ID,
      accounts: [
        {
          address: delegatedAccount.address,
          role: AccountRole.WRITABLE_SIGNER,
          signer: delegatedAccount,
        },
      ],
      data: encodeSystemProgramAssign(PORTAL_PROGRAM_ID),
    };

    console.log("Delegated account (keypair):", delegatedAccount.address);
    console.log("Delegation record PDA:", delegationRecordPDA);

    const delegateInstruction = {
      programAddress: PORTAL_PROGRAM_ID,
      accounts: [
        {
          address: portalOwner.address,
          role: AccountRole.WRITABLE_SIGNER,
        },
        {
          address: delegatedAccount.address,
          role: AccountRole.WRITABLE_SIGNER,
          signer: delegatedAccount,
        },
        {
          address: SYSTEM_PROGRAM_ID,
          role: AccountRole.READONLY,
        },
        { address: delegationRecordPDA, role: AccountRole.WRITABLE },
        { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY},
      ],
      data: PortalProgram.encodeDelegate({ gridId }),
    };

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(portalOwner, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx) =>
        appendTransactionMessageInstructions(
          [assignToPortalInstruction, delegateInstruction],
          tx,
        ),
    );

    const transaction =
      await signTransactionMessageWithSigners(transactionMessage);

    assertIsSendableTransaction(transaction);
    assertIsTransactionWithBlockhashLifetime(transaction);

    const signature = getSignatureFromTransaction(transaction);
    console.log("Signature:", signature);

    try {
        await sendAndConfirmTransactionWithoutWebsocket(transaction, {
        commitment: "confirmed",
        skipPreflight: skipPreflight,
      });
    } catch (e) {
      console.log("Transaction error (may have succeeded):", String(e));
      throw e;
    }
      

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

    const sessionPDA = await deriveSessionPDA(
      portalOwner.address,
      gridId,
    );

    const sessionPDA1 = await PortalProgram.deriveSessionPDA(
      portalOwner.address,
      gridId,
    );

    console.log("Session PDA:", sessionPDA);
    console.log("Session PDA1:", sessionPDA1);

    const depositReceiptPDA = await PortalProgram.deriveDepositReceiptPDA(
      sessionPDA,
      portalOwner.address,
    );

    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

    const depositInstruction = {
      programAddress: PORTAL_PROGRAM_ID,
      accounts: [
        {
          address: portalOwner.address,
          role: AccountRole.WRITABLE_SIGNER,
        }, // deposit 
        { address: sessionPDA, role: AccountRole.WRITABLE },
        { address: depositReceiptPDA, role: AccountRole.WRITABLE },
        { address: portalOwner.address, role: AccountRole.READONLY }, // receiver
        { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
      ],
      data: PortalProgram.encodeDepositFee({ lamports: 500_000n }),
    };

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(portalOwner, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx) => appendTransactionMessageInstructions([depositInstruction], tx),
    );

    const transaction =
      await signTransactionMessageWithSigners(transactionMessage);
    assertIsSendableTransaction(transaction);
    assertIsTransactionWithBlockhashLifetime(transaction);

    await sendAndConfirmTransactionWithoutWebsocket(transaction, {
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

    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

    const undelegateInstruction = {
      programAddress: PORTAL_PROGRAM_ID,
      accounts: [
        {
          address: portalOwner.address,
          role: AccountRole.WRITABLE_SIGNER,
        },
        {
          address: delegatedAccount.address,
          role: AccountRole.WRITABLE_SIGNER,
          signer: delegatedAccount,
        },
        { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
        { address: delegationRecordPDA, role: AccountRole.WRITABLE },
        { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
      ],
      data: PortalProgram.encodeUndelegate(),
    };

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(portalOwner, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx) => appendTransactionMessageInstructions([undelegateInstruction], tx),
    );

    const transaction =
      await signTransactionMessageWithSigners(transactionMessage);
    assertIsSendableTransaction(transaction);
    assertIsTransactionWithBlockhashLifetime(transaction);

    await sendAndConfirmTransactionWithoutWebsocket(transaction, {
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
    const sessionPDA = await deriveSessionPDA(
      closeSessionOwner.address,
      closeGridId,
    );
    const feeVaultPDA = await PortalProgram.deriveFeeVaultPDA(
      closeSessionOwner.address,
    );

    const { value: blockhashOpen } = await rpc.getLatestBlockhash().send();
    const openIx = {
      programAddress: PORTAL_PROGRAM_ID,
      accounts: [
        { address: closeSessionOwner.address, role: AccountRole.WRITABLE_SIGNER },
        { address: sessionPDA, role: AccountRole.WRITABLE },
        { address: feeVaultPDA, role: AccountRole.WRITABLE },
        { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
      ],
      data: PortalProgram.encodeOpenSession({
        gridId: closeGridId,
        ttlSlots,
        feeCap: 1_000_000n,
      }),
    };

    const openTx = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(closeSessionOwner, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhashOpen, tx),
      (tx) => appendTransactionMessageInstructions([openIx], tx),
    );
    const signedOpen = await signTransactionMessageWithSigners(openTx);
    assertIsSendableTransaction(signedOpen);
    assertIsTransactionWithBlockhashLifetime(signedOpen);
    await sendAndConfirmTransactionWithoutWebsocket(signedOpen, {
      commitment: "confirmed",
      skipPreflight: skipPreflight,
    });

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

    const { value: blockhashClose } = await rpc.getLatestBlockhash().send();
    const closeIx = {
      programAddress: PORTAL_PROGRAM_ID,
      accounts: [
        {
          address: closeSessionOwner.address,
          role: AccountRole.WRITABLE_SIGNER,
        },
        { address: sessionPDA, role: AccountRole.WRITABLE },
        { address: feeVaultPDA, role: AccountRole.WRITABLE },
        { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
      ],
      data: PortalProgram.encodeCloseSession({ gridId: closeGridId }),
    };

    const closeTx = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(closeSessionOwner, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhashClose, tx),
      (tx) => appendTransactionMessageInstructions([closeIx], tx),
    );
    const signedClose = await signTransactionMessageWithSigners(closeTx);
    assertIsSendableTransaction(signedClose);
    assertIsTransactionWithBlockhashLifetime(signedClose);
    await sendAndConfirmTransactionWithoutWebsocket(signedClose, {
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
    console.log("\n=== Step 3: Verify ER RPC ===");

    const erSdk = new NorthStarSDK({
      solanaNetwork: "localnet",
      customEndpoints: {
        ephemeralRollup: "http://127.0.0.1:8910",
      },
    });

    const health = await erSdk.checkHealth();
    console.log("Health check:", health);

    // ER should be running now that session was opened
    // Note: This may fail if ER takes time to start
  }, 30000);

  async function sendAndConfirmTransactionWithoutWebsocket(
    transaction: any,
    config: { commitment: "confirmed" | "finalized"; skipPreflight: boolean },
  ) {
    await sendTransactionWithoutConfirming(transaction, config);

    const signature = getSignatureFromTransaction(transaction);
    const maxAttempts = 40; // ~20 seconds total with 500ms interval
    for (let i = 0; i < maxAttempts; i++) {
      const statuses = await (rpc as any).getSignatureStatuses([signature]).send();
      const status = statuses?.value?.[0];

      if (status?.err) {
        console.error("Transaction failed on-chain: %o", status?.err);
        throw new Error(
          `Transaction failed on-chain: status.err ${safeStringify(status?.err)}`,
        );
      }

      if (
        status &&
        (status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized")
      ) {
        return;
      }

      await sleep(500);
    }

    throw new Error(
      `Transaction confirmation timeout (HTTP polling): ${String(signature)}`,
    );
  }
});

async function deriveSessionPDA(owner: any, gridId: number): Promise<any> {
  const addressEncoder = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: PORTAL_PROGRAM_ID,
    seeds: ["session", addressEncoder.encode(owner), numberToLE(gridId, 8)],
  });
  return pda;
}

async function deriveFeeVaultPDA(owner: any): Promise<any> {
  const addressEncoder = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: PORTAL_PROGRAM_ID,
    seeds: ["fee_vault", addressEncoder.encode(owner)],
  });
  return pda;
}

function numberToLE(num: number, bytes: number): Uint8Array {
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) {
    arr[i] = num & 0xff;
    num = num >> 8;
  }
  return arr;
}

/**
 * System Program `Assign` 指令数据（bincode：variant u32 LE = 1，后跟 32 字节新 owner）。
 */
function encodeSystemProgramAssign(newProgramOwner: ReturnType<typeof address>): Uint8Array {
  const addressEncoder = getAddressEncoder();
  const data = new Uint8Array(4 + 32);
  new DataView(data.buffer).setUint32(0, 1, true);
  data.set(addressEncoder.encode(newProgramOwner), 4);
  return data;
}

async function deriveDelegationRecordPDA(delegatedAccount: any): Promise<any> {
  const addressEncoder = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: PORTAL_PROGRAM_ID,
    seeds: ["delegation", addressEncoder.encode(delegatedAccount)],
  });
  return pda;
}

function safeStringify(obj: any): string {
  try {
    return JSON.stringify(obj, (_,v) => typeof v === 'bigint' ? v.toString() : v);
  } catch (e) {
    return "Error stringifying object";
  }
}