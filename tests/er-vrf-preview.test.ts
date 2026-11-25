import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';

const { lookupRequestReceipt } = require('../examples/er-vrf-preview/live-receipt.cjs');
const { recordedCallback } = require('../examples/er-vrf-preview/replay.cjs');
const sample = recordedCallback();
const coordinator = new PublicKey('CyurMJyKpoRp7ZtEQPK6emPFPWQyEqobuNECz2MyDkPU');
const consumer = new PublicKey(sample.consumerProgram);
const request = new PublicKey(sample.requestPda);
const context = Buffer.from('03780d636b520199b9cd390e30e0ad2db23a6ea28a77fff7ef5413bffc01a407', 'hex');

function requestTx() {
  const outer = { programId: consumer, accounts: [consumer, consumer, consumer, consumer, consumer, request, consumer, coordinator], data: bs58.encode(Buffer.from('2934b1498c249890', 'hex')) };
  const inner = { programId: coordinator, accounts: [consumer, consumer, consumer, consumer, consumer, request], data: bs58.encode(Buffer.from('cf0e6f2236380c5a', 'hex')) };
  return {
    slot: Number(sample.requestSlot),
    transaction: { signatures: [sample.requestSignature], message: { accountKeys: [{ pubkey: request }], instructions: [outer] } },
    meta: { err: null, preBalances: [0], postBalances: [50000], innerInstructions: [{ index: 0, instructions: [inner] }] },
  };
}

function client(tx: unknown) {
  const getParsedTransaction = jest.fn().mockResolvedValue(tx);
  const getExecutionSession = jest.fn().mockResolvedValue({ address: new PublicKey(sample.session), context });
  return { getExecutionSession, getEphemeralRpc: () => ({ getParsedTransaction }) };
}

const lookup = (sdk: ReturnType<typeof client>) => lookupRequestReceipt(sdk, sample.requestSignature, sample.requestPda);

test('live request lookup binds the signature, request, CPI and session but supplies no draw', async () => {
  const sdk = client(requestTx());
  await expect(lookup(sdk)).resolves.toEqual({ source: 'devnet-er-rpc', status: 'er-confirmed', signature: sample.requestSignature,
    requestPda: sample.requestPda, session: sample.session, slot: sample.requestSlot, callback: 'not-checked' });
  expect(sdk.getExecutionSession).toHaveBeenCalledTimes(2);
  expect(sdk.getEphemeralRpc().getParsedTransaction).toHaveBeenCalledWith(sample.requestSignature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
});

test('missing history, unavailable RPC and a session change do not fall back to replay', async () => {
  await expect(lookup(client(null))).resolves.toEqual(expect.objectContaining({ status: 'unconfirmed', callback: 'not-checked' }));
  const failed = client(null);
  failed.getEphemeralRpc().getParsedTransaction.mockRejectedValueOnce(new Error('unavailable'));
  await expect(lookup(failed)).rejects.toThrow('unavailable');
  const changed = client(requestTx());
  changed.getExecutionSession.mockResolvedValueOnce({ address: new PublicKey(sample.session), context })
    .mockResolvedValueOnce({ address: new PublicKey(sample.session), context: Buffer.alloc(32) });
  await expect(lookup(changed)).rejects.toThrow('session');
});

test.each(['signature', 'outer PDA', 'coordinator', 'creation', 'outer index', 'instruction', 'failed transaction'])('%s mismatch cannot produce a request receipt', async reason => {
  const tx = requestTx();
  switch (reason) {
    case 'signature': tx.transaction.signatures[0] = sample.fulfillmentSignature; break;
    case 'outer PDA': tx.transaction.message.instructions[0].accounts[5] = consumer; break;
    case 'coordinator': tx.meta.innerInstructions[0].instructions[0].programId = consumer; break;
    case 'creation': tx.meta.preBalances[0] = 1; break;
    case 'outer index': tx.meta.innerInstructions[0].index = 1; break;
    case 'instruction': tx.meta.innerInstructions[0].instructions[0].data = '11'; break;
    case 'failed transaction': Object.assign(tx.meta, { err: { InstructionError: [0, 'InvalidArgument'] } }); break;
  }
  await expect(lookup(client(tx))).rejects.toThrow();
});

test('recording decodes only the historical test round and never takes a live request identity', () => {
  const data = Buffer.from(sample.callbackDataBase64, 'base64');
  expect(sample.source).toBe('historical-devnet-er-replay');
  expect(data.length).toBe(104);
  expect(data.subarray(0, 8).toString('hex')).toBe('3fe44c86f31475aa');
  expect(bs58.encode(data.subarray(8, 40))).toBe(sample.requestPda);
  expect(data.subarray(40).toString('hex')).toBe(sample.recordedOutputHex);
  expect(recordedCallback()).toEqual(sample);
  expect(() => recordedCallback('another round')).toThrow();
});
