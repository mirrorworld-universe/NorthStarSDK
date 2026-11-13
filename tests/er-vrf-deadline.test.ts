import { calculateErVrfDeadlineSlots, ErVrfDeadlineBudget } from "../src/solana/erVrfDeadline";

const budget: ErVrfDeadlineBudget = {
  erSlotDurationMs: 10,
  checkpointWaitMs: 60_000,
  challengeAndFinalityMs: 30_000,
  queueWaitMs: 60_000,
  deliveryMarginMs: 30_000,
  safetyMs: 60_000,
};

it("budgets ER slots for checkpoint, independent finality, queue and delivery", () => {
  expect(calculateErVrfDeadlineSlots(budget, { minimumSlots: 2, maximumSlots: 65_535 })).toBe(24_000);
  expect(() => calculateErVrfDeadlineSlots(budget, { minimumSlots: 2, maximumSlots: 1000 })).toThrow(/ceiling/);
  expect(calculateErVrfDeadlineSlots({ ...budget, safetyMs: 60_001 }, { minimumSlots: 2, maximumSlots: 65_535 })).toBe(24_001);
  expect(calculateErVrfDeadlineSlots(budget, { minimumSlots: 30_000, maximumSlots: 65_535 })).toBe(30_000);
});

it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects an invalid ER slot duration: %p", erSlotDurationMs => {
  expect(() => calculateErVrfDeadlineSlots({ ...budget, erSlotDurationMs }, { minimumSlots: 2, maximumSlots: 65_535 })).toThrow();
});

it("never clamps an oversized budget into a shorter deadline", () => {
  expect(() => calculateErVrfDeadlineSlots({ ...budget, queueWaitMs: Number.MAX_SAFE_INTEGER }, { minimumSlots: 2, maximumSlots: 65_535 })).toThrow(/ceiling/);
  expect(() => calculateErVrfDeadlineSlots(budget, { minimumSlots: 2, maximumSlots: 65_536 })).toThrow();
  expect(() => calculateErVrfDeadlineSlots({ ...budget, safetyMs: -1 }, { minimumSlots: 2, maximumSlots: 65_535 })).toThrow();
});
