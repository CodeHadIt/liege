import { NextResponse } from "next/server";
import { getChainProvider, isChainSupported } from "@/lib/chains/registry";
import { CHAIN_CONFIGS } from "@/config/chains";
import * as helius from "@/lib/api/helius";
import { getTokenPairs } from "@/lib/api/dexscreener";
import { serverCache, CACHE_TTL } from "@/lib/cache";
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
  bsc: "0x38",
  ethereum: "0x1",
};

const EVM_NATIVE_SYMBOLS: Record<string, string> = {
  base: "ETH",
  bsc: "BNB",
  ethereum: "ETH",
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

// Chains where Moralis profitability endpoint is supported
const PROFITABILITY_SUPPORTED_CHAINS = new Set(["0x1", "0x2105"]); // ETH mainnet, Base

async function fetchEvmSwaps(
  walletAddress: string,
  moralisChain: string
): Promise<MoralisSwap[]> {
  const allSwaps: MoralisSwap[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const qs = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const data = await fetchMoralisEvm<MoralisSwapsResponse>(
      `/wallets/${walletAddress}/swaps?chain=${moralisChain}&limit=100${qs}`
    );
    if (!data?.result?.length) break;
    allSwaps.push(...data.result);
    if (!data.cursor) break;
    cursor = data.cursor;
  }
  return allSwaps;
}

async function buildEvmQuickView(
  walletAddress: string,
  chainId: ChainId
): Promise<WalletQuickViewData | null> {
  const moralisChain = MORALIS_CHAIN[chainId];
  if (!moralisChain) return null;

  const addr = walletAddress.toLowerCase();
  const supportsProf = PROFITABILITY_SUPPORTED_CHAINS.has(moralisChain);

  // Profitability calls are conditional — BSC is not supported by that endpoint
  // Swaps endpoint works on all chains and provides complete all-time buy/sell history
  const [tokensData, prof30dData, prof7dData, swaps, netWorthData] = await Promise.all([
    fetchMoralisEvm<MoralisTokensResponse>(
      `/wallets/${addr}/tokens?chain=${moralisChain}&exclude_spam=true`
    ),
    supportsProf
      ? fetchMoralisEvm<{ result: MoralisProfitabilityEntry[] }>(
          `/wallets/${addr}/profitability?chain=${moralisChain}&days=30`
        )
      : Promise.resolve(null),
    supportsProf
      ? fetchMoralisEvm<{ result: MoralisProfitabilityEntry[] }>(
          `/wallets/${addr}/profitability?chain=${moralisChain}&days=7`
        )
      : Promise.resolve(null),
    fetchEvmSwaps(addr, moralisChain),
    fetchMoralisEvm<MoralisNetWorthResponse>(
      `/wallets/${addr}/net-worth?chains[]=${moralisChain}&exclude_spam=true`
    ),
  ]);

  const chainConfig = CHAIN_CONFIGS[chainId];
  const nativeSymbol = EVM_NATIVE_SYMBOLS[chainId] ?? chainConfig.nativeCurrency.symbol;

  // net-worth returns chain as name ("bsc") not hex — take first entry since we request one chain
  const netWorthChain = netWorthData?.chains?.[0];
  const nativeBal = tokensData?.native_balance;
  const nativeBalance =
    parseFloat(netWorthChain?.native_balance_formatted ?? nativeBal?.balance_formatted ?? "0") || 0;
  const nativeBalanceUsd =
    parseFloat(netWorthChain?.native_balance_usd ?? nativeBal?.usd ?? "0") || 0;

  const EVM_STABLE_SYMBOLS = new Set(["USDC", "USDT", "BUSD", "DAI", "FRAX", "PYUSD"]);

  // ─── Build per-token bought/sold from swaps (all-time, cursor-paginated) ───
  const histBought = new Map<string, number>(); // token address → total USD cost
  const histSold = new Map<string, number>();   // token address → total USD proceeds
  const recentActivity: WalletQuickViewData["recentActivity"] = [];

  for (const swap of swaps) {
    const ts = Math.floor(new Date(swap.blockTimestamp).getTime() / 1000);
    if (swap.transactionType === "buy") {
      const tokenAddr = swap.bought.address.toLowerCase();
      const cost = Math.abs(swap.sold.usdAmount);
      histBought.set(tokenAddr, (histBought.get(tokenAddr) ?? 0) + cost);
      recentActivity.push({
        txHash: swap.transactionHash,
        timestamp: ts,
        side: "buy",
        tokenSymbol: swap.bought.symbol,
        amount: parseFloat(swap.bought.amount) || 0,
        amountUsd: cost,
      });
    } else {
      const tokenAddr = swap.sold.address.toLowerCase();
      const proceeds = Math.abs(swap.bought.usdAmount);
      histSold.set(tokenAddr, (histSold.get(tokenAddr) ?? 0) + proceeds);
      recentActivity.push({
        txHash: swap.transactionHash,
        timestamp: ts,
        side: "sell",
        tokenSymbol: swap.sold.symbol,
        amount: Math.abs(parseFloat(swap.sold.amount)) || 0,
        amountUsd: proceeds,
      });
    }
  }
  recentActivity.sort((a, b) => b.timestamp - a.timestamp);

  // ─── Stablecoins + Positions ───────────────────────────────────────────────
  const stablecoins: StablecoinBalance[] = [];
  let stablecoinTotal = 0;
  const activePositions: WalletPosition[] = [];

  for (const tok of tokensData?.result ?? []) {
    if (tok.possible_spam) continue;
    if (tok.native_token) continue; // native (BNB/ETH) shown in header, not positions
    const bal = parseFloat(tok.balance_formatted) || 0;
    const usdVal = tok.usd_value ?? 0;
    if (bal <= 0) continue;

    const isStable = EVM_STABLE_SYMBOLS.has(tok.symbol.toUpperCase());
    if (isStable) {
      // Stablecoins are $1-pegged — use balance as USD fallback when price feed is null
      const stableUsd = usdVal > 0 ? usdVal : bal;
      stablecoins.push({ symbol: tok.symbol, balance: bal, balanceUsd: stableUsd });
      stablecoinTotal += stableUsd;
    } else if (usdVal >= 0.01 || bal > 0) {
      const tokenAddrLower = tok.token_address.toLowerCase();

      // Use swaps-derived totals (works for all chains, all-time history)
      const totalBoughtUsd = histBought.get(tokenAddrLower) ?? 0;
      const totalSoldUsd = histSold.get(tokenAddrLower) ?? 0;
      const unrealizedPnl = usdVal + totalSoldUsd - totalBoughtUsd;

      activePositions.push({
        tokenAddress: tok.token_address,
        symbol: tok.symbol,
        name: tok.name,
        logoUrl: tok.logo ?? tok.thumbnail ?? null,
        chain: chainId,
        balance: bal,
        balanceUsd: usdVal,
        pnl: unrealizedPnl,
        pnlPercent: 0,
        entryPrice: null,
        currentPrice: tok.usd_price,
        totalBoughtUsd,
        totalSoldUsd,
        unrealizedPnl,
      });
    }
  }
  activePositions.sort((a, b) => b.balanceUsd - a.balanceUsd);

  // ─── PnL metrics + recentPnls + topBuys ───────────────────────────────────
  const recentPnls: PnlHistoryEntry[] = [];
  const topBuys: PnlHistoryEntry[] = [];
  let pnl30d = 0;
  let pnl7d = 0;
  let bestTrade7d: { symbol: string; pnl: number } | null = null;

  if (supportsProf && prof30dData) {
    for (const e of prof30dData.result) {
      const realizedPnl = parseFloat(e.realized_profit_usd ?? "0") || 0;
      const totalBoughtUsd = parseFloat(e.total_usd_invested ?? "0") || 0;
      const lastTradeTs = e.last_trade
        ? Math.floor(new Date(e.last_trade).getTime() / 1000)
        : 0;
      pnl30d += realizedPnl;
      if (realizedPnl !== 0) {
        recentPnls.push({
          tokenAddress: e.token_address,
          symbol: e.token_symbol,
          chain: chainId,
          realizedPnl,
          timestamp: lastTradeTs,
          side: "sell",
          amount: parseFloat(e.total_tokens_sold) || 0,
        });
      }
      if (totalBoughtUsd > 0) {
        topBuys.push({
          tokenAddress: e.token_address,
          symbol: e.token_symbol,
          chain: chainId,
          realizedPnl: totalBoughtUsd,
          timestamp: lastTradeTs,
          side: "buy",
          amount: parseFloat(e.total_tokens_bought) || 0,
        });
      }
    }
    for (const e of prof7dData?.result ?? []) {
      const realizedPnl = parseFloat(e.realized_profit_usd ?? "0") || 0;
      pnl7d += realizedPnl;
      if (!bestTrade7d || realizedPnl > bestTrade7d.pnl) {
        bestTrade7d = { symbol: e.token_symbol, pnl: realizedPnl };
      }
    }
  } else {
    // BSC: derive PnL stats from swaps
    const nowSec = Math.floor(Date.now() / 1000);
    const seenSellTokens = new Set<string>();
    for (const swap of [...swaps].sort(
      (a, b) => new Date(b.blockTimestamp).getTime() - new Date(a.blockTimestamp).getTime()
    )) {
      if (swap.transactionType !== "sell") continue;
      const ts = Math.floor(new Date(swap.blockTimestamp).getTime() / 1000);
      const tokenAddr = swap.sold.address.toLowerCase();
      const proceeds = Math.abs(swap.bought.usdAmount);
      if (nowSec - ts <= 30 * 24 * 60 * 60) {
        pnl30d += proceeds;
        if (!seenSellTokens.has(tokenAddr)) {
          seenSellTokens.add(tokenAddr);
          recentPnls.push({
            tokenAddress: swap.sold.address,
            symbol: swap.sold.symbol,
            chain: chainId,
            realizedPnl: proceeds,
            timestamp: ts,
            side: "sell",
            amount: Math.abs(parseFloat(swap.sold.amount)) || 0,
          });
        }
      }
      if (nowSec - ts <= 7 * 24 * 60 * 60) {
        pnl7d += proceeds;
        if (!bestTrade7d || proceeds > bestTrade7d.pnl) {
          bestTrade7d = { symbol: swap.sold.symbol, pnl: proceeds };
        }
      }
    }
    // Top buys from swaps
    for (const [tokenAddr, boughtUsd] of histBought) {
      const tok = tokensData?.result?.find(
        (t) => t.token_address.toLowerCase() === tokenAddr
      );
      topBuys.push({
        tokenAddress: tokenAddr,
        symbol: tok?.symbol ?? tokenAddr.slice(0, 8),
        chain: chainId,
        realizedPnl: boughtUsd,
        timestamp: 0,
        side: "buy",
        amount: 0,
      });
    }
  }

  recentPnls.sort((a, b) => b.realizedPnl - a.realizedPnl);
  topBuys.sort((a, b) => b.realizedPnl - a.realizedPnl);
  const bestTrade30d = recentPnls[0]
    ? { symbol: recentPnls[0].symbol, pnl: recentPnls[0].realizedPnl }
    : null;

  // ─── 30-day cumulative PnL history ────────────────────────────────────────
  const nowMs = Date.now();
  const thirtyDaysAgoMs = nowMs - 30 * 24 * 60 * 60 * 1000;
  const pnlByDay = new Map<string, number>();
  for (let d = 0; d < 30; d++) {
    const date = new Date(thirtyDaysAgoMs + d * 24 * 60 * 60 * 1000);
    pnlByDay.set(date.toISOString().slice(0, 10), 0);
  }
  if (supportsProf && prof30dData) {
    for (const e of prof30dData.result) {
      if (!e.last_trade) continue;
      const date = e.last_trade.slice(0, 10);
      const pnl = parseFloat(e.realized_profit_usd ?? "0") || 0;
      if (pnlByDay.has(date)) pnlByDay.set(date, (pnlByDay.get(date) ?? 0) + pnl);
    }
  } else {
    for (const swap of swaps) {
      if (swap.transactionType !== "sell") continue;
      const ts = Math.floor(new Date(swap.blockTimestamp).getTime() / 1000);
      const date = new Date(ts * 1000).toISOString().slice(0, 10);
      const proceeds = Math.abs(swap.bought.usdAmount);
      if (pnlByDay.has(date)) pnlByDay.set(date, (pnlByDay.get(date) ?? 0) + proceeds);
    }
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
    pnl7d,
    bestTrade30d,
    bestTrade7d,
    freshBuys7d: [],
    freshBuys30d: [],
    pnlHistory,
    activePositions: activePositions.slice(0, 20),
    recentPnls: recentPnls.slice(0, 20),
    topBuys: topBuys.slice(0, 10),
    recentActivity: recentActivity.slice(0, 30),
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
        maxPages: 30,
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
