export type SharedHoldChain = "eth" | "base" | "bsc" | "solana" | "ton";

export interface SharedHolderTokenData {
  balance: string;             // human-readable token balance
  balanceUsd: number;          // current USD value
  percentage: number;          // % of total supply held
  investedUsd: number | null;  // total USD spent buying
  soldUsd: number | null;      // total USD received from selling
  avgBuyPrice: number | null;  // average buy price per token
  buyMarketCap: number | null; // avgBuyPrice × totalSupply (MC when bought)
  realizedPnl: number | null;  // realized PnL in USD
  totalPnl: number;            // realizedPnl + unrealizedPnl
}

export interface SharedHolder {
  address: string;
  tokens: SharedHolderTokenData[];  // one entry per requested token, in request order
  combinedPnl: number;
}

export interface SharedHolderTokenMeta {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  priceUsd: number | null;
  marketCap: number | null;
  totalSupply: number | null;
  imageUrl: string | null;
}

export interface SharedHoldersRequest {
  chain: SharedHoldChain;
  addresses: string[];  // 2–5 token addresses
}

export interface SharedHoldersResponse {
  holders: SharedHolder[];
  tokens: SharedHolderTokenMeta[];  // metadata in same order as request addresses
  chain: SharedHoldChain;
}
