import { NextResponse } from "next/server";
import * as dexscreener from "@/lib/api/dexscreener";
import * as geckoterminal from "@/lib/api/geckoterminal";
import { serverCache, CACHE_TTL } from "@/lib/cache";
import { resolveTokenImages } from "@/lib/token-image";
import { isChainSupported } from "@/lib/chains/registry";
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
    const geckoNetwork = chain && chain !== "all" ? chain : undefined;
    const [dsBoosts, gtPools] = await Promise.allSettled([
      dexscreener.getTrendingTokens(
        chain && chain !== "all" ? chain : undefined
      ),
      geckoterminal.getTrendingPools(geckoNetwork),
    ]);

    const results: TrendingToken[] = [];
    const seen = new Set<string>();

    // DexScreener boosted tokens — enrich with pair data for price/volume
    if (dsBoosts.status === "fulfilled") {
      // Filter to only supported chains before enriching
      const boosts = dsBoosts.value
        .filter((b) => isChainSupported(b.chainId))
        .slice(0, 20);
      // Batch enrich: fetch pair data for each boost in parallel
      const enriched = await Promise.allSettled(
        boosts.map((boost) => dexscreener.enrichTokenBoost(boost))
      );

      for (let i = 0; i < boosts.length; i++) {
        const boost = boosts[i];
        const enrichResult = enriched[i];
        const pair =
          enrichResult.status === "fulfilled" ? enrichResult.value : null;

        const key = `${boost.chainId}:${boost.tokenAddress}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          rank: results.length + 1,
          address: boost.tokenAddress,
          chain: boost.chainId as ChainId,
          name: pair?.baseToken.name ?? boost.header ?? "Unknown",
          symbol: pair?.baseToken.symbol ?? "???",
          logoUrl: pair?.info?.imageUrl ?? boost.icon ?? null,
          priceUsd: pair ? parseFloat(pair.priceUsd) || null : null,
          marketCap: pair?.marketCap ?? pair?.fdv ?? null,
          volume24h: pair?.volume?.h24 ?? null,
          liquidity: pair?.liquidity?.usd ?? null,
          priceChange24h: pair?.priceChange?.h24 ?? null,
          txns24h: pair?.txns?.h24
            ? pair.txns.h24.buys + pair.txns.h24.sells
            : null,
          pairUrl: pair?.url ?? boost.url ?? "",
        });
      }
    }

    // GeckoTerminal trending pools (fill in gaps)
    if (gtPools.status === "fulfilled") {
      for (const pool of gtPools.value.slice(0, 20)) {
        const attr = pool.attributes;
        const poolChain = pool.id.split("_")[0] || "solana";

        // Skip unsupported chains (e.g. polygon, ton)
        if (!isChainSupported(poolChain)) continue;

        // Extract base token address from relationships (attr.address is the POOL address)
        const baseTokenId = pool.relationships?.base_token?.data?.id;
        const address = baseTokenId
          ? baseTokenId.split("_").slice(1).join("_")
          : attr.address;

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
          marketCap: attr.market_cap_usd ? parseFloat(attr.market_cap_usd) : null,
          volume24h: parseFloat(attr.volume_usd.h24) || null,
          liquidity: parseFloat(attr.reserve_in_usd) || null,
          priceChange24h:
            parseFloat(attr.price_change_percentage.h24) || null,
          txns24h: attr.transactions?.h24
            ? attr.transactions.h24.buys + attr.transactions.h24.sells
            : null,
          pairUrl: "",
        });
      }
    }

    // Re-rank
    results.forEach((r, i) => (r.rank = i + 1));

    // Resolve remaining missing images in batch
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
          images.forEach((url, addr) =>
            imageResults.set(`${chainId}:${addr}`, url)
          );
        })
      );

      for (const token of missingImages) {
        const img = imageResults.get(`${token.chain}:${token.address}`);
        if (img) token.logoUrl = img;
      }
    }

    serverCache.set(cacheKey, results, CACHE_TTL.TRENDING);
    return NextResponse.json({ data: results });
  } catch (error) {
    console.error("Trending error:", error);
    return NextResponse.json({ data: [] });
  }
}
