import { mkdtemp, rm, chmod, writeFile, unlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { initDemoStore, openDevnetDemoRandomness } = require('../examples/er-vrf-preview/demo-randomness.cjs');
const { smoke } = require('../examples/er-vrf-preview/demo-smoke.cjs');

let root: string;
let directory: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ns-stub-test-'));
  directory = join(root, 'instance');
  await initDemoStore(directory);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const open = (callback: Function) => openDevnetDemoRandomness({ network: 'devnet', directory, onDemoRandomness: callback });

test('full request/ack/callback cycle, concurrent deduplication and stable reopened round', async () => {
  const report = await smoke();
  expect(report).toMatchObject({ result: 'passed', retryMatched: true, verified: false, erCertified: false, l1Settled: false });
  expect(report.demoOutputHex).toMatch(/^[a-f0-9]{128}$/);
});

test('handler failure is visible; retry delivers the same bytes even after handler mutation', async () => {
  const observed: string[] = [];
  const handler = jest.fn((_id: string, value: Uint8Array) => {
    observed.push(Buffer.from(value).toString('hex'));
    value.fill(0);
    if (observed.length === 1) throw new Error('not delivered');
  });
  const app = await open(handler);
  await expect(app.requestRandomness('fixture:1').delivered).rejects.toThrow('not delivered');
  const receipt = await app.requestRandomness('fixture:1').delivered;
  expect(observed).toEqual([receipt.outputHex, receipt.outputHex]);
  expect(receipt).not.toHaveProperty('signature');
  expect(receipt).not.toHaveProperty('proof');
});

test('no implicit provider selection, mainnet, replacement state or caller-provided credentials', async () => {
  for (const network of [undefined, 'mainnet-beta', 'testnet']) {
    await expect(openDevnetDemoRandomness({ network, directory, onDemoRandomness: jest.fn() })).rejects.toThrow();
  }
  await expect(openDevnetDemoRandomness({ network: 'devnet', directory })).rejects.toThrow();
  await expect(initDemoStore(directory)).rejects.toThrow();
  await expect(openDevnetDemoRandomness({ network: 'devnet', directory: join(root, 'missing'), onDemoRandomness: jest.fn() })).rejects.toThrow();
});

test('malformed, missing and permissive instance files do not silently reroll', async () => {
  const file = join(directory, 'demo-instance-v1');
  await chmod(file, 0o644);
  await expect(open(jest.fn())).rejects.toThrow();
  await chmod(file, 0o600);
  await writeFile(file, 'not an instance');
  await expect(open(jest.fn())).rejects.toThrow();
  await unlink(file);
  await expect(open(jest.fn())).rejects.toThrow();
  await symlink(join(root, 'nowhere'), file);
  await expect(open(jest.fn())).rejects.toThrow();
});

test('validates bounded round IDs and rejects queue overflow without losing existing rounds', async () => {
  const app = await open(() => undefined);
  for (const id of ['', null, '../x', 'x'.repeat(97), 'x\ny']) expect(() => app.requestRandomness(id)).toThrow();
  const batch = Array.from({ length: 64 }, (_, n) => app.requestRandomness(`round-${n}`));
  expect(() => app.requestRandomness('another')).toThrow('queue is full');
  expect(app.requestRandomness('round-0')).toBe(batch[0]);
  await Promise.all(batch.map(x => x.delivered));
  await expect(app.requestRandomness('another').delivered).resolves.toMatchObject({ verified: false });
});
