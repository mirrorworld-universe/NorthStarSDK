import { PublicKey } from "@solana/web3.js";
import { PortalProgram } from "../src/programs/portal";
import { TokenBridgeProgram } from "../src/programs/tokenBridge";
import { sessionCommitment } from "../src/programs/continuity";

function u64(data: Uint8Array, offset: number, value: bigint) {
  new DataView(data.buffer, data.byteOffset, data.byteLength).setBigUint64(offset, value, true);
}

function sessionFrame(): Uint8Array {
  const data = new Uint8Array(378);
  data.set(Buffer.from("NSSESS02"));
  const base = data.subarray(8, 234);
  base.set([243, 81, 72, 115, 214, 188, 72, 144]);
  u64(base, 8, 1n); u64(base, 16, 2_000n); u64(base, 24, 1_000n); u64(base, 32, 10n); u64(base, 40, 7n);
  base.set(new Uint8Array(32).fill(1), 56); base.set(new Uint8Array(32).fill(2), 88);
  u64(base, 120, 10n); base[225] = 254;
  data.set(new Uint8Array(32).fill(3), 234); data.set(new Uint8Array(32).fill(4), 266);
  u64(data, 298, 2n); data.set(new Uint8Array(32).fill(5), 306);
  u64(data, 338, 1n); data.set(new Uint8Array(32).fill(6), 346);
  return data;
}

describe("continuity Portal contract", () => {
  test.each<[bigint, string]>([
    [7n, "01beb461f321f75cb0a09858be79ea208f6ca7e2d4172cf78d871108369aa647"],
    [(1n << 100n) + 7n, "0fc5636a0a9f37d69ed2b9adcac3337e045308d50b8b9118663349877616b4ce"],
  ])("matches native SessionIdentityV2 commitment for nonce %s", (nonce, expected) => {
    const identity = {
      l1Genesis: new Uint8Array(32).fill(3), portal: new PublicKey(new Uint8Array(32).fill(9)),
      session: new PublicKey(new Uint8Array(32).fill(8)), nonce, gridId: 1n,
      validator: new PublicKey(new Uint8Array(32).fill(2)), profile: new Uint8Array(32).fill(4)
    };
    expect(Buffer.from(sessionCommitment(identity)).toString("hex")).toBe(expected);
    expect(() => sessionCommitment({ ...identity, nonce: 0n })).toThrow();
    expect(() => sessionCommitment({ ...identity, nonce: 1n << 128n })).toThrow();
    expect(() => sessionCommitment({ ...identity, profile: new Uint8Array(32) })).toThrow();
  });
  test("rejects token state with the wrong discriminator and numeric values that lose precision", () => {
    expect(() => TokenBridgeProgram.parseTokenVault(new Uint8Array(146))).toThrow();
    expect(() => TokenBridgeProgram.parseErTokenAccount(new Uint8Array(106))).toThrow();
    expect(() => TokenBridgeProgram.encodeDeposit(Number.MAX_SAFE_INTEGER + 1, 6)).toThrow();
    expect(() => TokenBridgeProgram.encodeStartWithdrawal(1n, 256)).toThrow();
  });

  test("does not emit unbound immediate-payout or undelegation instructions", () => {
    expect(() => TokenBridgeProgram.encodeWithdraw(1n, 6)).toThrow();
    expect(() => TokenBridgeProgram.encodeUndelegateErTokenAccount()).toThrow();
    expect(() => TokenBridgeProgram.encodeRequestUndelegation()).toThrow();
  });
  test("parses the exact versioned session including immutable identity and ordered input position", () => {
    const session = PortalProgram.parseSession(sessionFrame()) as any;
    expect(session.nonce).toBe(7n);
    expect(session.l1Genesis).toEqual(new Uint8Array(32).fill(3));
    expect(session.profile).toEqual(new Uint8Array(32).fill(4));
    expect(session.ingressCount).toBe(2n);
    expect(session.consumedIngressCount).toBe(1n);
    expect(session.validator.equals(new PublicKey(new Uint8Array(32).fill(2)))).toBe(true);
  });

  test("does not accept a legacy session or a noncanonical framed length", () => {
    const frame = sessionFrame();
    expect(() => PortalProgram.parseSession(frame.subarray(8, 234))).toThrow();
    expect(() => PortalProgram.parseSession(Buffer.concat([frame, Buffer.from([0])]))).toThrow();
    for (const offset of [40 + 8, 234, 266]) {
      const changed = frame.slice(); changed.fill(0, offset, offset === 48 ? offset + 16 : offset + 32);
      expect(() => PortalProgram.parseSession(changed)).toThrow();
    }
  });

  test("opens only with explicit full network and checkpoint profile identities", () => {
    const params = {
      gridId: 1n, ttlSlots: 2n, feeCap: 3n, validator: new PublicKey(new Uint8Array(32).fill(2)),
      settlementIntervalSlots: 4n, l1Genesis: new Uint8Array(32).fill(3), profile: new Uint8Array(32).fill(4)
    };
    const data = PortalProgram.encodeOpenSession(params as any);
    expect(data.length).toBe(129);
    expect(data[0]).toBe(31);
    expect(data.subarray(65, 97)).toEqual(params.l1Genesis);
    expect(data.subarray(97, 129)).toEqual(params.profile);
    const { profile, ...missing } = params;
    expect(() => PortalProgram.encodeOpenSession(missing as any)).toThrow();
  });

  test("selects only the versioned input and authority-bound bridge instructions", () => {
    expect(PortalProgram.encodeDepositFee({ lamports: 7n })[0]).toBe(33);
    expect(PortalProgram.encodeDelegate({ gridId: 1n })[0]).toBe(32);
    const key = new PublicKey(new Uint8Array(32).fill(7));
    expect(PortalProgram.encodeRegisterSessionBridge({ mint: key, bridgeProgram: key, vault: key, tokenProgram: key })[0]).toBe(36);
  });
});
