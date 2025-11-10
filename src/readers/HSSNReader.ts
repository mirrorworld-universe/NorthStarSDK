/**
 * HSSN API Client
 * Handles reading account data from HSSN explorer API
 */

import { Address } from '@solana/addresses';
import axios, { AxiosInstance } from 'axios';
import { AccountInfo, HSSNAccountResponse } from '../types';

export class HSSNReader {
  private client: AxiosInstance;
  private baseUrl: string;

  constructor(hssnExapiUrl: string) {
    this.baseUrl = hssnExapiUrl;
    this.client = axios.create({
      baseURL: hssnExapiUrl,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Get account information from HSSN
   * Uses the HSSN API endpoint: /hypergrid-ssn/hypergridssn/solana_account/{address}/{version}
   * @param address - Account address
   * @param version - Account version (optional, defaults to latest)
   * @returns Account information or null if not found
   */
  async getAccountInfo(
    address: Address,
    version?: string
  ): Promise<AccountInfo | null> {
    try {
      const addressStr = address;
      const accountVersion = version || (await this.getLatestVersion(addressStr));

      if (!accountVersion) {
        return null;
      }

      const response = await this.client.get<HSSNAccountResponse>(
        `hypergrid-ssn/hypergridssn/solana_account/${addressStr}/${accountVersion}`
      );

      if (!response.data.solanaAccount) {
        return null;
      }

      const account = response.data.solanaAccount;

      const dataBuffer = this.decodeAccountValue(account.value);

      return {
        address: account.address as Address,
        data: dataBuffer,
        executable: false,
        lamports: BigInt(0),
        owner: account.source as Address,
        slot: BigInt(parseInt(account.slot) || 0),
        source: 'hssn',
      };
    } catch (error) {
      console.error('Error fetching from HSSN:', error);
      return null;
    }
  }

  /**
   * Get latest version for an account
   * @param address - Account address as base58 string
   * @returns Latest version string or null
   */
  private async getLatestVersion(address: string): Promise<string | null> {
    try {
      // Query the account list endpoint with pagination
      const response = await this.client.get(
        `hypergrid-ssn/hypergridssn/solana_account`,
        {
          params: {
            'pagination.limit': '100',
            'pagination.reverse': 'true', // Get latest first
          },
        }
      );

      if (!response.data.solanaAccount) {
        return null;
      }

      // Find the account in the list
      const accounts = response.data.solanaAccount;
      const targetAccount = accounts.find(
        (acc: any) => acc.address === address
      );

      return targetAccount?.version || null;
    } catch (error) {
      console.error('Error fetching account versions from HSSN:', error);
      return null;
    }
  }

  /**
   * Decode account value from HSSN storage format
   */
  private decodeAccountValue(value: string): Uint8Array {
    try {
      return new Uint8Array(Buffer.from(value, 'base64'));
    } catch {
      return new Uint8Array(0);
    }
  }

  /**
   * Check connection to HSSN
   */
  async isHealthy(): Promise<boolean> {
    try {
      const response = await this.client.get(
        'hypergrid-ssn/hypergridssn/hypergrid_node',
        {
          params: {
            'pagination.limit': '1',
          },
        }
      );
      return response.status === 200 && response.data?.hypergridNode !== undefined;
    } catch {
      return false;
    }
  }
}

