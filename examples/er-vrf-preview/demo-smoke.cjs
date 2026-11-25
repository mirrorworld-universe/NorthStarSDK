'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { initDemoStore, openDevnetDemoRandomness } = require('./demo-randomness.cjs');

async function smoke() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'northstar-demo-'));
  const directory = path.join(temp, 'instance');
  try {
    await initDemoStore(directory);
    const calls = [];
    const options = { network: 'devnet', directory, onDemoRandomness(id, bytes, label) {
      assert.equal(bytes.length, 64);
      assert.equal(label.source, 'northstar:devnet-demo-randomness:v1');
      assert.equal(label.verified, false);
      assert.equal(label.erCertified, false);
      assert.equal(label.l1Settled, false);
      calls.push({ id, output: Buffer.from(bytes).toString('hex'), at: process.hrtime.bigint() });
    } };
    const app = await openDevnetDemoRandomness(options);
    const round = randomUUID();
    const start = process.hrtime.bigint();
    const request = app.requestRandomness(round);
    assert.equal(request.status, 'demo-accepted');
    assert.equal(calls.length, 0);
    assert.equal(app.requestRandomness(round), request);
    const first = await request.delivered;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, round);
    assert.equal(calls[0].output, first.outputHex);
    const reopened = await openDevnetDemoRandomness(options);
    assert.equal((await reopened.requestRandomness(round).delivered).outputHex, first.outputHex);
    assert.notEqual((await reopened.requestRandomness(randomUUID()).delivered).outputHex, first.outputHex);
    assert.equal(calls.length, 3);
    return { source: first.source, result: 'passed', round, demoOutputHex: first.outputHex,
      requestToDemoCallbackMs: Number(calls[0].at - start) / 1e6,
      retryMatched: true, distinctRoundMatchedDifferentValue: true, verified: false, erCertified: false, l1Settled: false };
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

if (require.main === module) smoke().then(report => console.log(JSON.stringify(report)), error => {
  console.error(error.message); process.exitCode = 1;
});
module.exports = { smoke };
