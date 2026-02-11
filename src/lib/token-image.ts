import { serverCache } from "./cache";
import { rateLimit } from "./rate-limiter";
import type { ChainId } from "@/types/chain";

const IMAGE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours — images rarely change

/**
 * Resolves a token image URL from multiple sources with aggressive caching.
 * Priority: cache → DexScreener → Jupiter (Solana) → null
 */
export async function resolveTokenImage(
  chain: ChainId,
  tokenAddress: string
): Promise<string | null> {
  const cacheKey = `img:${chain}:${tokenAddress}`;
  const cached = serverCache.get<string | null>(cacheKey);
  if (cached !== null) return cached;

  let imageUrl: string | null = null;

  // 1. Try DexScreener (works for all chains)
  imageUrl = await fetchDexScreenerImage(chain, tokenAddress);
  if (imageUrl) {
    serverCache.set(cacheKey, imageUrl, IMAGE_CACHE_TTL);
    return imageUrl;
  }

  // 2. Chain-specific fallbacks
  if (chain === "solana") {
    imageUrl = await fetchJupiterImage(tokenAddress);
  }

  if (imageUrl) {
    serverCache.set(cacheKey, imageUrl, IMAGE_CACHE_TTL);
  }

  return imageUrl;
}

/**
 * Batch-resolve images for multiple tokens at once.
 * Uses cache first, then fetches missing ones.
 */
export async function resolveTokenImages(
  chain: ChainId,
  tokenAddresses: string[]
): Promise<Map<string, string | null>> {
  const results = new Map<string, string | null>();
  const uncached: string[] = [];

  // Check cache first
  for (const addr of tokenAddresses) {
    const cacheKey = `img:${chain}:${addr}`;
    const cached = serverCache.get<string>(cacheKey);
    if (cached !== null) {
      results.set(addr, cached);
    } else {
      uncached.push(addr);
    }
  }

  // Fetch uncached in parallel (limit concurrency)
  const batchSize = 5;
  for (let i = 0; i < uncached.length; i += batchSize) {
    const batch = uncached.slice(i, i + batchSize);
    const fetched = await Promise.allSettled(
      batch.map((addr) => resolveTokenImage(chain, addr))
    );
    fetched.forEach((result, idx) => {
      const addr = batch[idx];
      results.set(
        addr,
        result.status === "fulfilled" ? result.value : null
      );
    });
  }

  return results;
}

async function fetchDexScreenerImage(
  chain: ChainId,
  tokenAddress: string
): Promise<string | null> {
  const chainMap: Record<ChainId, string> = {
    solana: "solana",
    base: "base",
    bsc: "bsc",
  };
  const dsChain = chainMap[chain];
  if (!dsChain) return null;

  await rateLimit("dexscreener");
  try {
    const res = await fetch(
      `https://api.dexscreener.com/tokens/v1/${dsChain}/${tokenAddress}`,
      { headers: { Accept: "application/json" }, next: { revalidate: 3600 } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    // Response is an array of pairs
    const pairs = Array.isArray(data) ? data : data?.pairs;
    if (!pairs?.length) return null;
    // Find first pair with an image
    for (const pair of pairs) {
      if (pair.info?.imageUrl) return pair.info.imageUrl;
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchJupiterImage(
  tokenAddress: string
): Promise<string | null> {
  try {
    const res = await fetch(
      `https://tokens.jup.ag/token/${tokenAddress}`,
      { next: { revalidate: 3600 } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.logoURI || null;
  } catch {
    return null;
  }
}
