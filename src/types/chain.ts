export type ChainId = "solana" | "base" | "bsc";

export interface ChainConfig {
  id: ChainId;
  name: string;
  shortName: string;
  logo: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrl: string;
  explorerUrl: string;
  explorerApiUrl: string;
  dexScreenerChainId: string;
  geckoTerminalNetwork: string;
  addressPattern: RegExp;
  isEvm: boolean;
}
