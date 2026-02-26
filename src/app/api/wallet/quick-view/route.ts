import { NextResponse } from "next/server";
import { getChainProvider, isChainSupported } from "@/lib/chains/registry";
import { CHAIN_CONFIGS } from "@/config/chains";
import * as helius from "@/lib/api/helius";
import { serverCache, CACHE_TTL } from "@/lib/cache";
import type { ChainId } from "@/types/chain";
import type {
  WalletQuickViewData,
  StablecoinBalance,
  WalletPosition,
  PnlHistoryEntry,
} from "@/types/traders";

const SOLANA_STABLES: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": "PYUSD",
};

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

// SOL mints that appear in balance changes
const SOL_MINTS = new Set([
  "So11111111111111111111111111111111111111111",
  "So11111111111111111111111111111111111111112",
]);

function isStableMint(mint: string, chainId: ChainId): boolean {
  if (chainId === "solana") return !!SOLANA_STABLES[mint];
  const stableMap = EVM_STABLES_LOWER[chainId] ?? {};
  return !!stableMap[mint.toLowerCase()];
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { walletAddress, chain } = body as {
      walletAddress: string;
      chain: string;
    };

    if (!walletAddress || !chain || !isChainSupported(chain)) {
      return NextResponse.json(
        { error: "Invalid wallet address or chain" },
        { status: 400 }
      );
    }

    const chainId = chain as ChainId;
    const cacheKey = `wallet-quick:${chainId}:${walletAddress}`;
    const cached = serverCache.get<WalletQuickViewData>(cacheKey);
    if (cached) return NextResponse.json(cached);

    const provider = getChainProvider(chainId);
    const chainConfig = CHAIN_CONFIGS[chainId];

    // Fetch wallet balance (uses Helius v1/wallet/{w}/balances for Solana)
    const walletBalance = await provider.getWalletBalance(walletAddress);

    // Extract stablecoins
    const stablecoins: StablecoinBalance[] = [];
    let stablecoinTotal = 0;

    for (const tok of walletBalance.tokens) {
      let stableSymbol: string | null = null;
      if (chainId === "solana") {
        stableSymbol = SOLANA_STABLES[tok.tokenAddress] ?? null;
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

    // Build active positions (non-stablecoin tokens with value)
    const activePositions: WalletPosition[] = walletBalance.tokens
      .filter((tok) => {
        if (chainId === "solana")
          return !SOLANA_STABLES[tok.tokenAddress];
        const stableMap = EVM_STABLES_LOWER[chainId] ?? {};
        return !stableMap[tok.tokenAddress.toLowerCase()];
      })
      .filter((tok) => tok.balance > 0 && (tok.balanceUsd ?? 0) >= 0.01)
      .map((tok) => ({
        tokenAddress: tok.tokenAddress,
        symbol: tok.symbol,
        name: tok.name,
        logoUrl: tok.logoUrl,
        chain: chainId,
        balance: tok.balance,
        balanceUsd: tok.balanceUsd ?? 0,
        pnl: 0,
        pnlPercent: 0,
        entryPrice: null,
        currentPrice: tok.priceUsd,
        totalBoughtUsd: 0,
        totalSoldUsd: 0,
        unrealizedPnl: 0,
      }))
      .sort((a, b) => b.balanceUsd - a.balanceUsd)
      .slice(0, 20);

    // Build a price lookup from current holdings
    const priceMap = new Map<string, number>();
    for (const tok of walletBalance.tokens) {
      if (tok.priceUsd) priceMap.set(tok.tokenAddress, tok.priceUsd);
    }
    const symbolMap = new Map<string, string>();
    for (const tok of walletBalance.tokens) {
      symbolMap.set(tok.tokenAddress, tok.symbol);
    }

    // Fetch transaction history using Helius v1 wallet history
    const recentPnls: PnlHistoryEntry[] = [];
    const topBuys: PnlHistoryEntry[] = [];
    const recentActivity: WalletQuickViewData["recentActivity"] = [];

    // 7d tracking: per-mint buys/sells within 7 days
    const nowMs = Date.now();
    const sevenDaysAgoSec = Math.floor((nowMs - 7 * 24 * 60 * 60 * 1000) / 1000);
    const thirtyDaysAgoSec = Math.floor((nowMs - 30 * 24 * 60 * 60 * 1000) / 1000);
    // Per-mint buy USD within 7d
    const buys7d = new Map<string, number>();
    // Per-mint sell USD within 7d
    const sells7d = new Map<string, number>();
    // Best single sell PnL in 30d / 7d
    let bestTrade30d: { symbol: string; pnl: number } | null = null;
    let bestTrade7d: { symbol: string; pnl: number } | null = null;
    // Windowed PnL accumulators (realized profit: sell proceeds − cost basis)
    let pnl7dAccum = 0;
    let pnl30dAccum = 0;
    // Per-mint total bought/sold USD (all-time, for position enrichment)
    const mintTotalBoughtUsd = new Map<string, number>();
    const mintTotalSoldUsd = new Map<string, number>();

    if (chainId === "solana") {
      // Derive current SOL price from wallet balance (no extra API call)
      const solPriceUsd =
        walletBalance.nativeBalance > 0
          ? walletBalance.nativeBalanceUsd / walletBalance.nativeBalance
          : 0;

      // Average cost basis ledger per token
      const costLedger = new Map<
        string,
        { totalBoughtAmount: number; totalCostUsd: number }
      >();

      // Fetch parsed swap history via v0 API (filters SWAP client-side, up to 10 pages)
      const swapTxns = await helius.getParsedSwapsAll(walletAddress, {
        maxPages: 10,
        limit: 100,
      });

      // Reverse to chronological order so buys are processed before their sells
      swapTxns.reverse();

      // Resolve token names for mints not in current portfolio
      const unknownMints: string[] = [];
      for (const tx of swapTxns) {
        for (const tt of tx.tokenTransfers) {
          if (
            !SOL_MINTS.has(tt.mint) &&
            !isStableMint(tt.mint, chainId) &&
            !symbolMap.has(tt.mint)
          ) {
            unknownMints.push(tt.mint);
          }
        }
      }
      if (unknownMints.length > 0) {
        const assetInfo = await helius.getAssetBatch([
          ...new Set(unknownMints),
        ]);
        for (const [mint, info] of assetInfo) {
          symbolMap.set(mint, info.symbol);
        }
      }

      for (const tx of swapTxns) {
        if (!tx.timestamp) continue;

        // Compute net token flows per mint for this wallet
        const netChanges = new Map<string, number>();
        for (const tt of tx.tokenTransfers) {
          let delta = 0;
          if (tt.toUserAccount === walletAddress) delta += tt.tokenAmount;
          if (tt.fromUserAccount === walletAddress) delta -= tt.tokenAmount;
          if (delta !== 0) {
            netChanges.set(tt.mint, (netChanges.get(tt.mint) ?? 0) + delta);
          }
        }

        // Identify what was bought (positive non-SOL, non-stable token)
        // and what was spent (negative SOL/stables = cost)
        let boughtMint: string | null = null;
        let boughtAmount = 0;
        let soldMint: string | null = null;
        let soldAmount = 0;
        let costUsd = 0;
        let receivedUsd = 0;

        for (const [mint, amount] of netChanges) {
          // Track SOL flows as USD cost/proceeds
          if (SOL_MINTS.has(mint)) {
            if (amount < 0)
              costUsd += Math.abs(amount) * solPriceUsd; // SOL spent = cost
            if (amount > 0)
              receivedUsd += amount * solPriceUsd; // SOL received = proceeds
            continue; // still skip SOL for buy/sell token identification
          }

          if (amount > 0 && !isStableMint(mint, chainId)) {
            // Bought a token
            boughtMint = mint;
            boughtAmount = amount;
            const price = priceMap.get(mint) ?? 0;
            receivedUsd = amount * price;
          } else if (amount < 0 && !isStableMint(mint, chainId)) {
            // Sold a token
            soldMint = mint;
            soldAmount = Math.abs(amount);
          }

          // Track stablecoin flows for USD value
          if (isStableMint(mint, chainId)) {
            if (amount > 0) {
              receivedUsd += Math.abs(amount); // Stables received = profit in USD
            } else {
              costUsd += Math.abs(amount); // Stables spent = cost in USD
            }
          }
        }

        // If we received SOL/stables (sold token → got SOL/stables) = sell
        if (soldMint && receivedUsd > 0) {
          const symbol = symbolMap.get(soldMint) ?? soldMint.slice(0, 6);

          // Compute real PnL using average cost basis
          const entry = costLedger.get(soldMint);
          let costBasis = 0;
          if (entry && entry.totalBoughtAmount > 0) {
            const avgCost = entry.totalCostUsd / entry.totalBoughtAmount;
            costBasis = soldAmount * avgCost;
            // Deduct sold amount from ledger
            entry.totalBoughtAmount -= soldAmount;
            entry.totalCostUsd -= costBasis;
          }
          const realizedPnl = receivedUsd - costBasis;

          recentActivity.push({
            txHash: tx.signature,
            timestamp: tx.timestamp,
            side: "sell",
            tokenSymbol: symbol,
            amount: soldAmount,
            amountUsd: receivedUsd,
          });
          recentPnls.push({
            tokenAddress: soldMint,
            symbol,
            chain: chainId,
            realizedPnl,
            timestamp: tx.timestamp,
            side: "sell",
            amount: soldAmount,
          });

          mintTotalSoldUsd.set(soldMint, (mintTotalSoldUsd.get(soldMint) ?? 0) + receivedUsd);

          // 7d sell tracking (existence used by freshBuys7d)
          if (tx.timestamp >= sevenDaysAgoSec) {
            sells7d.set(soldMint, (sells7d.get(soldMint) ?? 0) + receivedUsd);
            pnl7dAccum += realizedPnl;
          }
          // Windowed PnL: add realized profit from this sell
          if (tx.timestamp >= thirtyDaysAgoSec) {
            pnl30dAccum += realizedPnl;
          }
          // Best single-trade tracking (30d and 7d)
          if (tx.timestamp >= thirtyDaysAgoSec) {
            if (!bestTrade30d || realizedPnl > bestTrade30d.pnl) {
              bestTrade30d = { symbol, pnl: realizedPnl };
            }
          }
          if (tx.timestamp >= sevenDaysAgoSec) {
            if (!bestTrade7d || realizedPnl > bestTrade7d.pnl) {
              bestTrade7d = { symbol, pnl: realizedPnl };
            }
          }
        }

        // If we received a token (spent SOL/stables → got token) = buy
        if (boughtMint) {
          const symbol = symbolMap.get(boughtMint) ?? boughtMint.slice(0, 6);
          const buyUsd = costUsd > 0 ? costUsd : receivedUsd;
          recentActivity.push({
            txHash: tx.signature,
            timestamp: tx.timestamp,
            side: "buy",
            tokenSymbol: symbol,
            amount: boughtAmount,
            amountUsd: buyUsd,
          });
          topBuys.push({
            tokenAddress: boughtMint,
            symbol,
            chain: chainId,
            realizedPnl: buyUsd,
            timestamp: tx.timestamp,
            side: "buy",
            amount: boughtAmount,
          });

          mintTotalBoughtUsd.set(boughtMint, (mintTotalBoughtUsd.get(boughtMint) ?? 0) + buyUsd);

          // Record cost basis for this buy
          const ledgerEntry = costLedger.get(boughtMint) ?? {
            totalBoughtAmount: 0,
            totalCostUsd: 0,
          };
          ledgerEntry.totalBoughtAmount += boughtAmount;
          ledgerEntry.totalCostUsd += buyUsd;
          costLedger.set(boughtMint, ledgerEntry);

          // 7d buy tracking (per-mint, used by freshBuys7d)
          if (tx.timestamp >= sevenDaysAgoSec) {
            buys7d.set(boughtMint, (buys7d.get(boughtMint) ?? 0) + buyUsd);
          }
        }
      }

    }

    // Enrich active positions with buy/sell totals and unrealized PnL
    for (const pos of activePositions) {
      pos.totalBoughtUsd = mintTotalBoughtUsd.get(pos.tokenAddress) ?? 0;
      pos.totalSoldUsd = mintTotalSoldUsd.get(pos.tokenAddress) ?? 0;
      // Total PnL = current value + what you cashed out − what you put in
      pos.unrealizedPnl = pos.balanceUsd + pos.totalSoldUsd - pos.totalBoughtUsd;
    }

    // Sort activity by timestamp desc
    recentActivity.sort((a, b) => b.timestamp - a.timestamp);
    // PNLs: highest USD first
    recentPnls.sort((a, b) => b.realizedPnl - a.realizedPnl);
    // Top buys: highest USD first
    topBuys.sort((a, b) => b.realizedPnl - a.realizedPnl);

    // Generate PNL history (last 30 days, aggregate by day)
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    const pnlByDay = new Map<string, number>();

    for (let d = 0; d < 30; d++) {
      const date = new Date(thirtyDaysAgo + d * 24 * 60 * 60 * 1000);
      const key = date.toISOString().slice(0, 10);
      pnlByDay.set(key, 0);
    }

    // Aggregate realized PnL by day (sell proceeds − cost basis)
    for (const entry of recentPnls) {
      const date = new Date(entry.timestamp * 1000)
        .toISOString()
        .slice(0, 10);
      if (pnlByDay.has(date)) {
        pnlByDay.set(date, (pnlByDay.get(date) ?? 0) + entry.realizedPnl);
      }
    }

    // Build cumulative PNL history
    const pnlHistory: { date: string; pnl: number }[] = [];
    let cumPnl = 0;
    for (const [date, dailyPnl] of pnlByDay) {
      cumPnl += dailyPnl;
      pnlHistory.push({ date, pnl: cumPnl });
    }

    const pnl30d = pnl30dAccum;
    const pnl7d = pnl7dAccum;

    // Fresh buys: tokens bought in 7d with no sells in 7d, still held
    const heldMints = new Set(activePositions.map((p) => p.tokenAddress));
    const freshBuys7d: WalletQuickViewData["freshBuys7d"] = [];
    for (const [mint, boughtUsd] of buys7d) {
      if (!sells7d.has(mint) && heldMints.has(mint)) {
        const symbol = symbolMap.get(mint) ?? mint.slice(0, 6);
        freshBuys7d.push({ tokenAddress: mint, symbol, boughtUsd });
      }
    }
    freshBuys7d.sort((a, b) => b.boughtUsd - a.boughtUsd);

    const result: WalletQuickViewData = {
      address: walletAddress,
      chain: chainId,
      nativeBalance: walletBalance.nativeBalance,
      nativeBalanceUsd: walletBalance.nativeBalanceUsd,
      nativeSymbol: chainConfig.nativeCurrency.symbol,
      stablecoinTotal,
      stablecoins,
      pnl30d,
      pnl7d,
      bestTrade30d,
      bestTrade7d,
      freshBuys7d,
      pnlHistory,
      activePositions,
      recentPnls: recentPnls.slice(0, 20),
      topBuys: topBuys.slice(0, 10),
      recentActivity: recentActivity.slice(0, 30),
    };

    serverCache.set(cacheKey, result, CACHE_TTL.WALLET_QUICK);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Wallet quick view error:", error);
    return NextResponse.json(
      { error: "Failed to fetch wallet data" },
      { status: 500 }
    );
  }
}
