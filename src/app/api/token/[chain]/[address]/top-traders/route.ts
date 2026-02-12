import { NextResponse } from "next/server";
import { getChainProvider, isChainSupported } from "@/lib/chains/registry";
import { CHAIN_CONFIGS } from "@/config/chains";
import * as helius from "@/lib/api/helius";
import { serverCache, CACHE_TTL } from "@/lib/cache";
import type { ChainId } from "@/types/chain";
import type {
  TopTrader,
  TopTradersResponse,
  TraderTier,
  StablecoinBalance,
} from "@/types/traders";

// Known stablecoin mints on Solana
const SOLANA_STABLES: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": "PYUSD",
};

// Known stablecoin addresses on EVM
const EVM_STABLES_LOWER: Record<string, Record<string, string>> = {
  base: {
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC",
    "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": "DAI",
  },
  bsc: {
    "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": "USDC",
    "0x55d398326f99059ff775485246999027b3197955": "USDT",
    "0xe9e7cea3dedca5984780bafc599bd69add087d56": "BUSD",
  },
};

function getTier(pnlUsd: number): TraderTier {
  const abs = Math.abs(pnlUsd);
  if (abs >= 50_000) return "whale";
  if (abs >= 10_000) return "dolphin";
  if (abs >= 1_000) return "fish";
  if (abs >= 100) return "crab";
  return "shrimp";
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ chain: string; address: string }> }
) {
  try {
    const { chain, address } = await params;

    if (!isChainSupported(chain)) {
      return NextResponse.json(
        { error: `Chain "${chain}" not supported` },
        { status: 400 }
      );
    }

    const chainId = chain as ChainId;
    const cacheKey = `top-traders:${chainId}:${address}`;
    const cached = serverCache.get<TopTradersResponse>(cacheKey);
    if (cached) return NextResponse.json(cached);

    const provider = getChainProvider(chainId);
    const chainConfig = CHAIN_CONFIGS[chainId];

    // Step 1: Get token pair data + holders
    const [pairData, holders] = await Promise.all([
      provider.getPairData(address),
      provider.getTopHolders(address, 50),
    ]);

    const priceUsd = pairData?.priceUsd ?? null;
    const marketCap = pairData?.marketCap ?? null;
    const tokenSymbol =
      pairData?.primaryPair?.baseToken?.symbol ?? "???";

    // Step 2: Resolve holder addresses to owner wallets (Solana PDA resolution)
    let ownerAddresses: string[];
    if (chainId === "solana") {
      const ownerMap = await helius.getMultipleAccountOwners(
        holders.map((h) => h.address)
      );
      ownerAddresses = holders.map(
        (h) => ownerMap.get(h.address) ?? h.address
      );
    } else {
      ownerAddresses = holders.map((h) => h.address);
    }

    // Step 3: For each holder, fetch wallet balance + trade history
    const traderPromises = ownerAddresses.map(async (walletAddr, idx) => {
      const holder = holders[idx];

      try {
        // Fetch wallet balance for native + stablecoin info
        const walletBalance = await provider.getWalletBalance(walletAddr);

        // Calculate stablecoin balances from token holdings
        const stablecoins: StablecoinBalance[] = [];
        let stablecoinTotal = 0;

        for (const tok of walletBalance.tokens) {
          let stableSymbol: string | null = null;

          if (chainId === "solana") {
            stableSymbol =
              SOLANA_STABLES[tok.tokenAddress] ?? null;
          } else {
            const stableMap = EVM_STABLES_LOWER[chainId] ?? {};
            stableSymbol =
              stableMap[tok.tokenAddress.toLowerCase()] ?? null;
          }

          if (stableSymbol) {
            const bal = tok.balanceUsd ?? tok.balance;
            stablecoins.push({
              symbol: stableSymbol,
              balance: tok.balance,
              balanceUsd: tok.balanceUsd ?? tok.balance,
            });
            stablecoinTotal += bal;
          }
        }

        // Fetch trade history using Helius v1 wallet history
        let avgBuyAmount = 0;
        let avgBuyAmountUsd = 0;
        let avgBuyMarketCap: number | null = null;
        let avgSellMarketCap: number | null = null;
        let avgSellPrice: number | null = null;
        let totalBoughtTokens = 0;
        let totalSoldTokens = 0;
        let lastTradeTimestamp: number | null = null;
        let tradeCount = 0;

        if (chainId === "solana") {
          // Fetch swap history for this wallet (1 page = 100 swaps)
          const history = await helius.getWalletHistoryAll(walletAddr, {
            maxPages: 1,
            limit: 100,
            type: "SWAP",
          });

          const buys: { amount: number; timestamp: number }[] = [];
          const sells: { amount: number; timestamp: number }[] = [];

          for (const tx of history) {
            if (tx.error || !tx.timestamp) continue;

            // Aggregate balance changes by mint
            const netChanges = new Map<string, number>();
            for (const bc of tx.balanceChanges) {
              const cur = netChanges.get(bc.mint) ?? 0;
              netChanges.set(bc.mint, cur + bc.amount);
            }

            const tokenChange = netChanges.get(address);
            if (!tokenChange || tokenChange === 0) continue;

            if (tokenChange > 0) {
              buys.push({ amount: tokenChange, timestamp: tx.timestamp });
            } else {
              sells.push({
                amount: Math.abs(tokenChange),
                timestamp: tx.timestamp,
              });
            }
          }

          tradeCount = buys.length + sells.length;

          if (buys.length > 0) {
            totalBoughtTokens = buys.reduce((s, b) => s + b.amount, 0);
            avgBuyAmount = totalBoughtTokens / buys.length;
            avgBuyAmountUsd = priceUsd ? avgBuyAmount * priceUsd : 0;
            avgBuyMarketCap = marketCap;
          }

          if (sells.length > 0) {
            totalSoldTokens = sells.reduce((s, b) => s + b.amount, 0);
            avgSellPrice = priceUsd;
            avgSellMarketCap = marketCap;
          }

          const allTimestamps = [
            ...buys.map((b) => b.timestamp),
            ...sells.map((s) => s.timestamp),
          ];
          if (allTimestamps.length > 0) {
            lastTradeTimestamp = Math.max(...allTimestamps);
          }
        }

        // PNL: total sold - total bought + remaining value (all in token units)
        const remaining = holder.balance;
        const realizedPnlTokens =
          totalSoldTokens - totalBoughtTokens + remaining;
        const realizedPnlUsd = priceUsd
          ? realizedPnlTokens * priceUsd
          : 0;

        const trader: TopTrader = {
          walletAddress: walletAddr,
          nativeBalance: walletBalance.nativeBalance,
          nativeBalanceUsd: walletBalance.nativeBalanceUsd,
          stablecoinTotal,
          stablecoins,
          avgBuyAmount,
          avgBuyAmountUsd,
          avgBuyMarketCap,
          avgSellMarketCap,
          avgSellPrice,
          realizedPnl: realizedPnlTokens,
          realizedPnlUsd,
          remainingTokens: remaining,
          remainingTokensUsd: priceUsd ? remaining * priceUsd : 0,
          lastTradeTimestamp,
          tier: getTier(Math.abs(realizedPnlUsd)),
          tradeCount,
        };

        return trader;
      } catch {
        return {
          walletAddress: walletAddr,
          nativeBalance: 0,
          nativeBalanceUsd: 0,
          stablecoinTotal: 0,
          stablecoins: [],
          avgBuyAmount: 0,
          avgBuyAmountUsd: 0,
          avgBuyMarketCap: null,
          avgSellMarketCap: null,
          avgSellPrice: null,
          realizedPnl: 0,
          realizedPnlUsd: 0,
          remainingTokens: holder.balance,
          remainingTokensUsd: priceUsd
            ? holder.balance * priceUsd
            : 0,
          lastTradeTimestamp: null,
          tier: "shrimp" as TraderTier,
          tradeCount: 0,
        } satisfies TopTrader;
      }
    });

    // Limit concurrency — process 5 at a time
    const traders: TopTrader[] = [];
    const BATCH = 5;
    for (let i = 0; i < traderPromises.length; i += BATCH) {
      const batch = await Promise.all(
        traderPromises.slice(i, i + BATCH)
      );
      traders.push(...batch);
    }

    // Sort by realized PNL descending
    traders.sort(
      (a, b) => Math.abs(b.realizedPnlUsd) - Math.abs(a.realizedPnlUsd)
    );

    const response: TopTradersResponse = {
      traders: traders.slice(0, 50),
      tokenSymbol,
      tokenPriceUsd: priceUsd,
      nativeSymbol: chainConfig.nativeCurrency.symbol,
    };

    serverCache.set(cacheKey, response, CACHE_TTL.TOP_TRADERS);

    return NextResponse.json(response);
  } catch (error) {
    console.error("Top traders error:", error);
    return NextResponse.json(
      { error: "Failed to fetch top traders" },
      { status: 500 }
    );
  }
}
