import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import { config } from "dotenv";
import {
  encodeSystemProgramAssignData,
  NorthStarSDK,
  signVersionedTransaction,
  TOKEN_BRIDGE_PROGRAM_ID,
} from "../src";

config();

const VALIDATOR_RPC = process.env.VALIDATOR_RPC ?? "http://localhost:8899";
const EPHEMERAL_ROLLUP_RPC =
  process.env.EPHEMERAL_ROLLUP_RPC ?? "http://localhost:8910";
const PORTAL_PROGRAM_ID = new PublicKey(process.env.PORTAL_PROGRAM_ID!.trim());
const DECIMALS = 6;
const GRID_ID = 1;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function walletSignLocal(...keypairs: Keypair[]) {
  return async (tx: VersionedTransaction) =>
    signVersionedTransaction(tx, keypairs);
}

async function loadFundingSignerFromEnv(): Promise<Keypair> {
  const secret = process.env.TRANSFER_SOURCE_PRIVATE_KEY?.trim();
  if (!secret) {
    throw new Error("TRANSFER_SOURCE_PRIVATE_KEY is required");
  }
  const bytes = Uint8Array.from(bs58.decode(secret));
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(`Invalid TRANSFER_SOURCE_PRIVATE_KEY length: ${bytes.length}`);
}

async function sendTx(
  sdk: NorthStarSDK,
  connection: Connection,
  payer: PublicKey,
  instructions: any[],
  signers: Keypair[],
  skipPreflight = true,
) {
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(),
  );
  tx.sign(signers);
  const { signature } = await sdk.sendAndConfirmTransactionWithoutWebsocket(tx, {
    commitment: "confirmed",
    skipPreflight,
    maxAttempts: 60,
    intervalMs: 500,
  });
  return signature;
}

async function assignAccountOwnerAndConfirm(
  sdk: NorthStarSDK,
  connection: Connection,
  feePayer: Keypair,
  account: Keypair,
  newOwnerProgramId: PublicKey,
) {
  await sendTx(
    sdk,
    connection,
    feePayer.publicKey,
    [
      {
        programId: SystemProgram.programId,
        keys: [{ pubkey: account.publicKey, isSigner: true, isWritable: true }],
        data: Buffer.from(encodeSystemProgramAssignData(newOwnerProgramId)),
      },
    ],
    [feePayer, account],
  );
}

async function sendErTx(
  erRpc: Connection,
  payer: PublicKey,
  instructions: any[],
  signers: Keypair[],
) {
  const { blockhash } = await erRpc.getLatestBlockhash("processed");
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(),
  );
  tx.sign(signers);
  return erRpc.sendRawTransaction(Buffer.from(tx.serialize()), {
    skipPreflight: true,
  });
}

async function waitForErAmount(
  sdk: NorthStarSDK,
  connection: Connection,
  erTokenAccount: PublicKey,
  expected: bigint,
  commitment: "processed" | "confirmed" = "processed",
) {
  for (let i = 0; i < 60; i++) {
    const info = await connection.getAccountInfo(erTokenAccount, commitment);
    if (info) {
      const state = sdk.tokenBridge.parseErTokenAccount(info.data);
      if (state.amount === expected) return state;
    }
    await sleep(500);
  }
  throw new Error(
    `Timed out waiting for ${erTokenAccount.toBase58()} amount ${expected}`,
  );
}

describe("SPL token bridge live E2E", () => {
  test("mint on L1, deposit to ER, transfer on ER, settle and withdraw on L1", async () => {
    const sdk = new NorthStarSDK({
      portalProgramId: PORTAL_PROGRAM_ID,
      customEndpoints: {
        solana: VALIDATOR_RPC,
        ephemeralRollup: EPHEMERAL_ROLLUP_RPC,
      },
    });
    const rpc = sdk.getRpc();
    const erRpc = sdk.getEphemeralRpc();
    const payer = await loadFundingSignerFromEnv();
    const alice = payer;
    const bob = Keypair.generate();
    const erFeePayer = Keypair.generate();

    console.log("payer/alice", alice.publicKey.toBase58());
    console.log("bob", bob.publicKey.toBase58());
    console.log("ER fee payer", erFeePayer.publicKey.toBase58());

    const tokenBridgeProgram = await rpc.getAccountInfo(TOKEN_BRIDGE_PROGRAM_ID);
    expect(tokenBridgeProgram?.executable).toBe(true);

    const identity = await (rpc as any)._rpcRequest("getIdentity", []);
    const validatorIdentity = new PublicKey(identity.result.identity);
    const session = await sdk.portal.deriveSessionPDA();
    const feeVault = await sdk.portal.deriveFeeVaultPDA();
    const existingSession = await rpc.getAccountInfo(session);
    if (existingSession) {
      await sdk.closeSession(
        alice.publicKey,
        walletSignLocal(alice),
        {},
        { commitment: "confirmed", skipPreflight: true },
      );
      await sleep(1000);
    }

    await sdk.openSession(
      alice.publicKey,
      GRID_ID,
      2_000,
      1_000_000,
      walletSignLocal(alice),
      {},
      { commitment: "confirmed", skipPreflight: true, maxAttempts: 60 },
      { validator: validatorIdentity, settlementIntervalSlots: 10 },
    );
    expect(await rpc.getAccountInfo(session)).not.toBeNull();
    expect(await rpc.getAccountInfo(feeVault)).not.toBeNull();
    console.log("session", session.toBase58());

    await sendTx(
      sdk,
      rpc,
      alice.publicKey,
      [
        SystemProgram.transfer({
          fromPubkey: alice.publicKey,
          toPubkey: bob.publicKey,
          lamports: 100_000_000,
        }),
        SystemProgram.transfer({
          fromPubkey: alice.publicKey,
          toPubkey: erFeePayer.publicKey,
          lamports: 100_000_000,
        }),
      ],
      [alice],
    );

    const mint = Keypair.generate();
    const mintRent = await rpc.getMinimumBalanceForRentExemption(MINT_SIZE);
    const sessionBridge = await sdk.portal.deriveSessionBridgePDA(
      session,
      mint.publicKey,
    );
    const vault = sdk.tokenBridge.deriveVaultPDA(sessionBridge);
    const aliceToken = getAssociatedTokenAddressSync(
      mint.publicKey,
      alice.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const bobToken = getAssociatedTokenAddressSync(
      mint.publicKey,
      bob.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const vaultToken = getAssociatedTokenAddressSync(
      mint.publicKey,
      vault,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const aliceEr = sdk.tokenBridge.deriveErTokenAccountPDA(
      sessionBridge,
      alice.publicKey,
    );
    const bobEr = sdk.tokenBridge.deriveErTokenAccountPDA(
      sessionBridge,
      bob.publicKey,
    );

    await sendTx(
      sdk,
      rpc,
      alice.publicKey,
      [
        SystemProgram.createAccount({
          fromPubkey: alice.publicKey,
          newAccountPubkey: mint.publicKey,
          lamports: mintRent,
          space: MINT_SIZE,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMintInstruction(
          mint.publicKey,
          DECIMALS,
          alice.publicKey,
          null,
          TOKEN_PROGRAM_ID,
        ),
        createAssociatedTokenAccountInstruction(
          alice.publicKey,
          aliceToken,
          alice.publicKey,
          mint.publicKey,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
        createAssociatedTokenAccountInstruction(
          alice.publicKey,
          bobToken,
          bob.publicKey,
          mint.publicKey,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
        createAssociatedTokenAccountInstruction(
          alice.publicKey,
          vaultToken,
          vault,
          mint.publicKey,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
        createMintToInstruction(
          mint.publicKey,
          aliceToken,
          alice.publicKey,
          1_000_000_000n,
          [],
          TOKEN_PROGRAM_ID,
        ),
      ],
      [alice, mint],
      false,
    );
    console.log("mint", mint.publicKey.toBase58());

    await sendTx(
      sdk,
      rpc,
      alice.publicKey,
      [
        await sdk.buildRegisterSessionBridgeInstruction({
          authority: alice.publicKey,
          session,
          mint: mint.publicKey,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
        }),
        await sdk.buildInitializeTokenVaultInstruction({
          payer: alice.publicKey,
          sessionBridge,
          vaultTokenAccount: vaultToken,
        }),
        await sdk.buildInitializeErTokenAccountInstruction({
          payer: alice.publicKey,
          sessionBridge,
          owner: alice.publicKey,
        }),
        await sdk.buildInitializeErTokenAccountInstruction({
          payer: alice.publicKey,
          sessionBridge,
          owner: bob.publicKey,
        }),
      ],
      [alice],
    );

    await sendTx(
      sdk,
      rpc,
      alice.publicKey,
      [
        sdk.buildTokenBridgeDepositInstruction({
          owner: alice.publicKey,
          vault,
          erTokenAccount: aliceEr,
          sessionBridge,
          sourceTokenAccount: aliceToken,
          vaultTokenAccount: vaultToken,
          mint: mint.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          amount: 600_000_000n,
          decimals: DECIMALS,
        }),
      ],
      [alice],
    );
    await waitForErAmount(sdk, rpc, aliceEr, 600_000_000n, "confirmed");

    await assignAccountOwnerAndConfirm(
      sdk,
      rpc,
      alice,
      erFeePayer,
      PORTAL_PROGRAM_ID,
    );
    await sdk.delegate(
      alice.publicKey,
      GRID_ID,
      walletSignLocal(alice),
      {
        delegations: [
          {
            delegatedAccountSigner: erFeePayer,
            ownerProgramId: SystemProgram.programId,
          },
        ],
      },
      { commitment: "confirmed", skipPreflight: true, maxAttempts: 60 },
    );

    await sendTx(
      sdk,
      rpc,
      alice.publicKey,
      [
        sdk.buildDelegateErTokenAccountInstruction({
          payer: alice.publicKey,
          erTokenAccount: aliceEr,
          sessionBridge,
          session,
          gridId: GRID_ID,
        }),
        sdk.buildDelegateErTokenAccountInstruction({
          payer: alice.publicKey,
          erTokenAccount: bobEr,
          sessionBridge,
          session,
          gridId: GRID_ID,
        }),
      ],
      [alice],
    );

    await waitForErAmount(sdk, erRpc, aliceEr, 600_000_000n);
    await waitForErAmount(sdk, erRpc, bobEr, 0n);

    const erTransferSig = await sendErTx(
      erRpc,
      erFeePayer.publicKey,
      [
        sdk.buildTokenBridgeTransferInstruction({
          authority: alice.publicKey,
          sourceErTokenAccount: aliceEr,
          destinationErTokenAccount: bobEr,
          amount: 250_000_000n,
        }),
      ],
      [erFeePayer, alice],
    );
    console.log("ER transfer", erTransferSig);
    await waitForErAmount(sdk, erRpc, aliceEr, 350_000_000n);
    await waitForErAmount(sdk, erRpc, bobEr, 250_000_000n);

    await waitForErAmount(sdk, rpc, bobEr, 250_000_000n, "confirmed");
    console.log("L1 settlement observed for Bob ER balance");

    await sendTx(
      sdk,
      rpc,
      alice.publicKey,
      [
        sdk.buildUndelegateErTokenAccountInstruction({
          authority: bob.publicKey,
          erTokenAccount: bobEr,
          session,
        }),
      ],
      [alice, bob],
    );

    await sendTx(
      sdk,
      rpc,
      alice.publicKey,
      [
        sdk.buildTokenBridgeWithdrawInstruction({
          owner: bob.publicKey,
          vault,
          erTokenAccount: bobEr,
          sessionBridge,
          vaultTokenAccount: vaultToken,
          destinationTokenAccount: bobToken,
          mint: mint.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          amount: 200_000_000n,
          decimals: DECIMALS,
        }),
      ],
      [alice, bob],
    );

    const bobTokenAfter = await getAccount(rpc, bobToken, "confirmed", TOKEN_PROGRAM_ID);
    const vaultTokenAfter = await getAccount(
      rpc,
      vaultToken,
      "confirmed",
      TOKEN_PROGRAM_ID,
    );
    expect(bobTokenAfter.amount).toBe(200_000_000n);
    expect(vaultTokenAfter.amount).toBe(400_000_000n);
    await waitForErAmount(sdk, rpc, bobEr, 50_000_000n, "confirmed");
    console.log("Bob L1 token balance", bobTokenAfter.amount.toString());
  }, 300_000);
});
