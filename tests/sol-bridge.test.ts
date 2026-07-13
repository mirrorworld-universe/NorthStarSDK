import {
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";
import { NorthStarSDK } from "../src";
import { WITHDRAWAL_SINK } from "../src/programs/portal";

const PORTAL_PROGRAM_ID = new PublicKey(
  "5TeWSsjg2gbxCyWVniXeCmwM7UtHTCK7svzJr5xYJzHf",
);

describe("ER SOL bridge helpers", () => {
  test("buildErSolWithdrawalInstructions invokes Portal StartWithdrawal", async () => {
    const sdk = new NorthStarSDK({
      portalProgramId: PORTAL_PROGRAM_ID,
      customEndpoints: {
        solana: "http://localhost:8899",
        ephemeralRollup: "http://localhost:8899",
      },
    });
    const erSource = Keypair.generate().publicKey;
    const l1Recipient = Keypair.generate().publicKey;
    const lamports = 1234;

    const [instruction] = await sdk.buildErSolWithdrawalInstructions({
      erSource,
      l1Recipient,
      lamports,
    });

    expect(instruction.programId.equals(PORTAL_PROGRAM_ID)).toBe(true);
    expect(instruction.keys).toEqual([
      { pubkey: erSource, isSigner: true, isWritable: true },
      { pubkey: l1Recipient, isSigner: false, isWritable: false },
      { pubkey: WITHDRAWAL_SINK, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    ]);
    expect(instruction.data).toEqual(Buffer.from([13, 0xd2, 0x04, 0, 0, 0, 0, 0, 0]));
  });
});
