import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { MEMO_PROGRAM_ID, NorthStarSDK } from "../src";

const PORTAL_PROGRAM_ID = new PublicKey(
  "5TeWSsjg2gbxCyWVniXeCmwM7UtHTCK7svzJr5xYJzHf",
);

describe("ER SOL bridge helpers", () => {
  test("buildErSolWithdrawalInstructions transfers ER source to its withdrawal sink and memoes L1 recipient", async () => {
    const sdk = new NorthStarSDK({
      portalProgramId: PORTAL_PROGRAM_ID,
      customEndpoints: {
        solana: "http://localhost:8899",
        ephemeralRollup: "http://localhost:8899",
      },
    });
    const sessionPDA = await sdk.portal.deriveSessionPDA();
    const erSource = Keypair.generate().publicKey;
    const l1Recipient = Keypair.generate().publicKey;
    const lamports = 1234;

    const [transferIx, memoIx] = await sdk.buildErSolWithdrawalInstructions({
      erSource,
      l1Recipient,
      lamports,
      sessionPDA,
    });
    const withdrawalSink = await sdk.portal.deriveWithdrawalSinkPDA(
      sessionPDA,
      erSource,
    );

    expect(transferIx.programId.equals(SystemProgram.programId)).toBe(true);
    expect(transferIx.keys[0]).toMatchObject({
      pubkey: erSource,
      isSigner: true,
      isWritable: true,
    });
    expect(transferIx.keys[1]).toMatchObject({
      pubkey: withdrawalSink,
      isSigner: false,
      isWritable: true,
    });
    expect(memoIx.programId.equals(MEMO_PROGRAM_ID)).toBe(true);
    expect(memoIx.keys).toHaveLength(0);
    expect(memoIx.data.toString("utf8")).toBe(l1Recipient.toBase58());
  });
});
