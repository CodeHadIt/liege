import { NextResponse } from "next/server";
import { getChainProvider, isChainSupported } from "@/lib/chains/registry";
import { scrapeGmgnTopTraders } from "@/lib/api/gmgn-scraper";
import type { ChainId } from "@/types/chain";
import type { ApiError } from "@/types/api";
import type { HolderEntry } from "@/types/token";
import { serverCache, CACHE_TTL } from "@/lib/cache";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ chain: string; address: string }> }
) {
  const { chain, address } = await params;

  if (!isChainSupported(chain)) {
    return NextResponse.json(
      { error: `Unsupported chain: ${chain}`, code: "CHAIN_ERROR" } satisfies ApiError,
      { status: 400 }
    );
  }

  try {
    const cacheKey = `holders:${chain}:${address}`;
    const cached = serverCache.get(cacheKey);
    if (cached) {
      return NextResponse.json({ data: cached, cached: true });
    }

    const chainId = chain as ChainId;
    let holders: HolderEntry[] = [];

    if (chainId !== "solana") {
      // EVM: use GMGN (same source as top-traders) for accurate holder data on all chains
      const provider = getChainProvider(chainId);
      const [gmgnTraders, pairData] = await Promise.all([
        scrapeGmgnTopTraders(chainId, address).catch(() => []),
        provider.getPairData(address).catch(() => null),
      ]);

      if (gmgnTraders.length > 0) {
        // Compute total supply from FDV / price (DexScreener provides this)
        const priceUsd = pairData?.priceUsd ?? null;
        const fdv = pairData?.fdv ?? null;
        const totalSupply =
          priceUsd && priceUsd > 0 && fdv && fdv > 0
            ? fdv / priceUsd
            : null;

        // Sort by current balance descending to get actual top holders
        const sorted = [...gmgnTraders].sort((a, b) => b.balance - a.balance);

        // Fallback: compute percentage relative to sum of top-100 holders
        const totalHeld = sorted.reduce((s, t) => s + t.balance, 0);

        holders = sorted.slice(0, 50).map((t) => ({
          address: t.walletAddress,
          balance: t.balance,
          percentage: totalSupply
            ? (t.balance / totalSupply) * 100
            : totalHeld > 0
            ? (t.balance / totalHeld) * 100
            : 0,
          isContract: null,
          label: null,
        }));
      }
    } else {
      // Solana: use existing provider (Helius / Solscan)
      const provider = getChainProvider(chainId);
      holders = await provider.getTopHolders(address, 50);
    }

    serverCache.set(cacheKey, holders, CACHE_TTL.TOKEN_META);

    return NextResponse.json({
      data: holders,
      chain,
      timestamp: Date.now(),
      cached: false,
    });
  } catch (error) {
    console.error(`Error fetching holders ${chain}/${address}:`, error);
    return NextResponse.json(
      { error: "Internal server error", code: "UNKNOWN", chain } satisfies ApiError,
      { status: 500 }
    );
  }
}
