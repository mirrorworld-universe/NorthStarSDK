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
import { NorthStarSDK, PORTAL_PROGRAM_ID, PortalProgram } from "../src";

let skipPreflight = true;
const SYSTEM_PROGRAM_ID = address("11111111111111111111111111111111");
const TOKEN_PROGRAM_ID = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  let delegatedAccount:KeyPairSigner;
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

    console.log("\n=== Test Setup ===");
    console.log("Portal owner:", portalOwner.address);
    console.log("Delegated account:", delegatedAccount.address);

    try {
      // Use direct RPC call for airdrop (faucet)
      // Note: Must use number for lamports, not BigInt
      await (rpc as any).requestAirdrop(portalOwner.address, 2000000000).send();
      console.log("✓ Airdropped 2 SOL to portal owner");

      await (rpc as any)
        .requestAirdrop(delegatedAccount.address, 1000000000)
        .send();
      console.log("✓ Airdropped 1 SOL to delegated account");


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
    await sleep(3000);
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

  test.skip("Step 3: Verify ER RPC is running after session opened", async () => {
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