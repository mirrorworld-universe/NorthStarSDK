/**
 * Account Resolver - 2-Tier Read Strategy
 * Implements the fallback chain: Ephemeral Rollup → Solana L1
 */

import { Address } from "@solana/addresses";
import { Rpc, SolanaRpcApi } from "@solana/rpc";
import { AccountInfo } from "../types";
import { EphemeralRollupReader } from "./EphemeralRollupReader";

export class AccountResolver {
  private ephemeralRollupReader: EphemeralRollupReader;
  private solanaRpc: Rpc<SolanaRpcApi>;

  constructor(
    ephemeralRollupReader: EphemeralRollupReader,
    solanaRpc: Rpc<SolanaRpcApi>,
  ) {
    this.ephemeralRollupReader = ephemeralRollupReader;
    this.solanaRpc = solanaRpc;
  }

  /**
   * Resolve account information using 2-tier fallback strategy:
   * Ephemeral Rollup → Solana L1
   *
   * @param address - Account address to resolve
   * @returns Account information with source indicator
   */
  async resolve(address: Address, search_source: "ephemeral" | "solana"): Promise<AccountInfo> {
    if (search_source === "ephemeral") {
      try {
        const account = await this.ephemeralRollupReader.getAccountInfo(address);
        if (account) {
          console.log(`✓ Account resolved from Ephemeral Rollup: ${address}`);
          return account;
        }
      } catch (error) {
        console.warn("Ephemeral Rollup unavailable, using Solana L1:", error);
        throw error;
      }
    } else if (search_source === "solana") {
      try {
        console.log(`→ Fetching from Solana L1: ${address}`);
        const response = await this.solanaRpc
          .getAccountInfo(address, { encoding: "base64" })
          .send();

        if (!response.value) {
          throw new Error(`Account not found: ${address}`);
        }

        const solanaAccount = response.value;

        return {
          address: address,
          data: new Uint8Array(Buffer.from(solanaAccount.data[0], "base64")),
          executable: solanaAccount.executable,
          lamports: solanaAccount.lamports,
          owner: solanaAccount.owner as Address,
          slot: BigInt(response.context.slot),
          source: "solana",
        };
      } catch (error) {
        console.error("All read sources failed:", error);
        throw new Error(`Failed to resolve account ${address} from any source`);
      }
    }

    throw new Error(`Invalid search source: ${search_source}`);
  }
  /**
   * Batch resolve multiple accounts using the fallback strategy
   * @param addresses - Array of account addresses
   * @returns Array of account information
   */
  async resolveMultiple(addresses: Address[], search_source: "ephemeral" | "solana"): Promise<AccountInfo[]> {
    const results: AccountInfo[] = [];

    for (const address of addresses) {
      try {
        const account = await this.resolve(address, search_source);
        results.push(account);
      } catch (error) {
        console.error(`Failed to resolve ${address}:`, error);
        throw error;
      }
    }

    return results;
  }
}
