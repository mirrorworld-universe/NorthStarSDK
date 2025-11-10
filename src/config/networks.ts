/**
 * Network configuration for North Star SDK
 * Contains RPC endpoints for Solana, Sonic Grid, and HSSN
 */

export interface NetworkConfig {
  solana: {
    mainnet: string;
    testnet: string;
    devnet: string;
  };
  sonic: {
    grid1: string;
    rpc: string;
  };
  hssn: {
    exapi: string;
  };
  oracle: {
    nisaba: string;
  };
}

export const NETWORKS: NetworkConfig = {
  solana: {
    mainnet: 'https://api.mainnet-beta.solana.com',
    testnet: 'https://api.testnet.solana.com',
    devnet: 'https://api.devnet.solana.com'
  },
  sonic: {
    grid1: 'https://api-dev.hypergrid.dev',
    rpc: 'https://api.testnet.sonic.game'
  },
  hssn: {
    exapi: 'https://exapi-hssn.testnet.sonic.game'
  },
  oracle: {
    nisaba: 'https://testnet.nisaba-hssn.sonic.game'
  }
};

export type SolanaNetwork = 'mainnet' | 'testnet' | 'devnet';



