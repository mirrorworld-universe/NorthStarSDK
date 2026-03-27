/**
 * Integration Tests
 * End-to-end tests for North Star SDK with Portal program
 *
 * These tests build transaction data but do NOT send them.
 * To execute against a running validator, add signing and sending.
 */

import { address, generateKeyPairSigner } from '@solana/kit';
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

  test('should resolve account info from Solana L1', async () => {
    const systemProgram = address('11111111111111111111111111111111');

    const accountInfo = await sdk.getAccountInfo(systemProgram);

    expect(accountInfo).toBeDefined();
    expect(accountInfo.address).toBe(systemProgram);
    expect(['ephemeral-rollup', 'solana']).toContain(accountInfo.source);
  }, 30000);

  describe('Portal Session Operations (Build Only)', () => {
    let ownerSigner: Awaited<ReturnType<typeof generateKeyPairSigner>>;

    beforeAll(async () => {
      ownerSigner = await generateKeyPairSigner();
    });

    test('should build open session transaction', async () => {
      const transaction = await sdk.buildOpenSession(ownerSigner, 1);

      expect(transaction).toBeDefined();
      expect(transaction.instructions.length).toBeGreaterThan(0);
      expect(transaction.feePayer).toBe(ownerSigner.address);
      expect(transaction.blockhash).toBeDefined();

      const instruction = transaction.instructions[0];
      expect(instruction.programAddress).toBeDefined();
      expect(instruction.accounts).toBeDefined();
      expect(instruction.data).toBeDefined();
    });

    test('should build deposit fee transaction', async () => {
      const transaction = await sdk.buildDepositFee(ownerSigner, ownerSigner.address, 1000000);

      expect(transaction).toBeDefined();
      expect(transaction.instructions.length).toBeGreaterThan(0);
      expect(transaction.feePayer).toBe(ownerSigner.address);
      expect(transaction.blockhash).toBeDefined();
    });

    test('should build close session transaction', async () => {
      const transaction = await sdk.buildCloseSession(ownerSigner, 1);

      expect(transaction).toBeDefined();
      expect(transaction.instructions.length).toBeGreaterThan(0);
      expect(transaction.feePayer).toBe(ownerSigner.address);
      expect(transaction.blockhash).toBeDefined();
    });
  });

  describe('Portal Delegation Operations (Build Only)', () => {
    let ownerSigner: Awaited<ReturnType<typeof generateKeyPairSigner>>;
    let delegatedAccountSigner: Awaited<ReturnType<typeof generateKeyPairSigner>>;

    beforeAll(async () => {
      ownerSigner = await generateKeyPairSigner();
      delegatedAccountSigner = await generateKeyPairSigner();
    });

    test('should build delegate transaction', async () => {
      const transaction = await sdk.buildDelegate(ownerSigner, delegatedAccountSigner.address, 1);

      expect(transaction).toBeDefined();
      expect(transaction.instructions.length).toBeGreaterThan(0);
      expect(transaction.feePayer).toBe(ownerSigner.address);
      expect(transaction.blockhash).toBeDefined();
      
      const instruction = transaction.instructions[0];
      expect(instruction.programAddress).toBeDefined();
      expect(instruction.accounts.length).toBe(3); // owner, delegatedAccount, delegationRecord
    });

    test('should build undelegate transaction', async () => {
      const transaction = await sdk.buildUndelegate(ownerSigner, delegatedAccountSigner.address);

      expect(transaction).toBeDefined();
      expect(transaction.instructions.length).toBeGreaterThan(0);
      expect(transaction.feePayer).toBe(ownerSigner.address);
      expect(transaction.blockhash).toBeDefined();
      
      const instruction = transaction.instructions[0];
      expect(instruction.accounts.length).toBe(3); // owner, delegatedAccount, delegationRecord
    });
  });

  describe('Transaction Structure Validation', () => {
    let ownerSigner: Awaited<ReturnType<typeof generateKeyPairSigner>>;

    beforeAll(async () => {
      ownerSigner = await generateKeyPairSigner();
    });

    test('openSession instruction should have correct accounts', async () => {
      const transaction = await sdk.buildOpenSession(ownerSigner, 42);

      const instruction = transaction.instructions[0];
      const accounts = instruction.accounts as Array<{address: string, role: number}>;
      
      expect(accounts.length).toBe(3);
      expect(accounts[0].address).toBe(ownerSigner.address); // owner (signer)
      expect(accounts[0].role).toBe(1); // writable + signer
      expect(accounts[1].address).toBeDefined(); // session PDA
      expect(accounts[1].role).toBe(1); // writable
      expect(accounts[2].address).toBeDefined(); // fee vault PDA
      expect(accounts[2].role).toBe(1); // writable
    });

    test('delegate instruction should have correct accounts', async () => {
      const delegatedAccountSigner = await generateKeyPairSigner();
      const transaction = await sdk.buildDelegate(ownerSigner, delegatedAccountSigner.address, 99);

      const instruction = transaction.instructions[0];
      const accounts = instruction.accounts as Array<{address: string, role: number}>;
      
      expect(accounts.length).toBe(3);
      expect(accounts[0].address).toBe(ownerSigner.address); // owner (signer)
      expect(accounts[0].role).toBe(1);
      expect(accounts[1].address).toBe(delegatedAccountSigner.address); // delegated account
      expect(accounts[1].role).toBe(1);
      expect(accounts[2].address).toBeDefined(); // delegation record PDA
      expect(accounts[2].role).toBe(1);
    });

    test('depositFee instruction should have correct accounts', async () => {
      const transaction = await sdk.buildDepositFee(ownerSigner, ownerSigner.address, 500000);

      const instruction = transaction.instructions[0];
      const accounts = instruction.accounts as Array<{address: string, role: number}>;
      
      expect(accounts.length).toBe(2);
      expect(accounts[0].address).toBe(ownerSigner.address); // depositor (signer)
      expect(accounts[0].role).toBe(1);
      expect(accounts[1].address).toBeDefined(); // fee vault PDA
      expect(accounts[1].role).toBe(1);
    });
  });
});
