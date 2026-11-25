# ER VRF integration preview (devnet)

Use the **demo adapter** for a new test value per round, the **live receipt** to show that ER received a transaction, or the **offline recording** to inspect a historical callback. They are separate, explicit entry points. None requires a wallet or sends a transaction.

### Fresh devnet app callback (stub)

On the app server, use [demo-randomness.cjs](./demo-randomness.cjs) with Node 20+ on Linux. Initialize a new directory **once** under an app-owned private parent with `await initDemoStore(directory)`. Keep it across restarts; do not put it inside the validator, signer or relay state directories. Opening a missing store fails instead of silently changing round results.

```js
const { openDevnetDemoRandomness } = require('./examples/er-vrf-preview/demo-randomness.cjs');
const provider = await openDevnetDemoRandomness({
  network: 'devnet', directory,
  onDemoRandomness(roundId, bytes, metadata) {
    // Upsert the test view by roundId: redelivery is possible.
    showDemoDraw(roundId, Buffer.from(bytes).toString('hex'), metadata.source);
  },
});
const request = provider.requestRandomness('bilal:round-42'); // returns before the handler runs
await request.delivered; // rejects if the handler failed; retry the same roundId
```

The interface models acceptance followed by asynchronous delivery of 64 bytes. New round IDs get distinct pseudorandom test values derived from the instance entropy. A retry or reopen of the same instance reproduces the same bytes. Concurrent duplicate requests on one provider share a delivery; later retries can call the handler again. There is no durable delivery queue: after restarting, resubmit outstanding IDs. Each app/test deployment needs its own instance directory.

This is an **app callback**, not an ER instruction, VRF proof, quorum certificate, or L1 settlement. Metadata always includes `verified: false`, `erCertified: false` and `l1Settled: false`. Keep the adapter behind an explicit demo setting. Never select it on failure of the real provider or use its output for prizes. A future certified provider can feed the same UI handler; only that provider may report verified evidence.

For a dependency-free E2E through the app callback, run `node examples/er-vrf-preview/demo-smoke.cjs`. It measures request to handler invocation, checks retry/reopen and a second fresh round, and removes its temporary demo store. It does not measure chain latency.

### 1. Test the callback handler now

From the SDK checkout, run this with Node (no install, network, or credentials):

```sh
node examples/er-vrf-preview/replay.cjs
```

The JSON has `source: "historical-devnet-er-replay"`, the original request PDA, the exact consumer callback instruction data in base64, and its 64-byte output in `recordedOutputHex`. For a renderer or decoder test:

```js
const { recordedCallback } = require('./examples/er-vrf-preview/replay.cjs');
const sample = recordedCallback();
// Use a test view/store, never the pending live round.
renderTestDraw({ label: 'Recorded devnet draw', outputHex: sample.recordedOutputHex });
```

The data came from a successful verifier CPI and consumer callback in the historical ER fulfillment identified in [recorded-callback.json](./recorded-callback.json). Its bytes are `discriminator[8] | request PDA[32] | output[64]` for **this test consumer**. Reading the file does not run the on-chain program, verify a new proof, create randomness, or update a live request. Do not use it for payouts or as a fallback on an RPC error.

### 2. Read a real request receipt

From the SDK root, install dependencies and build once (`npm ci && npm run build`). Then look up the recorded **request** against the running ER:

```sh
node examples/er-vrf-preview/live-receipt.cjs \
  2VcQgwE9kefdQhgyaSFz3EexJiCHVkfgamBLs67vfyepL3Qvdx3j3Gum4jXcwcAafx9dpweQwv6utTUJPoe9tzbt \
  3Yd51qT7BPxWbPBv4R8Hp5BqxgXk2xLFDZo3WaaD9gTE
```

Replace both arguments with your saved **request-creation signature** and its **request PDA** to inspect your own test-consumer request. A match returns `source: "devnet-er-rpc"`, `status: "er-confirmed"`, the slot, and `callback: "not-checked"`. The tool checks the retained L1/ER session and looks for the expected consumer instruction, Coordinator CPI and newly funded PDA. A missing transaction returns `unconfirmed`; mismatched evidence, failed execution, or an unavailable RPC returns an error. No result from this command means the draw is verified. A different consumer or ER session needs its own reviewed bindings.

### 3. Wire a new request into the app

For a client that already builds and signs test-consumer requests, use the [v0.2.0-devnet.1 SDK prerelease](https://github.com/mirrorworld-universe/NorthStarSDK/releases/tag/v0.2.0-devnet.1) (GitHub tarball, SHA-256 `e02a6770348cc89388165867c770fb244386272c9ea6acaaa2b5d96d996b133f`). The published SDK provides the acknowledgement method; the example files live in this repository. `makeDevnetSdk` in [live-receipt.cjs](./live-receipt.cjs) shows the devnet configuration.

```js
// Save the signed bytes, signature, request PDA and session before submission.
const ack = await sdk.sendAndAcknowledgeErTransaction(savedSignedRequest);
switch (ack.status) {
  case 'er-confirmed':       showStatus('Request received on ER — draw pending'); break;
  case 'settlement-pending': showStatus('Waiting for checkpoint admission'); break;
  case 'unconfirmed':        showStatus('Request not yet confirmed'); break;
}
```

On timeout or an unknown result, reconcile the **same signature** in the same session. Do not sign a replacement or display the recording. Enable a real result only after the application's normal verified fulfillment for **that** request. This kit does not add consumer allowlisting, change signer policy, promise callback latency, or certify an ER prefix.
