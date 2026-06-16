import { Keypair, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { DelegateAccount, NorthStarSDK } from "../src";

function createSdkForDelegateTests(): NorthStarSDK {
  const sdk = new NorthStarSDK({
    portalProgramId: Keypair.generate().publicKey,
    customEndpoints: {
      solana: "http://127.0.0.1:8899",
      ephemeralRollup: "http://127.0.0.1:8910",
    },
  });

  (sdk as any).rpc.getMinimumBalanceForRentExemption = jest
    .fn()
    .mockResolvedValue(0);
  (sdk as any).rpc.getLatestBlockhash = jest.fn().mockResolvedValue({
    blockhash: "11111111111111111111111111111111",
    lastValidBlockHeight: 123,
  });

  return sdk;
}

function createDelegations(count: number): DelegateAccount[] {
  return Array.from({ length: count }, () => ({
    delegatedAccountSigner: Keypair.generate(),
    ownerProgramId: Keypair.generate().publicKey,
  }));
}

function portalInstructions(
  sdk: NorthStarSDK,
  instructions: TransactionInstruction[],
): TransactionInstruction[] {
  const portalProgramId = sdk.getPortalProgramId().toBase58();
  return instructions.filter(
    (instruction) => instruction.programId.toBase58() === portalProgramId,
  );
}

describe("delegate instruction batching", () => {
  test("buildDelegate chunks delegations to fit Portal account cap", async () => {
    const sdk = createSdkForDelegateTests();
    const signer = Keypair.generate();
    const delegations = createDelegations(4);

    const built = await sdk.buildDelegate(signer, 7, delegations);
    const delegateIxs = portalInstructions(sdk, built.instructions);

    expect(delegateIxs).toHaveLength(2);
    expect(delegateIxs.map((ix) => ix.keys.length)).toEqual([15, 7]);
    expect(delegateIxs.every((ix) => ix.keys.length <= 16)).toBe(true);
  });

  test("delegate sends chunked Portal instructions", async () => {
    const sdk = createSdkForDelegateTests();
    const user = Keypair.generate();
    const delegations = createDelegations(4);
    let sentInstructions: TransactionInstruction[] = [];
    (sdk as any).sendTxV1 = jest
      .fn()
      .mockImplementation(async (_payer, instructions) => {
        sentInstructions = instructions;
        return { signature: "test-signature" };
      });

    await sdk.delegate(user.publicKey, 7, async (tx) => tx, { delegations });
    const delegateIxs = portalInstructions(sdk, sentInstructions);

    expect(delegateIxs).toHaveLength(2);
    expect(delegateIxs.map((ix) => ix.keys.length)).toEqual([15, 7]);
    expect(delegateIxs.every((ix) => ix.keys.length <= 16)).toBe(true);
    expect(
      sentInstructions.filter((ix) => ix.programId.equals(SystemProgram.programId)),
    ).toHaveLength(4);
  });
});
