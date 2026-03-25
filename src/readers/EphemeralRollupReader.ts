/**
 * Ephemeral Rollup Account Reader
 * Handles reading account data from Ephemeral Rollup RPC
 */

import { Address } from '@solana/addresses';
import axios, { AxiosInstance } from 'axios';
import { AccountInfo, EphemeralRollupAccountResponse } from '../types';

export class EphemeralRollupReader {
  private client: AxiosInstance;
  private rpcUrl: string;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
    this.client = axios.create({
      baseURL: rpcUrl,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Get account information from Ephemeral Rollup RPC
   * @param address - Account address
   * @returns Account information or null if not found
   */
  async getAccountInfo(address: Address): Promise<AccountInfo | null> {
    try {
      const response = await this.client.post<EphemeralRollupAccountResponse>('', {
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [
          address,
          {
            encoding: 'base64',
          },
        ],
      });

      if (!response.data.result || !response.data.result.value) {
        return null;
      }

      const result = response.data.result.value;

      return {
        address: address,
        data: new Uint8Array(Buffer.from(result.data[0], 'base64')),
        executable: result.executable,
        lamports: BigInt(result.lamports),
        owner: result.owner as Address,
        slot: BigInt(response.data.result.context.slot),
        source: 'ephemeral-rollup',
      };
    } catch (error) {
      console.error('Error fetching from Ephemeral Rollup:', error);
      return null;
    }
  }

  /**
   * Get multiple account information in batch
   * @param addresses - Array of account addresses
   * @returns Array of account information (null for not found)
   */
  async getMultipleAccounts(addresses: Address[]): Promise<(AccountInfo | null)[]> {
    try {
      const response = await this.client.post('', {
        jsonrpc: '2.0',
        id: 1,
        method: 'getMultipleAccounts',
        params: [
          addresses,
          {
            encoding: 'base64',
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
            data: new Uint8Array(Buffer.from(account.data[0], 'base64')),
            executable: account.executable,
            lamports: BigInt(account.lamports),
            owner: account.owner as Address,
            slot: BigInt(response.data.result.context.slot),
            source: 'ephemeral-rollup',
          };
        }
      );
    } catch (error) {
      console.error('Error fetching multiple accounts from Ephemeral Rollup:', error);
      return addresses.map(() => null);
    }
  }

  /**
   * Check connection to Ephemeral Rollup
   */
  async isHealthy(): Promise<boolean> {
    try {
      const response = await this.client.post('', {
        jsonrpc: '2.0',
        id: 1,
        method: 'getHealth',
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }
}
