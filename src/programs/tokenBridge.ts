import { PublicKey } from "@solana/web3.js";
import { readU64LE, toU64LE } from "../utils/common";

export const TOKEN_BRIDGE_PROGRAM_ID = new PublicKey(
  "HeVLVaSa9WnFai9aTRJ3UR2c4jwbMe5nbjagmDP1GbXR",
);

export interface TokenVault {
  discriminator: number;
  sessionBridge: PublicKey;
  mint: PublicKey;
  vaultTokenAccount: PublicKey;
  tokenProgram: PublicKey;
  deposited: bigint;
  withdrawn: bigint;
  bump: number;
}

export interface ErTokenAccount {
  discriminator: number;
  sessionBridge: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  amount: bigint;
  bump: number;
}

export const TOKEN_VAULT_DISCRIMINATOR = 1;
export const ER_TOKEN_ACCOUNT_DISCRIMINATOR = 2;
export const TOKEN_VAULT_LEN = 146;
export const ER_TOKEN_ACCOUNT_LEN = 106;

function assertAccountDataLength(
  data: Uint8Array,
  expected: number,
  accountName: string,
) {
  if (data.length < expected) {
    throw new Error(
      `Invalid ${accountName} data length: got ${data.length}, expected >= ${expected}`,
    );
  }
}

function u8(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

export class TokenBridgeProgram {
  readonly programId: PublicKey;

  constructor(programId: PublicKey = TOKEN_BRIDGE_PROGRAM_ID) {
    this.programId = programId;
  }

  deriveVaultPDA(sessionBridge: PublicKey): PublicKey {
    return TokenBridgeProgram.deriveVaultPDA(sessionBridge, this.programId);
  }

  deriveErTokenAccountPDA(sessionBridge: PublicKey, owner: PublicKey): PublicKey {
    return TokenBridgeProgram.deriveErTokenAccountPDA(
      sessionBridge,
      owner,
      this.programId,
    );
  }

  deriveDepositReceiptPDA(
    sessionBridge: PublicKey,
    erTokenAccount: PublicKey,
  ): PublicKey {
    return TokenBridgeProgram.deriveDepositReceiptPDA(
      sessionBridge,
      erTokenAccount,
      this.programId,
    );
  }

  deriveBufferPDA(erTokenAccount: PublicKey): PublicKey {
    return TokenBridgeProgram.deriveBufferPDA(erTokenAccount, this.programId);
  }

  encodeInitializeVault(): Uint8Array {
    return TokenBridgeProgram.encodeInitializeVault();
  }

  encodeInitializeErTokenAccount(owner: PublicKey): Uint8Array {
    return TokenBridgeProgram.encodeInitializeErTokenAccount(owner);
  }

  encodeDeposit(amount: number | bigint, decimals: number): Uint8Array {
    return TokenBridgeProgram.encodeDeposit(amount, decimals);
  }

  encodeTransfer(amount: number | bigint): Uint8Array {
    return TokenBridgeProgram.encodeTransfer(amount);
  }

  encodeWithdraw(amount: number | bigint, decimals: number): Uint8Array {
    return TokenBridgeProgram.encodeWithdraw(amount, decimals);
  }

  encodeStartWithdrawal(amount: number | bigint, decimals: number): Uint8Array {
    return TokenBridgeProgram.encodeStartWithdrawal(amount, decimals);
  }

  encodeDelegateErTokenAccount(gridId: number | bigint): Uint8Array {
    return TokenBridgeProgram.encodeDelegateErTokenAccount(gridId);
  }

  encodeUndelegateErTokenAccount(): Uint8Array {
    return TokenBridgeProgram.encodeUndelegateErTokenAccount();
  }

  parseTokenVault(data: Uint8Array): TokenVault {
    return TokenBridgeProgram.parseTokenVault(data);
  }

  parseErTokenAccount(data: Uint8Array): ErTokenAccount {
    return TokenBridgeProgram.parseErTokenAccount(data);
  }

  static deriveVaultPDA(
    sessionBridge: PublicKey,
    programId: PublicKey = TOKEN_BRIDGE_PROGRAM_ID,
  ): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), sessionBridge.toBuffer()],
      programId,
    );
    return pda;
  }

  static deriveErTokenAccountPDA(
    sessionBridge: PublicKey,
    owner: PublicKey,
    programId: PublicKey = TOKEN_BRIDGE_PROGRAM_ID,
  ): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("er_token"), sessionBridge.toBuffer(), owner.toBuffer()],
      programId,
    );
    return pda;
  }

  static deriveDepositReceiptPDA(
    sessionBridge: PublicKey,
    erTokenAccount: PublicKey,
    programId: PublicKey = TOKEN_BRIDGE_PROGRAM_ID,
  ): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("token_deposit"),
        sessionBridge.toBuffer(),
        erTokenAccount.toBuffer(),
      ],
      programId,
    );
    return pda;
  }

  static deriveBufferPDA(
    erTokenAccount: PublicKey,
    programId: PublicKey = TOKEN_BRIDGE_PROGRAM_ID,
  ): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("northstar-token-buffer"), erTokenAccount.toBuffer()],
      programId,
    );
    return pda;
  }

  static encodeInitializeVault(): Uint8Array {
    return u8(0);
  }

  static encodeInitializeErTokenAccount(owner: PublicKey): Uint8Array {
    const data = new Uint8Array(1 + 32);
    data[0] = 1;
    data.set(owner.toBytes(), 1);
    return data;
  }

  static encodeDeposit(amount: number | bigint, decimals: number): Uint8Array {
    const data = new Uint8Array(1 + 8 + 1);
    data[0] = 2;
    data.set(toU64LE(amount), 1);
    data[9] = decimals;
    return data;
  }

  static encodeTransfer(amount: number | bigint): Uint8Array {
    const data = new Uint8Array(1 + 8);
    data[0] = 3;
    data.set(toU64LE(amount), 1);
    return data;
  }

  static encodeWithdraw(amount: number | bigint, decimals: number): Uint8Array {
    const data = new Uint8Array(1 + 8 + 1);
    data[0] = 4;
    data.set(toU64LE(amount), 1);
    data[9] = decimals;
    return data;
  }

  static encodeStartWithdrawal(
    amount: number | bigint,
    decimals: number,
  ): Uint8Array {
    const data = new Uint8Array(1 + 8 + 1);
    data[0] = 7;
    data.set(toU64LE(amount), 1);
    data[9] = decimals;
    return data;
  }

  static encodeDelegateErTokenAccount(gridId: number | bigint): Uint8Array {
    const data = new Uint8Array(1 + 8);
    data[0] = 5;
    data.set(toU64LE(gridId), 1);
    return data;
  }

  static encodeUndelegateErTokenAccount(): Uint8Array {
    return u8(6);
  }

  static parseTokenVault(data: Uint8Array): TokenVault {
    assertAccountDataLength(data, TOKEN_VAULT_LEN, "TokenVault");
    return {
      discriminator: data[0],
      sessionBridge: new PublicKey(data.slice(1, 33)),
      mint: new PublicKey(data.slice(33, 65)),
      vaultTokenAccount: new PublicKey(data.slice(65, 97)),
      tokenProgram: new PublicKey(data.slice(97, 129)),
      deposited: readU64LE(data, 129),
      withdrawn: readU64LE(data, 137),
      bump: data[145],
    };
  }

  static parseErTokenAccount(data: Uint8Array): ErTokenAccount {
    assertAccountDataLength(data, ER_TOKEN_ACCOUNT_LEN, "ErTokenAccount");
    return {
      discriminator: data[0],
      sessionBridge: new PublicKey(data.slice(1, 33)),
      owner: new PublicKey(data.slice(33, 65)),
      mint: new PublicKey(data.slice(65, 97)),
      amount: readU64LE(data, 97),
      bump: data[105],
    };
  }
}
