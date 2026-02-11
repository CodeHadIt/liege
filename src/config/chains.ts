import type { ChainConfig, ChainId } from "@/types/chain";

export const CHAIN_CONFIGS: Record<ChainId, ChainConfig> = {
  solana: {
    id: "solana",
    name: "Solana",
    shortName: "SOL",
    logo: "/chains/solana.svg",
    nativeCurrency: { name: "SOL", symbol: "SOL", decimals: 9 },
    rpcUrl: (process.env.HELIUS_RPC_URL && !process.env.HELIUS_RPC_URL.endsWith("api-key="))
      ? process.env.HELIUS_RPC_URL
      : "https://api.mainnet-beta.solana.com",
    explorerUrl: "https://solscan.io",
    explorerApiUrl: "https://pro-api.solscan.io/v2.0",
    dexScreenerChainId: "solana",
    geckoTerminalNetwork: "solana",
    addressPattern: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
    isEvm: false,
  },
  base: {
    id: "base",
    name: "Base",
    shortName: "BASE",
    logo: "/chains/base.svg",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrl: "https://mainnet.base.org",
    explorerUrl: "https://basescan.org",
    explorerApiUrl: "https://api.basescan.org/api",
    dexScreenerChainId: "base",
    geckoTerminalNetwork: "base",
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    isEvm: true,
  },
  bsc: {
    id: "bsc",
    name: "BNB Chain",
    shortName: "BSC",
    logo: "/chains/bsc.svg",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrl: "https://bsc-dataseed1.binance.org",
    explorerUrl: "https://bscscan.com",
    explorerApiUrl: "https://api.bscscan.com/api",
    dexScreenerChainId: "bsc",
    geckoTerminalNetwork: "bsc",
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    isEvm: true,
  },
};

export const SUPPORTED_CHAINS: ChainId[] = ["solana", "base", "bsc"];

export function getChainConfig(chainId: ChainId): ChainConfig {
  return CHAIN_CONFIGS[chainId];
}

export function getExplorerTokenUrl(chainId: ChainId, address: string): string {
  const config = CHAIN_CONFIGS[chainId];
  if (chainId === "solana") return `${config.explorerUrl}/token/${address}`;
  return `${config.explorerUrl}/token/${address}`;
}

export function getExplorerAddressUrl(chainId: ChainId, address: string): string {
  const config = CHAIN_CONFIGS[chainId];
  if (chainId === "solana") return `${config.explorerUrl}/account/${address}`;
  return `${config.explorerUrl}/address/${address}`;
}

export function getExplorerTxUrl(chainId: ChainId, hash: string): string {
  const config = CHAIN_CONFIGS[chainId];
  if (chainId === "solana") return `${config.explorerUrl}/tx/${hash}`;
  return `${config.explorerUrl}/tx/${hash}`;
}
