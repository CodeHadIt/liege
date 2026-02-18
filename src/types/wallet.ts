import type { ChainId } from "./chain";

export interface WalletData {
  address: string;
  chain: ChainId;
  nativeBalance: number;
  nativeBalanceUsd: number;
  totalPortfolioUsd: number;
  tokens: WalletTokenHolding[];
  isDeployer: boolean;
  deployedTokens: DeployedToken[];
  deployerScore: DeployerScore | null;
}

export interface WalletTokenHolding {
  tokenAddress: string;
  symbol: string;
  name: string;
  balance: number;
  balanceUsd: number | null;
  priceUsd: number | null;
  priceChange24h: number | null;
  logoUrl: string | null;
}

export interface DeployedToken {
  address: string;
  name: string;
  symbol: string;
  deployedAt: number;
  currentPriceUsd: number | null;
  currentLiquidityUsd: number | null;
  status: "active" | "rugged" | "dead" | "unknown";
}

export interface DeployerScore {
  totalDeployed: number;
  activeCount: number;
  ruggedCount: number;
  deadCount: number;
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  riskLevel: "low" | "medium" | "high" | "critical";
}

export interface Transaction {
  hash: string;
  blockNumber: number;
  timestamp: number;
  type: "swap" | "transfer" | "deploy" | "approve" | "other";
  side: "buy" | "sell" | null;
  from: string;
  to: string;
  value: number;
  valueUsd: number | null;
  description: string;
  source: string | null;
  token: {
    address: string;
    symbol: string;
    name: string;
    logoUrl: string | null;
    amount: number;
    isNative: boolean;
    isStablecoin: boolean;
  } | null;
  fee: number;
  status: "success" | "failed";
}

export interface TxQueryOptions {
  limit?: number;
  offset?: number;
  type?: Transaction["type"];
  startTime?: number;
  endTime?: number;
}
