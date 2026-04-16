export function toU64LE(value: number | bigint): Uint8Array {
  const v = typeof value === "bigint" ? value : BigInt(value);
  if (v < 0n || v > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError("u64 overflow");
  }
  const out = new ArrayBuffer(8);
  new DataView(out).setBigUint64(0, v, true);
  return new Uint8Array(out);
}

export function readU64LE(data: Uint8Array, offset: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(offset, true);
}

export function readU128LE(data: Uint8Array, offset: number): bigint {
  const low = readU64LE(data, offset);
  const high = readU64LE(data, offset + 8);
  return low | (high << 64n);
}

/**
 * Convert number to little-endian bytes for PDA seeds
 */
export function numberToLE(num: bigint, bytes: number): Uint8Array {
  if (num < 0n) {
    throw "number is negative";
  }
  let arr = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) {
    arr[i] = Number(num & 0xffn);
    num = num >> 8n;
  }
  if (num != 0n) {
    throw new Error("Number to LE conversion failed");
  }
  return arr;
}
