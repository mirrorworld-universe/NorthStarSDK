import { generateKeyPairSigner } from "@solana/kit";
import { NorthStarSDK, PortalProgram } from "../src";
import {
  ER_RPC_URL,
  ER_WS_URL,
  L1_RPC_URL,
  L1_WS_URL,
  PORTAL_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  accountData,
  assignIx,
  closeSessionIx,
  createClients,
  delegateIx,
  depositFeeIx,
  deriveDelegationRecordPda,
  deriveDepositReceiptPda,
  deriveFeeVaultPda,
  deriveSessionPda,
  expectValidatorReady,
  fundedSigner,
  openSessionIx,
  readU64LE,
  rpcRequest,
  sendInstructions,
  sleep,
  transferIx,
  undelegateIx,
  uniqueGridId,
  waitFor,
  waitForBalance,
} from "./helpers/localValidator";

describe("NorthStar service scenarios on local validator", () => {
  const l1 = createClients(L1_RPC_URL, L1_WS_URL);
  const er = createClients(ER_RPC_URL, ER_WS_URL);
  const sdk = new NorthStarSDK({
    solanaNetwork: "localnet",
    portalProgramId: PORTAL_PROGRAM_ID,
    customEndpoints: { solana: L1_RPC_URL, ephemeralRollup: ER_RPC_URL },
  });

  beforeAll(async () => {
    await expectValidatorReady();
  }, 30_000);

  test("ER RPC is always on but has no active session before Portal event", async () => {
    const health = await sdk.checkHealth();
    expect(health).toEqual({ solana: true, ephemeralRollup: true });

    const session = await rpcRequest<string | null>(ER_RPC_URL, "getSessionPda");
    expect(session).toBeNull();

    const slotA = Number((await (er.rpc as any).getSlot({ commitment: "processed" }).send()) ?? 0);
    await sleep(800);
    const slotB = Number((await (er.rpc as any).getSlot({ commitment: "processed" }).send()) ?? 0);
    expect(slotB).toBe(slotA);
  }, 30_000);

  test("open session activates ER, deposits credit only delta, close deactivates", async () => {
    const owner = await fundedSigner(l1.rpc, 8_000_000_000);
    const recipient = await generateKeyPairSigner();
    const gridId = await uniqueGridId();
    const ttlSlots = 6n;
    const depositLamports = 1_000_000_000n;
    const transferLamports = 400_000_000n;

    const sessionPda = await deriveSessionPda(owner.address, gridId);
    const feeVaultPda = await deriveFeeVaultPda(owner.address);
    const receiptPda = await deriveDepositReceiptPda(sessionPda, owner.address);

    await sendInstructions(l1.rpc, l1.rpcSubscriptions, owner, [
      openSessionIx(owner, sessionPda, feeVaultPda, gridId, ttlSlots, 5_000_000_000n),
    ]);

    await waitFor(
      () => rpcRequest<string | null>(ER_RPC_URL, "getSessionPda"),
      (session) => session === sessionPda,
      "ER session activation",
      20_000,
    );

    const slotAfterOpenA = Number((await (er.rpc as any).getSlot({ commitment: "processed" }).send()) ?? 0);
    await waitFor(
      async () => Number((await (er.rpc as any).getSlot({ commitment: "processed" }).send()) ?? 0),
      (slot) => slot > slotAfterOpenA,
      "ER slot advancement while session active",
      5_000,
    );

    await sendInstructions(l1.rpc, l1.rpcSubscriptions, owner, [
      depositFeeIx(owner, sessionPda, receiptPda, owner.address, depositLamports),
    ]);

    await waitForBalance(er.rpc, owner.address, depositLamports);
    const ownerErBalance = BigInt(((await (er.rpc as any).getBalance(owner.address).send()).value ?? 0n) as bigint);
    expect(ownerErBalance).toBe(depositLamports);

    const receiptInfo = await (l1.rpc as any).getAccountInfo(receiptPda, { encoding: "base64" }).send();
    const receiptData = accountData(receiptInfo);
    expect(receiptData[0]).toBe(4); // DepositReceipt discriminator
    expect(readU64LE(receiptData, 65)).toBe(depositLamports);

    await sendInstructions(er.rpc, er.rpcSubscriptions, owner, [
      transferIx(owner, recipient.address, transferLamports),
    ]);
    await waitForBalance(er.rpc, recipient.address, transferLamports);

    const openSlot = Number((await (l1.rpc as any).getSlot({ commitment: "confirmed" }).send()) ?? 0);
    await waitFor(
      async () => Number((await (l1.rpc as any).getSlot({ commitment: "confirmed" }).send()) ?? 0),
      (slot) => slot > openSlot + Number(ttlSlots) + 1,
      "session TTL expiry on L1",
      10_000,
    );

    await sendInstructions(l1.rpc, l1.rpcSubscriptions, owner, [
      closeSessionIx(owner, sessionPda, feeVaultPda, gridId),
    ]);

    await waitFor(
      () => rpcRequest<string | null>(ER_RPC_URL, "getSessionPda"),
      (session) => session === null,
      "ER session deactivation",
      20_000,
    );

    const slotAfterCloseA = Number((await (er.rpc as any).getSlot({ commitment: "processed" }).send()) ?? 0);
    await sleep(800);
    const slotAfterCloseB = Number((await (er.rpc as any).getSlot({ commitment: "processed" }).send()) ?? 0);
    expect(slotAfterCloseB).toBe(slotAfterCloseA);
  }, 90_000);

  test("delegate and undelegate round-trip updates ER delegated account set", async () => {
    const owner = await fundedSigner(l1.rpc, 5_000_000_000);
    const delegated = await fundedSigner(l1.rpc, 1_000_000_000);
    const buffer = await fundedSigner(l1.rpc, 1_000_000);
    const gridId = await uniqueGridId();
    const ttlSlots = 8n;

    const sessionPda = await deriveSessionPda(owner.address, gridId);
    const feeVaultPda = await deriveFeeVaultPda(owner.address);
    const delegationRecordPda = await deriveDelegationRecordPda(delegated.address);

    await sendInstructions(l1.rpc, l1.rpcSubscriptions, owner, [
      openSessionIx(owner, sessionPda, feeVaultPda, gridId, ttlSlots, 5_000_000_000n),
    ]);
    await waitFor(
      () => rpcRequest<string | null>(ER_RPC_URL, "getSessionPda"),
      (session) => session === sessionPda,
      "ER session activation for delegation",
      20_000,
    );

    await sendInstructions(l1.rpc, l1.rpcSubscriptions, owner, [
      assignIx(delegated, PORTAL_PROGRAM_ID),
      delegateIx(
        owner,
        delegated,
        SYSTEM_PROGRAM_ID,
        delegationRecordPda,
        buffer.address,
        gridId,
      ),
    ]);

    await waitFor(
      () => rpcRequest<string[]>(ER_RPC_URL, "getDelegatedAccounts"),
      (accounts) => accounts.includes(delegated.address),
      "delegated account visible on ER",
      20_000,
    );

    const delegationInfo = await (l1.rpc as any).getAccountInfo(delegationRecordPda, { encoding: "base64" }).send();
    const delegationData = accountData(delegationInfo);
    expect(delegationData[0]).toBe(3); // DelegationRecord discriminator
    expect(readU64LE(delegationData, 33)).toBe(BigInt(gridId));

    const erDelegated = await sdk.getAccountInfo(delegated.address);
    expect(erDelegated.source).toBe("ephemeral-rollup");
    expect(erDelegated.lamports).toBeGreaterThan(0n);

    await sendInstructions(l1.rpc, l1.rpcSubscriptions, owner, [
      undelegateIx(owner, delegated.address, SYSTEM_PROGRAM_ID, delegationRecordPda),
    ]);

    await waitFor(
      async () => (await (l1.rpc as any).getAccountInfo(delegated.address).send()).value?.owner,
      (ownerProgram) => ownerProgram === SYSTEM_PROGRAM_ID,
      "delegated account owner restored on L1",
      20_000,
    );

    const closedRecord = await (l1.rpc as any)
      .getAccountInfo(delegationRecordPda, { encoding: "base64" })
      .send();
    expect(closedRecord.value).toBeNull();

    const openSlot = Number((await (l1.rpc as any).getSlot({ commitment: "confirmed" }).send()) ?? 0);
    await waitFor(
      async () => Number((await (l1.rpc as any).getSlot({ commitment: "confirmed" }).send()) ?? 0),
      (slot) => slot > openSlot + Number(ttlSlots) + 1,
      "delegation session TTL expiry on L1",
      10_000,
    );
    await sendInstructions(l1.rpc, l1.rpcSubscriptions, owner, [
      closeSessionIx(owner, sessionPda, feeVaultPda, gridId),
    ]);
  }, 90_000);
});
