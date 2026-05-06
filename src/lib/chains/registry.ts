import type { ChainId, ChainConfig } from "@/types/chain";
import type { ChainProvider } from "./types";
import { SolanaChainProvider } from "./solana/provider";
import { EvmChainProvider } from "./evm/provider";
import { TonChainProvider } from "./ton/provider";
import { CHAIN_CONFIGS } from "@/config/chains";

const providers: Record<string, ChainProvider> = {
  solana: new SolanaChainProvider(),
  base: new EvmChainProvider("base", {
    apiUrl: "https://api.basescan.org/api",
    apiKey: process.env.BASESCAN_API_KEY || "",
    rateLimiterKey: "basescan",
  }),
  bsc: new EvmChainProvider("bsc", {
    apiUrl: "https://api.bscscan.com/api",
    apiKey: process.env.BSCSCAN_API_KEY || "",
    rateLimiterKey: "bscscan",
  }),
  eth: new EvmChainProvider("eth", {
    apiUrl: "https://api.etherscan.io/api",
    apiKey: process.env.ETHERSCAN_API_KEY || "",
    rateLimiterKey: "etherscan",
  }),
  ton: new TonChainProvider(),
};

export function getChainProvider(chainId: ChainId): ChainProvider {
  const provider = providers[chainId];
  if (!provider) {
    throw new Error(`Chain "${chainId}" is not yet supported.`);
  }
  return provider;
}

export function isChainSupported(chainId: string): chainId is ChainId {
  return chainId in providers;
}

export function getAllSupportedChains(): ChainConfig[] {
  return Object.keys(providers).map(
    (id) => CHAIN_CONFIGS[id as ChainId]
  );
}

export function detectChainFromAddress(address: string): ChainId | null {
  // TON user-friendly addresses: EQ/UQ/Ef/Uf/kQ/kf prefix + 46 base64url chars
  // Check before Solana — they overlap in the base58 character set
  if (CHAIN_CONFIGS.ton.addressPattern.test(address)) {
    return "ton";
  }
  // Solana addresses: base58, 32-44 chars
  if (CHAIN_CONFIGS.solana.addressPattern.test(address)) {
    return "solana";
  }
  // EVM addresses: 0x prefix, 40 hex chars — default to base
  if (CHAIN_CONFIGS.base.addressPattern.test(address)) {
    return "base";
  }
  return null;
}
