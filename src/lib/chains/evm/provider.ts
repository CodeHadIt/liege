import { CHAIN_CONFIGS } from "@/config/chains";
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
import * as dexscreener from "@/lib/api/dexscreener";
import * as geckoterminal from "@/lib/api/geckoterminal";
import {
  createEtherscanClient,
  type EtherscanConfig,
} from "@/lib/api/etherscan";
import type {
  ChainProvider,
  PairData,
  TokenMetadata,
  WalletBalance,
} from "../types";

function parseDexScreenerPair(pair: dexscreener.DexScreenerPair): PairInfo {
  return {
    pairAddress: pair.pairAddress,
    dexId: pair.dexId,
    dexName: pair.dexId,
    baseToken: { address: pair.baseToken.address, symbol: pair.baseToken.symbol },
    quoteToken: { address: pair.quoteToken.address, symbol: pair.quoteToken.symbol },
    priceUsd: parseFloat(pair.priceUsd) || 0,
    liquidity: {
      usd: pair.liquidity?.usd ?? 0,
      base: pair.liquidity?.base ?? 0,
      quote: pair.liquidity?.quote ?? 0,
    },
    volume24h: pair.volume?.h24 ?? 0,
    url: pair.url,
  };
}

export class EvmChainProvider implements ChainProvider {
  readonly config: ChainConfig;
  private readonly etherscan;
  private readonly chainId: ChainId;

  constructor(chainId: ChainId, etherscanConfig: EtherscanConfig) {
    this.chainId = chainId;
    this.config = CHAIN_CONFIGS[chainId];
    this.etherscan = createEtherscanClient(etherscanConfig);
  }

  async getPairData(tokenAddress: string): Promise<PairData | null> {
    const dsChain = this.config.dexScreenerChainId;

    // Primary: DexScreener
    const dsPairs = await dexscreener.getTokenPairs(dsChain, tokenAddress);
    if (dsPairs.length > 0) {
      const sorted = dsPairs.sort(
        (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
      );
      const primary = sorted[0];
      const pairs = sorted.map(parseDexScreenerPair);
      return {
        pairs,
        primaryPair: pairs[0],
        priceUsd: parseFloat(primary.priceUsd) || null,
        priceNative: parseFloat(primary.priceNative) || null,
        volume24h: primary.volume?.h24 ?? null,
        liquidity: primary.liquidity?.usd ?? null,
        marketCap: primary.marketCap ?? null,
        fdv: primary.fdv ?? null,
        priceChange: {
          h1: primary.priceChange?.h1 ?? null,
          h6: primary.priceChange?.h6 ?? null,
          h24: primary.priceChange?.h24 ?? null,
        },
        txns24h: primary.txns?.h24 ?? null,
        createdAt: primary.pairCreatedAt
          ? Math.floor(primary.pairCreatedAt / 1000)
          : null,
        logoUrl: primary.info?.imageUrl ?? null,
      };
    }

    // Fallback: GeckoTerminal
    const gtPools = await geckoterminal.getTokenPools(
      this.config.geckoTerminalNetwork,
      tokenAddress
    );
    if (gtPools.length > 0) {
      const pool = gtPools[0];
      const attr = pool.attributes;
      return {
        pairs: [],
        primaryPair: null,
        priceUsd: parseFloat(attr.base_token_price_usd) || null,
        priceNative: parseFloat(attr.base_token_price_native_currency) || null,
        volume24h: parseFloat(attr.volume_usd.h24) || null,
        liquidity: parseFloat(attr.reserve_in_usd) || null,
        marketCap: attr.market_cap_usd ? parseFloat(attr.market_cap_usd) : null,
        fdv: parseFloat(attr.fdv_usd) || null,
        priceChange: {
          h1: parseFloat(attr.price_change_percentage.h1) || null,
          h6: parseFloat(attr.price_change_percentage.h6) || null,
          h24: parseFloat(attr.price_change_percentage.h24) || null,
        },
        txns24h: attr.transactions?.h24 ?? null,
        createdAt: attr.pool_created_at
          ? Math.floor(new Date(attr.pool_created_at).getTime() / 1000)
          : null,
        logoUrl: null,
      };
    }

    return null;
  }

  async getTokenMetadata(tokenAddress: string): Promise<TokenMetadata | null> {
    // DexScreener provides basic metadata for EVM tokens
    const dsPairs = await dexscreener.getTokenPairs(
      this.config.dexScreenerChainId,
      tokenAddress
    );
    if (dsPairs.length > 0) {
      const pair = dsPairs[0];
      return {
        address: pair.baseToken.address,
        name: pair.baseToken.name,
        symbol: pair.baseToken.symbol,
        decimals: 18,
        logoUrl: pair.info?.imageUrl ?? null,
        totalSupply: null,
        holderCount: null,
        website: pair.info?.websites?.[0]?.url ?? null,
        twitter:
          pair.info?.socials?.find((s) => s.type === "twitter")?.url ?? null,
        telegram:
          pair.info?.socials?.find((s) => s.type === "telegram")?.url ?? null,
        description: null,
      };
    }

    return null;
  }

  async getTopHolders(
    _tokenAddress: string,
    _limit = 20
  ): Promise<HolderEntry[]> {
    // Etherscan free tier doesn't provide top holder data
    // This would require paid API or on-chain RPC calls
    return [];
  }

  async getSafetySignals(tokenAddress: string): Promise<SafetySignals> {
    const flags: SafetySignals["flags"] = [];

    // Check contract source verification
    const source = await this.etherscan.getContractSourceCode(tokenAddress);
    const isVerified = source && source.length > 0 && source[0].SourceCode !== "";
    const isProxy = source?.[0]?.Proxy === "1";
    const contractName = source?.[0]?.ContractName || "";

    if (isVerified) {
      flags.push({
        severity: "safe",
        label: "Source Code Verified",
        description: `Contract "${contractName}" source code is verified on ${this.config.name}.`,
      });
    } else {
      flags.push({
        severity: "critical",
        label: "Source Code Not Verified",
        description: "Contract source code is not verified. Cannot audit the code.",
      });
    }

    if (isProxy) {
      flags.push({
        severity: "warning",
        label: "Proxy Contract",
        description: "This is a proxy contract. The implementation can be changed by the owner.",
      });
    }

    // Check for common dangerous function names in ABI
    if (source?.[0]?.ABI && source[0].ABI !== "Contract source code not verified") {
      try {
        const abi = JSON.parse(source[0].ABI);
        const dangerousFunctions = ["mint", "setFee", "blacklist", "pause", "setMaxTx"];
        const hasDangerous = abi
          .filter((item: { type: string }) => item.type === "function")
          .some((fn: { name: string }) =>
            dangerousFunctions.some((d) =>
              fn.name.toLowerCase().includes(d.toLowerCase())
            )
          );

        if (hasDangerous) {
          flags.push({
            severity: "warning",
            label: "Owner Functions Detected",
            description:
              "Contract contains functions that could allow the owner to modify fees, blacklist addresses, or pause trading.",
          });
        } else {
          flags.push({
            severity: "safe",
            label: "No Dangerous Owner Functions",
            description: "No common rug-pull functions detected in the contract ABI.",
          });
        }
      } catch {
        // ABI parsing failed
      }
    }

    return {
      mintAuthorityRevoked: null,
      freezeAuthorityRevoked: null,
      isMutable: null,
      isSourceVerified: isVerified,
      isProxy: isProxy,
      isHoneypot: null,
      hasOwnerFunctions: flags.some(
        (f) => f.label === "Owner Functions Detected"
      ),
      flags,
    };
  }

  async getPriceHistory(
    tokenAddress: string,
    timeframe: Timeframe
  ): Promise<OHLCVBar[]> {
    // Use GeckoTerminal for EVM OHLCV
    const pools = await geckoterminal.getTokenPools(
      this.config.geckoTerminalNetwork,
      tokenAddress
    );
    if (pools.length > 0) {
      const tfMap: Record<string, { tf: string; agg: number }> = {
        "1m": { tf: "minute", agg: 1 },
        "5m": { tf: "minute", agg: 5 },
        "15m": { tf: "minute", agg: 15 },
        "1h": { tf: "hour", agg: 1 },
        "4h": { tf: "hour", agg: 4 },
        "1d": { tf: "day", agg: 1 },
      };
      const { tf, agg } = tfMap[timeframe] || { tf: "hour", agg: 1 };
      return geckoterminal.getOHLCV(
        this.config.geckoTerminalNetwork,
        pools[0].attributes.address,
        tf,
        agg
      );
    }
    return [];
  }

  async getWalletBalance(walletAddress: string): Promise<WalletBalance> {
    const tokens: WalletTokenHolding[] = [];
    let totalPortfolioUsd = 0;

    // Get native balance
    const nativeBalanceWei = await this.etherscan.getBalance(walletAddress);
    const nativeBalance = nativeBalanceWei
      ? parseInt(nativeBalanceWei) / 1e18
      : 0;

    // Get token balances
    const tokenBalances = await this.etherscan.getTokenBalances(walletAddress);
    if (tokenBalances) {
      for (const tb of tokenBalances) {
        const decimals = parseInt(tb.TokenDecimal) || 18;
        const balance = parseFloat(tb.TokenQuantity) / Math.pow(10, decimals);
        tokens.push({
          tokenAddress: tb.TokenAddress,
          symbol: tb.TokenSymbol,
          name: tb.TokenName,
          balance,
          balanceUsd: null, // Would need price lookup
          priceUsd: null,
          priceChange24h: null,
          logoUrl: null,
        });
      }
    }

    return {
      nativeBalance,
      nativeBalanceUsd: 0, // Would need price feed
      tokens,
      totalPortfolioUsd,
    };
  }

  async getWalletTransactions(
    walletAddress: string,
    options?: TxQueryOptions
  ): Promise<Transaction[]> {
    const limit = options?.limit ?? 50;
    const txns = await this.etherscan.getNormalTxList(walletAddress, limit);
    if (!txns) return [];

    return txns.map((tx) => ({
      hash: tx.hash,
      blockNumber: parseInt(tx.blockNumber),
      timestamp: parseInt(tx.timeStamp),
      type: inferTxType(tx.functionName),
      side: null,
      from: tx.from,
      to: tx.to,
      value: parseInt(tx.value) / 1e18,
      valueUsd: null,
      description: "",
      source: null,
      token: null,
      fee: (parseInt(tx.gasUsed) * parseInt(tx.gasPrice)) / 1e18,
      status: tx.isError === "0" ? ("success" as const) : ("failed" as const),
    }));
  }

  async getDeployedTokens(_walletAddress: string): Promise<DeployedToken[]> {
    // TODO: Implement by scanning contract creation transactions
    return [];
  }

  async searchTokens(query: string): Promise<TokenSearchResult[]> {
    const results = await dexscreener.searchPairs(query);
    return results
      .filter((r) => r.chainId === this.config.dexScreenerChainId)
      .slice(0, 20)
      .map((pair) => ({
        address: pair.baseToken.address,
        chain: this.chainId,
        name: pair.baseToken.name,
        symbol: pair.baseToken.symbol,
        logoUrl: pair.info?.imageUrl ?? null,
        priceUsd: parseFloat(pair.priceUsd) || null,
        volume24h: pair.volume?.h24 ?? null,
        liquidity: pair.liquidity?.usd ?? null,
      }));
  }
}

function inferTxType(
  functionName: string
): "swap" | "transfer" | "deploy" | "approve" | "other" {
  const fn = functionName.toLowerCase();
  if (fn.includes("swap") || fn.includes("exchange")) return "swap";
  if (fn.includes("transfer") || fn.includes("send")) return "transfer";
  if (fn.includes("approve")) return "approve";
  if (fn === "") return "transfer"; // Simple ETH transfer
  return "other";
}
