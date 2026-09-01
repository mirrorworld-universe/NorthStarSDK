import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  NorthStarSDK,
  PortalProgram,
  TokenBridgeProgram,
  SESSION_DISCRIMINATOR,
  SESSION_LEN,
} from "../src";

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
    expect(undelegate.instructions[0].keys[1].isSigner).toBe(true);
    expect(undelegate.instructions[0].keys[5].isWritable).toBe(false);
  });

  test("builds DepositFee with readonly session", async () => {
    const sdk = sdkWithMockRpc();
    const user = Keypair.generate();
    const deposit = await sdk.buildDepositFee(user, 500);

    expect(deposit.instructions[0].keys[1].isWritable).toBe(false);
  });

  test("builds CloseSession with checkpoint cursor", async () => {
    const sdk = sdkWithMockRpc();
    const authority = Keypair.generate();
    const sessionPDA = await sdk.portal.deriveSessionPDA();
    const checkpointCursorPDA =
      await sdk.portal.deriveCheckpointCursorPDA(sessionPDA);
    const close = await sdk.buildCloseSession(authority);

    expect(close.instructions[0].keys).toHaveLength(5);
    expect(close.instructions[0].keys[4].pubkey.equals(checkpointCursorPDA)).toBe(
      true,
    );
    expect(close.instructions[0].keys[4].isWritable).toBe(true);
  });

  test("encodes RegisterSessionBridge with current Portal tag", () => {
    const data = PortalProgram.encodeRegisterSessionBridge({
      mint: Keypair.generate().publicKey,
      bridgeProgram: Keypair.generate().publicKey,
      vault: Keypair.generate().publicKey,
      tokenProgram: Keypair.generate().publicKey,
    });

    expect(data).toHaveLength(129);
    expect(data[0]).toBe(22);
  });

  test("builds permissionless RegisterSessionBridge with validation accounts", async () => {
    const sdk = sdkWithMockRpc();
    const payer = Keypair.generate().publicKey;
    const session = await sdk.portal.deriveSessionPDA();
    const mint = Keypair.generate().publicKey;
    const bridgeProgram = Keypair.generate().publicKey;
    const tokenProgram = Keypair.generate().publicKey;
    const sessionBridge = await sdk.portal.deriveSessionBridgePDA(session, mint);
    const vault = TokenBridgeProgram.deriveVaultPDA(sessionBridge, bridgeProgram);

    const instruction = await sdk.buildRegisterSessionBridgeInstruction({
      payer,
      session,
      mint,
      bridgeProgram,
      tokenProgram,
    });

    expect(instruction.keys).toHaveLength(7);
    expect(instruction.keys[0]).toMatchObject({
      pubkey: payer,
      isSigner: true,
      isWritable: true,
    });
    expect(instruction.keys[1].pubkey.equals(session)).toBe(true);
    expect(instruction.keys[2].pubkey.equals(sessionBridge)).toBe(true);
    expect(instruction.keys[3].pubkey.equals(mint)).toBe(true);
    expect(instruction.keys[4].pubkey.equals(bridgeProgram)).toBe(true);
    expect(instruction.keys[5].pubkey.equals(tokenProgram)).toBe(true);
    expect(instruction.keys[6].pubkey.equals(SystemProgram.programId)).toBe(true);
    expect(
      new PublicKey(instruction.data.slice(65, 97)).equals(vault),
    ).toBe(true);
  });

  test("parses Anchor-compatible Session layout", () => {
    const authority = Keypair.generate().publicKey;
    const validator = Keypair.generate().publicKey;
    const data = new Uint8Array(SESSION_LEN);
    data.set(SESSION_DISCRIMINATOR);
    writeU64LE(data, 8, 11n);
    writeU64LE(data, 16, 22n);
    writeU64LE(data, 24, 33n);
    writeU64LE(data, 32, 44n);
    writeU128LE(data, 40, 55n);
    data.set(authority.toBytes(), 56);
    data.set(validator.toBytes(), 88);
    writeU64LE(data, 120, 66n);
    writeU64LE(data, 128, 77n);
    writeU64LE(data, 136, 88n);
    data[144] = 1;
    writeU64LE(data, 145, 99n);
    data.fill(0xaa, 153, 185);
    data.fill(0xbb, 185, 217);
    writeU64LE(data, 217, 111n);
    data[225] = 9;

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

  test("rejects a Session with the wrong discriminator", () => {
    const data = new Uint8Array(SESSION_LEN);
    expect(() => PortalProgram.parseSession(data)).toThrow(
      "Invalid Session discriminator",
    );
  });
});
