'use strict';

const bs58 = require('bs58').default;
const session = '7o9FiREiiEHFPajgXkrevcWhMbazGnbZFdKtzmnEyGTG';
const context = '03780d636b520199b9cd390e30e0ad2db23a6ea28a77fff7ef5413bffc01a407';
const consumer = '8ijYrh4dpfkerWU2xfwEM5HLhZKe9kxkPnGHvocvWmhE';
const coordinator = 'CyurMJyKpoRp7ZtEQPK6emPFPWQyEqobuNECz2MyDkPU';

function makeDevnetSdk({ NorthStarSDK, PublicKey }) {
  return new NorthStarSDK({
    portalProgramId: new PublicKey('GpkXG19Y6TmnVHBv3HWT8T2ccKntXMB6FXZpcJZCwJ7n'),
    tokenBridgeProgramId: new PublicKey('3gmuii1R2SxqAGGD3qQ6CPagXMefYQA6p7K61MUepXsD'),
    l1GenesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    checkpointProfile: Buffer.from('c87ffee95815f4a055271f34f3c2ea0f118bb1fb6c4e6186436dac452a71fe2a', 'hex'),
    customEndpoints: { solana: 'https://api.devnet.sonic.game', ephemeralRollup: 'https://ephemeral.devnet.sonic.game' },
  });
}

async function checkSession(sdk) {
  const current = await sdk.getExecutionSession();
  if (current.address.toBase58() !== session || Buffer.from(current.context).toString('hex') !== context) {
    throw new Error('Not the expected devnet ER session; stop and reconcile');
  }
}

function matches(ix, program, discriminator, requestPda) {
  return ix.programId.toBase58() === program && Array.isArray(ix.accounts) &&
    ix.accounts[5]?.toBase58() === requestPda && typeof ix.data === 'string' &&
    Buffer.from(bs58.decode(ix.data)).subarray(0, 8).toString('hex') === discriminator;
}

// Look up a saved request, never submit it. No fallback to a recorded callback on a miss or error.
async function lookupRequestReceipt(sdk, signature, requestPda) {
  if (typeof signature !== 'string' || signature.length > 88 || bs58.decode(signature).length !== 64 ||
      typeof requestPda !== 'string' || requestPda.length > 44 || bs58.decode(requestPda).length !== 32) {
    throw new Error('Expected a transaction signature and a request PDA');
  }
  await checkSession(sdk);
  const tx = await sdk.getEphemeralRpc().getParsedTransaction(signature, {
    commitment: 'confirmed', maxSupportedTransactionVersion: 0,
  });
  await checkSession(sdk);
  const base = { source: 'devnet-er-rpc', signature, requestPda, session, callback: 'not-checked' };
  if (tx === null) return { ...base, status: 'unconfirmed' };
  if (!tx.meta || tx.meta.err !== null || tx.transaction.signatures[0] !== signature ||
      !Number.isSafeInteger(tx.slot) || tx.slot < 0) throw new Error('No matching successful ER transaction');
  const message = tx.transaction.message;
  const outer = message.instructions.flatMap((ix, i) =>
    matches(ix, consumer, '2934b1498c249890', requestPda) && ix.accounts[7]?.toBase58() === coordinator ? [i] : []);
  const groups = tx.meta.innerInstructions?.filter(group => group.index === outer[0]);
  const i = message.accountKeys.findIndex(key => key.pubkey.toBase58() === requestPda);
  if (outer.length !== 1 || groups?.length !== 1 ||
      groups[0].instructions.filter(ix => matches(ix, coordinator, 'cf0e6f2236380c5a', requestPda)).length !== 1 ||
      i < 0 || tx.meta.preBalances[i] !== 0 || !(tx.meta.postBalances[i] > 0)) {
    throw new Error('Not a matching test-consumer request creation');
  }
  return { ...base, status: 'er-confirmed', slot: String(tx.slot) };
}

module.exports = { makeDevnetSdk, lookupRequestReceipt };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    console.error('Usage: node live-receipt.cjs <saved-request-signature> <request-PDA>');
    process.exitCode = 2;
  } else {
    lookupRequestReceipt(makeDevnetSdk(require('../..')), ...args)
      .then(value => console.log(JSON.stringify(value, null, 2)))
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
