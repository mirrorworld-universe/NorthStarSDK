'use strict';

const { createHmac, randomBytes } = require('node:crypto');
const { constants, promises: fs } = require('node:fs');
const path = require('node:path');

const SOURCE = 'northstar:devnet-demo-randomness:v1';
const LABEL = Object.freeze({ source: SOURCE, network: 'devnet', verified: false, erCertified: false, l1Settled: false });
const FILE = 'demo-instance-v1';
const HEADER = Buffer.from(SOURCE + '\0');
const ENTROPY_BYTES = 32;

// Run once at application setup. Opening a missing/broken instance never initializes a replacement.
async function initDemoStore(directory) {
  await fs.mkdir(directory, { mode: 0o700 });
  const file = await fs.open(path.join(directory, FILE), 'wx', 0o600);
  try {
    await file.writeFile(Buffer.concat([HEADER, randomBytes(ENTROPY_BYTES)]));
    await file.sync();
  } finally { await file.close(); }
  const dir = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await dir.sync(); } finally { await dir.close(); }
}

async function readInstance(directory) {
  const root = path.resolve(directory);
  const dir = await fs.lstat(root);
  if (!dir.isDirectory() || (dir.mode & 0o777) !== 0o700 || dir.uid !== process.getuid()) {
    throw new Error('Expected a private, owned demo directory');
  }
  const file = await fs.open(path.join(root, FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    const size = HEADER.length + ENTROPY_BYTES;
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== size || (stat.mode & 0o077) || stat.uid !== dir.uid) {
      throw new Error('Invalid demo instance');
    }
    const data = Buffer.alloc(size + 1);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead !== size || !data.subarray(0, HEADER.length).equals(HEADER)) throw new Error('Invalid demo instance');
    return data.subarray(HEADER.length, size);
  } finally { await file.close(); }
}

async function openDevnetDemoRandomness({ network, directory, onDemoRandomness }) {
  if (network !== 'devnet' || typeof onDemoRandomness !== 'function') {
    throw new TypeError('Explicit devnet selection and onDemoRandomness handler required');
  }
  const entropy = await readInstance(directory);
  const pending = new Map();
  return Object.freeze({
    requestRandomness(roundId) {
      if (typeof roundId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,95}$/.test(roundId)) {
        throw new TypeError('Expected an application round ID of 1–96 ASCII characters');
      }
      if (pending.has(roundId)) return pending.get(roundId);
      if (pending.size >= 64) throw new Error('Demo callback queue is full');
      const delivered = new Promise(resolve => setImmediate(resolve)).then(async () => {
        // Only this demo instance and round affect the output, never retry count or arrival order.
        const bytes = createHmac('sha512', entropy).update(SOURCE + '\0' + roundId).digest();
        const outputHex = bytes.toString('hex');
        await onDemoRandomness(roundId, Uint8Array.from(bytes), LABEL);
        return Object.freeze({ ...LABEL, roundId, outputHex });
      }).finally(() => pending.delete(roundId));
      const request = Object.freeze({ ...LABEL, status: 'demo-accepted', roundId, delivered });
      pending.set(roundId, request);
      return request;
    },
  });
}

module.exports = { initDemoStore, openDevnetDemoRandomness };
