/**
 * Ephemeral Rollup Account Reader
 * Handles reading account data from Ephemeral Rollup RPC
 */

import { PublicKey } from "@solana/web3.js";
import { checkedInteger } from "../programs/continuity";
import axios, { AxiosInstance } from "axios";
import {
  AccountInfo,
  EphemeralRollupAccountResponse,
  NorthStarSyncStatus,
  NorthStarSyncStatusResponse,
} from "../types";

export class EphemeralRollupReader {
  private client: AxiosInstance;
  private rpcUrl: string;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
    this.client = axios.create({
      baseURL: rpcUrl,
      timeout: 10000,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  /**
   * Get account information from Ephemeral Rollup RPC
   * @param address - Account address
   * @returns Account information or null if not found
   */
  async getAccountInfo(address: PublicKey): Promise<AccountInfo | null> {
    try {
      const response = await this.client.post<EphemeralRollupAccountResponse>(
        "",
        {
          jsonrpc: "2.0",
          id: 1,
          method: "getAccountInfo",
          params: [
            address.toBase58(),
            {
              encoding: "base64",
            },
          ],
        },
      );

      if (!response.data.result || !response.data.result.value) {
        return null;
      }

      const result = response.data.result.value;

      return {
        address,
        data: new Uint8Array(Buffer.from(result.data[0], "base64")),
        executable: result.executable,
        lamports: BigInt(result.lamports),
        owner: new PublicKey(result.owner),
        slot: BigInt(response.data.result.context.slot),
        source: "ephemeral-rollup",
      };
    } catch (error) {
      console.error("Error fetching from Ephemeral Rollup:", error);
      return null;
    }
  }

  /**
   * Get multiple account information in batch
   * @param addresses - Array of account addresses
   * @returns Array of account information (null for not found)
   */
  async getMultipleAccounts(
    addresses: PublicKey[],
  ): Promise<(AccountInfo | null)[]> {
    try {
      const response = await this.client.post("", {
        jsonrpc: "2.0",
        id: 1,
        method: "getMultipleAccounts",
        params: [
          addresses.map((a) => a.toBase58()),
          {
            encoding: "base64",
          },
        ],
      });

      if (!response.data.result || !response.data.result.value) {
        return addresses.map(() => null);
      }

      return response.data.result.value.map(
        (account: any, index: number): AccountInfo | null => {
          if (!account) return null;

          return {
            address: addresses[index],
            data: new Uint8Array(Buffer.from(account.data[0], "base64")),
            executable: account.executable,
            lamports: BigInt(account.lamports),
            owner: new PublicKey(account.owner),
            slot: BigInt(response.data.result.context.slot),
            source: "ephemeral-rollup",
          };
        },
      );
    } catch (error) {
      console.error(
        "Error fetching multiple accounts from Ephemeral Rollup:",
        error,
      );
      return addresses.map(() => null);
    }
  }

  /**
   * Read NorthStar L1 sync status from the ER RPC.
   */
  async getSyncStatus(): Promise<NorthStarSyncStatus> {
    const response = await this.client.post<NorthStarSyncStatusResponse>("", {
      jsonrpc: "2.0",
      id: 1,
      method: "northstarSysGetSyncStatus",
    });

    const result = response.data.result;
    if (!result || typeof result.isSyncing !== "boolean" ||
      (result.checkpointError != null && typeof result.checkpointError !== "string")) {
      throw new Error("Malformed Northstar sync status");
    }
    const slot = (value: number | string): bigint => {
      if (typeof value === "string") {
        if (!/^(0|[1-9][0-9]{0,19})$/.test(value)) throw new Error("Malformed sync slot");
        return checkedInteger(BigInt(value), 64, "sync slot");
      }
      return checkedInteger(value, 64, "sync slot");
    };
    return {
      isSyncing: result.isSyncing,
      latestSyncedSlot: slot(result.latestSyncedSlot),
      latestL1Slot: slot(result.latestL1Slot),
      checkpointError: result.checkpointError,
    };
  }

  async getSessionPda(): Promise<PublicKey | null> {
    const response = await this.client.post("", { jsonrpc: "2.0", id: 1, method: "getSessionPda" });
    const result = response.data.result;
    if (result === null) return null;
    if (typeof result !== "string") throw new Error("Malformed ER session binding");
    return new PublicKey(result);
  }

  /**
   * Check connection to Ephemeral Rollup
   */
  async isHealthy(): Promise<boolean> {
    try {
      const response = await this.client.post("", {
        jsonrpc: "2.0",
        id: 1,
        method: "getHealth",
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }
}
