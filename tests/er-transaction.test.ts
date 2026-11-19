import { Connection, Keypair, PublicKey, SendTransactionError, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { submitErTransaction } from "../src/solana/erTransaction";
import { NorthStarSDK } from "../src";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { getVersionedTxSignatureBase58, sendRawVersionedTransaction } from "../src/solana/kitCompat";

const pendingMessage = "canonical checkpoint awaits settlement; retry after settlement";

function fixture() {
  const payer = Keypair.fromSeed(new Uint8Array(32).fill(7));
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: new PublicKey(new Uint8Array(32).fill(8)).toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 0 })],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([payer]);
  const signature = getVersionedTxSignatureBase58(transaction);
  const connection: { sendRawTransaction: jest.Mock; getSignatureStatuses: jest.Mock; isBlockhashValid: jest.Mock } = {
    sendRawTransaction: jest.fn(async () => signature),
    getSignatureStatuses: jest.fn(async () => ({ context: { slot: 12 }, value: [null as any] })),
    isBlockhashValid: jest.fn(async () => ({ context: { slot: 12 }, value: true })),
  };
  return { transaction, signature, connection, checkSession: jest.fn(async () => {}) };
}

function pending(signature = "", message = pendingMessage) {
  return new SendTransactionError({ action: "send", signature, transactionMessage: message, logs: [] });
}

const options = { maxAttempts: 8, intervalMs: 1, timeoutMs: 1000 };

it("retries only settlement-pending with the original signed bytes", async () => {
  const value = fixture();
  const wire = Buffer.from(value.transaction.serialize());
  value.connection.sendRawTransaction.mockRejectedValueOnce(pending()).mockRejectedValueOnce(pending());
  value.connection.getSignatureStatuses
    .mockResolvedValueOnce({ context: { slot: 12 }, value: [null] })
    .mockResolvedValueOnce({ context: { slot: 12 }, value: [null] })
    .mockResolvedValueOnce({ context: { slot: 12 }, value: [null] })
    .mockResolvedValueOnce({ context: { slot: 12 }, value: [{ slot: 12, confirmationStatus: "finalized", err: null }] });
  const result = await submitErTransaction(value.connection, value.transaction, value.checkSession, options);
  expect(result).toEqual({ signature: value.signature, slot: 12n });
  expect(value.connection.sendRawTransaction).toHaveBeenCalledTimes(3);
  for (const call of value.connection.sendRawTransaction.mock.calls) expect(Buffer.from(call[0])).toEqual(wire);
  expect(value.checkSession).toHaveBeenCalledTimes(4);
});

it.each(["changed-message", "nonempty-signature", "plain-error"])("does not retry %s", async kind => {
  const value = fixture();
  const error = kind === "plain-error" ? new Error(pendingMessage)
    : pending(kind === "nonempty-signature" ? value.signature : "", kind === "changed-message" ? pendingMessage + "." : pendingMessage);
  value.connection.sendRawTransaction.mockRejectedValue(error);
  await expect(submitErTransaction(value.connection, value.transaction, value.checkSession, options)).rejects.toBe(error);
  expect(value.connection.sendRawTransaction).toHaveBeenCalledTimes(1);
});

it("retains the original intent when the bounded retry budget expires", async () => {
  const value = fixture();
  value.connection.sendRawTransaction.mockRejectedValue(pending());
  await expect(submitErTransaction(value.connection, value.transaction, value.checkSession, { ...options, maxAttempts: 3 })).rejects.toThrow(/timeout/i);
  expect(value.connection.sendRawTransaction).toHaveBeenCalledTimes(3);
});

it("stops before another broadcast when the session check fails", async () => {
  const value = fixture();
  const changed = new Error("ER session changed");
  value.checkSession.mockResolvedValueOnce(undefined).mockRejectedValueOnce(changed);
  value.connection.sendRawTransaction.mockRejectedValue(pending());
  await expect(submitErTransaction(value.connection, value.transaction, value.checkSession, options)).rejects.toBe(changed);
  expect(value.connection.sendRawTransaction).toHaveBeenCalledTimes(1);
});

it("never broadcasts an expired signed transaction", async () => {
  const value = fixture();
  value.connection.isBlockhashValid.mockResolvedValue({ context: { slot: 12 }, value: false });
  await expect(submitErTransaction(value.connection, value.transaction, value.checkSession, options)).rejects.toThrow(/expired/i);
  expect(value.connection.sendRawTransaction).not.toHaveBeenCalled();
});

it("does not rebroadcast after observing a receipt, even if a later poll is null", async () => {
  const value = fixture();
  value.connection.getSignatureStatuses
    .mockResolvedValueOnce({ context: { slot: 12 }, value: [null] })
    .mockResolvedValueOnce({ context: { slot: 12 }, value: [{ slot: 12, confirmationStatus: "processed", err: null }] })
    .mockResolvedValueOnce({ context: { slot: 12 }, value: [null] })
    .mockResolvedValueOnce({ context: { slot: 13 }, value: [{ slot: 13, confirmationStatus: "finalized", err: null }] });
  expect(await submitErTransaction(value.connection, value.transaction, value.checkSession, options)).toEqual({ signature: value.signature, slot: 13n });
  expect(value.connection.sendRawTransaction).toHaveBeenCalledTimes(1);
});

it("captures signed bytes and blockhash before asynchronous checks", async () => {
  const value = fixture();
  const wire = Buffer.from(value.transaction.serialize());
  const blockhash = value.transaction.message.recentBlockhash;
  value.checkSession.mockImplementation(async () => {
    value.transaction.message.recentBlockhash = new PublicKey(new Uint8Array(32).fill(9)).toBase58();
  });
  value.connection.sendRawTransaction.mockRejectedValueOnce(pending());
  value.connection.getSignatureStatuses
    .mockResolvedValueOnce({ value: [null] }).mockResolvedValueOnce({ value: [null] })
    .mockResolvedValueOnce({ value: [{ slot: 13, confirmationStatus: "confirmed", err: null }] });
  await submitErTransaction(value.connection, value.transaction, value.checkSession, options);
  for (const call of value.connection.sendRawTransaction.mock.calls) expect(Buffer.from(call[0])).toEqual(wire);
  for (const call of value.connection.isBlockhashValid.mock.calls) expect(call[0]).toBe(blockhash);
});

it("bounds an unavailable RPC without submitting a replacement", async () => {
  const value = fixture();
  value.connection.getSignatureStatuses.mockImplementation(() => new Promise(() => {}));
  await expect(submitErTransaction(value.connection, value.transaction, value.checkSession, { ...options, timeoutMs: 20 })).rejects.toThrow(/timeout/i);
  expect(value.connection.sendRawTransaction).not.toHaveBeenCalled();
});

it("pins the SDK session context and never routes this helper through L1", async () => {
  const value = fixture();
  const sdk = Object.create(NorthStarSDK.prototype) as NorthStarSDK;
  const l1 = { getSignatureStatuses: jest.fn(), sendRawTransaction: jest.fn() };
  Object.assign(sdk, { ephemeral_rpc: value.connection, rpc: l1 });
  jest.spyOn(sdk, "getExecutionSession")
    .mockResolvedValueOnce({ address: Keypair.generate().publicKey, context: new Uint8Array(32).fill(1) } as any)
    .mockResolvedValueOnce({ address: Keypair.generate().publicKey, context: new Uint8Array(32).fill(2) } as any);
  value.connection.sendRawTransaction.mockRejectedValue(pending());
  await expect(sdk.sendAndConfirmErTransaction(value.transaction, options)).rejects.toThrow(/session changed/);
  expect(value.connection.sendRawTransaction).toHaveBeenCalledTimes(1);
  expect(l1.sendRawTransaction).not.toHaveBeenCalled();
  expect(l1.getSignatureStatuses).not.toHaveBeenCalled();
});

it("disables hidden HTTP retries on the SDK ER connection", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(429, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = new PublicKey(new Uint8Array(32).fill(3));
    const sdk = new NorthStarSDK({ portalProgramId: address, tokenBridgeProgramId: address,
      l1GenesisHash: address.toBase58(), checkpointProfile: new Uint8Array(32).fill(1),
      customEndpoints: { solana: "http://127.0.0.1:8899", ephemeralRollup: `http://127.0.0.1:${(server.address() as AddressInfo).port}` } });
    await expect(sdk.getEphemeralRpc().getSlot()).rejects.toThrow(/429/);
    expect(requests).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 20_000);

it("keeps the existing L1 submission helper single-attempt", async () => {
  const value = fixture();
  const error = pending();
  value.connection.sendRawTransaction.mockRejectedValue(error);
  await expect(sendRawVersionedTransaction(value.connection as unknown as Connection, value.transaction)).rejects.toBe(error);
  expect(value.connection.sendRawTransaction).toHaveBeenCalledTimes(1);
});
