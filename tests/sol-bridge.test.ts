import { Keypair, SYSVAR_CLOCK_PUBKEY, SystemProgram } from "@solana/web3.js";
import { WITHDRAWAL_SINK } from "../src/programs/portal";
import { PORTAL, sdkFixture, sessionFrame } from "./fixtures/continuity";

describe("ER SOL bridge helpers", () => {
  test("builds Portal StartWithdrawal only for the bound healthy ER session", async () => {
    const { sdk } = sdkFixture();
    const erSource = Keypair.generate().publicKey;
    const l1Recipient = Keypair.generate().publicKey;
    const [instruction] = await sdk.buildErSolWithdrawalInstructions({ erSource, l1Recipient, lamports: 1234n });
    expect(instruction.programId.equals(PORTAL)).toBe(true);
    expect(instruction.keys).toEqual([
      { pubkey: erSource, isSigner: true, isWritable: true },
      { pubkey: l1Recipient, isSigner: false, isWritable: false },
      { pubkey: WITHDRAWAL_SINK, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    ]);
    expect(instruction.data).toEqual(Buffer.from([13, 0xd2, 0x04, 0, 0, 0, 0, 0, 0]));
  });

  test("does not construct an ER withdrawal while checkpoint state is quarantined", async () => {
    const { sdk, reader, user } = sdkFixture();
    reader.getSyncStatus.mockResolvedValue({
      isSyncing: false, latestSyncedSlot: 20n, latestL1Slot: 20n,
      checkpointError: "checkpoint_lineage_mismatch"
    });
    await expect(sdk.buildErSolWithdrawal(user.publicKey, 1n)).rejects.toThrow("checkpoint error");
  });

  test("requires the ER endpoint to report the same session and incarnation as L1", async () => {
    const { sdk, reader, er, user } = sdkFixture();
    reader.getSessionPda.mockResolvedValue(null);
    await expect(sdk.buildErSolWithdrawal(user.publicKey, 1n)).rejects.toThrow("ER session differs");
    const snapshot = await sdk.getSessionSnapshot();
    reader.getSessionPda.mockResolvedValue(snapshot.address);
    er.getAccountInfo.mockResolvedValue({ owner: PORTAL, executable: false, lamports: 1_000_000, data: sessionFrame(8n), rentEpoch: 0 });
    await expect(sdk.buildErSolWithdrawal(user.publicKey, 1n)).rejects.toThrow("incarnation");
  });
});
