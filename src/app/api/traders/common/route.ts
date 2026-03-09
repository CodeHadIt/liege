import { NextResponse } from "next/server";
import { getChainProvider } from "@/lib/chains/registry";
import { scrapeTopTraders } from "@/lib/api/dexscreener-scraper";
import * as helius from "@/lib/api/helius";
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
        const cacheKey = `common-traders-pnl-v2:${chain}:${address}`;
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
        const walletStats = new Map<
          string,
          { totalBought: number; totalSold: number }
        >();

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
          // EVM: scrape top traders from DexScreener
          const topTraders = await scrapeTopTraders(chain, address);

          for (const trader of topTraders) {
            const key = trader.wallet.toLowerCase();
            if (ZERO_ADDRESSES.has(key)) continue;

            walletStats.set(key, {
              totalBought: trader.tokensBought,
              totalSold: trader.tokensSold,
            });
          }
        }

        // Compute PnL per wallet
        const walletPnls: WalletPnl[] = [];
        const DEBUG_WALLET = "0xacaf65505d9a48cd7a9be7eba5f25d886792354a";
        for (const [walletAddress, stats] of walletStats) {
          const pnl = stats.totalSold - stats.totalBought;
          const pnlUsd = priceUsd ? pnl * priceUsd : 0;
          const remaining = stats.totalBought - stats.totalSold;
          const unrealizedUsd =
            remaining > 0 && priceUsd ? remaining * priceUsd : 0;

          if (walletAddress.toLowerCase() === DEBUG_WALLET) {
            console.log(
              `\n=== DEBUG WALLET ${DEBUG_WALLET} on ${symbol} (${address}) ===`
            );
            console.log(`  Price USD:       $${priceUsd}`);
            console.log(
              `  Total Bought:    ${stats.totalBought.toLocaleString()} tokens`
            );
            console.log(
              `  Total Sold:      ${stats.totalSold.toLocaleString()} tokens`
            );
            console.log(
              `  Remaining:       ${remaining.toLocaleString()} tokens`
            );
            console.log(
              `  Realized PnL:    ${pnl.toLocaleString()} tokens ($${pnlUsd.toFixed(2)})`
            );
            console.log(
              `  Unrealized:      ${remaining > 0 ? remaining.toLocaleString() : 0} tokens ($${unrealizedUsd.toFixed(2)})`
            );
            console.log(`===\n`);
          }

          walletPnls.push({
            walletAddress,
            totalBought: stats.totalBought,
            totalSold: stats.totalSold,
            pnl,
            pnlUsd,
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

    // Debug: check if target wallet made it as common trader
    const DEBUG_WALLET = "0xacaf65505d9a48cd7a9be7eba5f25d886792354a";
    const debugTrader = traders.find(
      (t) => t.walletAddress.toLowerCase() === DEBUG_WALLET
    );
    if (debugTrader) {
      const rank = traders.indexOf(debugTrader) + 1;
      console.log(`\n=== DEBUG: ${DEBUG_WALLET} IS A COMMON TRADER ===`);
      console.log(`  Rank: #${rank} of ${traders.length}`);
      console.log(`  Token Count: ${debugTrader.tokenCount}`);
      console.log(`  Total PnL USD: $${debugTrader.totalPnlUsd.toFixed(2)}`);
      for (const t of debugTrader.tokens) {
        console.log(
          `  ${t.symbol}: bought=${t.totalBought.toLocaleString()} sold=${t.totalSold.toLocaleString()} pnl=$${t.pnlUsd.toFixed(2)}`
        );
      }
      console.log(`===\n`);
    } else {
      console.log(
        `\n=== DEBUG: ${DEBUG_WALLET} NOT found as common trader ===`
      );
      console.log(`  Total common traders: ${traders.length}`);
      for (const tr of tokenResults) {
        const found = tr.walletPnls.find(
          (wp) => wp.walletAddress.toLowerCase() === DEBUG_WALLET
        );
        console.log(
          `  ${tr.symbol} (${tr.address}): ${found ? `FOUND - bought=${found.totalBought} sold=${found.totalSold}` : "NOT found"}`
        );
      }
      console.log(`===\n`);
    }

    // Temporary debug: check target wallet presence per token
    const DEBUG_TARGET = "0xacaf65505d9a48cd7a9be7eba5f25d886792354a";
    const debugPerToken = tokenResults.map((tr) => {
      const found = tr.walletPnls.find(
        (wp) => wp.walletAddress.toLowerCase() === DEBUG_TARGET
      );
      return {
        symbol: tr.symbol,
        address: tr.address,
        totalWallets: tr.walletPnls.length,
        targetFound: !!found,
        targetData: found || null,
      };
    });

    const response: CommonTradersResponse = {
      traders: traders.slice(0, 100),
      tokensMeta,
    };

    return NextResponse.json({ ...response, _debug: debugPerToken });
  } catch (error) {
    console.error("Common traders error:", error);
    return NextResponse.json(
      { error: "Failed to find common traders" },
      { status: 500 }
    );
  }
}
