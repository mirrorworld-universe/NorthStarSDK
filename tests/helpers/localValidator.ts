import {
  Address,
  TransactionSigner,
  address,
  appendTransactionMessageInstructions,
  assertIsSendableTransaction,
  assertIsTransactionWithBlockhashLifetime,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { PortalProgram } from "../../src";

export const L1_RPC_URL = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
export const L1_WS_URL = process.env.SOLANA_WS_URL ?? "ws://127.0.0.1:8900";
export const ER_RPC_URL = process.env.ER_RPC_URL ?? "http://127.0.0.1:8910";
export const ER_WS_URL = process.env.ER_WS_URL ?? "ws://127.0.0.1:8911";

export const PORTAL_PROGRAM_ID = address(
  process.env.PORTAL_PROGRAM_ID ?? "5TeWSsjg2gbxCyWVniXeCmwM7UtHTCK7svzJr5xYJzHf",
);
export const SYSTEM_PROGRAM_ID = address("11111111111111111111111111111111");

export type TestRpc = ReturnType<typeof createSolanaRpc>;
export type TestSubscriptions = ReturnType<typeof createSolanaRpcSubscriptions>;

export function createClients(rpcUrl = L1_RPC_URL, wsUrl = L1_WS_URL) {
  const rpc = createSolanaRpc(rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
  const sendAndConfirmTransaction = sendAndConfirmTransactionFactory({
    rpc,
    rpcSubscriptions,
  });
  return { rpc, rpcSubscriptions, sendAndConfirmTransaction };
}

export async function rpcRequest<T = unknown>(
  url: string,
  method: string,
  params?: unknown,
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await response.json()) as any;
  if (json.error) throw new Error(`${method} failed: ${JSON.stringify(json.error)}`);
  return json.result as T;
}

export async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs = 15_000,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      lastValue = await fn();
      if (predicate(lastValue)) return lastValue;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Timed out waiting for ${label}` +
      (lastError ? `; last error: ${String(lastError)}` : ""),
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function expectValidatorReady(): Promise<void> {
  await waitFor(
    () => rpcRequest<string>(L1_RPC_URL, "getHealth"),
    (health) => health === "ok",
    "L1 getHealth=ok",
  );
  await waitFor(
    () => rpcRequest<string>(ER_RPC_URL, "getHealth"),
    (health) => health === "ok",
    "ER getHealth=ok",
  );
}

export async function fundedSigner(
  rpc: TestRpc,
  lamports = 5_000_000_000,
): Promise<TransactionSigner> {
  const signer = await generateKeyPairSigner();
  await (rpc as any).requestAirdrop(signer.address, lamports).send();
  await waitForBalance(rpc, signer.address, BigInt(lamports));
  return signer;
}

export async function waitForBalance(
  rpc: TestRpc,
  owner: Address,
  atLeast: bigint,
): Promise<bigint> {
  return waitFor(
    async () => BigInt(((await (rpc as any).getBalance(owner).send()).value ?? 0n) as bigint),
    (balance) => balance >= atLeast,
    `balance(${owner}) >= ${atLeast}`,
  );
}

export async function sendInstructions(
  rpc: TestRpc,
  rpcSubscriptions: TestSubscriptions,
  feePayer: TransactionSigner,
  instructions: any[],
  config: Record<string, unknown> = { commitment: "confirmed", skipPreflight: true },
): Promise<string> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(feePayer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  assertIsSendableTransaction(transaction);
  assertIsTransactionWithBlockhashLifetime(transaction);
  const signature = getSignatureFromTransaction(transaction);
  const wireTransaction = getBase64EncodedWireTransaction(transaction);
  await (rpc as any)
    .sendTransaction(wireTransaction, { encoding: "base64", ...config })
    .send();
  await waitFor(
    async () => (await (rpc as any).getSignatureStatuses([signature]).send()).value[0],
    (status) => status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized",
    `confirmation for ${signature}`,
    20_000,
  );
  return signature;
}

export async function deriveSessionPda(owner: Address, gridId: number): Promise<Address> {
  return PortalProgram.deriveSessionPDA(owner, gridId, PORTAL_PROGRAM_ID);
}

export async function deriveFeeVaultPda(owner: Address): Promise<Address> {
  return PortalProgram.deriveFeeVaultPDA(owner, PORTAL_PROGRAM_ID);
}

export async function deriveDelegationRecordPda(delegatedAccount: Address): Promise<Address> {
  return PortalProgram.deriveDelegationRecordPDA(delegatedAccount, PORTAL_PROGRAM_ID);
}

export async function deriveDepositReceiptPda(
  session: Address,
  recipient: Address,
): Promise<Address> {
  return PortalProgram.deriveDepositReceiptPDA(session, recipient, PORTAL_PROGRAM_ID);
}

export function openSessionIx(
  owner: TransactionSigner,
  sessionPda: Address,
  feeVaultPda: Address,
  gridId: number,
  ttlSlots: bigint,
  feeCap: bigint,
) {
  return {
    version: 0 as const,
    programAddress: PORTAL_PROGRAM_ID,
    accounts: [
      { address: owner.address, role: 1 as const },
      { address: sessionPda, role: 1 as const },
      { address: feeVaultPda, role: 1 as const },
      { address: SYSTEM_PROGRAM_ID, role: 0 as const },
    ],
    data: PortalProgram.encodeOpenSession({ gridId, ttlSlots, feeCap }),
  };
}

export function closeSessionIx(
  owner: TransactionSigner,
  sessionPda: Address,
  feeVaultPda: Address,
  gridId: number,
) {
  return {
    version: 0 as const,
    programAddress: PORTAL_PROGRAM_ID,
    accounts: [
      { address: owner.address, role: 1 as const },
      { address: sessionPda, role: 1 as const },
      { address: feeVaultPda, role: 1 as const },
      { address: SYSTEM_PROGRAM_ID, role: 0 as const },
    ],
    data: PortalProgram.encodeCloseSession({ gridId }),
  };
}

export function depositFeeIx(
  depositor: TransactionSigner,
  sessionPda: Address,
  depositReceiptPda: Address,
  recipient: Address,
  lamports: bigint,
) {
  return {
    version: 0 as const,
    programAddress: PORTAL_PROGRAM_ID,
    accounts: [
      { address: depositor.address, role: 1 as const },
      { address: sessionPda, role: 0 as const },
      { address: depositReceiptPda, role: 1 as const },
      { address: recipient, role: 0 as const },
      { address: SYSTEM_PROGRAM_ID, role: 0 as const },
    ],
    data: PortalProgram.encodeDepositFee({ lamports }),
  };
}

export function assignIx(accountSigner: TransactionSigner, newOwner: Address) {
  return {
    version: 0 as const,
    programAddress: SYSTEM_PROGRAM_ID,
    accounts: [{ address: accountSigner.address, role: 3 as const, signer: accountSigner }],
    data: encodeAssignInstruction(newOwner),
  };
}

export function delegateIx(
  payer: TransactionSigner,
  delegatedAccount: TransactionSigner,
  ownerProgram: Address,
  delegationRecordPda: Address,
  buffer: Address,
  gridId: number,
) {
  return {
    version: 0 as const,
    programAddress: PORTAL_PROGRAM_ID,
    accounts: [
      { address: payer.address, role: 1 as const },
      { address: delegatedAccount.address, role: 3 as const, signer: delegatedAccount },
      { address: ownerProgram, role: 0 as const },
      { address: delegationRecordPda, role: 1 as const },
      { address: SYSTEM_PROGRAM_ID, role: 0 as const },
      { address: buffer, role: 0 as const },
    ],
    data: PortalProgram.encodeDelegate({ gridId }),
  };
}

export function undelegateIx(
  authority: TransactionSigner,
  delegatedAccount: Address,
  ownerProgram: Address,
  delegationRecordPda: Address,
) {
  return {
    version: 0 as const,
    programAddress: PORTAL_PROGRAM_ID,
    accounts: [
      { address: authority.address, role: 1 as const },
      { address: delegatedAccount, role: 1 as const },
      { address: ownerProgram, role: 0 as const },
      { address: delegationRecordPda, role: 1 as const },
      { address: SYSTEM_PROGRAM_ID, role: 0 as const },
    ],
    data: PortalProgram.encodeUndelegate(),
  };
}

export function transferIx(from: TransactionSigner, to: Address, lamports: bigint) {
  return {
    version: 0 as const,
    programAddress: SYSTEM_PROGRAM_ID,
    accounts: [
      { address: from.address, role: 1 as const },
      { address: to, role: 1 as const },
    ],
    data: encodeTransferInstruction(lamports),
  };
}

export function readU64LE(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 0; i < 8; i++) value |= BigInt(bytes[offset + i]) << BigInt(8 * i);
  return value;
}

export function accountData(accountInfo: any): Uint8Array {
  const data = accountInfo?.value?.data;
  if (!Array.isArray(data)) throw new Error(`missing base64 account data: ${JSON.stringify(accountInfo)}`);
  return new Uint8Array(Buffer.from(data[0], "base64"));
}

function encodeAssignInstruction(newOwner: Address): Uint8Array {
  const ownerBytes = getAddressEncoder().encode(newOwner);
  const data = new Uint8Array(4 + 32);
  data[0] = 1;
  data.set(ownerBytes, 4);
  return data;
}

function encodeTransferInstruction(lamports: bigint): Uint8Array {
  const data = new Uint8Array(12);
  data[0] = 2;
  for (let i = 0; i < 8; i++) data[4 + i] = Number((lamports >> BigInt(8 * i)) & 0xffn);
  return data;
}

export async function uniqueGridId(): Promise<number> {
  return Math.floor(Math.random() * 900_000) + 10_000;
}
