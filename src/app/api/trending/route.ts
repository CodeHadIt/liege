import { NextResponse } from "next/server";
import * as dexscreener from "@/lib/api/dexscreener";
import * as geckoterminal from "@/lib/api/geckoterminal";
import { serverCache, CACHE_TTL } from "@/lib/cache";
import type { TrendingToken } from "@/types/token";
import type { ChainId } from "@/types/chain";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const chain = searchParams.get("chain") as ChainId | "all" | null;

  const cacheKey = `trending:${chain || "all"}`;
  const cached = serverCache.get<TrendingToken[]>(cacheKey);
  if (cached) {
    return NextResponse.json({ data: cached, cached: true });
  }

  try {
    // Fetch from both sources in parallel
    const geckoNetwork =
      chain && chain !== "all" ? chain : undefined;
    const [dsPairs, gtPools] = await Promise.allSettled([
      dexscreener.getTrendingTokens(
        chain && chain !== "all" ? chain : undefined
      ),
      geckoterminal.getTrendingPools(geckoNetwork),
    ]);

    const results: TrendingToken[] = [];
    const seen = new Set<string>();

    // DexScreener results
    if (dsPairs.status === "fulfilled") {
      for (const pair of dsPairs.value.slice(0, 30)) {
        const key = `${pair.chainId}:${pair.baseToken.address}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({
          rank: results.length + 1,
          address: pair.baseToken.address,
          chain: pair.chainId as ChainId,
          name: pair.baseToken.name,
          symbol: pair.baseToken.symbol,
          logoUrl: pair.info?.imageUrl ?? null,
          priceUsd: parseFloat(pair.priceUsd) || null,
          volume24h: pair.volume?.h24 ?? null,
          liquidity: pair.liquidity?.usd ?? null,
          priceChange24h: pair.priceChange?.h24 ?? null,
          txns24h: pair.txns?.h24
            ? pair.txns.h24.buys + pair.txns.h24.sells
            : null,
          pairUrl: pair.url,
        });
      }
    }

    // GeckoTerminal results (fill in gaps)
    if (gtPools.status === "fulfilled") {
      for (const pool of gtPools.value.slice(0, 20)) {
        const attr = pool.attributes;
        // Extract chain from pool ID (format: "network_address")
        const poolChain = pool.id.split("_")[0] || "solana";
        const address = attr.address;
        const key = `${poolChain}:${address}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({
          rank: results.length + 1,
          address,
          chain: poolChain as ChainId,
          name: attr.name,
          symbol: attr.name.split(" / ")[0] || attr.name,
          logoUrl: null,
          priceUsd: parseFloat(attr.base_token_price_usd) || null,
          volume24h: parseFloat(attr.volume_usd.h24) || null,
          liquidity: parseFloat(attr.reserve_in_usd) || null,
          priceChange24h: parseFloat(attr.price_change_percentage.h24) || null,
          txns24h: attr.transactions?.h24
            ? attr.transactions.h24.buys + attr.transactions.h24.sells
            : null,
          pairUrl: "",
        });
      }
    }

    // Re-rank
    results.forEach((r, i) => (r.rank = i + 1));

    serverCache.set(cacheKey, results, CACHE_TTL.TRENDING);
    return NextResponse.json({ data: results });
  } catch (error) {
    console.error("Trending error:", error);
    return NextResponse.json({ data: [] });
  }
}
