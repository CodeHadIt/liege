import { NextResponse } from "next/server";
import * as helius from "@/lib/api/helius";
import { createEtherscanClient } from "@/lib/api/etherscan";
import { serverCache, CACHE_TTL } from "@/lib/cache";
import type { ChainId } from "@/types/chain";
import type {
  TradeHistoryRequest,
  TradeHistoryResponse,
  TokenTradeHistory,
  TradeTranche,
} from "@/types/traders";

// SOL mints that appear in balance changes
const SOL_MINTS = new Set([
  "So11111111111111111111111111111111111111111",
  "So11111111111111111111111111111111111111112",
]);

function getEtherscanConfig(chain: ChainId) {
  const configs: Record<
    string,
    { apiUrl: string; apiKey: string; rateLimiterKey: string }
  > = {
    base: {
      apiUrl: "https://api.basescan.org/api",
      apiKey: process.env.BASESCAN_API_KEY || "",
      rateLimiterKey: "basescan",
    },
    bsc: {
      apiUrl: "https://api.bscscan.com/api",
      apiKey: process.env.BSCSCAN_API_KEY || "",
      rateLimiterKey: "bscscan",
    },
  };
  return configs[chain] ?? null;
}

/**
 * Parse Solana wallet history (v1) into trade tranches for a specific token mint.
 * Uses balanceChanges to detect buys/sells of a particular token.
 */
function parseSolanaWalletHistory(
  txns: helius.WalletHistoryTransaction[],
  tokenMint: string
): TradeTranche[] {
  const tranches: TradeTranche[] = [];

  for (const tx of txns) {
    if (tx.error || !tx.timestamp) continue;

    // Aggregate balance changes by mint
    const netChanges = new Map<string, number>();
    for (const bc of tx.balanceChanges) {
      const cur = netChanges.get(bc.mint) ?? 0;
      netChanges.set(bc.mint, cur + bc.amount);
    }

    const tokenChange = netChanges.get(tokenMint);
    if (!tokenChange || tokenChange === 0) continue;

    // Determine source (DEX) from feePayer heuristic
    let source: string | null = null;
    // If feePayer is not the wallet itself, it might indicate the DEX program
    if (tx.feePayer !== tokenMint) {
      source = null; // We don't have source info from v1 API
    }

    tranches.push({
      txHash: tx.signature,
      timestamp: tx.timestamp,
      amount: Math.abs(tokenChange),
      side: tokenChange > 0 ? "buy" : "sell",
      source,
    });
  }

  return tranches;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as TradeHistoryRequest;
    const { walletAddress, tokens } = body;

    if (!walletAddress || !tokens || tokens.length === 0) {
      return NextResponse.json(
        { error: "Missing walletAddress or tokens" },
        { status: 400 }
      );
    }

    // Check full request cache
    const requestCacheKey = `trade-history:${walletAddress}:${tokens.map((t) => `${t.chain}:${t.address}`).join(",")}`;
    const cachedResponse = serverCache.get<TradeHistoryResponse>(requestCacheKey);
    if (cachedResponse) {
      return NextResponse.json(cachedResponse);
    }

    const solanaTokens = tokens.filter((t) => t.chain === "solana");
    const evmTokens = tokens.filter((t) => t.chain !== "solana");

    // Solana: fetch wallet history once using v1 endpoint, then filter per token
    let solanaTxns: helius.WalletHistoryTransaction[] = [];
    if (solanaTokens.length > 0) {
      const txCacheKey = `solana-wallet-history:${walletAddress}`;
      const cached = serverCache.get<helius.WalletHistoryTransaction[]>(txCacheKey);
      if (cached) {
        solanaTxns = cached;
      } else {
        // Fetch swap transactions (3 pages = up to 300 swaps)
        solanaTxns = await helius.getWalletHistoryAll(walletAddress, {
          maxPages: 3,
          limit: 100,
          type: "SWAP",
        });
        serverCache.set(txCacheKey, solanaTxns, CACHE_TTL.TRADE_HISTORY);
      }
    }

    const tokenHistories: TokenTradeHistory[] = [];

    // Process Solana tokens
    for (const token of solanaTokens) {
      const tranches = parseSolanaWalletHistory(solanaTxns, token.address);
      tranches.sort((a, b) => a.timestamp - b.timestamp);

      const totalBought = tranches
        .filter((t) => t.side === "buy")
        .reduce((sum, t) => sum + t.amount, 0);
      const totalSold = tranches
        .filter((t) => t.side === "sell")
        .reduce((sum, t) => sum + t.amount, 0);

      tokenHistories.push({
        tokenAddress: token.address,
        chain: token.chain,
        symbol: token.symbol,
        priceUsd: token.priceUsd,
        totalBought,
        totalSold,
        currentBalance: token.currentBalance,
        tranches,
      });
    }

    // Process EVM tokens in parallel
    const evmResults = await Promise.all(
      evmTokens.map(async (token) => {
        const config = getEtherscanConfig(token.chain);
        if (!config) {
          return {
            tokenAddress: token.address,
            chain: token.chain,
            symbol: token.symbol,
            priceUsd: token.priceUsd,
            totalBought: 0,
            totalSold: 0,
            currentBalance: token.currentBalance,
            tranches: [] as TradeTranche[],
          } satisfies TokenTradeHistory;
        }

        const client = createEtherscanClient(config);
        const txns = await client.getTokenTxListForContract(
          walletAddress,
          token.address,
          100
        );

        const tranches: TradeTranche[] = [];
        const walletLower = walletAddress.toLowerCase();

        if (txns) {
          for (const tx of txns) {
            const decimals = parseInt(tx.tokenDecimal) || 18;
            const amount = parseFloat(tx.value) / Math.pow(10, decimals);
            const isBuy = tx.to.toLowerCase() === walletLower;
            const isSell = tx.from.toLowerCase() === walletLower;
            if (!isBuy && !isSell) continue;

            tranches.push({
              txHash: tx.hash,
              timestamp: parseInt(tx.timeStamp),
              amount,
              side: isBuy ? "buy" : "sell",
              source: null,
            });
          }
        }

        tranches.sort((a, b) => a.timestamp - b.timestamp);

        const totalBought = tranches
          .filter((t) => t.side === "buy")
          .reduce((sum, t) => sum + t.amount, 0);
        const totalSold = tranches
          .filter((t) => t.side === "sell")
          .reduce((sum, t) => sum + t.amount, 0);

        return {
          tokenAddress: token.address,
          chain: token.chain,
          symbol: token.symbol,
          priceUsd: token.priceUsd,
          totalBought,
          totalSold,
          currentBalance: token.currentBalance,
          tranches,
        } satisfies TokenTradeHistory;
      })
    );

    tokenHistories.push(...evmResults);

    const response: TradeHistoryResponse = { walletAddress, tokenHistories };
    serverCache.set(requestCacheKey, response, CACHE_TTL.TRADE_HISTORY);

    return NextResponse.json(response);
  } catch (error) {
    console.error("Trade history error:", error);
    return NextResponse.json(
      { error: "Failed to fetch trade history" },
      { status: 500 }
    );
  }
}
