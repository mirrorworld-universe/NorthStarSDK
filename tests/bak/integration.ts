/**
 * Integration Tests
 * SDK smoke tests with mocked RPC (no live network).
 */

import { Keypair, SystemProgram } from "@solana/web3.js";
import { NorthStarSDK } from "../../src";

const PORTAL_PROGRAM_ID = Keypair.generate().publicKey;

const MOCK_LATEST_BLOCKHASH = {
  blockhash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  lastValidBlockHeight: 12345,
};

describe("North Star SDK Integration Tests", () => {
  let sdk: NorthStarSDK;

  beforeAll(() => {
    sdk = new NorthStarSDK({
      portalProgramId: PORTAL_PROGRAM_ID,
      customEndpoints: {
        solana: "http://127.0.0.1:8899",
        ephemeralRollup: "http://127.0.0.1:8910",
      },
    });

    jest.spyOn(sdk.getRpc(), "getLatestBlockhash").mockResolvedValue(MOCK_LATEST_BLOCKHASH);
    jest.spyOn(sdk.getRpc(), "getAccountInfo").mockResolvedValue({
      data: Buffer.from([1, 2, 3]),
      executable: false,
      lamports: 1_000_000,
      owner: SystemProgram.programId,
    } as any);
    jest.spyOn(sdk.getRpc(), "getSlot").mockResolvedValue(200_000_000);
    jest.spyOn(sdk.getEphemeralRpc(), "getSlot").mockResolvedValue(1);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  test("should initialize SDK successfully", () => {
    expect(sdk).toBeDefined();
    expect(sdk.getRpc()).toBeDefined();
  });

  test("should check service health", async () => {
    jest.spyOn(sdk as any, "ephemeralRollupReader", "get").mockReturnValue({
      isHealthy: async () => true,
    });
    const health = await sdk.checkHealth();

    expect(health).toHaveProperty("solana");
    expect(health).toHaveProperty("ephemeralRollup");
    expect(typeof health.solana).toBe("boolean");
    expect(typeof health.ephemeralRollup).to("boolean");
  });

  test("should resolve account info from Solana L1", async () => {
    const systemProgram = SystemProgram.programId;

    const accountInfo = await sdk.getAccountInfo(systemProgram, "solana");

    expect(accountInfo).toBeDefined();
    expect(accountInfo.address.equals(systemProgram)).toBe(true);
    expect(accountInfo.source).toBe("solana");
  });

  describe("Portal Session Operations (Build Only)", () => {
    let ownerSigner: Keypair;

    beforeAll(async () => {
      ownerSigner = Keypair.generate();
    });

    test("should build open session transaction", async () => {
      const transaction = await sdk.buildOpenSession(ownerSigner, 1);

      expect(transaction).toBeDefined();
      expect(transaction.instructions.length).toBeGreaterThan(0);
      expect(transaction.feePayer.equals(ownerSigner.publicKey)).toBe(true);
      expect(transaction.blockhash).toBe(MOCK_LATEST_BLOCKHASH.blockhash);

      const instruction = transaction.instructions[0];
      expect(instruction.programId).toBeDefined();
      expect(instruction.keys).toBeDefined();
      expect(instruction.data).toBeDefined();
    });

    test("should build deposit fee transaction", async () => {
      const transaction = await sdk.buildDepositFee(
        ownerSigner,
        ownerSigner.publicKey,
        1,
        1000000,
      );

      expect(transaction).toBeDefined();
      expect(transaction.instructions.length).toBeGreaterThan(0);
      expect(transaction.feePayer.equals(ownerSigner.publicKey)).toBe(true);
      expect(transaction.blockhash).toBe(MOCK_LATEST_BLOCKHASH.blockhash);
    });

    test("should build close session transaction", async () => {
      const transaction = await sdk.buildCloseSession(ownerSigner, 1);

      expect(transaction).toBeDefined();
      expect(transaction.instructions.length).toBeGreaterThan(0);
      expect(transaction.feePayer.equals(ownerSigner.publicKey)).toBe(true);
      expect(transaction.blockhash).toBe(MOCK_LATEST_BLOCKHASH.blockhash);
    });
  });

  describe("Portal Delegation Operations (Build Only)", () => {
    let ownerSigner: Keypair;
    let delegatedAccountSigner: Keypair;

    beforeAll(async () => {
      ownerSigner = Keypair.generate();
      delegatedAccountSigner = Keypair.generate();
    });

    test("should build delegate transaction", async () => {
      const transaction = await sdk.buildDelegate(
        ownerSigner,
        delegatedAccountSigner.publicKey,
        1,
      );

      expect(transaction).toBeDefined();
      expect(transaction.instructions.length).toBeGreaterThan(0);
      expect(transaction.feePayer.equals(ownerSigner.publicKey)).toBe(true);
      expect(transaction.blockhash).toBe(MOCK_LATEST_BLOCKHASH.blockhash);

      const instruction = transaction.instructions[0];
      expect(instruction.programId).toBeDefined();
      expect(instruction.keys.length).toBe(5);
    });

    test("should build undelegate transaction", async () => {
      const transaction = await sdk.buildUndelegate(
        ownerSigner,
        delegatedAccountSigner.publicKey,
      );

      expect(transaction).toBeDefined();
      expect(transaction.instructions.length).toBeGreaterThan(0);
      expect(transaction.feePayer.equals(ownerSigner.publicKey)).toBe(true);
      expect(transaction.blockhash).toBe(MOCK_LATEST_BLOCKHASH.blockhash);

      const instruction = transaction.instructions[0];
      expect(instruction.keys.length).toBe(5);
    });
  });

  describe("Transaction Structure Validation", () => {
    let ownerSigner: Keypair;

    beforeAll(async () => {
      ownerSigner = Keypair.generate();
    });

    test("openSession instruction should have correct accounts", async () => {
      const transaction = await sdk.buildOpenSession(ownerSigner, 42);

      const instruction = transaction.instructions[0];
      const keys = instruction.keys;

      expect(keys.length).toBe(4);
      expect(keys[0].pubkey.equals(ownerSigner.publicKey)).toBe(true);
      expect(keys[0].isSigner).toBe(true);
      expect(keys[0].isWritable).toBe(true);
      expect(keys[3].pubkey.equals(SystemProgram.programId)).toBe(true);
      expect(keys[3].isWritable).toBe(false);
    });

    test("delegate instruction should have correct accounts", async () => {
      const delegatedAccountSigner = Keypair.generate();
      const transaction = await sdk.buildDelegate(
        ownerSigner,
        delegatedAccountSigner.publicKey,
        99,
      );

      const keys = transaction.instructions[0].keys;

      expect(keys.length).toBe(5);
      expect(keys[0].pubkey.equals(ownerSigner.publicKey)).toBe(true);
      expect(keys[1].pubkey.equals(delegatedAccountSigner.publicKey)).toBe(true);
      expect(keys[2].pubkey.equals(SystemProgram.programId)).toBe(true);
    });

    test("depositFee instruction should have correct accounts", async () => {
      const transaction = await sdk.buildDepositFee(
        ownerSigner,
        ownerSigner.publicKey,
        1,
        500000,
      );

      const keys = transaction.instructions[0].keys;

      expect(keys.length).toBe(5);
      expect(keys[0].pubkey.equals(ownerSigner.publicKey)).toBe(true);
      expect(keys[3].pubkey.equals(ownerSigner.publicKey)).toBe(true);
      expect(keys[4].pubkey.equals(SystemProgram.programId)).toBe(true);
    });
  });
});
