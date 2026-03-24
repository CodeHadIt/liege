import { NextResponse } from "next/server";
import { getChainProvider } from "@/lib/chains/registry";
import { getMoralisTopTraders } from "@/lib/api/moralis-traders";
import { getTokenTopTraders } from "@/lib/api/coingecko";
import { scrapeGmgnTopTraders } from "@/lib/api/gmgn-scraper";
import * as helius from "@/lib/api/helius";
import { serverCache, CACHE_TTL } from "@/lib/cache";
import { getChainConfig } from "@/config/chains";
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

    // Phase 1: Fetch top traders + price per token (sequential to avoid rate-limiting)
    const tokenResults = [];
    for (const { chain, address, symbol: clientSymbol } of tokens) {
      const result = await (async () => {
        const cacheKey = `common-traders-dex-v1:${chain}:${address}`;
        const cached = serverCache.get<{
          walletPnls: WalletPnl[];
          symbol: string;
          priceUsd: number | null;
        }>(cacheKey);
        if (cached) return { chain, address, ...cached };

        const provider = getChainProvider(chain);
        const [pairData, metadata] = await Promise.all([
          provider.getPairData(address),
          provider.getTokenMetadata(address),
        ]);

        const symbol = metadata?.symbol || clientSymbol || "???";
        const priceUsd = pairData?.priceUsd ?? null;

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

        if (chain === "solana") {
          // Helius: fetch parsed swaps for the token mint address
          const swaps = await helius.getParsedSwapsAll(address, {
            maxPages: 5,
            limit: 100,
          });

          for (const tx of swaps) {
            for (const transfer of tx.tokenTransfers) {
              if (transfer.mint !== address) continue;
              const amount = transfer.tokenAmount;
              if (amount <= 0) continue;

              const buyer = transfer.toUserAccount;
              if (buyer && !ZERO_ADDRESSES.has(buyer)) {
                const stats = walletStats.get(buyer) || {
                  totalBought: 0,
                  totalSold: 0,
                };
                stats.totalBought += amount;
                walletStats.set(buyer, stats);
              }

              const seller = transfer.fromUserAccount;
              if (seller && !ZERO_ADDRESSES.has(seller)) {
                const stats = walletStats.get(seller) || {
                  totalBought: 0,
                  totalSold: 0,
                };
                stats.totalSold += amount;
                walletStats.set(seller, stats);
              }
            }
          }
        } else {
          // EVM: GMGN scraper (primary, exact historical PnL)
          //      → Moralis (fallback) → GeckoTerminal (last resort)
          const geckoNetwork = getChainConfig(chain as ChainId).geckoTerminalNetwork;

          type TraderEntry = {
            address: string;
            tokensBought: number;
            tokensSold: number;
            boughtUsd?: number;
            soldUsd?: number;
            avgBuyPrice?: number;
            avgSellPrice?: number;
            buyCount?: number;
            sellCount?: number;
            realizedPnlUsd?: number;
            unrealizedPnlUsd?: number;
          };
          let traders: TraderEntry[] = [];

          // Primary: GMGN scraper — returns true top-100 traders with exact historical PnL
          const gmgnTraders = await scrapeGmgnTopTraders(chain, address).catch(() => []);
          if (gmgnTraders.length > 0) {
            console.log(`[common-traders] GMGN: ${gmgnTraders.length} traders for ${address}`);
            traders = gmgnTraders.map((t) => ({
              address: t.walletAddress.toLowerCase(),
              tokensBought: t.avgCostUsd > 0 ? t.historyBoughtCostUsd / t.avgCostUsd : t.balance,
              tokensSold: t.avgSoldUsd > 0 ? t.historySoldIncomeUsd / t.avgSoldUsd : 0,
              // Pass rich fields through for UI display
              boughtUsd: t.historyBoughtCostUsd,
              soldUsd: t.historySoldIncomeUsd,
              avgBuyPrice: t.avgCostUsd,
              avgSellPrice: t.avgSoldUsd,
              buyCount: t.buyCount,
              sellCount: t.sellCount,
              realizedPnlUsd: t.realizedProfitUsd,
              unrealizedPnlUsd: t.unrealizedProfitUsd,
            }));
          }

          // Fallback: Moralis paginated ERC-20 transfer history
          if (traders.length === 0) {
            console.log(`[common-traders] GMGN returned 0, trying Moralis for ${address}`);
            const moralisTraders = await getMoralisTopTraders(chain, geckoNetwork, address).catch(() => []);
            traders = moralisTraders.map((t) => ({
              address: t.address,
              tokensBought: t.tokensBought,
              tokensSold: t.tokensSold,
            }));
          }

          // Last resort: GeckoTerminal recent trades (~300)
          if (traders.length === 0) {
            console.log(`[common-traders] Moralis returned 0, trying GeckoTerminal for ${address}`);
            const geckoTraders = await getTokenTopTraders(geckoNetwork, address).catch(() => []);
            traders = geckoTraders.map((t) => ({
              address: t.address,
              tokensBought: t.tokensBought,
              tokensSold: t.tokensSold,
            }));
          }

          for (const trader of traders) {
            if (ZERO_ADDRESSES.has(trader.address)) continue;
            walletStats.set(trader.address, {
              totalBought: trader.tokensBought,
              totalSold: trader.tokensSold,
              boughtUsd: trader.boughtUsd,
              soldUsd: trader.soldUsd,
              avgBuyPrice: trader.avgBuyPrice,
              avgSellPrice: trader.avgSellPrice,
              buyCount: trader.buyCount,
              sellCount: trader.sellCount,
              realizedPnlUsd: trader.realizedPnlUsd,
              unrealizedPnlUsd: trader.unrealizedPnlUsd,
            });
          }
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

        const resultData = { walletPnls, symbol, priceUsd };
        serverCache.set(cacheKey, resultData, CACHE_TTL.HOLDERS);

        return { chain, address, ...resultData };
      })();
      tokenResults.push(result);
    }

    // Phase 2: Build tokensMeta
    const tokensMeta: TokenMeta[] = tokenResults.map((tr) => ({
      address: tr.address,
      symbol: tr.symbol,
      chain: tr.chain,
      priceUsd: tr.priceUsd,
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
              chain: tr.chain,
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
