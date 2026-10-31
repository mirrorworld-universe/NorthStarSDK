import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import { PortalProgram, SESSION_LEN } from "../src";
import { BRIDGE, GENESIS, PORTAL, PROFILE, SESSION, sdkFixture, sessionFrame, u64 } from "./fixtures/continuity";

const key = () => Keypair.generate().publicKey;

describe("Portal continuity bindings", () => {
  test("opens with five accounts and explicit network/profile bytes", async () => {
    const { sdk, user } = sdkFixture();
    const validator = key();
    const plan = await sdk.buildOpenSession(user, 1n, 2n, 3n, { validator, settlementIntervalSlots: 4n });
    const instruction = plan.instructions[0];
    expect(instruction.data).toHaveLength(129);
    expect(instruction.data[0]).toBe(31);
    expect(instruction.keys).toHaveLength(5);
    expect(instruction.keys[4]).toEqual({ pubkey: await sdk.portal.deriveSessionEpochPDA(), isSigner: false, isWritable: true });
    expect(instruction.data.subarray(65, 97)).toEqual(Buffer.from(GENESIS));
    expect(instruction.data.subarray(97)).toEqual(Buffer.from(PROFILE));
    expect(new PublicKey(instruction.data.subarray(25, 57)).equals(validator)).toBe(true);
  });

  test("rejects the wrong L1 network before wallet signing or blockhash planning", async () => {
    const { sdk, user, rpc } = sdkFixture();
    rpc.getGenesisHash.mockResolvedValue(bs58.encode(new Uint8Array(32).fill(8)));
    const wallet = jest.fn(async transaction => transaction);
    await expect(sdk.openSession(user.publicKey, 1, 2000, 1000, wallet, {})).rejects.toThrow("genesis");
    expect(wallet).not.toHaveBeenCalled();
    expect(rpc.getLatestBlockhash).not.toHaveBeenCalled();
  });

  test("deposits through the mutable session and nonce-derived receipt/inbox", async () => {
    const { sdk, user, frame } = sdkFixture();
    const snapshot = await sdk.getSessionSnapshot();
    const first = (await sdk.buildDepositFee(user, 500n)).instructions[0];
    expect(first.data[0]).toBe(33);
    expect(first.keys).toHaveLength(6);
    expect(first.keys[1]).toEqual({ pubkey: SESSION, isSigner: false, isWritable: true });
    expect(first.keys[2].pubkey.equals(await sdk.portal.deriveDepositReceiptPDA(snapshot.context, user.publicKey))).toBe(true);
    expect(first.keys[5].pubkey.equals(await sdk.portal.deriveIngressRecordPDA(snapshot.context, 3n))).toBe(true);
    u64(frame, 48, 8n);
    const second = (await sdk.buildDepositFee(user, 500n)).instructions[0];
    expect(second.keys[2].pubkey.equals(first.keys[2].pubkey)).toBe(false);
    expect(second.keys[5].pubkey.equals(first.keys[5].pubkey)).toBe(false);
  });

  test("bridge registration requires the session authority and configured bridge", async () => {
    const { sdk, user } = sdkFixture();
    const mint = key();
    const tokenProgram = key();
    const snapshot = await sdk.getSessionSnapshot();
    const registry = await sdk.portal.deriveSessionBridgePDA(snapshot.context, mint);
    const instruction = await sdk.buildRegisterSessionBridgeInstruction({ payer: user.publicKey, session: SESSION, mint, tokenProgram });
    expect(instruction.data[0]).toBe(36);
    expect(instruction.keys).toHaveLength(7);
    expect(instruction.keys[2].pubkey.equals(registry)).toBe(true);
    expect(instruction.keys[4].pubkey.equals(BRIDGE)).toBe(true);
    expect(new PublicKey(instruction.data.subarray(65, 97)).equals(sdk.tokenBridge.deriveVaultPDA(registry))).toBe(true);
    await expect(sdk.buildRegisterSessionBridgeInstruction({ payer: key(), session: SESSION, mint, tokenProgram })).rejects.toThrow("authority");
    await expect(sdk.buildRegisterSessionBridgeInstruction({ payer: user.publicKey, session: SESSION, mint, tokenProgram, bridgeProgram: key() })).rejects.toThrow("bridge program");
  });

  test("parses all embedded settlement fields without accepting a legacy frame", () => {
    const data = sessionFrame((1n << 100n) + 55n);
    u64(data, 16, 11n);
    u64(data, 128, 66n);
    data[152] = 1;
    data.fill(0xaa, 161, 193);
    data.fill(0xbb, 193, 225);
    const state = PortalProgram.parseSession(data);
    expect(state.gridId).toBe(11n);
    expect(state.nonce).toBe((1n << 100n) + 55n);
    expect(state.settlementIntervalSlots).toBe(66n);
    expect(state.settlementStatus).toBe(1);
    expect(state.settlementChecksum[0]).toBe(0xaa);
    expect(state.settlementAccumulator[0]).toBe(0xbb);
    expect(() => PortalProgram.parseSession(data.subarray(8, 234))).toThrow();
    expect(() => PortalProgram.parseSession(new Uint8Array(SESSION_LEN))).toThrow("discriminator");
  });

  test.each([
    ["nonce", (frame: Buffer) => frame.fill(0, 48, 64)],
    ["profile", (frame: Buffer) => frame.fill(9, 266, 298)],
    ["input prefix", (frame: Buffer) => u64(frame, 338, 3n)],
    ["bump", (frame: Buffer) => { frame[233] ^= 1; }],
  ] as const)("rejects changed session %s before building a deposit", async (_name, change) => {
    const { sdk, user, frame, rpc } = sdkFixture();
    change(frame);
    await expect(sdk.buildDepositFee(user, 1n)).rejects.toThrow();
    expect(rpc.getLatestBlockhash).not.toHaveBeenCalled();
  });

  test("rejects wrong ownership and expired context", async () => {
    const { sdk, user, rpc } = sdkFixture();
    rpc.getAccountInfoAndContext.mockResolvedValue({
      context: { slot: 20 }, value: {
        owner: SystemProgram.programId, executable: false, lamports: 1_000_000, data: sessionFrame(), rentEpoch: 0,
      }
    });
    await expect(sdk.buildDepositFee(user, 1n)).rejects.toThrow("owner");
    rpc.getAccountInfoAndContext.mockResolvedValue({
      context: { slot: 2011 }, value: {
        owner: PORTAL, executable: false, lamports: 1_000_000, data: sessionFrame(), rentEpoch: 0,
      }
    });
    await expect(sdk.buildDepositFee(user, 1n)).rejects.toThrow("expired");
  });

  test("parses framed cumulative receipts with exact totals", () => {
    const data = new Uint8Array(137);
    data.set(Buffer.from("NSRECP02"));
    const base = data.subarray(8, 97);
    base.set([64, 175, 24, 183, 138, 109, 70, 78]);
    base.set(SESSION.toBytes(), 8);
    base.set(key().toBytes(), 40);
    u64(base, 72, 10n);
    u64(base, 80, 3n);
    data.set(new Uint8Array(32).fill(7), 97);
    u64(data, 129, 13n);
    expect(PortalProgram.parseDepositReceipt(data)).toMatchObject({ balance: 10n, withdrawn: 3n, totalDeposited: 13n });
    u64(data, 129, 12n);
    expect(() => PortalProgram.parseDepositReceipt(data)).toThrow("totals");
  });

  test("parses only the framed session registry", () => {
    const data = new Uint8Array(209);
    data.set(Buffer.from("NSBRDG02"));
    const base = data.subarray(8, 177);
    base.set([145, 47, 8, 254, 118, 119, 114, 215]);
    const mint = key();
    base.set(SESSION.toBytes(), 8);
    base.set(mint.toBytes(), 40);
    base.set(BRIDGE.toBytes(), 72);
    base.set(key().toBytes(), 104);
    base.set(key().toBytes(), 136);
    data.set(new Uint8Array(32).fill(7), 177);
    expect(PortalProgram.parseSessionBridge(data).mint.equals(mint)).toBe(true);
    expect(() => PortalProgram.parseSessionBridge(base)).toThrow();
  });

  test("unsupported lifecycle commands cannot reach wallet signing", async () => {
    const { sdk, user, rpc } = sdkFixture();
    const wallet = jest.fn();
    await expect(sdk.closeSession(user.publicKey, wallet, {})).rejects.toThrow("no transaction is signed");
    await expect(sdk.requestUndelegation(user.publicKey, key(), wallet, {})).rejects.toThrow();
    expect(wallet).not.toHaveBeenCalled();
    expect(rpc.getLatestBlockhash).not.toHaveBeenCalled();
    expect(() => PortalProgram.parseUndelegationRequest(new Uint8Array(146))).toThrow("no legacy");
  });
});
