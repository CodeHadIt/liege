import type { ChainId } from "./chain";

export interface UnifiedTokenData {
  address: string;
  chain: ChainId;
  name: string;
  symbol: string;
  decimals: number;
  logoUrl: string | null;

  priceUsd: number | null;
  priceNative: number | null;
  marketCap: number | null;
  fdv: number | null;
  totalSupply: number | null;
  circulatingSupply: number | null;

  volume24h: number | null;
  volumeChange24h: number | null;
  priceChange: {
    h1: number | null;
    h6: number | null;
    h24: number | null;
  };
  txns24h: { buys: number; sells: number } | null;

  liquidity: LiquidityInfo | null;

  createdAt: number | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  description: string | null;

  safetySignals: SafetySignals | null;
  ddScore: DueDiligenceScore | null;

  primaryPair: PairInfo | null;
  allPairs: PairInfo[];
}

export interface PairInfo {
  pairAddress: string;
  dexId: string;
  dexName: string;
  baseToken: { address: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceUsd: number;
  liquidity: { usd: number; base: number; quote: number };
  volume24h: number;
  url: string;
}

export interface LiquidityInfo {
  totalUsd: number;
  pools: LiquidityPool[];
}

export interface LiquidityPool {
  pairAddress: string;
  dex: string;
  liquidityUsd: number;
  isLocked: boolean | null;
  lockDuration: number | null;
  lockPlatform: string | null;
}

export interface SafetySignals {
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  isMutable: boolean | null;

  isSourceVerified: boolean | null;
  isProxy: boolean | null;
  isHoneypot: boolean | null;
  hasOwnerFunctions: boolean | null;

  flags: SafetyFlag[];
}

export type SafetyFlag = {
  severity: "critical" | "warning" | "info" | "safe";
  label: string;
  description: string;
};

export interface DueDiligenceScore {
  overall: number;
  grade: "A" | "B" | "C" | "D" | "F";
  breakdown: {
    liquidity: number;
    holderDistribution: number;
    contractSafety: number;
    deployerHistory: number;
    ageAndVolume: number;
  };
}

export interface HolderEntry {
  address: string;
  balance: number;
  percentage: number;
  isContract: boolean | null;
  label: string | null;
}

export interface OHLCVBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export interface TokenSearchResult {
  address: string;
  chain: ChainId;
  name: string;
  symbol: string;
  logoUrl: string | null;
  priceUsd: number | null;
  volume24h: number | null;
  liquidity: number | null;
}

export interface PumpFunToken {
  address: string;
  name: string;
  symbol: string;
  logoUrl: string | null;
  priceUsd: number | null;
  liquidity: number | null;
  fdv: number | null;
  createdAt: string;
}

export type DexOrderTag = "dexPaid" | "cto";

export interface DexOrderToken extends PumpFunToken {
  tags: DexOrderTag[];
  tradeCount?: number;
  rank?: number;
  discoveredAt: string;
  url?: string | null;
  twitter?: string | null;
}

export interface TrendingToken extends TokenSearchResult {
  rank: number;
  marketCap: number | null;
  priceChange24h: number | null;
  txns24h: number | null;
  pairUrl: string;
}
