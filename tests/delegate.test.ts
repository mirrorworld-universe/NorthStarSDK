import {
  Keypair, SystemInstruction, SystemProgram, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { signVersionedTransaction } from "../src";
import { PORTAL, sdkFixture } from "./fixtures/continuity";

function delegations(count: number) {
  return Array.from({ length: count }, () => ({
    delegatedAccountSigner: Keypair.generate(), ownerProgramId: SystemProgram.programId,
  }));
}

describe("wallet delegation continuity binding", () => {
  test("stages owner transfer and reserves a distinct input for each account", async () => {
    const { sdk, user } = sdkFixture();
    const value = await sdk.buildDelegate(user, 1, delegations(2));
    const calls = value.instructions.filter(instruction => instruction.programId.equals(PORTAL));
    expect(calls).toHaveLength(2);
    expect(calls.map(instruction => instruction.keys.length)).toEqual([8, 8]);
    expect(calls.every(instruction => instruction.data[0] === 32 && instruction.keys[2].isWritable)).toBe(true);
    const snapshot = await sdk.getSessionSnapshot();
    expect(calls[0].keys[7].pubkey.equals(await sdk.portal.deriveIngressRecordPDA(snapshot.context, 3n))).toBe(true);
    expect(calls[1].keys[7].pubkey.equals(await sdk.portal.deriveIngressRecordPDA(snapshot.context, 4n))).toBe(true);
    const staging = value.instructions.filter(instruction => instruction.programId.equals(SystemProgram.programId));
    expect(staging.map(instruction => SystemInstruction.decodeInstructionType(instruction))).toEqual(["Create", "Assign", "Create", "Assign"]);
    const message = new TransactionMessage({
      payerKey: user.publicKey, recentBlockhash: value.blockhash,
      instructions: value.instructions
    }).compileToV0Message();
    expect(new VersionedTransaction(message).serialize().length).toBeLessThanOrEqual(1232);
  });

  test("wallet signing completes buffer, account and payer signatures without changing the binding", async () => {
    const { sdk, user, rpc } = sdkFixture();
    await sdk.delegate(user.publicKey, 1, async transaction => signVersionedTransaction(transaction, [user]),
      { delegations: delegations(2) });
    expect(rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
    const wire = (rpc.sendRawTransaction.mock.calls[0] as unknown as [Uint8Array])[0];
    const transaction = VersionedTransaction.deserialize(wire);
    expect(transaction.message.header.numRequiredSignatures).toBe(5);
    expect(transaction.signatures.every(signature => signature.some(byte => byte !== 0))).toBe(true);
  });

  test("rejects a batch that cannot fit the supported transaction packet bound", async () => {
    const { sdk, user, rpc } = sdkFixture();
    await expect(sdk.buildDelegate(user, 1, delegations(4))).rejects.toThrow("at most two");
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });

  test("does not replace owner-program CPI with a wallet signature", async () => {
    const { sdk, user } = sdkFixture();
    const value = delegations(1);
    value[0].ownerProgramId = Keypair.generate().publicKey;
    await expect(sdk.buildDelegate(user, 1, value)).rejects.toThrow("owner program");
    await expect(sdk.buildDelegate(user, 2, delegations(1))).rejects.toThrow("grid");
  });
});
