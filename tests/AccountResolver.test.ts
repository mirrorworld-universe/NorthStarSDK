/**
 * AccountResolver Tests
 * Tests the 2-tier fallback strategy for account resolution
 */

import { address, Address } from "@solana/addresses";
import { AccountResolver } from "../src/readers/AccountResolver";
import { EphemeralRollupReader } from "../src/readers/EphemeralRollupReader";

jest.mock("../src/readers/EphemeralRollupReader");

describe("AccountResolver", () => {
  let accountResolver: AccountResolver;
  let mockEphemeralRollupReader: jest.Mocked<EphemeralRollupReader>;
  let mockRpc: any;

  beforeEach(() => {
    mockEphemeralRollupReader = new EphemeralRollupReader(
      "http://test",
    ) as jest.Mocked<EphemeralRollupReader>;
    mockRpc = {
      getAccountInfo: jest.fn().mockReturnValue({
        send: jest.fn(),
      }),
    };

    accountResolver = new AccountResolver(mockEphemeralRollupReader, mockRpc);
  });

  test("should resolve from Ephemeral Rollup when available", async () => {
    const testAddress = address("11111111111111111111111111111111");
    const mockAccount = {
      address: testAddress,
      data: new Uint8Array(Buffer.from("test")),
      executable: false,
      lamports: BigInt(1000000),
      owner: address("11111111111111111111111111111111"),
      slot: BigInt(12345),
      source: "ephemeral-rollup" as const,
    };

    mockEphemeralRollupReader.getAccountInfo.mockResolvedValue(mockAccount);

    const result = await accountResolver.resolve(testAddress);

    expect(result).toEqual(mockAccount);
    expect(result.source).toBe("ephemeral-rollup");
    expect(mockEphemeralRollupReader.getAccountInfo).toHaveBeenCalledWith(
      testAddress,
    );
    expect(mockRpc.getAccountInfo).not.toHaveBeenCalled();
  });

  test("should fallback to Solana L1 when Ephemeral Rollup fails", async () => {
    const testAddress = address("11111111111111111111111111111111");
    const mockSolanaResponse = {
      context: { slot: 12345 },
      value: {
        data: ["c29sYW5hLWRhdGE=", "base64"],
        executable: false,
        lamports: BigInt(2000000),
        owner: address("11111111111111111111111111111111"),
      },
    };

    mockEphemeralRollupReader.getAccountInfo.mockResolvedValue(null);
    mockRpc.getAccountInfo.mockReturnValue({
      send: jest.fn().mockResolvedValue(mockSolanaResponse),
    });

    const result = await accountResolver.resolve(testAddress);

    expect(result.source).toBe("solana");
    expect(result.lamports).toBe(BigInt(2000000));
    expect(mockEphemeralRollupReader.getAccountInfo).toHaveBeenCalled();
    expect(mockRpc.getAccountInfo).toHaveBeenCalled();
  });

  test("should throw error when all sources fail", async () => {
    const testAddress = address("11111111111111111111111111111111");

    mockEphemeralRollupReader.getAccountInfo.mockResolvedValue(null);
    mockRpc.getAccountInfo.mockReturnValue({
      send: jest.fn().mockResolvedValue({ value: null }),
    });

    await expect(accountResolver.resolve(testAddress)).rejects.toThrow(
      `Failed to resolve account ${testAddress} from any source`,
    );
  });
});
