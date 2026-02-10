import type { ChainId, ChainConfig } from "@/types/chain";
import type { ChainProvider } from "./types";
import { SolanaChainProvider } from "./solana/provider";
import { CHAIN_CONFIGS } from "@/config/chains";

const providers: Record<string, ChainProvider> = {
  solana: new SolanaChainProvider(),
  // base and bsc will be added in Phase 4
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
  for (const [id, config] of Object.entries(CHAIN_CONFIGS)) {
    if (config.addressPattern.test(address)) {
      // For EVM addresses, default to base if chain not specified
      if (config.isEvm) return "base" as ChainId;
      return id as ChainId;
    }
  }
  return null;
}
