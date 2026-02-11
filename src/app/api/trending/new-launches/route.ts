import { NextResponse } from "next/server";
import * as geckoterminal from "@/lib/api/geckoterminal";
import { serverCache, CACHE_TTL } from "@/lib/cache";
import { resolveTokenImages } from "@/lib/token-image";
import type { ChainId } from "@/types/chain";

export interface NewLaunchToken {
  address: string;
  chain: ChainId;
  name: string;
  symbol: string;
  logoUrl: string | null;
  priceUsd: number | null;
  volume24h: number | null;
  liquidity: number | null;
  priceChange24h: number | null;
  createdAt: string;
  dex: string;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const chain = searchParams.get("chain") as ChainId | "all" | null;

  const cacheKey = `new-launches:${chain || "all"}`;
  const cached = serverCache.get<NewLaunchToken[]>(cacheKey);
  if (cached) {
    return NextResponse.json({ data: cached, cached: true });
  }

  try {
    const network = chain && chain !== "all" ? chain : undefined;
    const pools = await geckoterminal.getNewPools(network);

    const results: NewLaunchToken[] = pools.slice(0, 20).map((pool) => {
      const attr = pool.attributes;
      const poolChain = pool.id.split("_")[0] || "solana";
      const dex = pool.relationships?.dex?.data?.id || "unknown";

      return {
        address: attr.address,
        chain: poolChain as ChainId,
        name: attr.name,
        symbol: attr.name.split(" / ")[0] || attr.name,
        logoUrl: null,
        priceUsd: parseFloat(attr.base_token_price_usd) || null,
        volume24h: parseFloat(attr.volume_usd.h24) || null,
        liquidity: parseFloat(attr.reserve_in_usd) || null,
        priceChange24h: parseFloat(attr.price_change_percentage.h24) || null,
        createdAt: attr.pool_created_at,
        dex,
      };
    });

    // Resolve images in batch
    if (results.length > 0) {
      const byChain = new Map<ChainId, string[]>();
      for (const token of results) {
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

      for (const token of results) {
        const img = imageResults.get(`${token.chain}:${token.address}`);
        if (img) token.logoUrl = img;
      }
    }

    serverCache.set(cacheKey, results, CACHE_TTL.TRENDING);
    return NextResponse.json({ data: results });
  } catch (error) {
    console.error("New launches error:", error);
    return NextResponse.json({ data: [] });
  }
}
