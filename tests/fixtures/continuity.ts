import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import { NorthStarSDK } from "../../src";

export const PORTAL = new PublicKey(new Uint8Array(32).fill(9));
export const BRIDGE = new PublicKey(new Uint8Array(32).fill(10));
export const GENESIS = new Uint8Array(32).fill(3);
export const PROFILE = new Uint8Array(32).fill(4);
export const AUTHORITY = Keypair.fromSeed(new Uint8Array(32).fill(11));
export const SESSION = PublicKey.findProgramAddressSync([Buffer.from("session")], PORTAL)[0];

export function u64(data: Uint8Array, offset: number, value: bigint): void {
  new DataView(data.buffer, data.byteOffset, data.byteLength).setBigUint64(offset, value, true);
}

export function sessionFrame(nonce = 7n): Buffer {
  const data = Buffer.alloc(378);
  data.set(Buffer.from("NSSESS02"));
  const base = data.subarray(8, 234);
  base.set([243, 81, 72, 115, 214, 188, 72, 144]);
  u64(base, 8, 1n);
  u64(base, 16, 2_000n);
  u64(base, 24, 1_000n);
  u64(base, 32, 10n);
  u64(base, 40, nonce & 0xffff_ffff_ffff_ffffn);
  u64(base, 48, nonce >> 64n);
  base.set(AUTHORITY.publicKey.toBytes(), 56);
  base.set(new Uint8Array(32).fill(2), 88);
  u64(base, 120, 10n);
  base[225] = PublicKey.findProgramAddressSync([Buffer.from("session")], PORTAL)[1];
  data.set(GENESIS, 234);
  data.set(PROFILE, 266);
  u64(data, 298, 2n);
  data.set(new Uint8Array(32).fill(5), 306);
  u64(data, 338, 1n);
  data.set(new Uint8Array(32).fill(6), 346);
  return data;
}

export function sdkFixture() {
  const sdk = new NorthStarSDK({
    portalProgramId: PORTAL,
    tokenBridgeProgramId: BRIDGE,
    l1GenesisHash: bs58.encode(GENESIS),
    checkpointProfile: PROFILE,
    customEndpoints: { solana: "http://localhost:8899", ephemeralRollup: "http://localhost:8910" },
  });
  const frame = sessionFrame();
  const account = () => ({ owner: PORTAL, executable: false, lamports: 1_000_000, data: frame, rentEpoch: 0 });
  const rpc = {
    getGenesisHash: jest.fn(async () => bs58.encode(GENESIS)),
    getAccountInfoAndContext: jest.fn(async () => ({ context: { slot: 20 }, value: account() })),
    getAccountInfo: jest.fn(async () => ({
      owner: SystemProgram.programId, executable: false,
      lamports: 1_000_000, data: Buffer.alloc(0), rentEpoch: 0
    })),
    getLatestBlockhash: jest.fn(async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 })),
    getMinimumBalanceForRentExemption: jest.fn(async () => 890_880),
    sendRawTransaction: jest.fn(async () => "submitted"),
    getSignatureStatuses: jest.fn(async () => ({ value: [{ err: null, confirmationStatus: "finalized" }] })),
  };
  const er = { getAccountInfo: jest.fn(async () => account()) };
  const reader = {
    getSyncStatus: jest.fn(async () => ({ isSyncing: false, latestSyncedSlot: 20n, latestL1Slot: 20n, checkpointError: undefined as string | undefined })),
    getSessionPda: jest.fn(async (): Promise<PublicKey | null> => SESSION),
  };
  Object.assign(sdk as any, { rpc, ephemeral_rpc: er, ephemeralRollupReader: reader });
  return { sdk, frame, rpc, er, reader, user: AUTHORITY };
}
