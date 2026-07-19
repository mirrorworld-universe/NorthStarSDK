import { Keypair, SystemProgram } from "@solana/web3.js";
import {
  NorthStarSDK,
  TokenBridgeProgram,
} from "../src";

function writeU64LE(data: Uint8Array, offset: number, value: bigint) {
  new DataView(data.buffer, data.byteOffset, data.byteLength).setBigUint64(
    offset,
    value,
    true,
  );
}

describe("SPL token bridge", () => {
  test("builds active-ER deposit and withdrawal instructions", () => {
    const portalProgramId = Keypair.generate().publicKey;
    const sdk = new NorthStarSDK({
      portalProgramId,
      customEndpoints: {
        solana: "http://localhost:8899",
        ephemeralRollup: "http://localhost:8910",
      },
    });
    const owner = Keypair.generate().publicKey;
    const sessionBridge = Keypair.generate().publicKey;
    const erTokenAccount = Keypair.generate().publicKey;
    const vault = Keypair.generate().publicKey;
    const sourceTokenAccount = Keypair.generate().publicKey;
    const vaultTokenAccount = Keypair.generate().publicKey;
    const destinationTokenAccount = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const tokenProgram = Keypair.generate().publicKey;

    const deposit = sdk.buildTokenBridgeDepositInstruction({
      owner,
      vault,
      erTokenAccount,
      sessionBridge,
      sourceTokenAccount,
      vaultTokenAccount,
      mint,
      tokenProgram,
      amount: 600n,
      decimals: 6,
    });
    expect(deposit.keys).toHaveLength(12);
    expect(deposit.keys[1].isWritable).toBe(true);
    expect(deposit.keys[9].pubkey.equals(
      sdk.tokenBridge.deriveDepositReceiptPDA(sessionBridge, erTokenAccount),
    )).toBe(true);
    expect(deposit.keys[11].pubkey.equals(SystemProgram.programId)).toBe(true);

    const withdrawal = sdk.buildTokenBridgeStartWithdrawalInstruction({
      owner,
      erTokenAccount,
      sessionBridge,
      destinationTokenAccount,
      tokenProgram,
      amount: 200n,
      decimals: 6,
    });
    expect(withdrawal.keys).toHaveLength(6);
    expect(withdrawal.data[0]).toBe(7);
    expect(withdrawal.keys[4].pubkey.equals(destinationTokenAccount)).toBe(true);
  });

  test("parses cumulative vault deposit and withdrawal totals", () => {
    const sessionBridge = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const vaultTokenAccount = Keypair.generate().publicKey;
    const tokenProgram = Keypair.generate().publicKey;
    const data = new Uint8Array(146);
    data[0] = 1;
    data.set(sessionBridge.toBytes(), 1);
    data.set(mint.toBytes(), 33);
    data.set(vaultTokenAccount.toBytes(), 65);
    data.set(tokenProgram.toBytes(), 97);
    writeU64LE(data, 129, 600n);
    writeU64LE(data, 137, 200n);
    data[145] = 254;

    const vault = TokenBridgeProgram.parseTokenVault(data);
    expect(vault.deposited).toBe(600n);
    expect(vault.withdrawn).toBe(200n);
    expect(vault.bump).toBe(254);
  });
});
