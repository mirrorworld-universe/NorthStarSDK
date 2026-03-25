/**
 * Integration Tests
 * End-to-end tests for North Star SDK with Portal program
 */

import { address } from '@solana/addresses';
import { NorthStarSDK } from '../src';

describe('North Star SDK Integration Tests', () => {
  let sdk: NorthStarSDK;

  beforeAll(() => {
    sdk = new NorthStarSDK({
      solanaNetwork: 'testnet',
    });
  });

  test('should initialize SDK successfully', () => {
    expect(sdk).toBeDefined();
    expect(sdk.getRpc()).toBeDefined();
  });

  test('should check service health', async () => {
    const health = await sdk.checkHealth();

    expect(health).toHaveProperty('solana');
    expect(health).toHaveProperty('ephemeralRollup');
    expect(typeof health.solana).toBe('boolean');
    expect(typeof health.ephemeralRollup).toBe('boolean');
  }, 30000);

  test('should resolve account info', async () => {
    const systemProgram = address('11111111111111111111111111111111');

    const accountInfo = await sdk.getAccountInfo(systemProgram);

    expect(accountInfo).toBeDefined();
    expect(accountInfo.address).toBe(systemProgram);
    expect(['ephemeral-rollup', 'solana']).toContain(accountInfo.source);
  }, 30000);

  test('should open portal session', async () => {
    const owner = address('11111111111111111111111111111112');
    const gridId = 1;
    const transaction = await sdk.openSession(owner, gridId);

    expect(transaction).toBeDefined();
    expect(transaction.instructions.length).toBeGreaterThan(0);
    expect(transaction.feePayer).toBe(owner);
  });

  test('should build delegate transaction', async () => {
    const owner = address('11111111111111111111111111111112');
    const delegatedAccount = address('11111111111111111111111111111113');
    const gridId = 1;

    const transaction = await sdk.delegate(owner, delegatedAccount, gridId);

    expect(transaction).toBeDefined();
    expect(transaction.instructions.length).toBeGreaterThan(0);
    expect(transaction.feePayer).toBe(owner);
  });
});
