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
  tokens: { chain: ChainId; address: string }[];
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
