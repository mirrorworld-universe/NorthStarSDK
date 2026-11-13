import { Connection, SendTransactionError, VersionedTransaction } from "@solana/web3.js";
import { getVersionedTxSignatureBase58 } from "./kitCompat";

export interface ErTransactionOptions {
  commitment?: "processed" | "confirmed" | "finalized";
  skipPreflight?: boolean;
  maxAttempts?: number;
  intervalMs?: number;
  timeoutMs?: number;
}

type ErConnection = Pick<Connection, "sendRawTransaction" | "getSignatureStatuses" | "isBlockhashValid">;

const settlementPending = "canonical checkpoint awaits settlement; retry after settlement";
const rank = { processed: 0, confirmed: 1, finalized: 2 };
const has = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ER ${name}`);
  return value;
}

export async function submitErTransaction(
  connection: ErConnection,
  transaction: VersionedTransaction,
  checkSession: () => Promise<void>,
  options: ErTransactionOptions = {},
): Promise<{ signature: string; slot: bigint }> {
  const attempts = boundedInteger(options.maxAttempts ?? 600, 1, 10_000, "attempt budget");
  const interval = boundedInteger(options.intervalMs ?? 500, 1, 60_000, "poll interval");
  const timeout = boundedInteger(options.timeoutMs ?? 300_000, 1, 3_600_000, "timeout");
  const commitment = options.commitment ?? "confirmed";
  if (!has(rank, commitment) || options.skipPreflight !== undefined && typeof options.skipPreflight !== "boolean") {
    throw new Error("Invalid ER transaction options");
  }
  const wire = Buffer.from(transaction.serialize());
  if (wire.length > 1232 || transaction.signatures[0]?.length !== 64 || !transaction.signatures[0].some(byte => byte !== 0)) {
    throw new Error("ER transaction must be signed and fit one packet");
  }
  const signature = getVersionedTxSignatureBase58(transaction);
  const blockhash = transaction.message.recentBlockhash;
  const end = performance.now() + timeout;
  const timedOut = () => new Error(`ER transaction confirmation timeout; original signed intent retained: ${signature}`);
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    const remaining = end - performance.now();
    if (remaining <= 0) throw timedOut();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timedOut()), Math.ceil(remaining)); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  let observed = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await bounded(checkSession);
    const response = await bounded(() => connection.getSignatureStatuses([signature], { searchTransactionHistory: true }));
    if (!Array.isArray(response?.value) || response.value.length !== 1) throw new Error("Invalid ER signature status response");
    const receipt = response.value[0];
    if (receipt !== null) {
      if (!receipt || !has(receipt, "err") || !Number.isSafeInteger(receipt.slot) || receipt.slot < 0 ||
          !receipt.confirmationStatus || !has(rank, receipt.confirmationStatus)) {
        throw new Error("Invalid ER transaction receipt");
      }
      observed = true;
      if (receipt.err !== null) throw new Error(`ER transaction rejected: ${JSON.stringify(receipt.err)}`);
      if (rank[receipt.confirmationStatus] >= rank[commitment]) return { signature, slot: BigInt(receipt.slot) };
    } else if (!observed) {
      const valid = await bounded(() => connection.isBlockhashValid(blockhash, { commitment: "confirmed" }));
      if (typeof valid?.value !== "boolean") throw new Error("Invalid ER blockhash validity response");
      if (!valid.value) throw new Error(`ER transaction expired without a receipt; no replacement created: ${signature}`);
      try {
        const submitted = await bounded(() => connection.sendRawTransaction(Buffer.from(wire), {
          skipPreflight: options.skipPreflight ?? false, preflightCommitment: commitment, maxRetries: 0,
        }));
        if (submitted !== signature) throw new Error("Submitted ER transaction signature differs");
      } catch (error) {
        // web3.js keeps the submission signature in a TypeScript-private runtime field.
        if (!(error instanceof SendTransactionError) || Reflect.get(error, "signature") !== "" || error.transactionError.message !== settlementPending) throw error;
      }
    }
    if (attempt + 1 < attempts) await bounded(() => new Promise(resolve => setTimeout(resolve, interval)));
  }
  throw timedOut();
}
