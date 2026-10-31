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
import { assertDevelopmentDeployment } from "./live-config";
import {
  NorthStarSDK,
  signVersionedTransaction,
} from "../src";

config();

const VALIDATOR_RPC = process.env.VALIDATOR_RPC ?? "http://localhost:8899";
const EPHEMERAL_ROLLUP_RPC =
  process.env.EPHEMERAL_ROLLUP_RPC ?? "http://localhost:8910";
const PORTAL_PROGRAM_ID = new PublicKey(process.env.PORTAL_PROGRAM_ID!.trim());
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the continuity deployment`);
  return value;
}
const TOKEN_BRIDGE_PROGRAM_ID = new PublicKey(required("TOKEN_BRIDGE_PROGRAM_ID"));
const L1_GENESIS_HASH = required("L1_GENESIS_HASH");
assertDevelopmentDeployment(L1_GENESIS_HASH, VALIDATOR_RPC);
const PROFILE_HEX = required("CHECKPOINT_PROFILE");
if (!/^[0-9a-fA-F]{64}$/.test(PROFILE_HEX)) throw new Error("CHECKPOINT_PROFILE must be 64 hex digits");
const CHECKPOINT_PROFILE = Uint8Array.from(Buffer.from(PROFILE_HEX, "hex"));
const VALIDATOR_IDENTITY = new PublicKey(required("VALIDATOR_IDENTITY"));
const DECIMALS = 6;
const GRID_ID = BigInt(process.env.NORTHSTAR_GRID_ID ?? "0");

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
  skipPreflight = false,
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
    skipPreflight: false,
    maxRetries: 0,
  });
}

async function waitForErAmount(
  sdk: NorthStarSDK,
  connection: Connection,
  erTokenAccount: PublicKey,
  expected: bigint,
  commitment: "processed" | "confirmed" = "processed",
) {
  for (let i = 0; i < 120; i++) {
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

async function waitForTokenAmount(
  connection: Connection,
  tokenAccount: PublicKey,
  expected: bigint,
) {
  for (let i = 0; i < 120; i++) {
    const state = await getAccount(
      connection,
      tokenAccount,
      "finalized",
      TOKEN_PROGRAM_ID,
    );
    if (state.amount === expected) return state;
    await sleep(1000);
  }
  throw new Error(
    `Timed out waiting for token account ${tokenAccount.toBase58()} amount ${expected}`,
  );
}

async function waitForExecutionSession(sdk: NorthStarSDK) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 120; attempt++) {
    const status = await sdk.getEphemeralRollupSyncStatus();
    if (status.checkpointError != null) throw new Error(`ER checkpoint error: ${status.checkpointError}`);
    try { return await sdk.getExecutionSession(); }
    catch (error) { lastError = error; }
    await sleep(1000);
  }
  throw new Error(`ER session readiness timed out: ${String(lastError)}`);
}

describe("SPL token bridge live E2E", () => {
  test("mint on L1, deposit to ER, transfer on ER, settle and withdraw on L1", async () => {
    const sdk = new NorthStarSDK({
      portalProgramId: PORTAL_PROGRAM_ID,
      tokenBridgeProgramId: TOKEN_BRIDGE_PROGRAM_ID,
      l1GenesisHash: L1_GENESIS_HASH,
      checkpointProfile: CHECKPOINT_PROFILE,
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

    const session = await sdk.portal.deriveSessionPDA();
    const feeVault = await sdk.portal.deriveFeeVaultPDA();
    if (await rpc.getAccountInfo(session)) {
      const existing = await sdk.getSessionSnapshot();
      if (!existing.state.authority.equals(alice.publicKey) || !existing.state.validator.equals(VALIDATOR_IDENTITY) || existing.state.gridId !== GRID_ID) {
        throw new Error("Existing session authority, validator or grid differs from this deployment");
      }
    } else {
      await sdk.openSession(alice.publicKey, GRID_ID, 80_000n, 1_000_000n,
        walletSignLocal(alice), {}, { commitment: "confirmed", maxAttempts: 60 },
        { validator: VALIDATOR_IDENTITY, settlementIntervalSlots: 10 });
    }
    expect(await rpc.getAccountInfo(session)).not.toBeNull();
    expect(await rpc.getAccountInfo(feeVault)).not.toBeNull();
    console.log("session", session.toBase58());

    await sdk.depositFee(alice.publicKey, 100_000_000n, walletSignLocal(alice), {},
      { commitment: "confirmed", maxAttempts: 60 }, erFeePayer.publicKey);

    const mint = Keypair.generate();
    const mintRent = await rpc.getMinimumBalanceForRentExemption(MINT_SIZE);
    const initialSnapshot = await sdk.getSessionSnapshot();
    const sessionBridge = await sdk.portal.deriveSessionBridgePDA(
      initialSnapshot.context,
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
          payer: alice.publicKey,
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

    await waitForExecutionSession(sdk);
    const delegationSnapshot = await sdk.getSessionSnapshot();

    await sendTx(
      sdk,
      rpc,
      alice.publicKey,
      [
        sdk.buildDelegateErTokenAccountInstruction({
          payer: alice.publicKey, owner: alice.publicKey, erTokenAccount: aliceEr,
          sessionBridge, session, mint: mint.publicKey, gridId: GRID_ID,
          sessionContext: delegationSnapshot.context, sequence: delegationSnapshot.nextSequence,
        }),
        sdk.buildDelegateErTokenAccountInstruction({
          payer: alice.publicKey, owner: bob.publicKey, erTokenAccount: bobEr,
          sessionBridge, session, mint: mint.publicKey, gridId: GRID_ID,
          sessionContext: delegationSnapshot.context, sequence: delegationSnapshot.nextSequence + 1n,
        }),
      ],
      [alice, bob],
    );

    await waitForErAmount(sdk, erRpc, aliceEr, 0n);
    await waitForErAmount(sdk, erRpc, bobEr, 0n);
    const depositSnapshot = await sdk.getSessionSnapshot();

    await sendTx(
      sdk,
      rpc,
      alice.publicKey,
      [
        sdk.buildTokenBridgeDepositInstruction({
          session, sessionContext: depositSnapshot.context, sequence: depositSnapshot.nextSequence,
          payer: alice.publicKey,
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
    await waitForErAmount(sdk, erRpc, aliceEr, 600_000_000n);

    await waitForExecutionSession(sdk);
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
    const executionSnapshot = await waitForExecutionSession(sdk);

    await sendErTx(
      erRpc,
      erFeePayer.publicKey,
      [
        sdk.buildTokenBridgeStartWithdrawalInstruction({
          sessionContext: executionSnapshot.context, mint: mint.publicKey,
          owner: bob.publicKey,
          erTokenAccount: bobEr,
          sessionBridge,
          destinationTokenAccount: bobToken,
          tokenProgram: TOKEN_PROGRAM_ID,
          amount: 200_000_000n,
          decimals: DECIMALS,
        }),
      ],
      [erFeePayer, bob],
    );
    await waitForErAmount(sdk, erRpc, bobEr, 50_000_000n);

    const bobTokenAfter = await waitForTokenAmount(rpc, bobToken, 200_000_000n);
    const vaultTokenAfter = await waitForTokenAmount(
      rpc,
      vaultToken,
      400_000_000n,
    );
    expect(bobTokenAfter.amount).toBe(200_000_000n);
    expect(vaultTokenAfter.amount).toBe(400_000_000n);
    await waitForErAmount(sdk, rpc, bobEr, 50_000_000n, "confirmed");

    expect((await rpc.getAccountInfo(bobEr, "confirmed"))?.owner.equals(PORTAL_PROGRAM_ID)).toBe(true);
    expect(() => sdk.buildRequestErTokenAccountUndelegationInstruction({})).toThrow("no continuity lifecycle binding");
    console.log("Bob L1 token balance", bobTokenAfter.amount.toString());
  }, 600_000);
});
