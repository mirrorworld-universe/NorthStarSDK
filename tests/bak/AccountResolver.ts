/**
 * AccountResolver Tests
 * Tests the 2-tier fallback strategy for account resolution
 */

import { PublicKey } from "@solana/web3.js";
import { AccountResolver } from "../../src/readers/AccountResolver";
import { EphemeralRollupReader } from "../../src/readers/EphemeralRollupReader";

jest.mock("../src/readers/EphemeralRollupReader");

const SYS = new PublicKey("11111111111111111111111111111111");

describe("AccountResolver", () => {
  let accountResolver: AccountResolver;
  let mockEphemeralRollupReader: jest.Mocked<EphemeralRollupReader>;
  let mockConnection: any;

  beforeEach(() => {
    mockEphemeralRollupReader = new EphemeralRollupReader(
      "http://test",
    ) as jest.Mocked<EphemeralRollupReader>;
    mockConnection = {
      getAccountInfo: jest.fn(),
      getSlot: jest.fn(),
    };

    accountResolver = new AccountResolver(
      mockEphemeralRollupReader,
      mockConnection,
    );
  });

  test("should resolve from Ephemeral Rollup when available", async () => {
    const testAddress = SYS;
    const mockAccount = {
      address: testAddress,
      data: new Uint8Array(Buffer.from("test")),
      executable: false,
      lamports: BigInt(1000000),
      owner: SYS,
      slot: BigInt(12345),
      source: "ephemeral-rollup" as const,
    };

    mockEphemeralRollupReader.getAccountInfo.mockResolvedValue(mockAccount);

    const result = await accountResolver.resolve(testAddress, "ephemeral");

    expect(result).toEqual(mockAccount);
    expect(result.source).toBe("ephemeral-rollup");
    expect(mockEphemeralRollupReader.getAccountInfo).toHaveBeenCalledWith(
      testAddress,
    );
    expect(mockConnection.getAccountInfo).not.toHaveBeenCalled();
  });

  test("should read from Solana L1 when search_source is solana", async () => {
    const testAddress = SYS;
    const dataBuf = Buffer.from("solana-data");

    mockConnection.getAccountInfo.mockResolvedValue({
      data: dataBuf,
      executable: false,
      lamports: 2_000_000,
      owner: SYS,
    });
    mockConnection.getSlot.mockResolvedValue(12345);

    const result = await accountResolver.resolve(testAddress, "solana");

    expect(result.source).toBe("solana");
    expect(result.lamports).toBe(BigInt(2_000_000));
    expect(result.data).toEqual(new Uint8Array(dataBuf));
    expect(mockConnection.getAccountInfo).toHaveBeenCalledWith(testAddress);
  });

  test("should throw error when Solana account missing", async () => {
    const testAddress = SYS;

    mockConnection.getAccountInfo.mockResolvedValue(null);

    await expect(
      accountResolver.resolve(testAddress, "solana"),
    ).rejects.toThrow(/Failed to resolve account/);
  });
});
