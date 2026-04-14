import { NextResponse } from "next/server";
import { getChainProvider } from "@/lib/chains/registry";
import { scrapeGmgnTopTraders } from "@/lib/api/gmgn-scraper";
import { serverCache, CACHE_TTL } from "@/lib/cache";
import type { ChainId } from "@/types/chain";
import type {
  CommonTrader,
  CommonTraderToken,
  CommonTradersRequest,
  CommonTradersResponse,
  TokenMeta,
} from "@/types/traders";

/** Per-wallet trading stats for one token */
interface WalletPnl {
  walletAddress: string;
  totalBought: number;
  totalSold: number;
  pnl: number;
  pnlUsd: number;
  // Rich fields from GMGN (optional)
  boughtUsd?: number;
  soldUsd?: number;
  avgBuyPrice?: number;
  avgSellPrice?: number;
  buyCount?: number;
  sellCount?: number;
  unrealizedPnlUsd?: number;
}

const ZERO_ADDRESSES = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
  "11111111111111111111111111111111",
]);

// Allow up to 5 minutes — GMGN scraping per token takes ~60s and tokens run in parallel
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as CommonTradersRequest;
    const { tokens } = body;

    if (!tokens || tokens.length < 2 || tokens.length > 10) {
      return NextResponse.json(
        { error: "Provide 2-10 tokens" },
        { status: 400 }
      );
    }

    // Phase 1: Fetch top traders + price per token in parallel
    const tokenResults = await Promise.all(tokens.map(async ({ chain, address, symbol: clientSymbol }): Promise<{
        chain: string;
        address: string;
        walletPnls: WalletPnl[];
        symbol: string;
        priceUsd: number | null;
        marketCap: number | null;
        fetchError: boolean;
      }> => {
        const cacheKey = `common-traders-gmgn-v2:${chain}:${address}`;
        const cached = serverCache.get<{
          walletPnls: WalletPnl[];
          symbol: string;
          priceUsd: number | null;
          marketCap: number | null;
        }>(cacheKey);
        if (cached) return { chain, address, ...cached, fetchError: false };

        const provider = getChainProvider(chain);
        const [pairData, metadata] = await Promise.all([
          provider.getPairData(address),
          provider.getTokenMetadata(address),
        ]);

        const symbol = metadata?.symbol || clientSymbol || "???";
        const priceUsd = pairData?.priceUsd ?? null;
        const marketCap = pairData?.marketCap ?? pairData?.fdv ?? null;

        // Build per-wallet buy/sell totals
        const walletStats = new Map<string, {
          totalBought: number;
          totalSold: number;
          boughtUsd?: number;
          soldUsd?: number;
          avgBuyPrice?: number;
          avgSellPrice?: number;
          buyCount?: number;
          sellCount?: number;
          realizedPnlUsd?: number;
          unrealizedPnlUsd?: number;
        }>();

        // GMGN scraper for all chains (Solana + EVM).
        // Solana addresses are case-sensitive and passed as-is; EVM are lowercased inside the scraper.
        const gmgnTraders = await scrapeGmgnTopTraders(chain, address).catch(() => []);
        let usedGmgn = false;

        if (gmgnTraders.length > 0) {
          console.log(`[common-traders] GMGN: ${gmgnTraders.length} traders for ${chain}:${address}`);
          usedGmgn = true;
          for (const t of gmgnTraders) {
            // Solana wallets are base58 (case-sensitive); EVM lowercase for dedup consistency
            const addr = chain === "solana" ? t.walletAddress : t.walletAddress.toLowerCase();
            if (ZERO_ADDRESSES.has(addr)) continue;
            walletStats.set(addr, {
              totalBought: t.avgCostUsd > 0 ? t.historyBoughtCostUsd / t.avgCostUsd : t.balance,
              totalSold: t.avgSoldUsd > 0 ? t.historySoldIncomeUsd / t.avgSoldUsd : 0,
              boughtUsd: t.historyBoughtCostUsd,
              soldUsd: t.historySoldIncomeUsd,
              avgBuyPrice: t.avgCostUsd,
              avgSellPrice: t.avgSoldUsd,
              buyCount: t.buyCount,
              sellCount: t.sellCount,
              realizedPnlUsd: t.realizedProfitUsd,
              unrealizedPnlUsd: t.unrealizedProfitUsd,
            });
          }
        } else {
          console.log(`[common-traders] GMGN returned 0 for ${chain}:${address} — marking as failed`);
          return { chain, address, walletPnls: [], symbol: clientSymbol ?? "???", priceUsd: null, marketCap: null, fetchError: true };
        }

        // Compute PnL per wallet — use exact realizedPnlUsd from GMGN when available,
        // otherwise approximate via current price × net token position
        const walletPnls: WalletPnl[] = [];
        for (const [walletAddress, stats] of walletStats) {
          const pnl = stats.totalSold - stats.totalBought;
          const pnlUsd = stats.realizedPnlUsd ?? (priceUsd ? pnl * priceUsd : 0);
          walletPnls.push({
            walletAddress,
            totalBought: stats.totalBought,
            totalSold: stats.totalSold,
            pnl,
            pnlUsd,
            boughtUsd: stats.boughtUsd,
            soldUsd: stats.soldUsd,
            avgBuyPrice: stats.avgBuyPrice,
            avgSellPrice: stats.avgSellPrice,
            buyCount: stats.buyCount,
            sellCount: stats.sellCount,
            unrealizedPnlUsd: stats.unrealizedPnlUsd,
          });
        }

        const resultData = { walletPnls, symbol, priceUsd, marketCap };
        // Only cache when GMGN data was used; Solana is always authoritative.
        if (usedGmgn) {
          serverCache.set(cacheKey, resultData, CACHE_TTL.GMGN_TRADERS);
        }

        return { chain, address, ...resultData, fetchError: false };
      })
    );

    // Surface per-token fetch failures
    const failedTokens = tokenResults.filter((tr) => tr.fetchError);
    if (failedTokens.length > 0) {
      const names = failedTokens
        .map((tr) => `${tr.symbol !== "???" ? tr.symbol : tr.address.slice(0, 10) + "…"} (${tr.chain})`)
        .join(", ");
      return NextResponse.json(
        { error: `Could not fetch trader data for: ${names}. GMGN may be temporarily unavailable — please try again in a moment.` },
        { status: 503 }
      );
    }

    // Phase 2: Build tokensMeta
    const tokensMeta: TokenMeta[] = tokenResults.map((tr) => ({
      address: tr.address,
      symbol: tr.symbol,
      chain: tr.chain as ChainId,
      priceUsd: tr.priceUsd,
      marketCap: tr.marketCap,
    }));

    // Phase 3: Intersect wallets across tokens
    const walletMap = new Map<
      string,
      Map<string, { token: CommonTraderToken; originalAddress: string }>
    >();

    for (const tr of tokenResults) {
      const tokenKey = `${tr.chain}:${tr.address}`;
      for (const wp of tr.walletPnls) {
        const key =
          tr.chain === "solana"
            ? wp.walletAddress
            : wp.walletAddress.toLowerCase();

        if (!walletMap.has(key)) {
          walletMap.set(key, new Map());
        }

        const existing = walletMap.get(key)!.get(tokenKey);
        if (!existing) {
          walletMap.get(key)!.set(tokenKey, {
            token: {
              address: tr.address,
              symbol: tr.symbol,
              chain: tr.chain as ChainId,
              totalBought: wp.totalBought,
              totalSold: wp.totalSold,
              pnl: wp.pnl,
              pnlUsd: wp.pnlUsd,
              boughtUsd: wp.boughtUsd,
              soldUsd: wp.soldUsd,
              avgBuyPrice: wp.avgBuyPrice,
              avgSellPrice: wp.avgSellPrice,
              buyCount: wp.buyCount,
              sellCount: wp.sellCount,
              unrealizedPnlUsd: wp.unrealizedPnlUsd,
            },
            originalAddress: wp.walletAddress,
          });
        }
      }
    }

    // Filter to wallets appearing in 2+ token trade lists
    const traders: CommonTrader[] = [];

    for (const [, tokenEntries] of walletMap) {
      if (tokenEntries.size < 2) continue;

      const entries = Array.from(tokenEntries.values());
      const traderTokens = entries.map((e) => e.token);
      const totalPnlUsd = traderTokens.reduce((sum, t) => sum + t.pnlUsd, 0);

      traders.push({
        walletAddress: entries[0].originalAddress,
        tokens: traderTokens,
        totalPnlUsd,
        tokenCount: tokenEntries.size,
      });
    }

    // Sort by total PnL descending (most profitable first)
    traders.sort((a, b) => b.totalPnlUsd - a.totalPnlUsd);

    const response: CommonTradersResponse = {
      traders: traders.slice(0, 100),
      tokensMeta,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("Common traders error:", error);
    return NextResponse.json(
      { error: "Failed to find common traders" },
      { status: 500 }
    );
  }
}
