# ER VRF integration preview (devnet)

Use the **live receipt** to show that the ER received a request. Use the **offline recording** to test your callback handler without waiting for a draw. The tools have separate entry points. Neither requires a wallet or sends a transaction.

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
