import { NextResponse } from "next/server";
import { getChainProvider, isChainSupported } from "@/lib/chains/registry";
import { CHAIN_CONFIGS } from "@/config/chains";
import { serverCache, CACHE_TTL } from "@/lib/cache";
import type { ChainId } from "@/types/chain";

/**
 * Lightweight wallet summary — balances + positions only (no swap history).
 * Used by the favorites page to render cards fast.
 */
export interface FavoriteSummary {
  address: string;
  chain: ChainId;
  nativeBalance: number;
  nativeBalanceUsd: number;
  nativeSymbol: string;
  stablecoinTotal: number;
  activePositions: { tokenAddress: string; symbol: string; balanceUsd: number }[];
  totalPortfolioUsd: number;
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

async function fetchSummary(
  walletAddress: string,
  chainId: ChainId
): Promise<FavoriteSummary> {
  const cacheKey = `fav-summary:${chainId}:${walletAddress}`;
  const cached = serverCache.get<FavoriteSummary>(cacheKey);
  if (cached) return cached;

  const provider = getChainProvider(chainId);
  const chainConfig = CHAIN_CONFIGS[chainId];
  const walletBalance = await provider.getWalletBalance(walletAddress);

  let stablecoinTotal = 0;
  for (const tok of walletBalance.tokens) {
    let isStable = false;
    if (chainId === "solana") {
      isStable = !!SOLANA_STABLES[tok.tokenAddress];
    } else {
      const stableMap = EVM_STABLES_LOWER[chainId] ?? {};
      isStable = !!stableMap[tok.tokenAddress.toLowerCase()];
    }
    if (isStable) {
      stablecoinTotal += tok.balanceUsd ?? tok.balance;
    }
  }

  const activePositions = walletBalance.tokens
    .filter((tok) => {
      if (chainId === "solana") return !SOLANA_STABLES[tok.tokenAddress];
      const stableMap = EVM_STABLES_LOWER[chainId] ?? {};
      return !stableMap[tok.tokenAddress.toLowerCase()];
    })
    .filter((tok) => tok.balance > 0)
    .sort((a, b) => (b.balanceUsd ?? 0) - (a.balanceUsd ?? 0))
    .slice(0, 12)
    .map((tok) => ({ tokenAddress: tok.tokenAddress, symbol: tok.symbol, balanceUsd: tok.balanceUsd ?? 0 }));

  const positionsUsd = activePositions.reduce((sum, p) => sum + p.balanceUsd, 0);
  const totalPortfolioUsd = walletBalance.nativeBalanceUsd + stablecoinTotal + positionsUsd;

  const summary: FavoriteSummary = {
    address: walletAddress,
    chain: chainId,
    nativeBalance: walletBalance.nativeBalance,
    nativeBalanceUsd: walletBalance.nativeBalanceUsd,
    nativeSymbol: chainConfig.nativeCurrency.symbol,
    stablecoinTotal,
    activePositions,
    totalPortfolioUsd,
  };

  // Cache for 2 minutes — these are favorites, not live trading views
  serverCache.set(cacheKey, summary, CACHE_TTL.WALLET);

  return summary;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { wallets } = body as {
      wallets: { address: string; chain: string }[];
    };

    if (!Array.isArray(wallets) || wallets.length === 0) {
      return NextResponse.json({ error: "No wallets provided" }, { status: 400 });
    }

    // Cap at 20 to prevent abuse
    const capped = wallets.slice(0, 20);

    // Fetch all in parallel
    const results = await Promise.allSettled(
      capped.map((w) => {
        if (!isChainSupported(w.chain)) {
          return Promise.reject(new Error(`Unsupported chain: ${w.chain}`));
        }
        return fetchSummary(w.address, w.chain as ChainId);
      })
    );

    // Build keyed response
    const summaries: Record<string, FavoriteSummary> = {};
    for (let i = 0; i < capped.length; i++) {
      const result = results[i];
      const key = `${capped[i].chain}:${capped[i].address}`;
      if (result.status === "fulfilled") {
        summaries[key] = result.value;
      }
    }

    return NextResponse.json(summaries);
  } catch (error) {
    console.error("Favorites insights error:", error);
    return NextResponse.json(
      { error: "Failed to fetch insights" },
      { status: 500 }
    );
  }
}
