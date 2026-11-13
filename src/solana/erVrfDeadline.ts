export interface ErVrfDeadlineBudget {
  erSlotDurationMs: number;
  checkpointWaitMs: number;
  challengeAndFinalityMs: number;
  queueWaitMs: number;
  deliveryMarginMs: number;
  safetyMs: number;
}

export interface VrfDeadlineLimits {
  minimumSlots: number;
  maximumSlots: number;
}

export function calculateErVrfDeadlineSlots(budget: ErVrfDeadlineBudget, limits: VrfDeadlineLimits): number {
  const components = [budget.checkpointWaitMs, budget.challengeAndFinalityMs, budget.queueWaitMs, budget.deliveryMarginMs, budget.safetyMs];
  if (!Number.isSafeInteger(budget.erSlotDurationMs) || budget.erSlotDurationMs <= 0 ||
      components.some(value => !Number.isSafeInteger(value) || value < 0) ||
      !Number.isSafeInteger(limits.minimumSlots) || !Number.isSafeInteger(limits.maximumSlots) ||
      limits.minimumSlots < 2 || limits.minimumSlots > limits.maximumSlots || limits.maximumSlots > 65_535) {
    throw new Error("Invalid ER VRF deadline budget or Coordinator limits");
  }
  const duration = BigInt(budget.erSlotDurationMs);
  const total = components.reduce((sum, value) => sum + BigInt(value), 0n);
  const required = (total + duration - 1n) / duration;
  const slots = required > BigInt(limits.minimumSlots) ? required : BigInt(limits.minimumSlots);
  if (slots > BigInt(limits.maximumSlots)) {
    throw new Error("Coordinator deadline ceiling cannot cover the ER checkpoint budget");
  }
  return Number(slots);
}
