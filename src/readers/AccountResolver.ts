/**
 * Account Resolver - 2-Tier Read Strategy
 * Implements the fallback chain: Ephemeral Rollup → Solana L1
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { AccountInfo } from "../types";
import { EphemeralRollupReader } from "./EphemeralRollupReader";

export class AccountResolver {
  private ephemeralRollupReader: EphemeralRollupReader;
  private connection: Connection;

  constructor(
    ephemeralRollupReader: EphemeralRollupReader,
    connection: Connection,
  ) {
    this.ephemeralRollupReader = ephemeralRollupReader;
    this.connection = connection;
  }

  /**
   * Resolve account information using 2-tier fallback strategy:
   * Ephemeral Rollup → Solana L1
   *
   * @param address - Account address to resolve
   * @returns Account information with source indicator
   */
  async resolve(
    address: PublicKey,
    search_source: "ephemeral" | "solana",
  ): Promise<AccountInfo> {
    if (search_source === "ephemeral") {
      try {
        const account = await this.ephemeralRollupReader.getAccountInfo(address);
        if (account) {
          console.log(`✓ Account resolved from Ephemeral Rollup: ${address.toBase58()}`);
          return account;
        }
      } catch (error) {
        console.warn("Ephemeral Rollup unavailable, using Solana L1:", error);
        throw error;
      }
    } else if (search_source === "solana") {
      try {
        console.log(`→ Fetching from Solana L1: ${address.toBase58()}`);
        const response = await this.connection.getAccountInfo(address);

        if (!response) {
          throw new Error(`Account not found: ${address.toBase58()}`);
        }

        const solanaAccount = response;
        const slot = await this.connection.getSlot();

        return {
          address,
          data: new Uint8Array(solanaAccount.data),
          executable: solanaAccount.executable,
          lamports: BigInt(solanaAccount.lamports),
          owner: solanaAccount.owner,
          slot: BigInt(slot),
          source: "solana",
        };
      } catch (error) {
        console.error("All read sources failed:", error);
        throw new Error(`Failed to resolve account ${address.toBase58()} from any source`);
      }
    }

    throw new Error(`Invalid search source: ${search_source}`);
  }
  /**
   * Batch resolve multiple accounts using the fallback strategy
   * @param addresses - Array of account addresses
   * @returns Array of account information
   */
  async resolveMultiple(
    addresses: PublicKey[],
    search_source: "ephemeral" | "solana",
  ): Promise<AccountInfo[]> {
    const results: AccountInfo[] = [];

    for (const address of addresses) {
      try {
        const account = await this.resolve(address, search_source);
        results.push(account);
      } catch (error) {
        console.error(`Failed to resolve ${address.toBase58()}:`, error);
        throw error;
      }
    }

    return results;
  }
}
