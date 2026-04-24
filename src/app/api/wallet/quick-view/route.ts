import { NextResponse } from "next/server";
import { getChainProvider, isChainSupported } from "@/lib/chains/registry";
import { CHAIN_CONFIGS } from "@/config/chains";
import * as helius from "@/lib/api/helius";
import { serverCache, CACHE_TTL } from "@/lib/cache";
import { scrapeGmgnWalletHoldings } from "@/lib/api/gmgn-scraper";
import { getTokenPairs } from "@/lib/api/dexscreener";
import type { ChainId } from "@/types/chain";
import type {
  WalletQuickViewData,
  StablecoinBalance,
  WalletPosition,
  PnlHistoryEntry,
} from "@/types/traders";

// ─── Moralis EVM helpers ───────────────────────────────────────────────────────

const MORALIS_BASE = "https://deep-index.moralis.io/api/v2.2";

const MORALIS_CHAIN: Record<string, string> = {
  base: "0x2105",
  bsc:  "0x38",
  eth:  "0x1",
};

const EVM_NATIVE_SYMBOLS: Record<string, string> = {
  base: "ETH",
  bsc:  "BNB",
  eth:  "ETH",
};

async function fetchMoralisEvm<T>(path: string): Promise<T | null> {
  const apiKey = process.env.MORALIS_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(`${MORALIS_BASE}${path}`, {
      headers: { "X-API-Key": apiKey, Accept: "application/json" },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

interface MoralisTokenBalance {
  token_address: string;
  symbol: string;
  name: string;
  logo: string | null;
  thumbnail: string | null;
  decimals: string;
  balance_formatted: string;
  usd_price: number | null;
  usd_value: number | null;
  possible_spam: boolean;
  native_token: boolean;
}

interface MoralisTokensResponse {
  result: MoralisTokenBalance[];
  native_balance?: {
    balance: string;
    balance_formatted: string;
    usd: string | null;
  };
}

interface MoralisProfitabilityEntry {
  token_address: string;
  token_name: string;
  token_symbol: string;
  logo: string | null;
  total_tokens_bought: string;
  total_tokens_sold: string;
  total_sold_usd: string | null;
  total_usd_invested: string | null;
  avg_buy_price_usd: string | null;
  avg_sell_price_usd: string | null;
  realized_profit_usd: string | null;
  count_of_trades: number;
  last_trade: string | null;
}

interface MoralisNetWorthResponse {
  total_networth_usd: string;
  chains: {
    chain: string;
    native_balance: string;
    native_balance_formatted: string;
    native_balance_usd: string;
    token_balance_usd: string;
    networth_usd: string;
  }[];
}

interface MoralisSwapSide {
  address: string;
  symbol: string;
  logo: string | null;
  usdAmount: number;
  amount: string;
}

interface MoralisSwap {
  transactionType: "buy" | "sell";
  blockTimestamp: string;
  transactionHash: string;
  bought: MoralisSwapSide;
  sold: MoralisSwapSide;
  totalValueUsd: number;
}

interface MoralisSwapsResponse {
  result: MoralisSwap[];
  cursor: string | null;
}

async function enrichActivityWithMarketCap(
  activity: WalletQuickViewData["recentActivity"],
  chainId: ChainId
): Promise<void> {
  const dexChain = chainId === "solana" ? "solana" : (chainId as string);
  const validEntries = activity.filter((e) => e.amount > 0 && e.amountUsd > 0).slice(0, 20);
  const uniqueAddrs = [...new Set(validEntries.map((e) => e.tokenAddress))];
  if (uniqueAddrs.length === 0) return;
  const mcMap = new Map<string, { currentMc: number; currentPrice: number }>();
  try {
    const pairs = await getTokenPairs(dexChain, uniqueAddrs.join(","));
    for (const pair of pairs) {
      const addr = pair.baseToken.address.toLowerCase();
      const currentMc = pair.marketCap ?? pair.fdv ?? 0;
      const currentPrice = parseFloat(pair.priceUsd ?? "0") || 0;
      if (currentMc > 0 && currentPrice > 0 && !mcMap.has(addr)) {
        mcMap.set(addr, { currentMc, currentPrice });
      }
    }
  } catch { /* skip on failure */ }
  for (const entry of activity) {
    if (entry.amount <= 0 || entry.amountUsd <= 0) continue;
    const pairData = mcMap.get(entry.tokenAddress.toLowerCase());
    if (!pairData) continue;
    const { currentMc, currentPrice } = pairData;
    const circulatingSupply = currentMc / currentPrice;
    const priceAtTrade = entry.amountUsd / entry.amount;
    entry.marketCap = priceAtTrade * circulatingSupply;
  }
}

/**
 * Build EVM wallet quick-view using:
 *   - GMGN  → positions, PnL per token, cost basis (primary, richer data)
 *   - Moralis /tokens → native balance + stablecoins only (fast, ~0.5s)
 *
 * Swap pagination removed entirely — GMGN provides cost basis directly.
 */
async function buildEvmQuickView(
  walletAddress: string,
  chainId: ChainId
): Promise<WalletQuickViewData | null> {
  const moralisChain = MORALIS_CHAIN[chainId];
  if (!moralisChain) return null;

  const addr = walletAddress.toLowerCase();
  const chainConfig = CHAIN_CONFIGS[chainId];
  const nativeSymbol = EVM_NATIVE_SYMBOLS[chainId] ?? chainConfig.nativeCurrency.symbol;

  // Run GMGN scrape and Moralis token fetch in parallel
  const [gmgnHoldings, tokensData] = await Promise.all([
    scrapeGmgnWalletHoldings(chainId, walletAddress),
    fetchMoralisEvm<MoralisTokensResponse>(
      `/wallets/${addr}/tokens?chain=${moralisChain}&exclude_spam=true&include_native=true`
    ),
  ]);

  // ─── Native balance from Moralis /tokens ──────────────────────────────────
  const nativeTok = tokensData?.result?.find((t) => t.native_token);
  const nativeBalance    = parseFloat(nativeTok?.balance_formatted ?? "0") || 0;
  const nativeBalanceUsd = nativeTok?.usd_value ?? 0;

  // ─── Stablecoins from Moralis ─────────────────────────────────────────────
  const EVM_STABLE_SYMBOLS = new Set(["USDC", "USDT", "BUSD", "DAI", "FRAX", "PYUSD"]);
  const stablecoins: StablecoinBalance[] = [];
  let stablecoinTotal = 0;
  for (const tok of tokensData?.result ?? []) {
    if (tok.possible_spam || tok.native_token) continue;
    if (!EVM_STABLE_SYMBOLS.has(tok.symbol.toUpperCase())) continue;
    const bal = parseFloat(tok.balance_formatted) || 0;
    if (bal <= 0) continue;
    const usdVal = tok.usd_value && tok.usd_value > 0 ? tok.usd_value : bal;
    stablecoins.push({ symbol: tok.symbol, balance: bal, balanceUsd: usdVal });
    stablecoinTotal += usdVal;
  }

  // ─── Positions from GMGN holdings ─────────────────────────────────────────
  const activePositions: WalletPosition[] = gmgnHoldings
    .filter((h) => h.balanceUsd >= 0.01)
    .map((h) => ({
      tokenAddress: h.tokenAddress,
      symbol:       h.symbol,
      name:         h.name,
      logoUrl:      h.logoUrl,
      chain:        chainId,
      balance:      h.balance,
      balanceUsd:   h.balanceUsd,
      pnl:          h.totalPnlUsd,
      pnlPercent:   h.totalPnlPct * 100,
      entryPrice:   h.avgCostUsd || null,
      currentPrice: h.currentPriceUsd || null,
      totalBoughtUsd:  h.investedUsd,
      totalSoldUsd:    h.historySoldIncomeUsd,
      unrealizedPnl:   h.unrealizedPnlUsd,
    }))
    .sort((a, b) => b.balanceUsd - a.balanceUsd)
    .slice(0, 20);

  // ─── PnL stats from GMGN ──────────────────────────────────────────────────
  let pnl30d = 0;
  const recentPnls: PnlHistoryEntry[] = [];
  const topBuys: PnlHistoryEntry[] = [];

  for (const h of gmgnHoldings) {
    pnl30d += h.realizedPnl30dUsd;

    if (h.realizedPnlUsd !== 0) {
      recentPnls.push({
        tokenAddress:  h.tokenAddress,
        symbol:        h.symbol,
        chain:         chainId,
        realizedPnl:   h.realizedPnlUsd,
        totalBoughtUsd: h.investedUsd,
        totalSoldUsd:   h.historySoldIncomeUsd,
        timestamp:     h.lastActiveTimestamp ?? 0,
        side:          "sell",
        amount:        h.historySoldAmount,
        logoUrl:       h.logoUrl,
      });
    }

    if (h.investedUsd > 0) {
      topBuys.push({
        tokenAddress:  h.tokenAddress,
        symbol:        h.symbol,
        chain:         chainId,
        realizedPnl:   h.investedUsd,
        totalBoughtUsd: h.investedUsd,
        totalSoldUsd:   h.historySoldIncomeUsd,
        timestamp:     h.startHoldingAt ?? 0,
        side:          "buy",
        amount:        h.historyBoughtAmount,
        logoUrl:       h.logoUrl,
      });
    }
  }

  recentPnls.sort((a, b) => b.realizedPnl - a.realizedPnl);
  topBuys.sort((a, b) => b.realizedPnl - a.realizedPnl);

  const bestTrade30d = recentPnls[0]
    ? { symbol: recentPnls[0].symbol, pnl: recentPnls[0].realizedPnl }
    : null;

  // ─── 30-day cumulative PnL history from per-token realized PnL ───────────
  // Place each token's realized PnL on its last_active_timestamp day
  const nowMs = Date.now();
  const thirtyDaysAgoMs = nowMs - 30 * 24 * 60 * 60 * 1000;
  const pnlByDay = new Map<string, number>();
  for (let d = 0; d < 30; d++) {
    const date = new Date(thirtyDaysAgoMs + d * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    pnlByDay.set(date, 0);
  }
  for (const h of gmgnHoldings) {
    if (!h.lastActiveTimestamp || h.realizedPnl30dUsd === 0) continue;
    const date = new Date(h.lastActiveTimestamp * 1000).toISOString().slice(0, 10);
    if (pnlByDay.has(date)) pnlByDay.set(date, (pnlByDay.get(date) ?? 0) + h.realizedPnl30dUsd);
  }
  let cumPnl = 0;
  const pnlHistory = Array.from(pnlByDay.entries()).map(([date, dailyPnl]) => {
    cumPnl += dailyPnl;
    return { date, pnl: cumPnl };
  });

  return {
    address: walletAddress,
    chain: chainId,
    nativeBalance,
    nativeBalanceUsd,
    nativeSymbol,
    stablecoinTotal,
    stablecoins,
    pnl30d,
    pnl7d: 0,
    bestTrade30d,
    bestTrade7d: null,
    freshBuys7d: [],
    freshBuys30d: [],
    pnlHistory,
    activePositions,
    recentPnls: recentPnls.slice(0, 20),
    topBuys: topBuys.slice(0, 10),
    recentActivity: [],
  };
}

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

    // EVM chains: use Moralis
    if (chainId !== "solana") {
      const evmData = await buildEvmQuickView(walletAddress, chainId);
      if (evmData) {
        serverCache.set(cacheKey, evmData, CACHE_TTL.WALLET_QUICK);
        return NextResponse.json(evmData);
      }
      return NextResponse.json({ error: "Failed to fetch EVM wallet data" }, { status: 502 });
    }

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
    const logoMap = new Map<string, string | null>();
    for (const tok of walletBalance.tokens) {
      symbolMap.set(tok.tokenAddress, tok.symbol);
      logoMap.set(tok.tokenAddress, tok.logoUrl ?? null);
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
    // Per-mint first buy timestamp within 7d
    const buys7dFirstTs = new Map<string, number>();
    // Per-mint sell USD within 7d
    const sells7d = new Map<string, number>();
    // Per-mint buy USD within exclusive 7d-30d window (not overlapping 7d)
    const buys30d = new Map<string, number>();
    // Per-mint first buy timestamp within exclusive 7d-30d window
    const buys30dFirstTs = new Map<string, number>();
    // Per-mint sell USD within full 0-30d window (any sell disqualifies)
    const sells30d = new Map<string, number>();
    // Per-mint cumulative buy USD within full 0-30d window (for display totals)
    const cumulativeBuys30d = new Map<string, number>();
    // Per-mint aggregated realized PnL in 30d / 7d (for best trade)
    const mintPnl30d = new Map<string, { symbol: string; pnl: number }>();
    const mintPnl7d = new Map<string, { symbol: string; pnl: number }>();
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

      // Fetch parsed swap history via v0 API (filters SWAP client-side, up to 30 pages to cover 30d)
      const swapTxns = await helius.getParsedSwapsAll(walletAddress, {
        maxPages: 5,
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
          logoMap.set(mint, info.logoUrl ?? null);
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
            tokenAddress: soldMint,
            amount: soldAmount,
            amountUsd: receivedUsd,
            logoUrl: logoMap.get(soldMint) ?? null,
            marketCap: null,
          });
          mintTotalSoldUsd.set(soldMint, (mintTotalSoldUsd.get(soldMint) ?? 0) + receivedUsd);
          recentPnls.push({
            tokenAddress: soldMint,
            symbol,
            chain: chainId,
            realizedPnl,
            totalBoughtUsd: mintTotalBoughtUsd.get(soldMint) ?? 0,
            totalSoldUsd: mintTotalSoldUsd.get(soldMint) ?? 0,
            timestamp: tx.timestamp,
            side: "sell",
            amount: soldAmount,
            logoUrl: logoMap.get(soldMint) ?? null,
          });

          // 7d sell tracking (existence used by freshBuys7d)
          if (tx.timestamp >= sevenDaysAgoSec) {
            sells7d.set(soldMint, (sells7d.get(soldMint) ?? 0) + receivedUsd);
            pnl7dAccum += realizedPnl;
            // Aggregate per-mint PnL for best trade (7d)
            const prev7 = mintPnl7d.get(soldMint);
            mintPnl7d.set(soldMint, {
              symbol,
              pnl: (prev7?.pnl ?? 0) + realizedPnl,
            });
          }
          // Windowed PnL: add realized profit from this sell
          if (tx.timestamp >= thirtyDaysAgoSec) {
            pnl30dAccum += realizedPnl;
            sells30d.set(soldMint, (sells30d.get(soldMint) ?? 0) + receivedUsd);
            // Aggregate per-mint PnL for best trade (30d)
            const prev30 = mintPnl30d.get(soldMint);
            mintPnl30d.set(soldMint, {
              symbol,
              pnl: (prev30?.pnl ?? 0) + realizedPnl,
            });
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
            tokenAddress: boughtMint,
            amount: boughtAmount,
            amountUsd: buyUsd,
            logoUrl: logoMap.get(boughtMint) ?? null,
            marketCap: null,
          });
          mintTotalBoughtUsd.set(boughtMint, (mintTotalBoughtUsd.get(boughtMint) ?? 0) + buyUsd);
          topBuys.push({
            tokenAddress: boughtMint,
            symbol,
            chain: chainId,
            realizedPnl: buyUsd,
            totalBoughtUsd: mintTotalBoughtUsd.get(boughtMint) ?? 0,
            totalSoldUsd: mintTotalSoldUsd.get(boughtMint) ?? 0,
            timestamp: tx.timestamp,
            side: "buy",
            amount: boughtAmount,
            logoUrl: logoMap.get(boughtMint) ?? null,
          });

          // Record cost basis for this buy
          const ledgerEntry = costLedger.get(boughtMint) ?? {
            totalBoughtAmount: 0,
            totalCostUsd: 0,
          };
          ledgerEntry.totalBoughtAmount += boughtAmount;
          ledgerEntry.totalCostUsd += buyUsd;
          costLedger.set(boughtMint, ledgerEntry);

          // Cumulative buy tracking: all buys within 30d (for display totals)
          if (tx.timestamp >= thirtyDaysAgoSec) {
            cumulativeBuys30d.set(boughtMint, (cumulativeBuys30d.get(boughtMint) ?? 0) + buyUsd);
          }
          // 7d buy tracking (per-mint, used by freshBuys7d)
          if (tx.timestamp >= sevenDaysAgoSec) {
            buys7d.set(boughtMint, (buys7d.get(boughtMint) ?? 0) + buyUsd);
            if (!buys7dFirstTs.has(boughtMint)) {
              buys7dFirstTs.set(boughtMint, tx.timestamp);
            }
          }
          // 30d buy tracking — exclusive window: bought 7d-30d ago only
          if (tx.timestamp >= thirtyDaysAgoSec && tx.timestamp < sevenDaysAgoSec) {
            buys30d.set(boughtMint, (buys30d.get(boughtMint) ?? 0) + buyUsd);
            if (!buys30dFirstTs.has(boughtMint)) {
              buys30dFirstTs.set(boughtMint, tx.timestamp);
            }
          }
        }
      }

    }

    // Derive best trade per window from aggregated per-mint PnL
    let bestTrade30d: { symbol: string; pnl: number } | null = null;
    for (const entry of mintPnl30d.values()) {
      if (!bestTrade30d || entry.pnl > bestTrade30d.pnl) {
        bestTrade30d = { symbol: entry.symbol, pnl: entry.pnl };
      }
    }
    let bestTrade7d: { symbol: string; pnl: number } | null = null;
    for (const entry of mintPnl7d.values()) {
      if (!bestTrade7d || entry.pnl > bestTrade7d.pnl) {
        bestTrade7d = { symbol: entry.symbol, pnl: entry.pnl };
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

    // All tokens with non-zero balance (regardless of USD value — tokens with null price still count)
    const heldMints = new Set(
      walletBalance.tokens
        .filter((tok) => tok.balance > 0)
        .map((tok) => tok.tokenAddress)
    );

    // Fresh buys: tokens bought in 7d with no sells in 7d, still held
    const freshBuys7d: WalletQuickViewData["freshBuys7d"] = [];
    for (const [mint] of buys7d) {
      if (!sells7d.has(mint) && heldMints.has(mint)) {
        const symbol = symbolMap.get(mint) ?? mint.slice(0, 6);
        freshBuys7d.push({
          tokenAddress: mint,
          symbol,
          boughtUsd: cumulativeBuys30d.get(mint) ?? buys7d.get(mint) ?? 0,
          logoUrl: null,
          buyTimestamp: buys7dFirstTs.get(mint) ?? 0,
          twitter: null,
          telegram: null,
          website: null,
          marketCap: null,
        });
      }
    }
    freshBuys7d.sort((a, b) => b.boughtUsd - a.boughtUsd);

    // Fresh buys 30d: tokens bought in 30d with no sells in 30d, still held, excluding 7d tokens
    const freshBuys7dMints = new Set(freshBuys7d.map((fb) => fb.tokenAddress));
    const freshBuys30d: WalletQuickViewData["freshBuys30d"] = [];
    for (const [mint] of buys30d) {
      if (!sells30d.has(mint) && heldMints.has(mint) && !freshBuys7dMints.has(mint)) {
        const symbol = symbolMap.get(mint) ?? mint.slice(0, 6);
        freshBuys30d.push({
          tokenAddress: mint,
          symbol,
          boughtUsd: cumulativeBuys30d.get(mint) ?? buys30d.get(mint) ?? 0,
          logoUrl: null,
          buyTimestamp: buys30dFirstTs.get(mint) ?? 0,
          twitter: null,
          telegram: null,
          website: null,
          marketCap: null,
        });
      }
    }
    freshBuys30d.sort((a, b) => b.boughtUsd - a.boughtUsd);

    // Enrich fresh buys (7d + 30d) with logo + socials from DAS API
    const allFreshBuys = [...freshBuys7d, ...freshBuys30d];
    if (allFreshBuys.length > 0) {
      const freshMints = allFreshBuys.map((fb) => fb.tokenAddress);
      const freshAssets = await helius.getAssetBatch(freshMints);

      const socialsPromises = allFreshBuys.map(async (fb) => {
        const asset = freshAssets.get(fb.tokenAddress);
        if (asset?.jsonUri) {
          return helius.fetchTokenSocials(asset.jsonUri);
        }
        return { twitter: null, telegram: null, website: null };
      });
      const socialsResults = await Promise.all(socialsPromises);

      for (let i = 0; i < allFreshBuys.length; i++) {
        const fb = allFreshBuys[i];
        const asset = freshAssets.get(fb.tokenAddress);
        const pos = activePositions.find((p) => p.tokenAddress === fb.tokenAddress);
        fb.logoUrl = pos?.logoUrl ?? asset?.logoUrl ?? null;
        fb.twitter = socialsResults[i].twitter;
        fb.telegram = socialsResults[i].telegram;
        fb.website = socialsResults[i].website;
      }

      // Enrich with market cap from DexScreener (batch up to 30 per call)
      const dexChainId = chainId === "solana" ? "solana" : chainId;
      const BATCH_SIZE = 30;
      const mcMap = new Map<string, number>();
      for (let i = 0; i < freshMints.length; i += BATCH_SIZE) {
        const batch = freshMints.slice(i, i + BATCH_SIZE);
        try {
          const pairs = await getTokenPairs(dexChainId, batch.join(","));
          for (const pair of pairs) {
            const addr = pair.baseToken.address;
            const mc = pair.marketCap ?? pair.fdv ?? null;
            if (mc && (!mcMap.has(addr) || mc > (mcMap.get(addr) ?? 0))) {
              mcMap.set(addr, mc);
            }
          }
        } catch { /* skip on failure */ }
      }
      for (const fb of allFreshBuys) {
        fb.marketCap = mcMap.get(fb.tokenAddress) ?? null;
      }
    }

    // Enrich buy activity entries with MC at buy
    await enrichActivityWithMarketCap(recentActivity, chainId);

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
      freshBuys30d,
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
