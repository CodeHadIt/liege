import type { ChainId } from "@/types/chain";
import type { UnifiedTokenData } from "@/types/token";
import { getChainProvider } from "./chains/registry";
import { serverCache, CACHE_TTL } from "./cache";

export async function aggregateTokenData(
  chain: ChainId,
  address: string
): Promise<UnifiedTokenData | null> {
  const cacheKey = `token:${chain}:${address}`;
  const cached = serverCache.get<UnifiedTokenData>(cacheKey);
  if (cached) return cached;

  const provider = getChainProvider(chain);

  const [pairData, tokenMeta, safetySignals] = await Promise.allSettled([
    provider.getPairData(address),
    provider.getTokenMetadata(address),
    provider.getSafetySignals(address),
  ]);

  const pair = pairData.status === "fulfilled" ? pairData.value : null;
  const meta = tokenMeta.status === "fulfilled" ? tokenMeta.value : null;
  const safety =
    safetySignals.status === "fulfilled" ? safetySignals.value : null;

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
    ddScore: null, // Computed in Phase 2

    primaryPair: pair?.primaryPair ?? null,
    allPairs: pair?.pairs ?? [],
  };

  serverCache.set(cacheKey, result, CACHE_TTL.PRICE);
  return result;
}
