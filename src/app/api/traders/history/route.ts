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

function parseSolanaTranches(
  txns: helius.HeliusTransaction[],
  walletAddress: string,
  tokenMint: string
): TradeTranche[] {
  const tranches: TradeTranche[] = [];

  for (const tx of txns) {
    if (!tx.tokenTransfers || tx.tokenTransfers.length === 0) continue;

    for (const transfer of tx.tokenTransfers) {
      if (transfer.mint !== tokenMint) continue;

      const isBuy = transfer.toUserAccount === walletAddress;
      const isSell = transfer.fromUserAccount === walletAddress;
      if (!isBuy && !isSell) continue;

      tranches.push({
        txHash: tx.signature,
        timestamp: tx.timestamp,
        amount: Math.abs(transfer.tokenAmount),
        side: isBuy ? "buy" : "sell",
        source: tx.source || null,
      });
    }
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

    // Solana: fetch all wallet transactions once, then filter per token
    let solanaTxns: helius.HeliusTransaction[] = [];
    if (solanaTokens.length > 0) {
      const txCacheKey = `solana-txns:${walletAddress}`;
      const cached = serverCache.get<helius.HeliusTransaction[]>(txCacheKey);
      if (cached) {
        solanaTxns = cached;
      } else {
        solanaTxns = await helius.getTransactionHistory(walletAddress, 100);
        serverCache.set(txCacheKey, solanaTxns, CACHE_TTL.TRADE_HISTORY);
      }
    }

    const tokenHistories: TokenTradeHistory[] = [];

    // Process Solana tokens
    for (const token of solanaTokens) {
      const tranches = parseSolanaTranches(
        solanaTxns,
        walletAddress,
        token.address
      );
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
