import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
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
    const payer = Keypair.generate().publicKey;
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
      payer,
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
    expect(deposit.keys).toHaveLength(13);
    expect(deposit.keys[0]).toMatchObject({
      pubkey: payer,
      isSigner: true,
      isWritable: true,
    });
    expect(deposit.keys[1]).toMatchObject({
      pubkey: owner,
      isSigner: true,
      isWritable: false,
    });
    expect(deposit.keys[2].isWritable).toBe(true);
    expect(
      deposit.keys[10].pubkey.equals(
        sdk.tokenBridge.deriveDepositReceiptPDA(sessionBridge, erTokenAccount),
      ),
    ).toBe(true);
    expect(deposit.keys[12].pubkey.equals(SystemProgram.programId)).toBe(true);

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

  test("separates ER token delegation payer from owner", () => {
    const portalProgramId = Keypair.generate().publicKey;
    const sdk = new NorthStarSDK({
      portalProgramId,
      customEndpoints: {
        solana: "http://localhost:8899",
        ephemeralRollup: "http://localhost:8910",
      },
    });
    const payer = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    const erTokenAccount = Keypair.generate().publicKey;
    const sessionBridge = Keypair.generate().publicKey;
    const session = Keypair.generate().publicKey;

    const instruction = sdk.buildDelegateErTokenAccountInstruction({
      payer,
      owner,
      erTokenAccount,
      sessionBridge,
      session,
      gridId: 1n,
    });

    expect(instruction.keys).toHaveLength(10);
    expect(instruction.keys[0]).toMatchObject({
      pubkey: payer,
      isSigner: true,
      isWritable: true,
    });
    expect(instruction.keys[1]).toMatchObject({
      pubkey: owner,
      isSigner: true,
      isWritable: false,
    });
    expect(instruction.keys[2].pubkey.equals(erTokenAccount)).toBe(true);
  });

  test("builds token-account request and final undelegation instructions", () => {
    const portalProgramId = Keypair.generate().publicKey;
    const sdk = new NorthStarSDK({
      portalProgramId,
      customEndpoints: {
        solana: "http://localhost:8899",
        ephemeralRollup: "http://localhost:8910",
      },
    });
    const payer = Keypair.generate().publicKey;
    const authority = Keypair.generate().publicKey;
    const erTokenAccount = Keypair.generate().publicKey;
    const session = Keypair.generate().publicKey;
    const requestPDA = PublicKey.findProgramAddressSync(
      [Buffer.from("undelegation_request"), erTokenAccount.toBuffer()],
      portalProgramId,
    )[0];

    const request = sdk.buildRequestErTokenAccountUndelegationInstruction({
      payer,
      authority,
      erTokenAccount,
      session,
    });
    expect(request.data[0]).toBe(9);
    expect(request.keys).toHaveLength(9);
    expect(request.keys[0]).toMatchObject({
      pubkey: payer,
      isSigner: true,
      isWritable: true,
    });
    expect(request.keys[1]).toMatchObject({
      pubkey: authority,
      isSigner: true,
      isWritable: false,
    });
    expect(request.keys[7].pubkey.equals(requestPDA)).toBe(true);

    const undelegate = sdk.buildUndelegateErTokenAccountInstruction({
      authority,
      erTokenAccount,
      session,
    });
    expect(undelegate.keys).toHaveLength(9);
    expect(undelegate.keys[8].pubkey.equals(requestPDA)).toBe(true);
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
