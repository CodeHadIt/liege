import type { ChainConfig, ChainId } from "@/types/chain";
import type {
  HolderEntry,
  OHLCVBar,
  PairInfo,
  SafetySignals,
  Timeframe,
  TokenSearchResult,
} from "@/types/token";
import type {
  DeployedToken,
  Transaction,
  TxQueryOptions,
  WalletTokenHolding,
} from "@/types/wallet";

export interface TokenMetadata {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  logoUrl: string | null;
  totalSupply: number | null;
  holderCount: number | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  description: string | null;
}

export interface PairData {
  pairs: PairInfo[];
  primaryPair: PairInfo | null;
  priceUsd: number | null;
  priceNative: number | null;
  volume24h: number | null;
  liquidity: number | null;
  marketCap: number | null;
  fdv: number | null;
  priceChange: { h1: number | null; h6: number | null; h24: number | null };
  txns24h: { buys: number; sells: number } | null;
  createdAt: number | null;
  logoUrl: string | null;
}

export interface WalletBalance {
  nativeBalance: number;
  nativeBalanceUsd: number;
  tokens: WalletTokenHolding[];
  totalPortfolioUsd: number;
}

export interface ChainProvider {
  readonly config: ChainConfig;

  getPairData(tokenAddress: string): Promise<PairData | null>;
  getTokenMetadata(tokenAddress: string): Promise<TokenMetadata | null>;
  getTopHolders(
    tokenAddress: string,
    limit?: number
  ): Promise<HolderEntry[]>;
  getSafetySignals(tokenAddress: string): Promise<SafetySignals>;
  getPriceHistory(
    tokenAddress: string,
    timeframe: Timeframe
  ): Promise<OHLCVBar[]>;

  getWalletBalance(walletAddress: string): Promise<WalletBalance>;
  getWalletTransactions(
    walletAddress: string,
    options?: TxQueryOptions
  ): Promise<Transaction[]>;
  getDeployedTokens(walletAddress: string): Promise<DeployedToken[]>;

  searchTokens(query: string): Promise<TokenSearchResult[]>;
}
