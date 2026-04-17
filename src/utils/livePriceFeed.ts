import { PublicKey } from "@solana/web3.js";

export interface LivePriceFeedDefinition {
  symbol: string;
  feedId: string;
}

export const DEFAULT_PUSH_ORACLE_PROGRAM_ID = new PublicKey(
  "pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT",
);

export function getPriceFeedAccountAddress(
  shardId: number,
  feedId: string,
  pushOracleProgramId: PublicKey = DEFAULT_PUSH_ORACLE_PROGRAM_ID,
): PublicKey {
  const normalizedFeedId = normalizeHexFeedId(feedId);
  const shardBuffer = Buffer.alloc(2);
  shardBuffer.writeUInt16LE(shardId, 0);

  return PublicKey.findProgramAddressSync(
    [shardBuffer, Buffer.from(normalizedFeedId.slice(2), "hex")],
    pushOracleProgramId,
  )[0];
}

export const DEFAULT_LIVE_PRICE_FEEDS: LivePriceFeedDefinition[] = [
  {
    symbol: "SOL/USD",
    feedId: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  },
  {
    symbol: "BTC/USD",
    feedId: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  },
  {
    symbol: "ETH/USD",
    feedId: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  },
];

export function normalizeHexFeedId(value: string): string {
  const normalized = value.trim().toLowerCase();
  const prefixed = normalized.startsWith("0x") ? normalized : `0x${normalized}`;

  if (!/^0x[0-9a-f]{64}$/.test(prefixed)) {
    throw new Error(
      `Invalid Pyth feed id: ${value}. Expected a 32-byte hex string.`,
    );
  }

  return prefixed;
}

export function toNumberLike(
  value: bigint | number | string | { toString(): string },
): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  return Number(value.toString());
}

export function scalePythPrice(
  value: bigint | number | string | { toString(): string },
  exponent: number,
): number {
  return toNumberLike(value) * 10 ** exponent;
}

export class RollingWindowRateTracker {
  private readonly windowMs: number;
  private readonly samples: number[] = [];

  constructor(windowMs: number = 1000) {
    this.windowMs = windowMs;
  }

  record(timestampMs: number = Date.now()): number {
    this.samples.push(timestampMs);
    this.trim(timestampMs);
    return this.rate(timestampMs);
  }

  rate(timestampMs: number = Date.now()): number {
    this.trim(timestampMs);
    return Number((this.samples.length / (this.windowMs / 1000)).toFixed(2));
  }

  size(timestampMs: number = Date.now()): number {
    this.trim(timestampMs);
    return this.samples.length;
  }

  private trim(timestampMs: number): void {
    const minTimestamp = timestampMs - this.windowMs;

    while (this.samples.length > 0 && this.samples[0] < minTimestamp) {
      this.samples.shift();
    }
  }
}
