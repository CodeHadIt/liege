import { NextResponse } from "next/server";
import * as dexscreener from "@/lib/api/dexscreener";
import { serverCache, CACHE_TTL } from "@/lib/cache";
import { resolveTokenImages } from "@/lib/token-image";
import type { TokenSearchResult } from "@/types/token";
import type { ChainId } from "@/types/chain";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q");
  const chain = searchParams.get("chain") as ChainId | null;

  if (!query || query.length < 2) {
    return NextResponse.json({ data: [] });
  }

  const cacheKey = `search:${query}:${chain || "all"}`;
  const cached = serverCache.get<TokenSearchResult[]>(cacheKey);
  if (cached) {
    return NextResponse.json({ data: cached, cached: true });
  }

  try {
    const pairs = await dexscreener.searchPairs(query);
    let results: TokenSearchResult[] = pairs
      .filter((pair) => {
        if (!chain) return true;
        return pair.chainId === chain;
      })
      .slice(0, 20)
      .map((pair) => ({
        address: pair.baseToken.address,
        chain: pair.chainId as ChainId,
        name: pair.baseToken.name,
        symbol: pair.baseToken.symbol,
        logoUrl: pair.info?.imageUrl ?? null,
        priceUsd: parseFloat(pair.priceUsd) || null,
        volume24h: pair.volume?.h24 ?? null,
        liquidity: pair.liquidity?.usd ?? null,
      }));

    // Deduplicate by address + chain
    const seen = new Set<string>();
    results = results.filter((r) => {
      const key = `${r.chain}:${r.address}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Resolve missing images
    const missingImages = results.filter((r) => !r.logoUrl);
    if (missingImages.length > 0) {
      const byChain = new Map<ChainId, string[]>();
      for (const token of missingImages) {
        const addrs = byChain.get(token.chain) || [];
        addrs.push(token.address);
        byChain.set(token.chain, addrs);
      }
      const imageResults = new Map<string, string | null>();
      await Promise.allSettled(
        Array.from(byChain.entries()).map(async ([chainId, addresses]) => {
          const images = await resolveTokenImages(chainId, addresses);
          images.forEach((url, addr) => imageResults.set(`${chainId}:${addr}`, url));
        })
      );
      for (const token of missingImages) {
        const img = imageResults.get(`${token.chain}:${token.address}`);
        if (img) token.logoUrl = img;
      }
    }

    serverCache.set(cacheKey, results, CACHE_TTL.SEARCH);
    return NextResponse.json({ data: results });
  } catch (error) {
    console.error("Search error:", error);
    return NextResponse.json({ data: [] });
  }
}
