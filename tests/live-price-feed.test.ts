import {
  RollingWindowRateTracker,
  getPriceFeedAccountAddress,
  normalizeHexFeedId,
  scalePythPrice,
} from "../src/utils/livePriceFeed";

describe("live price feed helpers", () => {
  test("normalizeHexFeedId lowercases and prefixes values", () => {
    expect(
      normalizeHexFeedId(
        "EF0D8B6FDA2CEBA41DA15D4095D1DA392A0D2F8ED0C6C7BC0F4CFAC8C280B56D",
      ),
    ).toBe("0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d");
  });

  test("normalizeHexFeedId rejects malformed ids", () => {
    expect(() => normalizeHexFeedId("sol")).toThrow("Invalid Pyth feed id");
  });

  test("getPriceFeedAccountAddress derives the deterministic PDA", () => {
    expect(
      getPriceFeedAccountAddress(
        0,
        "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
      ).toBase58(),
    ).toBe("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
  });

  test("scalePythPrice applies the exponent", () => {
    expect(scalePythPrice(123456n, -4)).toBeCloseTo(12.3456);
    expect(scalePythPrice("987654", -3)).toBeCloseTo(987.654);
  });

  test("RollingWindowRateTracker keeps only recent samples", () => {
    const tracker = new RollingWindowRateTracker(1000);

    tracker.record(0);
    tracker.record(200);
    tracker.record(400);

    expect(tracker.rate(400)).toBe(3);
    expect(tracker.size(400)).toBe(3);

    expect(tracker.rate(1401)).toBe(0);
    expect(tracker.size(1401)).toBe(0);
  });
});
