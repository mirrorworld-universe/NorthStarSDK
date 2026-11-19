import {
  Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "dotenv";
import { NorthStarSDK, signVersionedTransaction } from "../src";
import { assertDevelopmentDeployment } from "./live-config";

config();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the continuity deployment`);
  return value;
}

const profile = required("CHECKPOINT_PROFILE");
if (!/^[0-9a-fA-F]{64}$/.test(profile)) throw new Error("CHECKPOINT_PROFILE must be 64 hex digits");
const portal = new PublicKey(required("PORTAL_PROGRAM_ID"));
const bridge = new PublicKey(required("TOKEN_BRIDGE_PROGRAM_ID"));
const validator = new PublicKey(required("VALIDATOR_IDENTITY"));
const grid = BigInt(process.env.NORTHSTAR_GRID_ID ?? "0");
const genesis = required("L1_GENESIS_HASH");
const l1Rpc = process.env.VALIDATOR_RPC ?? "http://localhost:8899";
const erRpc = process.env.EPHEMERAL_ROLLUP_RPC ?? "http://localhost:8910";
assertDevelopmentDeployment(genesis, l1Rpc);

async function poll<T>(phase: string, read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 240; attempt++) {
    try {
      const value = await read();
      if (ready(value)) return value;
    } catch (error) {
      if (String(error).includes("checkpoint error")) throw error;
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`${phase} timed out: ${String(lastError)}`);
}

function fundingSigner(): Keypair {
  const bytes = bs58.decode(required("TRANSFER_SOURCE_PRIVATE_KEY"));
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error("Funding key must contain 32 or 64 bytes");
}

async function sendL1(sdk: NorthStarSDK, signer: Keypair, instructions: TransactionInstruction[]) {
  const latest = await sdk.getRpc().getLatestBlockhash("confirmed");
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: signer.publicKey, recentBlockhash: latest.blockhash, instructions,
  }).compileToV0Message());
  transaction.sign([signer]);
  return sdk.sendAndConfirmTransactionWithoutWebsocket(transaction, { maxAttempts: 120, intervalMs: 500 });
}

describe("continuity SOL live lifecycle", () => {
  test("binds delegation, explicit deposits, two deferred payouts and a later top-up", async () => {
    const sdk = new NorthStarSDK({
      portalProgramId: portal, tokenBridgeProgramId: bridge, l1GenesisHash: genesis,
      checkpointProfile: Uint8Array.from(Buffer.from(profile, "hex")),
      customEndpoints: { solana: l1Rpc, ephemeralRollup: erRpc },
    });
    const rpc = sdk.getRpc();
    const er = sdk.getEphemeralRpc();
    const funder = fundingSigner();
    const wallet = async (transaction: VersionedTransaction) => signVersionedTransaction(transaction, [funder]);
    const session = await sdk.portal.deriveSessionPDA();
    if (await rpc.getAccountInfo(session, "confirmed")) {
      const snapshot = await sdk.getSessionSnapshot();
      if (!snapshot.state.authority.equals(funder.publicKey) || !snapshot.state.validator.equals(validator) || snapshot.state.gridId !== grid) {
        throw new Error("Existing session authority, validator or grid differs from the requested deployment");
      }
    } else {
      await sdk.openSession(funder.publicKey, grid, 80_000n, 1_000_000n, wallet, {},
        { maxAttempts: 120, intervalMs: 500 }, { validator, settlementIntervalSlots: 10n });
    }

    const delegated = Keypair.generate();
    await sendL1(sdk, funder, [SystemProgram.transfer({
      fromPubkey: funder.publicKey, toPubkey: delegated.publicKey, lamports: 1_000_000,
    })]);
    await sdk.delegate(funder.publicKey, grid, wallet, {
      delegations: [{ delegatedAccountSigner: delegated, ownerProgramId: SystemProgram.programId }],
    }, { maxAttempts: 120, intervalMs: 500 });
    const recordAddress = await sdk.portal.deriveDelegationRecordPDA(delegated.publicKey);
    const record = await rpc.getAccountInfo(recordAddress, "confirmed");
    expect(record?.owner.equals(portal)).toBe(true);
    expect(sdk.portal.parseDelegationRecord(record!.data).gridId).toBe(grid);
    expect((await rpc.getAccountInfo(delegated.publicKey, "confirmed"))?.owner.equals(portal)).toBe(true);

    const payer = Keypair.generate();
    await sdk.depositFee(funder.publicKey, 10_000_000n, wallet, {},
      { maxAttempts: 120, intervalMs: 500 }, payer.publicKey);
    const snapshot = await sdk.getSessionSnapshot();
    const receiptAddress = await sdk.portal.deriveDepositReceiptPDA(snapshot.context, payer.publicKey);
    const receiptBefore = await rpc.getAccountInfo(receiptAddress, "confirmed");
    expect(receiptBefore?.owner.equals(portal)).toBe(true);
    expect(sdk.portal.parseDepositReceipt(receiptBefore!.data).totalDeposited).toBe(10_000_000n);
    await poll("initial ER SOL credit", () => er.getBalance(payer.publicKey, "processed"), value => value === 10_000_000);

    for (const cycle of [0, 1]) {
      if (cycle === 1) {
        const before = await er.getBalance(payer.publicKey, "processed");
        await sdk.depositFee(funder.publicKey, 2_000_000n, wallet, {},
          { maxAttempts: 120, intervalMs: 500 }, payer.publicKey);
        await poll("later ER SOL top-up", () => er.getBalance(payer.publicKey, "processed"), value => value >= before + 2_000_000);
      }
      await poll("bound ER session", () => sdk.getExecutionSession(), () => true);
      const recipient = Keypair.generate().publicKey;
      const instructions = await sdk.buildErSolWithdrawalInstructions({
        erSource: payer.publicKey, l1Recipient: recipient, lamports: 1_000_000n,
      });
      const latest = await er.getLatestBlockhash("processed");
      const transaction = new VersionedTransaction(new TransactionMessage({
        payerKey: payer.publicKey, recentBlockhash: latest.blockhash, instructions,
      }).compileToV0Message());
      transaction.sign([payer]);
      const signature = await er.sendRawTransaction(transaction.serialize(), { skipPreflight: false, maxRetries: 0 });
      console.log(`SOL cycle ${cycle + 1} ER signature: ${signature}`);
      await poll("finalized L1 SOL payout", () => rpc.getBalance(recipient, "finalized"), value => value === 1_000_000);
      await poll("cumulative SOL payout receipt", async () => {
        const account = await rpc.getAccountInfo(receiptAddress, "finalized");
        if (!account?.owner.equals(portal)) throw new Error("Payout receipt owner changed");
        return sdk.portal.parseDepositReceipt(account.data);
      }, state => state.withdrawn === BigInt(cycle + 1) * 1_000_000n);
    }
    const finalReceipt = await rpc.getAccountInfo(receiptAddress, "finalized");
    expect(sdk.portal.parseDepositReceipt(finalReceipt!.data).totalDeposited).toBe(12_000_000n);
    expect((await rpc.getAccountInfo(delegated.publicKey, "finalized"))?.owner.equals(portal)).toBe(true);
  }, 600_000);
});
