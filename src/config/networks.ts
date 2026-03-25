/**
 * Network configuration for North Star SDK
 * Contains RPC endpoints for Solana and Ephemeral Rollup
 */

export interface NetworkConfig {
  solana: {
    mainnet: string;
    testnet: string;
    devnet: string;
  };
  ephemeralRollup: {
    devnet: string;
    testnet: string;
    mainnet: string;
  };
}

export const NETWORKS: NetworkConfig = {
  solana: {
    mainnet: 'https://api.mainnet-beta.solana.com',
    testnet: 'https://api.testnet.solana.com',
    devnet: 'https://api.devnet.solana.com'
  },
  ephemeralRollup: {
    devnet: 'http://localhost:8910',
    testnet: 'http://localhost:8910',
    mainnet: 'http://localhost:8910'
  }
};

export type SolanaNetwork = 'mainnet' | 'testnet' | 'devnet';
