/**
 * Core types and interfaces for North Star SDK
 */

import { PublicKey } from "@solana/web3.js";

/** Account address (base-58 pubkey). */
export type Address = PublicKey;

/**
 * Account information from Ephemeral Rollup or Solana
 */
export interface AccountInfo {
  address: Address;
  data: Uint8Array;
  executable: boolean;
  lamports: bigint;
  owner: Address;
  slot: bigint;
  source: "ephemeral-rollup" | "solana";
}

/**
 * Ephemeral Rollup RPC account response
 */
export interface EphemeralRollupAccountResponse {
  jsonrpc: string;
  result: {
    context: {
      apiVersion: string;
      slot: number;
    };
    value: {
      data: [string, string];
      executable: boolean;
      lamports: number;
      owner: string;
      remote: boolean;
      rentEpoch: number;
      space: number;
    };
  };
  id: number;
}

/**
 * SDK configuration
 */
export interface NorthStarConfig {
  portalProgramId: Address;
  customEndpoints: {
    solana: string;
    ephemeralRollup: string;
  };
}

/**
 * Transaction build parameters
 */
export interface ReadTransactionParams {
  gridId: number;
  accountAddress: Address;
  sessionPDA?: Address;
}
