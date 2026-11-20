// Disposable Northstar fixture driver. Never run it against a live endpoint.
const assert = require("node:assert/strict");
const { readFileSync, writeFileSync } = require("node:fs");
const { createServer, request } = require("node:http");
const { networkInterfaces } = require("node:os");
const { dirname, join } = require("node:path");
const { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } = require("@solana/web3.js");
const { NorthStarSDK, getVersionedTxSignatureBase58 } = require("../../dist");

const proxies = [];

async function delayedRpc(endpoint, ms) {
  if (!ms) return endpoint;
  const proxy = createServer((input, output) => {
    const upstream = request(endpoint, { method: input.method, headers: input.headers }, response => {
      const timer = setTimeout(() => {
        output.writeHead(response.statusCode, response.headers);
        response.pipe(output);
      }, ms);
      output.once("close", () => { clearTimeout(timer); response.destroy(); });
      response.on("error", () => output.destroy());
    });
    upstream.setTimeout(6000, () => upstream.destroy());
    upstream.on("error", () => {
      if (output.destroyed) return;
      if (output.headersSent) output.destroy();
      else output.writeHead(502).end();
    });
    output.once("close", () => upstream.destroy());
    input.pipe(upstream);
  });
  await new Promise((resolve, reject) => proxy.once("error", reject).listen(0, "127.0.0.1", resolve));
  proxies.push(proxy);
  return `http://127.0.0.1:${proxy.address().port}`;
}

async function main() {
  assert.deepEqual(Object.keys(networkInterfaces()), ["lo"]);
  const file = process.argv[2];
  const root = dirname(file);
  const spec = JSON.parse(readFileSync(file, "utf8"));
  for (const endpoint of [spec.l1, spec.er]) assert.match(endpoint, /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/);
  assert.notEqual(spec.l1, spec.er);
  assert.ok(Array.isArray(spec.requests) && spec.requests.length > 0 && spec.requests.length <= 24);
  assert.ok(!["EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"].includes(spec.l1Genesis));
  const delay = Number(process.env.NORTHSTAR_TEST_ACK_RPC_DELAY_MS ?? "0");
  assert.ok(Number.isInteger(delay) && delay >= 0 && delay <= 400);
  const [solana, ephemeralRollup] = await Promise.all([delayedRpc(spec.l1, delay), delayedRpc(spec.er, delay)]);
  const sdk = new NorthStarSDK({
    portalProgramId: new PublicKey(spec.portal), tokenBridgeProgramId: new PublicKey(spec.bridge),
    l1GenesisHash: spec.l1Genesis, checkpointProfile: Buffer.from(spec.profile, "hex"),
    customEndpoints: { solana, ephemeralRollup },
  });
  const rpc = sdk.getEphemeralRpc();
  const expectedSession = new PublicKey(spec.session);
  const warmup = await sdk.getExecutionSession();
  assert.ok(warmup.address.equals(expectedSession));
  assert.equal(Buffer.from(warmup.context).toString("hex"), spec.context);
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(root, "keys/signer.json"), "utf8"))));
  assert.equal(payer.publicKey.toBase58(), spec.payer);
  const signatures = new Set();
  const requests = new Set();
  const results = [];
  for (const { label, request, instructions } of spec.requests) {
    assert.match(label, /^request-randomness(?:-[0-9]{2})?$/);
    assert.ok(!requests.has(request));
    requests.add(request);
    const latest = await rpc.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: latest.blockhash,
      instructions: instructions.map(ix => new TransactionInstruction({
        programId: new PublicKey(ix.program), data: Buffer.from(ix.data_base64, "base64"),
        keys: ix.accounts.map(value => ({ pubkey: new PublicKey(value.address), isSigner: value.signer, isWritable: value.writable })),
      })),
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([payer]);
    const signature = getVersionedTxSignatureBase58(tx);
    assert.ok(!signatures.has(signature));
    signatures.add(signature);
    writeFileSync(join(root, "intents", `${label}.json`), JSON.stringify({
      signature, wire_base64: Buffer.from(tx.serialize()).toString("base64"), session: spec.session, context: spec.context,
    }), { flag: "wx", mode: 0o600, flush: true });
    const started = performance.now();
    const receipt = await sdk.sendAndAcknowledgeErTransaction(tx);
    const elapsed_ms = Math.ceil(performance.now() - started);
    assert.equal(receipt.signature, signature);
    assert.ok(["er-confirmed", "settlement-pending", "unconfirmed"].includes(receipt.status));
    const result = { label, request, status: receipt.status, signature, elapsed_ms };
    if (receipt.status === "er-confirmed") {
      const l1 = await sdk.getRpc().getAccountInfo(expectedSession, "finalized");
      assert.ok(l1?.owner.equals(sdk.getPortalProgramId()) && !l1.executable);
      const l1Session = sdk.portal.parseSession(l1.data);
      assert.equal(Buffer.from(sdk.portal.sessionContext(expectedSession, l1Session)).toString("hex"), spec.context);
      const info = await rpc.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      assert.equal(info?.meta?.err, null);
      assert.equal(BigInt(info.slot), receipt.slot);
      assert.equal(info.transaction.signatures[0], signature);
      assert.deepEqual(Buffer.from(info.transaction.message.serialize()), Buffer.from(message.serialize()));
      const keys = info.transaction.message.staticAccountKeys;
      assert.ok(keys.some(key => key.toBase58() === request));
      // The callback may close the request before a separate account read.
      assert.ok(info.meta.innerInstructions?.some(group => group.instructions.some(ix =>
        keys[ix.programIdIndex].toBase58() === spec.coordinator && ix.accounts.some(index => keys[index].toBase58() === request),
      )));
      result.slot = info.slot;
      result.err = null;
      result.l1_settled_at_ack = l1Session.lastSettledErSlot >= receipt.slot;
    }
    results.push(result);
  }
  console.log(JSON.stringify({ results, added_rpc_delay_ms: delay }));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const proxy of proxies) { proxy.close(); proxy.closeAllConnections(); }
});
