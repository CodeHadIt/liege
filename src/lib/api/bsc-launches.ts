import { rateLimit } from "@/lib/rate-limiter";

// Launches themselves are detected on-chain (see bsc-onchain.ts). This module
// only decorates a token we already know about with market stats, which have to
// come from an indexer. A brand-new bonding curve usually has none yet — that's
// expected, and every field here is optional in the alert.
export const BSC_EXPLORER = "https://bscscan.com";

export interface BscTokenStats {
  priceUsd: number | null;
  liquidityUsd: number | null;
  marketCap: number | null;
  pairUrl: string | null;
  imageUrl: string | null;
}

interface DexPair {
  baseToken?: { address?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  marketCap?: number;
  url?: string;
  info?: { imageUrl?: string };
}

const EMPTY: BscTokenStats = {
  priceUsd: null,
  liquidityUsd: null,
  marketCap: null,
  pairUrl: null,
  imageUrl: null,
};

/**
 * Best-effort market stats from the token's own deepest pool (where it is the
 * base token, so price and market cap belong to it rather than its quote).
 * Returns empty values rather than throwing — a curve that just launched is
 * routinely not indexed yet.
 */
export async function fetchBscTokenStats(tokenAddress: string): Promise<BscTokenStats> {
  await rateLimit("dexscreener");
  try {
    const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/bsc/${tokenAddress}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return EMPTY;
    const data = await res.json();
    const pairs: DexPair[] = Array.isArray(data) ? data : (data?.pairs ?? []);
    const self = tokenAddress.toLowerCase();
    const asBase = pairs.filter((p) => (p.baseToken?.address ?? "").toLowerCase() === self);
    const pool = (asBase.length ? asBase : pairs).sort(
      (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
    )[0];
    if (!pool) return EMPTY;
    return {
      priceUsd: pool.priceUsd ? parseFloat(pool.priceUsd) : null,
      liquidityUsd: pool.liquidity?.usd ?? null,
      marketCap: pool.marketCap ?? null,
      pairUrl: pool.url ?? null,
      imageUrl: pool.info?.imageUrl ?? null,
    };
  } catch {
    return EMPTY;
  }
}

export function bscExplorerTokenUrl(address: string): string {
  return `${BSC_EXPLORER}/token/${address}`;
}
