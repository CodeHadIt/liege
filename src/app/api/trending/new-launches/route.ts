import { NextResponse } from "next/server";
import * as geckoterminal from "@/lib/api/geckoterminal";
import { serverCache, CACHE_TTL } from "@/lib/cache";
import type { ChainId } from "@/types/chain";

export interface NewLaunchToken {
  address: string;
  chain: ChainId;
  name: string;
  symbol: string;
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
        priceUsd: parseFloat(attr.base_token_price_usd) || null,
        volume24h: parseFloat(attr.volume_usd.h24) || null,
        liquidity: parseFloat(attr.reserve_in_usd) || null,
        priceChange24h: parseFloat(attr.price_change_percentage.h24) || null,
        createdAt: attr.pool_created_at,
        dex,
      };
    });

    serverCache.set(cacheKey, results, CACHE_TTL.TRENDING);
    return NextResponse.json({ data: results });
  } catch (error) {
    console.error("New launches error:", error);
    return NextResponse.json({ data: [] });
  }
}
