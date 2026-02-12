import type { ChainId } from "./chain";

export interface CommonTraderToken {
  address: string;
  symbol: string;
  chain: ChainId;
  balance: number;
  balanceUsd: number;
  percentage: number;
}

export interface CommonTrader {
  walletAddress: string;
  tokens: CommonTraderToken[];
  totalValueUsd: number;
  tokenCount: number;
}

export interface CommonTradersRequest {
  tokens: { chain: ChainId; address: string; symbol?: string }[];
}

export interface TokenMeta {
  address: string;
  symbol: string;
  chain: ChainId;
  priceUsd: number | null;
}

export interface CommonTradersResponse {
  traders: CommonTrader[];
  tokensMeta: TokenMeta[];
}

/** A single buy or sell event (tranche) */
export interface TradeTranche {
  txHash: string;
  timestamp: number;
  amount: number;
  side: "buy" | "sell";
  source: string | null;
}

/** Aggregated trade history for one wallet on one token */
export interface TokenTradeHistory {
  tokenAddress: string;
  chain: ChainId;
  symbol: string;
  priceUsd: number | null;
  totalBought: number;
  totalSold: number;
  currentBalance: number;
  tranches: TradeTranche[];
}

export interface TradeHistoryRequest {
  walletAddress: string;
  tokens: {
    chain: ChainId;
    address: string;
    symbol: string;
    currentBalance: number;
    priceUsd: number | null;
  }[];
}

export interface TradeHistoryResponse {
  walletAddress: string;
  tokenHistories: TokenTradeHistory[];
}

// ─── Top Traders ───

export type TraderTier = "whale" | "dolphin" | "fish" | "crab" | "shrimp";

export interface StablecoinBalance {
  symbol: string;
  balance: number;
  balanceUsd: number;
}

export interface TopTrader {
  walletAddress: string;
  nativeBalance: number;
  nativeBalanceUsd: number;
  stablecoinTotal: number;
  stablecoins: StablecoinBalance[];
  avgBuyAmount: number;
  avgBuyAmountUsd: number;
  avgBuyMarketCap: number | null;
  avgSellMarketCap: number | null;
  avgSellPrice: number | null;
  realizedPnl: number;
  realizedPnlUsd: number;
  remainingTokens: number;
  remainingTokensUsd: number;
  lastTradeTimestamp: number | null;
  tier: TraderTier;
  tradeCount: number;
}

export interface TopTradersResponse {
  traders: TopTrader[];
  tokenSymbol: string;
  tokenPriceUsd: number | null;
  nativeSymbol: string;
}

// ─── Wallet Quick View (Dialog) ───

export interface WalletPosition {
  tokenAddress: string;
  symbol: string;
  name: string;
  logoUrl: string | null;
  chain: ChainId;
  balance: number;
  balanceUsd: number;
  pnl: number;
  pnlPercent: number;
  entryPrice: number | null;
  currentPrice: number | null;
}

export interface PnlHistoryEntry {
  tokenAddress: string;
  symbol: string;
  chain: ChainId;
  realizedPnl: number;
  timestamp: number;
  side: "buy" | "sell";
  amount: number;
}

export interface WalletQuickViewData {
  address: string;
  chain: ChainId;
  nativeBalance: number;
  nativeBalanceUsd: number;
  nativeSymbol: string;
  stablecoinTotal: number;
  stablecoins: StablecoinBalance[];
  pnl30d: number;
  pnlHistory: { date: string; pnl: number }[];
  activePositions: WalletPosition[];
  recentPnls: PnlHistoryEntry[];
  topBuys: PnlHistoryEntry[];
  recentActivity: {
    txHash: string;
    timestamp: number;
    side: "buy" | "sell";
    tokenSymbol: string;
    amount: number;
    amountUsd: number;
  }[];
}
