import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { NorthStarSDK, PortalProgram } from "../src";

function readU64LE(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(
    offset,
    true,
  );
}

function writeU64LE(data: Uint8Array, offset: number, value: bigint) {
  new DataView(data.buffer, data.byteOffset, data.byteLength).setBigUint64(
    offset,
    value,
    true,
  );
}

function writeU128LE(data: Uint8Array, offset: number, value: bigint) {
  writeU64LE(data, offset, value & 0xffff_ffff_ffff_ffffn);
  writeU64LE(data, offset + 8, value >> 64n);
}

function sdkWithMockRpc(): NorthStarSDK {
  const sdk = new NorthStarSDK({
    portalProgramId: Keypair.generate().publicKey,
    customEndpoints: {
      solana: "http://localhost:8899",
      ephemeralRollup: "http://localhost:8899",
    },
  });
  (sdk as any).rpc = {
    getLatestBlockhash: async () => ({
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 1,
    }),
    getMinimumBalanceForRentExemption: async () => 0,
  };
  return sdk;
}

describe("Portal SDK encoding and account layout", () => {
  test("encodes OpenSession with validator and settlement interval", () => {
    const validator = Keypair.generate().publicKey;
    const data = PortalProgram.encodeOpenSession({
      gridId: 1n,
      ttlSlots: 2n,
      feeCap: 3n,
      validator,
      settlementIntervalSlots: 4n,
    });

    expect(data.length).toBe(65);
    expect(data[0]).toBe(0);
    expect(readU64LE(data, 1)).toBe(1n);
    expect(readU64LE(data, 9)).toBe(2n);
    expect(readU64LE(data, 17)).toBe(3n);
    expect(new PublicKey(data.slice(25, 57)).equals(validator)).toBe(true);
    expect(readU64LE(data, 57)).toBe(4n);
  });

  test("builds Delegate and Undelegate with required session account", async () => {
    const sdk = sdkWithMockRpc();
    const user = Keypair.generate();
    const delegatedAccountSigner = Keypair.generate();
    const sessionPDA = await sdk.portal.deriveSessionPDA();

    const delegate = await sdk.buildDelegate(user, 7, [
      { delegatedAccountSigner, ownerProgramId: SystemProgram.programId },
    ]);
    const delegateIx = delegate.instructions[delegate.instructions.length - 1];
    expect(delegateIx.keys[0].pubkey.equals(user.publicKey)).toBe(true);
    expect(delegateIx.keys[1].pubkey.equals(SystemProgram.programId)).toBe(true);
    expect(delegateIx.keys[2].pubkey.equals(sessionPDA)).toBe(true);
    expect(delegateIx.keys[2].isWritable).toBe(false);
    expect(delegateIx.keys[3].pubkey.equals(delegatedAccountSigner.publicKey)).toBe(
      true,
    );

    const undelegate = await sdk.buildUndelegate(
      user,
      delegatedAccountSigner.publicKey,
      SystemProgram.programId,
    );
    expect(undelegate.instructions[0].keys).toHaveLength(6);
    expect(undelegate.instructions[0].keys[5].pubkey.equals(sessionPDA)).toBe(
      true,
    );
    expect(undelegate.instructions[0].keys[5].isWritable).toBe(false);
  });

  test("builds DepositFee with readonly session", async () => {
    const sdk = sdkWithMockRpc();
    const user = Keypair.generate();
    const deposit = await sdk.buildDepositFee(user, 500);

    expect(deposit.instructions[0].keys[1].isWritable).toBe(false);
  });

  test("parses current 219-byte Session layout", () => {
    const authority = Keypair.generate().publicKey;
    const validator = Keypair.generate().publicKey;
    const data = new Uint8Array(219);
    data[0] = 1;
    writeU64LE(data, 1, 11n);
    writeU64LE(data, 9, 22n);
    writeU64LE(data, 17, 33n);
    writeU64LE(data, 25, 44n);
    writeU128LE(data, 33, 55n);
    data.set(authority.toBytes(), 49);
    data.set(validator.toBytes(), 81);
    writeU64LE(data, 113, 66n);
    writeU64LE(data, 121, 77n);
    writeU64LE(data, 129, 88n);
    data[137] = 1;
    writeU64LE(data, 138, 99n);
    data.fill(0xaa, 146, 178);
    data.fill(0xbb, 178, 210);
    writeU64LE(data, 210, 111n);
    data[218] = 9;

    const session = PortalProgram.parseSession(data);
    expect(session.gridId).toBe(11n);
    expect(session.authority.equals(authority)).toBe(true);
    expect(session.validator.equals(validator)).toBe(true);
    expect(session.settlementIntervalSlots).toBe(66n);
    expect(session.settlementStatus).toBe(1);
    expect(session.settlementChecksum[0]).toBe(0xaa);
    expect(session.settlementAccumulator[0]).toBe(0xbb);
    expect(session.bump).toBe(9);
  });
});
