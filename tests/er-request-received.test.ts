import { Keypair, PublicKey, SendTransactionError, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { getVersionedTxSignatureBase58 } from "../src";
import { SESSION, sdkFixture, sessionFrame } from "./fixtures/continuity";

const confirmed = { value: [{ slot: 42, confirmationStatus: "confirmed", err: null }] };
const missing = { value: [null] };
const settlementPending = "canonical checkpoint awaits settlement; retry after settlement";

function fixture() {
  const { sdk, rpc, er, reader, user } = sdkFixture();
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: user.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: user.publicKey, lamports: 0 })],
  }).compileToV0Message());
  transaction.sign([user]);
  const signature = getVersionedTxSignatureBase58(transaction);
  const status = jest.fn().mockResolvedValueOnce(missing).mockResolvedValue(confirmed);
  const send = jest.fn().mockResolvedValue(signature);
  const valid = jest.fn().mockResolvedValue({ value: true });
  Object.assign(er, { getSignatureStatuses: status, sendRawTransaction: send, isBlockhashValid: valid });
  return { sdk, rpc, er, reader, transaction, signature, status, send, valid };
}

it("starts all five admission reads together and sends only after they pass", async () => {
  const { sdk, rpc, er, reader, transaction, send } = fixture();
  const admission = [rpc.getGenesisHash, rpc.getAccountInfoAndContext, reader.getSyncStatus,
    reader.getSessionPda, er.getAccountInfo];
  let resume!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  for (const spy of admission) {
    const mock = spy as jest.Mock;
    const reply = mock.getMockImplementation()!;
    mock.mockImplementationOnce(async (...args) => { await gate; return reply(...args); });
  }
  const result = sdk.sendAndAcknowledgeErTransaction(transaction);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(admission.map(spy => spy.mock.calls.length)).toEqual([1, 1, 1, 1, 1]);
    expect(send).not.toHaveBeenCalled();
  } finally {
    resume();
    await result;
  }
});

it("acknowledges in six round trips at a 240 ms RPC delay without caching session evidence", async () => {
  jest.useFakeTimers();
  try {
    const { sdk, rpc, er, reader, transaction, signature, send, status, valid } = fixture();
    for (const spy of [rpc.getGenesisHash, rpc.getAccountInfoAndContext, reader.getSyncStatus,
      reader.getSessionPda, er.getAccountInfo, send, valid]) {
      const mock = spy as jest.Mock;
      const reply = mock.getMockImplementation()!;
      mock.mockImplementation(async (...args) => {
        await new Promise<void>(resolve => setTimeout(resolve, 240));
        return reply(...args);
      });
    }
    status.mockReset();
    let reads = 0;
    status.mockImplementation(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 240));
      return reads++ === 0 ? missing : confirmed;
    });
    const started = performance.now();
    const acknowledgement = sdk.sendAndAcknowledgeErTransaction(transaction).then(result => ({ result, elapsed: performance.now() - started }));
    await jest.advanceTimersByTimeAsync(2800);
    expect(await acknowledgement).toEqual({ result: { status: "er-confirmed", signature, slot: 42n }, elapsed: 1440 });
    expect(reader.getSyncStatus).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

it("checks the ER receipt immediately after send, without waiting for the next poll", async () => {
  const { sdk, rpc, er, transaction, signature, status, send } = fixture();
  // The only post-send read must happen immediately, not on the 60-second polling interval.
  const receipt = await sdk.sendAndAcknowledgeErTransaction(transaction, { maxAttempts: 1, intervalMs: 60_000 });
  expect(receipt).toEqual({ status: "er-confirmed", signature, slot: 42n });
  expect(status).toHaveBeenCalledTimes(2);
  expect(status).toHaveBeenLastCalledWith([signature], { searchTransactionHistory: true });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toEqual(Buffer.from(transaction.serialize()));
  expect(send.mock.calls[0][1]).toEqual({ maxRetries: 0, preflightCommitment: "confirmed", skipPreflight: false });
  expect(er.getAccountInfo).toHaveBeenCalledTimes(2);
  expect(rpc.getAccountInfoAndContext).toHaveBeenCalledTimes(1);
  expect(rpc.getSignatureStatuses).not.toHaveBeenCalled();
  expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
});

it.each([missing, { value: [{ slot: 42, confirmationStatus: "processed", err: null }] }])(
  "does not say received without a confirmed receipt: %j", async reply => {
    const { sdk, transaction, signature, status, send } = fixture();
    status.mockResolvedValue(reply);
    const result = await sdk.sendAndAcknowledgeErTransaction(transaction, { maxAttempts: 2, intervalMs: 50, timeoutMs: 1000 });
    expect(result).toEqual({ status: "unconfirmed", signature });
    expect(send).toHaveBeenCalledTimes(1);
  },
);

it("does not acknowledge a failed transaction or a malformed receipt", async () => {
  for (const reply of [
    { value: [{ slot: 42, confirmationStatus: "confirmed", err: { InstructionError: [0, "Custom"] } }] },
    { value: [{ slot: 42, confirmationStatus: "confirmed" }] },
  ]) {
    const { sdk, transaction, status } = fixture();
    status.mockResolvedValue(reply);
    await expect(sdk.sendAndAcknowledgeErTransaction(transaction)).rejects.toThrow(/rejected|invalid ER transaction receipt/i);
  }
});

it("rechecks the pinned ER session incarnation before acknowledging", async () => {
  const { sdk, er, transaction, send } = fixture();
  const account = await er.getAccountInfo();
  er.getAccountInfo.mockClear();
  er.getAccountInfo.mockResolvedValueOnce(account).mockResolvedValueOnce({ ...account, data: sessionFrame(8n) });
  await expect(sdk.sendAndAcknowledgeErTransaction(transaction)).rejects.toThrow(/ER session incarnation differs/);
  expect(send).toHaveBeenCalledTimes(1);
});

it("does not submit before confirming the L1 genesis even when the other reads pass", async () => {
  const { sdk, rpc, transaction, status, send } = fixture();
  rpc.getGenesisHash.mockResolvedValueOnce(Keypair.generate().publicKey.toBase58());
  await expect(sdk.sendAndAcknowledgeErTransaction(transaction)).rejects.toThrow(/L1 genesis differs/);
  expect(status).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

it("does not acknowledge a receipt if the ER restarts after submission", async () => {
  const { sdk, reader, transaction, send } = fixture();
  reader.getSessionPda.mockResolvedValueOnce(SESSION).mockResolvedValueOnce(null);
  await expect(sdk.sendAndAcknowledgeErTransaction(transaction)).rejects.toThrow(/ER session differs/);
  expect(send).toHaveBeenCalledTimes(1);
});

it.each(["before", "after"] as const)("blocks acknowledgement on sync lag %s submission", async when => {
  const { sdk, reader, transaction, send } = fixture();
  const synced = await reader.getSyncStatus();
  const lagging = { ...synced, latestSyncedSlot: synced.latestL1Slot - 1n };
  reader.getSyncStatus.mockClear();
  if (when === "after") reader.getSyncStatus.mockResolvedValueOnce(synced);
  reader.getSyncStatus.mockResolvedValueOnce(lagging);
  await expect(sdk.sendAndAcknowledgeErTransaction(transaction)).rejects.toThrow(/ER runtime is syncing/);
  expect(send).toHaveBeenCalledTimes(when === "after" ? 1 : 0);
});

it("requires the same session for any settlement-pending retry", async () => {
  const { sdk, reader, transaction, status, send } = fixture();
  status.mockReset().mockResolvedValue(missing);
  send.mockRejectedValueOnce(new SendTransactionError({ action: "send", signature: "", logs: [],
    transactionMessage: settlementPending }));
  reader.getSessionPda.mockResolvedValueOnce(SESSION).mockResolvedValueOnce(new PublicKey(new Uint8Array(32).fill(42)));
  await expect(sdk.sendAndAcknowledgeErTransaction(transaction, { intervalMs: 50 }))
    .rejects.toThrow(/ER session differs/);
  expect(send).toHaveBeenCalledTimes(1);
});

it("reconciles an already confirmed original signature without resending it", async () => {
  const { sdk, transaction, signature, status, send, valid } = fixture();
  status.mockReset().mockResolvedValue(confirmed);
  await expect(sdk.sendAndAcknowledgeErTransaction(transaction)).resolves.toEqual({ status: "er-confirmed", signature, slot: 42n });
  expect(send).not.toHaveBeenCalled();
  expect(valid).not.toHaveBeenCalled();
});

it("returns an unconfirmed signature when an ER call stalls", async () => {
  const { sdk, transaction, signature, status, send } = fixture();
  status.mockReset().mockImplementation(() => new Promise(() => {}));
  const result = await sdk.sendAndAcknowledgeErTransaction(transaction, { timeoutMs: 40 });
  expect(result).toEqual({ status: "unconfirmed", signature });
  expect(send).not.toHaveBeenCalled();
});

it("reports an exact settlement refusal without claiming ER receipt", async () => {
  const { sdk, transaction, signature, status, send } = fixture();
  status.mockReset().mockResolvedValue(missing);
  send.mockRejectedValue(new SendTransactionError({ action: "send", signature: "", logs: [], transactionMessage: settlementPending }));
  await expect(sdk.sendAndAcknowledgeErTransaction(transaction, { maxAttempts: 2, intervalMs: 50 }))
    .resolves.toEqual({ status: "settlement-pending", signature });
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls.map(([wire]) => wire)).toEqual([Buffer.from(transaction.serialize()), Buffer.from(transaction.serialize())]);
});

it("keeps settle errors with different details distinct", async () => {
  for (const [submission, message] of [["", settlementPending + "."], ["not-empty", settlementPending]]) {
    const { sdk, transaction, send } = fixture();
    const error = new SendTransactionError({ action: "send", signature: submission, logs: [], transactionMessage: message });
    send.mockRejectedValueOnce(error);
    await expect(sdk.sendAndAcknowledgeErTransaction(transaction)).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(1);
  }
});

it("reports unknown when a subsequent send may be in flight after an earlier refusal", async () => {
  const { sdk, transaction, signature, status, send } = fixture();
  status.mockReset().mockResolvedValue(missing);
  send.mockRejectedValueOnce(new SendTransactionError({ action: "send", signature: "", logs: [], transactionMessage: settlementPending }));
  send.mockImplementation(() => new Promise(() => {}));
  await expect(sdk.sendAndAcknowledgeErTransaction(transaction, { maxAttempts: 2, intervalMs: 50, timeoutMs: 900 }))
    .resolves.toEqual({ status: "unconfirmed", signature });
  expect(send).toHaveBeenCalledTimes(2);
});

it("does not report a stale settlement refusal after a receipt is observed", async () => {
  const { sdk, er, transaction, signature, send } = fixture();
  const session = await er.getAccountInfo();
  er.getAccountInfo.mockReset().mockResolvedValueOnce(session).mockImplementation(() => new Promise(() => {}));
  send.mockRejectedValueOnce(new SendTransactionError({ action: "send", signature: "", logs: [], transactionMessage: settlementPending }));
  await expect(sdk.sendAndAcknowledgeErTransaction(transaction, { maxAttempts: 2, intervalMs: 50, timeoutMs: 900 }))
    .resolves.toEqual({ status: "unconfirmed", signature });
  expect(send).toHaveBeenCalledTimes(1);
});
