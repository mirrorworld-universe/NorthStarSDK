import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TokenBridgeProgram } from "../src";
import { BRIDGE, PORTAL, SESSION, sdkFixture, u64 } from "./fixtures/continuity";

const key = () => Keypair.generate().publicKey;
const tokenProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

async function tokenFixture() {
  const value = sdkFixture();
  const snapshot = await value.sdk.getSessionSnapshot();
  const mint = key();
  const owner = value.user.publicKey;
  const sessionBridge = await value.sdk.portal.deriveSessionBridgePDA(snapshot.context, mint);
  const erTokenAccount = value.sdk.tokenBridge.deriveErTokenAccountPDA(sessionBridge, owner);
  return {
    ...value, snapshot, mint, owner, sessionBridge, erTokenAccount,
    vault: value.sdk.tokenBridge.deriveVaultPDA(sessionBridge)
  };
}

async function depositFixture() {
  const value = await tokenFixture();
  return {
    ...value, params: {
      session: SESSION, sessionContext: value.snapshot.context, sequence: value.snapshot.nextSequence,
      payer: key(), owner: value.owner, vault: value.vault, erTokenAccount: value.erTokenAccount,
      sessionBridge: value.sessionBridge, sourceTokenAccount: key(), vaultTokenAccount: key(),
      mint: value.mint, tokenProgram, amount: 600n, decimals: 6,
    }
  };
}

describe("authenticated SPL token bridge", () => {
  test("builds custody plus the exact 17-account authenticated input contract", async () => {
    const { sdk, params, snapshot } = await depositFixture();
    const instruction = sdk.buildTokenBridgeDepositInstruction(params);
    expect(instruction.programId.equals(BRIDGE)).toBe(true);
    expect(instruction.data[0]).toBe(2);
    expect(instruction.keys).toHaveLength(17);
    expect(instruction.keys[0]).toEqual({ pubkey: params.payer, isSigner: true, isWritable: true });
    expect(instruction.keys[1]).toEqual({ pubkey: params.owner, isSigner: true, isWritable: false });
    expect(instruction.keys[10].pubkey.equals(sdk.tokenBridge.deriveDepositReceiptPDA(params.sessionBridge, params.erTokenAccount))).toBe(true);
    expect(instruction.keys[12].pubkey.equals(SystemProgram.programId)).toBe(true);
    expect(instruction.keys[14]).toEqual({ pubkey: SESSION, isSigner: false, isWritable: true });
    expect(instruction.keys[15]).toEqual({ pubkey: sdk.tokenBridge.deriveOriginPDA(params.erTokenAccount), isSigner: false, isWritable: false });
    expect(instruction.keys[16]).toEqual({ pubkey: await sdk.portal.deriveIngressRecordPDA(snapshot.context, 3n), isSigner: false, isWritable: true });
  });

  test("rejects changed context, ownership, vault and sequence bindings", async () => {
    const { sdk, params } = await depositFixture();
    expect(() => sdk.buildTokenBridgeDepositInstruction({ ...params, sessionContext: new Uint8Array(32).fill(12) })).toThrow("context");
    expect(() => sdk.buildTokenBridgeDepositInstruction({ ...params, owner: key() })).toThrow("owner");
    expect(() => sdk.buildTokenBridgeDepositInstruction({ ...params, vault: key() })).toThrow("canonical");
    expect(() => sdk.buildTokenBridgeDepositInstruction({ ...params, sequence: 0n })).toThrow("sequence");
  });

  test("separates payer from owner and delegates the program PDA only by CPI", async () => {
    const { sdk, snapshot, owner, mint, sessionBridge, erTokenAccount } = await tokenFixture();
    const payer = key();
    const instruction = sdk.buildDelegateErTokenAccountInstruction({
      payer, owner, mint, sessionBridge, erTokenAccount,
      session: SESSION, sessionContext: snapshot.context, sequence: 3n, gridId: 1n
    });
    expect(instruction.keys).toHaveLength(13);
    expect(instruction.keys[0]).toEqual({ pubkey: payer, isSigner: true, isWritable: true });
    expect(instruction.keys[1]).toEqual({ pubkey: owner, isSigner: true, isWritable: false });
    expect(instruction.keys[2]).toEqual({ pubkey: erTokenAccount, isSigner: false, isWritable: true });
    expect(instruction.keys[3].pubkey.equals(BRIDGE)).toBe(true);
    expect(instruction.keys[6].isWritable).toBe(true);
    expect(instruction.keys[11]).toEqual({ pubkey: sdk.tokenBridge.deriveOriginPDA(erTokenAccount), isSigner: false, isWritable: true });
    expect(instruction.keys[12].pubkey.equals(await sdk.portal.deriveIngressRecordPDA(snapshot.context, 3n))).toBe(true);
  });

  test("includes the canonical mint in seven-account deferred withdrawal", async () => {
    const { sdk, snapshot, owner, mint, sessionBridge, erTokenAccount } = await tokenFixture();
    const destinationTokenAccount = key();
    const instruction = sdk.buildTokenBridgeStartWithdrawalInstruction({
      owner, mint, sessionBridge, erTokenAccount,
      sessionContext: snapshot.context, destinationTokenAccount, tokenProgram, amount: 200n, decimals: 6
    });
    expect(instruction.data[0]).toBe(7);
    expect(instruction.keys).toHaveLength(7);
    expect(instruction.keys[4]).toEqual({ pubkey: destinationTokenAccount, isSigner: false, isWritable: false });
    expect(instruction.keys[6]).toEqual({ pubkey: mint, isSigner: false, isWritable: false });
  });

  test("keeps initialization derived from the same registry", async () => {
    const { sdk, user, owner, sessionBridge, erTokenAccount, vault } = await tokenFixture();
    const initialize = await sdk.buildInitializeTokenVaultInstruction({ payer: user.publicKey, sessionBridge, vaultTokenAccount: key() });
    expect(initialize.keys[1].pubkey.equals(vault)).toBe(true);
    const initializeEr = await sdk.buildInitializeErTokenAccountInstruction({ payer: user.publicKey, sessionBridge, owner });
    expect(initializeEr.keys[1].pubkey.equals(erTokenAccount)).toBe(true);
    expect(initializeEr.keys[3].pubkey.equals(PORTAL)).toBe(true);
  });

  test("does not construct unbound immediate payouts or lifecycle requests", () => {
    const { sdk } = sdkFixture();
    expect(() => sdk.buildTokenBridgeWithdrawInstruction({})).toThrow("no transaction is signed");
    expect(() => sdk.buildRequestErTokenAccountUndelegationInstruction({})).toThrow();
    expect(() => sdk.buildUndelegateErTokenAccountInstruction({})).toThrow();
  });

  test("parses cumulative vault deposit and withdrawal totals", () => {
    const data = new Uint8Array(146);
    data[0] = 1;
    const registry = key();
    data.set(registry.toBytes(), 1);
    data.set(key().toBytes(), 33);
    data.set(key().toBytes(), 65);
    data.set(tokenProgram.toBytes(), 97);
    u64(data, 129, 600n);
    u64(data, 137, 200n);
    data[145] = 254;
    const vault = TokenBridgeProgram.parseTokenVault(data);
    expect(vault.sessionBridge.equals(registry)).toBe(true);
    expect(vault.deposited).toBe(600n);
    expect(vault.withdrawn).toBe(200n);
    expect(vault.bump).toBe(254);
  });
});
