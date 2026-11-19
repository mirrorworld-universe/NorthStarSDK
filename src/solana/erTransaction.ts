import { Connection, SendTransactionError, VersionedTransaction } from "@solana/web3.js";
import { getVersionedTxSignatureBase58 } from "./kitCompat";

export interface ErTransactionOptions {
  commitment?: "processed" | "confirmed" | "finalized";
  skipPreflight?: boolean;
  maxAttempts?: number;
  intervalMs?: number;
  timeoutMs?: number;
}

export type ErAcknowledgementOptions = Pick<ErTransactionOptions, "maxAttempts" | "intervalMs" | "timeoutMs">;
export type ErTransactionAcknowledgement =
  | { status: "er-confirmed"; signature: string; slot: bigint }
  | { status: "settlement-pending"; signature: string }
  | { status: "unconfirmed"; signature: string };

type ErConnection = Pick<Connection, "sendRawTransaction" | "getSignatureStatuses" | "isBlockhashValid">;
type ErReceipt = { signature: string; slot: bigint };

const settlementPending = "canonical checkpoint awaits settlement; retry after settlement";
const rank = { processed: 0, confirmed: 1, finalized: 2 };
const has = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ER ${name}`);
  return value;
}

function signedIntent(transaction: VersionedTransaction) {
  const wire = Buffer.from(transaction.serialize());
  if (wire.length > 1232 || transaction.signatures[0]?.length !== 64 || !transaction.signatures[0].some(byte => byte !== 0)) {
    throw new Error("ER transaction must be signed and fit one packet");
  }
  return { wire, signature: getVersionedTxSignatureBase58(transaction), blockhash: transaction.message.recentBlockhash };
}

class ErConfirmationTimeout extends Error {
  constructor(signature: string) {
    super(`ER transaction confirmation timeout; original signed intent retained: ${signature}`);
  }
}

function confirmationBudget(signature: string, timeout: number) {
  const end = performance.now() + timeout;
  const remaining = () => {
    const left = end - performance.now();
    if (left <= 0) throw new ErConfirmationTimeout(signature);
    return Math.ceil(left);
  };
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    const left = remaining();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ErConfirmationTimeout(signature)), left);
      });
      const result = await Promise.race([deadline, operation()]);
      remaining();
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const delay = async (interval: number) => new Promise<void>(resolve => setTimeout(resolve, Math.min(remaining(), interval)));
  return { run, delay };
}

async function getReceipt(connection: ErConnection, signature: string) {
  const response = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
  if (!Array.isArray(response?.value) || response.value.length !== 1) throw new Error("Invalid ER signature status response");
  const receipt = response.value[0];
  if (receipt === null) return null;
  if (!receipt || !has(receipt, "err") || !Number.isSafeInteger(receipt.slot) || receipt.slot < 0 ||
      !receipt.confirmationStatus || !has(rank, receipt.confirmationStatus)) {
    throw new Error("Invalid ER transaction receipt");
  }
  if (receipt.err !== null) throw new Error(`ER transaction rejected: ${JSON.stringify(receipt.err)}`);
  return { slot: BigInt(receipt.slot), rank: rank[receipt.confirmationStatus] };
}

async function checkBlockhash(connection: ErConnection, { blockhash, signature }: ReturnType<typeof signedIntent>): Promise<void> {
  const valid = await connection.isBlockhashValid(blockhash, { commitment: "confirmed" });
  if (typeof valid?.value !== "boolean") throw new Error("Invalid ER blockhash validity response");
  if (!valid.value) throw new Error(`ER transaction expired without a receipt; no replacement created: ${signature}`);
}

async function sendSaved(
  connection: ErConnection, { wire, signature }: ReturnType<typeof signedIntent>,
  commitment: keyof typeof rank, skipPreflight: boolean,
): Promise<boolean> {
  try {
    const submitted = await connection.sendRawTransaction(Buffer.from(wire), {
      skipPreflight, preflightCommitment: commitment, maxRetries: 0,
    });
    if (submitted !== signature) throw new Error("Submitted ER transaction signature differs");
    return true;
  } catch (error) {
    // web3.js keeps the submission signature in a TypeScript-private runtime field.
    if (!(error instanceof SendTransactionError) || Reflect.get(error, "signature") !== "" || error.transactionError.message !== settlementPending) throw error;
    return false;
  }
}

export async function submitErTransaction(
  connection: ErConnection,
  transaction: VersionedTransaction,
  checkSession: () => Promise<void>,
  options: ErTransactionOptions = {},
): Promise<ErReceipt> {
  const attempts = boundedInteger(options.maxAttempts ?? 600, 1, 10_000, "attempt budget");
  const interval = boundedInteger(options.intervalMs ?? 500, 1, 60_000, "poll interval");
  const timeout = boundedInteger(options.timeoutMs ?? 300_000, 1, 3_600_000, "timeout");
  const commitment = options.commitment ?? "confirmed";
  if (!has(rank, commitment) || options.skipPreflight !== undefined && typeof options.skipPreflight !== "boolean") {
    throw new Error("Invalid ER transaction options");
  }
  const intent = signedIntent(transaction);
  const { signature } = intent;
  const budget = confirmationBudget(signature, timeout);
  let observed = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await budget.run(checkSession);
    const receipt = await budget.run(() => getReceipt(connection, signature));
    if (receipt !== null) {
      observed = true;
      if (receipt.rank >= rank[commitment]) return { signature, slot: receipt.slot };
    } else if (!observed) {
      await budget.run(() => checkBlockhash(connection, intent));
      await budget.run(() => sendSaved(connection, intent, commitment, options.skipPreflight ?? false));
    }
    if (attempt + 1 < attempts) await budget.delay(interval);
  }
  throw new ErConfirmationTimeout(signature);
}

export async function acknowledgeErTransaction(
  connection: ErConnection,
  transaction: VersionedTransaction,
  checkBeforeSend: () => Promise<void>,
  checkBeforeAcknowledgement: () => Promise<void>,
  options: ErAcknowledgementOptions = {},
): Promise<ErTransactionAcknowledgement> {
  const attempts = boundedInteger(options.maxAttempts ?? 28, 1, 600, "attempt budget");
  const interval = boundedInteger(options.intervalMs ?? 100, 50, 60_000, "poll interval");
  const timeout = boundedInteger(options.timeoutMs ?? 2800, 1, 60_000, "timeout");
  const intent = signedIntent(transaction);
  const { signature } = intent;
  const budget = confirmationBudget(signature, timeout);
  const read = () => budget.run(() => getReceipt(connection, signature));
  const acknowledge = async (slot: bigint): Promise<ErTransactionAcknowledgement> => {
    await budget.run(checkBeforeAcknowledgement);
    return { status: "er-confirmed", signature, slot };
  };
  let observeOnly = false;
  let refusedForSettlement = false;
  try {
    await budget.run(checkBeforeSend);
    for (let attempt = 0; attempt < attempts; attempt++) {
      let receipt = await read();
      if (receipt !== null) {
        observeOnly = true;
        refusedForSettlement = false;
        if (receipt.rank >= rank.confirmed) return await acknowledge(receipt.slot);
      } else if (!observeOnly) {
        if (attempt > 0) await budget.run(checkBeforeSend);
        await budget.run(() => checkBlockhash(connection, intent));
        // An in-flight send at the deadline has an unknown outcome, even after a previous refusal.
        refusedForSettlement = false;
        if (await budget.run(() => sendSaved(connection, intent, "confirmed", false))) {
          // After the node accepts the wire, a missing receipt is not permission to send again.
          observeOnly = true;
          receipt = await read();
          if (receipt !== null && receipt.rank >= rank.confirmed) return await acknowledge(receipt.slot);
        } else {
          refusedForSettlement = true;
        }
      }
      if (attempt + 1 < attempts) await budget.delay(refusedForSettlement ? Math.max(interval, 300) : interval);
    }
  } catch (error) {
    if (!(error instanceof ErConfirmationTimeout)) throw error;
  }
  return { status: refusedForSettlement ? "settlement-pending" : "unconfirmed", signature };
}
