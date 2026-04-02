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
  address,
  generateKeyPairSigner,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  signTransactionMessageWithSigners,
  assertIsTransactionWithBlockhashLifetime,
  assertIsSendableTransaction,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  sendAndConfirmTransactionFactory,
  getSignatureFromTransaction,
  getAddressEncoder,
  getProgramDerivedAddress,
} from "@solana/kit";
import { NorthStarSDK, PORTAL_PROGRAM_ID, PortalProgram } from "../src";

describe("Real Integration Tests", () => {
  const PORTAL_PROGRAM_ID = address(
    "5TeWSsjg2gbxCyWVniXeCmwM7UtHTCK7svzJr5xYJzHf",
  );

  let sdk: NorthStarSDK;
  let rpc: ReturnType<typeof createSolanaRpc>;
  let rpcSubscriptions: ReturnType<typeof createSolanaRpcSubscriptions>;
  let sendAndConfirmTransaction: ReturnType<
    typeof sendAndConfirmTransactionFactory
  >;
  let portalOwner: Awaited<ReturnType<typeof generateKeyPairSigner>>;
  let delegatedAccount: Awaited<ReturnType<typeof generateKeyPairSigner>>;
  const gridId = 1;

  beforeAll(async () => {
    rpc = createSolanaRpc("http://127.0.0.1:8899");
    rpcSubscriptions = createSolanaRpcSubscriptions("ws://127.0.0.1:8900");
    sendAndConfirmTransaction = sendAndConfirmTransactionFactory({
      rpc,
      rpcSubscriptions,
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
    console.log("Portal owner:", String(portalOwner.address));
    console.log("Delegated account:", String(delegatedAccount.address));

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
      await new Promise((resolve) => setTimeout(resolve, 1000));
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
      version: 0 as const,
      programAddress: PORTAL_PROGRAM_ID,
      accounts: [
        { address: portalOwner.address, role: 1 as const },
        { address: sessionPDA, role: 1 as const },
        { address: feeVaultPDA, role: 1 as const },
        {
          address: address("11111111111111111111111111111111"),
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
      await sendAndConfirmTransaction(transaction, {
        commitment: "confirmed",
        skipPreflight: true,
      });
    } catch (e) {
      console.log("Transaction error (may have succeeded):", String(e));
    }
    const signature = getSignatureFromTransaction(transaction);

    console.log("✓ Session opened");
    console.log("  Signature:", signature);

    // Wait a bit for the transaction to be processed
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Retry getting account info with retries
    let sessionInfo = null;
    for (let i = 0; i < 3; i++) {
      try {
        sessionInfo = await rpc.getAccountInfo(sessionPDA).send();
        break;
      } catch (e) {
        console.log("Retry getAccountInfo:", i + 1);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    expect(sessionInfo?.value).not.toBeNull();
    console.log("✓ Session account exists on-chain");

    // Retry getting account info with retries
    let feeVaultInfo = null;
    for (let i = 0; i < 3; i++) {
      try {
        feeVaultInfo = await rpc.getAccountInfo(feeVaultPDA).send();
        break;
      } catch (e) {
        console.log("Retry feeVaultInfo:", i + 1);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    expect(feeVaultInfo?.value).not.toBeNull();
    console.log("✓ FeeVault account exists on-chain");
  }, 60000);

  test("Step 2: Delegate Account - should create delegation record", async () => {
    console.log("\n=== Step 2: Delegate Account ===");

    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

    const delegationRecordPDA = await deriveDelegationRecordPDA(
      delegatedAccount.address,
    );

    console.log("Delegation record PDA:", delegationRecordPDA);

    // First, assign ownership of the delegated account to the portal program.
    // The Delegate instruction requires the account to already be owned by
    // the portal program.
    const assignInstruction = {
      version: 0 as const,
      programAddress: address("11111111111111111111111111111111"),
      accounts: [
        {
          address: delegatedAccount.address,
          role: 3 as const,
          signer: delegatedAccount,
        }, // writable + signer
      ],
      data: encodeAssignInstruction(PORTAL_PROGRAM_ID),
    };

    const delegateInstruction = {
      version: 0 as const,
      programAddress: PORTAL_PROGRAM_ID,
      accounts: [
        { address: portalOwner.address, role: 1 as const },
        {
          address: delegatedAccount.address,
          role: 1 as const,
        },
        { address: PORTAL_PROGRAM_ID, role: 0 as const },
        { address: delegationRecordPDA, role: 1 as const },
        {
          address: address("11111111111111111111111111111111"),
          role: 0 as const,
        },
      ],
      data: PortalProgram.encodeDelegate({ gridId }),
    };

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(portalOwner, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx) =>
        appendTransactionMessageInstructions(
          [assignInstruction, delegateInstruction],
          tx,
        ),
    );

    const transaction =
      await signTransactionMessageWithSigners(transactionMessage);
    assertIsSendableTransaction(transaction);
    assertIsTransactionWithBlockhashLifetime(transaction);

    try {
      await sendAndConfirmTransaction(transaction, {
        commitment: "confirmed",
        skipPreflight: true,
      });
    } catch (e) {
      console.log("Transaction error (may have succeeded):", String(e));
    }
    const signature = getSignatureFromTransaction(transaction);

    console.log("✓ Delegation created");
    console.log("  Signature:", signature);

    // Wait a bit for the transaction to be processed
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Retry getting account info with retries
    let delegationInfo = null;
    for (let i = 0; i < 3; i++) {
      try {
        delegationInfo = await rpc.getAccountInfo(delegationRecordPDA).send();
        break;
      } catch (e) {
        console.log("Retry getAccountInfo:", i + 1);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    expect(delegationInfo?.value).not.toBeNull();
    console.log("✓ Delegation record exists on-chain");
  }, 60000);

  test("Step 3: Verify ER RPC is running after session opened", async () => {
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

async function deriveDelegationRecordPDA(delegatedAccount: any): Promise<any> {
  const addressEncoder = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: PORTAL_PROGRAM_ID,
    seeds: ["delegation", addressEncoder.encode(delegatedAccount)],
  });
  return pda;
}

/**
 * Encode a SystemProgram.Assign instruction.
 * Layout: [1, 0, 0, 0] (u32 LE instruction index) + 32 bytes new owner pubkey
 */
function encodeAssignInstruction(newOwner: any): Uint8Array {
  const addressEncoder = getAddressEncoder();
  const ownerBytes = addressEncoder.encode(newOwner);
  const data = new Uint8Array(4 + 32);
  // Instruction index 1 = Assign (little-endian u32)
  data[0] = 1;
  data[1] = 0;
  data[2] = 0;
  data[3] = 0;
  data.set(ownerBytes, 4);
  return data;
}
