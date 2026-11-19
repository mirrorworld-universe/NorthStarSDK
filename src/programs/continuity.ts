import { sha256 } from "@noble/hashes/sha256";
import { PublicKey } from "@solana/web3.js";

export type Hash32 = Uint8Array;

export interface SessionIdentity {
  l1Genesis: Hash32;
  portal: PublicKey;
  session: PublicKey;
  nonce: bigint;
  gridId: bigint;
  validator: PublicKey;
  profile: Hash32;
}

export function checkedHash(value: Uint8Array, name: string): Hash32 {
  if (!(value instanceof Uint8Array) || value.length !== 32 || value.every(byte => byte === 0)) {
    throw new Error(`${name} must be a nonzero 32-byte value`);
  }
  return Uint8Array.from(value);
}

export function checkedInteger(value: number | bigint, bits: 64 | 128, name: string): bigint {
  if (typeof value !== "number" && typeof value !== "bigint") throw new TypeError(`${name} must be an integer`);
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe integer or bigint`);
  }
  const result = BigInt(value);
  if (result < 0n || result >= (1n << BigInt(bits))) throw new RangeError(`${name} overflows u${bits}`);
  return result;
}

export function uintLE(value: number | bigint, bits: 64 | 128, name: string): Uint8Array {
  const result = checkedInteger(value, bits, name);
  const data = new Uint8Array(bits / 8);
  const view = new DataView(data.buffer);
  view.setBigUint64(0, result & 0xffff_ffff_ffff_ffffn, true);
  if (bits === 128) view.setBigUint64(8, result >> 64n, true);
  return data;
}

export function concatBytes(...values: Uint8Array[]): Uint8Array {
  const data = new Uint8Array(values.reduce((length, value) => length + value.length, 0));
  let offset = 0;
  for (const value of values) { data.set(value, offset); offset += value.length; }
  return data;
}

export function sessionCommitment(identity: SessionIdentity): Hash32 {
  const nonce = checkedInteger(identity.nonce, 128, "session nonce");
  if (nonce === 0n) throw new Error("Session nonce must be nonzero");
  const data = concatBytes(Uint8Array.of(2), checkedHash(identity.l1Genesis, "L1 genesis"),
    checkedHash(identity.portal.toBytes(), "Portal"), checkedHash(identity.session.toBytes(), "Session"),
    uintLE(nonce, 128, "session nonce"), uintLE(identity.gridId, 64, "grid id"),
    checkedHash(identity.validator.toBytes(), "Validator"), checkedHash(identity.profile, "checkpoint profile"));
  const label = Uint8Array.from(Buffer.from("session", "utf8"));
  const lengths = new Uint8Array(4);
  const view = new DataView(lengths.buffer);
  view.setUint16(0, label.length, true); view.setUint16(2, data.length, true);
  const root = sha256(concatBytes(Uint8Array.from(Buffer.from("northstar-continuity-v2", "utf8")),
    lengths.subarray(0, 2), label, lengths.subarray(2), data));
  root[0] &= 0x1f;
  return root;
}
