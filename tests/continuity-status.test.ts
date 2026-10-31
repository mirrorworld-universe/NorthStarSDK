import { EphemeralRollupReader } from "../src/readers/EphemeralRollupReader";

function reader(result: unknown): EphemeralRollupReader {
  const value = new EphemeralRollupReader("http://localhost:8899");
  (value as any).client = { post: async () => ({ data: { jsonrpc: "2.0", id: 1, result } }) };
  return value;
}

describe("continuity runtime status", () => {
  test("preserves the checkpoint quarantine reason", async () => {
    const status = await reader({
      isSyncing: true, latestSyncedSlot: 12, latestL1Slot: 12,
      checkpointError: "checkpoint_lineage_mismatch"
    }).getSyncStatus();
    expect(status.checkpointError).toBe("checkpoint_lineage_mismatch");
  });

  test.each([
    { isSyncing: "false", latestSyncedSlot: 1, latestL1Slot: 1 },
    { isSyncing: false, latestSyncedSlot: -1, latestL1Slot: 1 },
    { isSyncing: false, latestSyncedSlot: Number.MAX_SAFE_INTEGER + 1, latestL1Slot: 1 },
    { isSyncing: false, latestSyncedSlot: 1, latestL1Slot: 1, checkpointError: false },
    { isSyncing: false, latestSyncedSlot: true, latestL1Slot: 1 },
  ])("rejects malformed status instead of authorizing execution: %p", async result => {
    await expect(reader(result).getSyncStatus()).rejects.toThrow();
  });
});
