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

// Token boost/profile response (different shape from pair data)
export interface DexScreenerTokenBoost {
  tokenAddress: string;
  chainId: string;
  icon?: string;
  header?: string;
  description?: string;
  url?: string;
  // Sometimes it also includes full pair-like fields
  [key: string]: unknown;
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
  // The /tokens/v1 endpoint returns an array directly, not wrapped in {pairs:}
  const data = await fetchDexScreener<DexScreenerPair[]>(
    `/tokens/v1/${chainId}/${tokenAddress}`
  );
  if (Array.isArray(data)) return data;
  // Fallback: might be {pairs: [...]}
  const wrapped = data as unknown as { pairs?: DexScreenerPair[] };
  return wrapped?.pairs ?? [];
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
): Promise<DexScreenerTokenBoost[]> {
  const path = chainId
    ? `/token-boosts/top/v1?chainId=${chainId}`
    : `/token-boosts/top/v1`;
  const data = await fetchDexScreener<DexScreenerTokenBoost[]>(path);
  return data ?? [];
}

/**
 * Look up full pair data for a token boost entry to get price/volume/image.
 */
export async function enrichTokenBoost(
  boost: DexScreenerTokenBoost
): Promise<DexScreenerPair | null> {
  const pairs = await getTokenPairs(boost.chainId, boost.tokenAddress);
  if (pairs.length === 0) return null;
  // Return the highest liquidity pair
  return pairs.sort(
    (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
  )[0];
}

export interface DexScreenerOrder {
  type: string;
  status: string;
  chainId?: string;
  tokenAddress?: string;
  paymentTimestamp?: number;
}

interface DexScreenerOrdersResponse {
  orders: DexScreenerOrder[];
  boosts?: { chainId: string; tokenAddress: string; id: string; amount: number; paymentTimestamp: number }[];
}

export async function getTokenOrders(
  chainId: string,
  tokenAddress: string
): Promise<DexScreenerOrdersResponse | null> {
  const data = await fetchDexScreener<DexScreenerOrdersResponse>(
    `/orders/v1/${chainId}/${tokenAddress}`
  );
  if (data && Array.isArray(data.orders)) return data;
  return null;
}

export async function getLatestTokenProfiles(): Promise<DexScreenerTokenBoost[]> {
  const data = await fetchDexScreener<DexScreenerTokenBoost[]>(
    `/token-profiles/latest/v1`
  );
  return data ?? [];
}
