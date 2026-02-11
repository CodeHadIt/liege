import type { ChainId } from "@/types/chain";
import type { UnifiedTokenData } from "@/types/token";
import { getChainProvider } from "./chains/registry";
import * as dexscreener from "./api/dexscreener";
import { serverCache, CACHE_TTL } from "./cache";
import { calculateDDScore } from "./scoring";
import { resolveTokenImage } from "./token-image";

export async function aggregateTokenData(
  chain: ChainId,
  address: string
): Promise<UnifiedTokenData | null> {
  const cacheKey = `token:${chain}:${address}`;
  const cached = serverCache.get<UnifiedTokenData>(cacheKey);
  if (cached) return cached;

  const provider = getChainProvider(chain);

  const [pairData, tokenMeta, safetySignals, holders] = await Promise.allSettled([
    provider.getPairData(address),
    provider.getTokenMetadata(address),
    provider.getSafetySignals(address),
    provider.getTopHolders(address, 20),
  ]);

  let pair = pairData.status === "fulfilled" ? pairData.value : null;
  let meta = tokenMeta.status === "fulfilled" ? tokenMeta.value : null;
  const safety =
    safetySignals.status === "fulfilled" ? safetySignals.value : null;
  const holderList = holders.status === "fulfilled" ? holders.value : [];

  // Fallback: if chain-specific provider returned nothing, try DexScreener search by address
  if (!pair && !meta) {
    try {
      const searchResults = await dexscreener.searchPairs(address);
      const match = searchResults.find(
        (p) => p.baseToken.address.toLowerCase() === address.toLowerCase()
      );
      if (match) {
        pair = {
          pairs: [{
            pairAddress: match.pairAddress,
            dexId: match.dexId,
            dexName: match.dexId,
            baseToken: { address: match.baseToken.address, symbol: match.baseToken.symbol },
            quoteToken: { address: match.quoteToken.address, symbol: match.quoteToken.symbol },
            priceUsd: parseFloat(match.priceUsd) || 0,
            liquidity: {
              usd: match.liquidity?.usd ?? 0,
              base: match.liquidity?.base ?? 0,
              quote: match.liquidity?.quote ?? 0,
            },
            volume24h: match.volume?.h24 ?? 0,
            url: match.url,
          }],
          primaryPair: {
            pairAddress: match.pairAddress,
            dexId: match.dexId,
            dexName: match.dexId,
            baseToken: { address: match.baseToken.address, symbol: match.baseToken.symbol },
            quoteToken: { address: match.quoteToken.address, symbol: match.quoteToken.symbol },
            priceUsd: parseFloat(match.priceUsd) || 0,
            liquidity: {
              usd: match.liquidity?.usd ?? 0,
              base: match.liquidity?.base ?? 0,
              quote: match.liquidity?.quote ?? 0,
            },
            volume24h: match.volume?.h24 ?? 0,
            url: match.url,
          },
          priceUsd: parseFloat(match.priceUsd) || null,
          priceNative: parseFloat(match.priceNative) || null,
          volume24h: match.volume?.h24 ?? null,
          liquidity: match.liquidity?.usd ?? null,
          marketCap: match.marketCap ?? null,
          fdv: match.fdv ?? null,
          priceChange: {
            h1: match.priceChange?.h1 ?? null,
            h6: match.priceChange?.h6 ?? null,
            h24: match.priceChange?.h24 ?? null,
          },
          txns24h: match.txns?.h24 ?? null,
          createdAt: match.pairCreatedAt
            ? Math.floor(match.pairCreatedAt / 1000)
            : null,
          logoUrl: match.info?.imageUrl ?? null,
        };
        meta = {
          address: match.baseToken.address,
          name: match.baseToken.name,
          symbol: match.baseToken.symbol,
          decimals: 9,
          logoUrl: match.info?.imageUrl ?? null,
          totalSupply: null,
          holderCount: null,
          website: match.info?.websites?.[0]?.url ?? null,
          twitter: match.info?.socials?.find((s) => s.type === "twitter")?.url ?? null,
          telegram: match.info?.socials?.find((s) => s.type === "telegram")?.url ?? null,
          description: null,
        };
      }
    } catch {
      // Search fallback failed, continue
    }
  }

  // If we have no data at all, the token likely doesn't exist
  if (!pair && !meta) return null;

  const result: UnifiedTokenData = {
    address,
    chain,
    name: meta?.name ?? pair?.primaryPair?.baseToken.symbol ?? "Unknown",
    symbol: meta?.symbol ?? pair?.primaryPair?.baseToken.symbol ?? "???",
    decimals: meta?.decimals ?? 9,
    logoUrl: meta?.logoUrl ?? pair?.logoUrl ?? null,

    priceUsd: pair?.priceUsd ?? null,
    priceNative: pair?.priceNative ?? null,
    marketCap: pair?.marketCap ?? null,
    fdv: pair?.fdv ?? null,
    totalSupply: meta?.totalSupply ?? null,
    circulatingSupply: null,

    volume24h: pair?.volume24h ?? null,
    volumeChange24h: null,
    priceChange: pair?.priceChange ?? { h1: null, h6: null, h24: null },
    txns24h: pair?.txns24h ?? null,

    liquidity: pair?.liquidity
      ? {
          totalUsd: pair.liquidity,
          pools: pair.pairs.map((p) => ({
            pairAddress: p.pairAddress,
            dex: p.dexName,
            liquidityUsd: p.liquidity.usd,
            isLocked: null,
            lockDuration: null,
            lockPlatform: null,
          })),
        }
      : null,

    createdAt: pair?.createdAt ?? null,
    website: meta?.website ?? null,
    twitter: meta?.twitter ?? null,
    telegram: meta?.telegram ?? null,
    description: meta?.description ?? null,

    safetySignals: safety ?? null,
    ddScore: null,

    primaryPair: pair?.primaryPair ?? null,
    allPairs: pair?.pairs ?? [],
  };

  // Calculate DD Score
  result.ddScore = calculateDDScore(result, holderList);

  // Resolve image if missing
  if (!result.logoUrl) {
    result.logoUrl = await resolveTokenImage(chain, address);
  }

  serverCache.set(cacheKey, result, CACHE_TTL.PRICE);
  return result;
}
