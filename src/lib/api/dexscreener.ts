import { rateLimit } from "@/lib/rate-limiter";

const BASE_URL = "https://api.dexscreener.com";

export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  labels?: string[];
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken: {
    address: string;
    name: string;
    symbol: string;
  };
  priceNative: string;
  priceUsd: string;
  txns: {
    h1: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  volume: {
    h1: number;
    h6: number;
    h24: number;
  };
  priceChange: {
    h1: number;
    h6: number;
    h24: number;
  };
  liquidity?: {
    usd: number;
    base: number;
    quote: number;
  };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    websites?: { url: string }[];
    socials?: { type: string; url: string }[];
  };
}

export interface DexScreenerSearchResult {
  pairs: DexScreenerPair[];
}

async function fetchDexScreener<T>(path: string): Promise<T | null> {
  await rateLimit("dexscreener");
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { Accept: "application/json" },
      next: { revalidate: 30 },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function getTokenPairs(
  chainId: string,
  tokenAddress: string
): Promise<DexScreenerPair[]> {
  const data = await fetchDexScreener<{ pairs: DexScreenerPair[] }>(
    `/tokens/v1/${chainId}/${tokenAddress}`
  );
  return data?.pairs ?? [];
}

export async function searchPairs(
  query: string
): Promise<DexScreenerPair[]> {
  const data = await fetchDexScreener<DexScreenerSearchResult>(
    `/latest/dex/search?q=${encodeURIComponent(query)}`
  );
  return data?.pairs ?? [];
}

export async function getTrendingTokens(
  chainId?: string
): Promise<DexScreenerPair[]> {
  const path = chainId
    ? `/token-boosts/top/v1?chainId=${chainId}`
    : `/token-boosts/top/v1`;
  const data = await fetchDexScreener<DexScreenerPair[]>(path);
  return data ?? [];
}

export async function getLatestTokenProfiles(): Promise<DexScreenerPair[]> {
  const data = await fetchDexScreener<DexScreenerPair[]>(
    `/token-profiles/latest/v1`
  );
  return data ?? [];
}
