import { NextResponse } from "next/server";
import { getChainProvider, isChainSupported } from "@/lib/chains/registry";
import { scrapeGmgnTopHolders } from "@/lib/api/gmgn-scraper";
import type { ChainId } from "@/types/chain";
import type { ApiError } from "@/types/api";
import type { HolderEntry } from "@/types/token";
import { serverCache, CACHE_TTL } from "@/lib/cache";

// Allow up to 120s on Vercel Pro — GMGN scraping takes ~25s
export const maxDuration = 120;

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

    if (chainId === "ton") {
      // TON: GMGN doesn't support TON — use TonCenter directly
      const provider = getChainProvider(chainId);
      holders = await provider.getTopHolders(address, 50);
    } else if (chainId !== "solana") {
      // EVM: use GMGN sorted by balance (true top holders, not top traders)
      const provider = getChainProvider(chainId);
      const [gmgnHolders, pairData] = await Promise.all([
        scrapeGmgnTopHolders(chainId, address).catch(() => []),
        provider.getPairData(address).catch(() => null),
      ]);

      if (gmgnHolders.length > 0) {
        // Compute total supply from FDV / price as a percentage fallback
        const priceUsd = pairData?.priceUsd ?? null;
        const fdv = pairData?.fdv ?? null;
        const totalSupply =
          priceUsd && priceUsd > 0 && fdv && fdv > 0
            ? fdv / priceUsd
            : null;

        // Sum of balances from returned list (fallback when supply unknown)
        const totalHeld = gmgnHolders.reduce((s, t) => s + t.balance, 0);

        holders = gmgnHolders.slice(0, 50).map((t) => {
          // Prefer GMGN's own supplyPercent, then FDV-derived, then relative share
          let percentage = 0;
          if (t.supplyPercent > 0) {
            // GMGN may return as decimal fraction (0.0263) or whole % (2.63)
            percentage = t.supplyPercent <= 1 ? t.supplyPercent * 100 : t.supplyPercent;
          } else if (totalSupply && totalSupply > 0) {
            percentage = (t.balance / totalSupply) * 100;
          } else if (totalHeld > 0) {
            percentage = (t.balance / totalHeld) * 100;
          }
          return {
            address: t.walletAddress,
            balance: t.balance,
            percentage,
            isContract: null,
            label: null,
          };
        });
      }
    } else {
      // Solana: use existing provider (Helius / Solscan)
      const provider = getChainProvider(chainId);
      holders = await provider.getTopHolders(address, 50);
    }

    // Only cache if we actually got data — don't poison the cache with empty results
    if (holders.length > 0) {
      serverCache.set(cacheKey, holders, CACHE_TTL.TOKEN_META);
    }

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
