import { CHAIN_CONFIGS } from "@/config/chains";
import type { ChainConfig } from "@/types/chain";
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
import * as birdeye from "@/lib/api/birdeye";
import * as helius from "@/lib/api/helius";
import * as solscan from "@/lib/api/solscan";
import type { ChainProvider, PairData, TokenMetadata, WalletBalance } from "../types";

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

export class SolanaChainProvider implements ChainProvider {
  readonly config: ChainConfig = CHAIN_CONFIGS.solana;

  async getPairData(tokenAddress: string): Promise<PairData | null> {
    // Primary: DexScreener
    const dsPairs = await dexscreener.getTokenPairs("solana", tokenAddress);
    if (dsPairs.length > 0) {
      // Sort by liquidity desc
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
    const gtPools = await geckoterminal.getTokenPools("solana", tokenAddress);
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
    // Try Birdeye first for rich data
    const be = await birdeye.getTokenOverview(tokenAddress);
    if (be) {
      return {
        address: be.address,
        name: be.name,
        symbol: be.symbol,
        decimals: be.decimals,
        logoUrl: be.logoURI || null,
        totalSupply: be.supply || null,
        holderCount: be.holder || null,
        website: be.extensions?.website ?? null,
        twitter: be.extensions?.twitter ?? null,
        telegram: be.extensions?.telegram ?? null,
        description: be.extensions?.description ?? null,
      };
    }

    // Fallback: Solscan
    const sc = await solscan.getTokenMeta(tokenAddress);
    if (sc) {
      return {
        address: sc.address,
        name: sc.name,
        symbol: sc.symbol,
        decimals: sc.decimals,
        logoUrl: sc.icon || null,
        totalSupply: sc.supply ? parseFloat(sc.supply) : null,
        holderCount: sc.holder || null,
        website: sc.website ?? null,
        twitter: sc.twitter ?? null,
        telegram: sc.telegram ?? null,
        description: null,
      };
    }

    return null;
  }

  async getTopHolders(
    tokenAddress: string,
    _limit = 50
  ): Promise<HolderEntry[]> {
    // Primary: Solana RPC getTokenLargestAccounts (up to 20, works with Helius key)
    const [largestAccounts, mintInfo] = await Promise.all([
      helius.getTokenLargestAccounts(tokenAddress),
      helius.getMintInfo(tokenAddress),
    ]);

    const totalSupply = mintInfo
      ? parseInt(mintInfo.supply) / Math.pow(10, mintInfo.decimals)
      : 0;

    if (largestAccounts.length > 0) {
      return largestAccounts.map((acct) => ({
        address: acct.address,
        balance: acct.uiAmount,
        percentage: totalSupply > 0 ? (acct.uiAmount / totalSupply) * 100 : 0,
        isContract: null,
        label: null,
      }));
    }

    // Fallback: Solscan (for users with upgraded API plan)
    const holders = await solscan.getTokenHolders(tokenAddress, _limit);
    if (holders.length > 0) {
      let supply = totalSupply;
      if (supply === 0) {
        const meta = await solscan.getTokenMeta(tokenAddress);
        if (meta?.supply) {
          supply = parseFloat(meta.supply) / Math.pow(10, meta.decimals);
        }
      }
      return holders.map((h) => {
        const balance = h.amount / Math.pow(10, h.decimals);
        return {
          address: h.owner,
          balance,
          percentage: supply > 0 ? (balance / supply) * 100 : 0,
          isContract: null,
          label: null,
        };
      });
    }

    return [];
  }

  async getSafetySignals(tokenAddress: string): Promise<SafetySignals> {
    const mintInfo = await helius.getMintInfo(tokenAddress);
    const flags: SafetySignals["flags"] = [];

    const mintAuthorityRevoked = mintInfo?.mintAuthority === null;
    const freezeAuthorityRevoked = mintInfo?.freezeAuthority === null;

    if (!mintAuthorityRevoked) {
      flags.push({
        severity: "critical",
        label: "Mint Authority Active",
        description:
          "Token supply can be increased at any time by the mint authority.",
      });
    } else {
      flags.push({
        severity: "safe",
        label: "Mint Authority Revoked",
        description: "No new tokens can be minted.",
      });
    }

    if (!freezeAuthorityRevoked) {
      flags.push({
        severity: "warning",
        label: "Freeze Authority Active",
        description:
          "Token accounts can be frozen, preventing transfers.",
      });
    } else {
      flags.push({
        severity: "safe",
        label: "Freeze Authority Revoked",
        description: "Token accounts cannot be frozen.",
      });
    }

    return {
      mintAuthorityRevoked: mintInfo ? mintAuthorityRevoked : null,
      freezeAuthorityRevoked: mintInfo ? freezeAuthorityRevoked : null,
      isMutable: null,
      isSourceVerified: null,
      isProxy: null,
      isHoneypot: null,
      hasOwnerFunctions: null,
      flags,
    };
  }

  async getPriceHistory(
    tokenAddress: string,
    timeframe: Timeframe
  ): Promise<OHLCVBar[]> {
    // Try Birdeye first
    const beData = await birdeye.getOHLCV(tokenAddress, timeframe);
    if (beData.length > 0) {
      return beData.map((bar) => ({
        timestamp: bar.unixTime,
        open: bar.o,
        high: bar.h,
        low: bar.l,
        close: bar.c,
        volume: bar.v,
      }));
    }

    // Fallback: GeckoTerminal (needs pool address)
    const pools = await geckoterminal.getTokenPools("solana", tokenAddress);
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
        "solana",
        pools[0].attributes.address,
        tf,
        agg
      );
    }

    return [];
  }

  async getWalletBalance(walletAddress: string): Promise<WalletBalance> {
    const data = await helius.getWalletBalances(walletAddress);

    if (!data) {
      // Fallback to getAssetsByOwner if v1 endpoint fails
      return this.getWalletBalanceFallback(walletAddress);
    }

    const tokens: WalletTokenHolding[] = [];
    let nativeBalance = 0;
    let nativeBalanceUsd = 0;

    const SOL_MINT = "So11111111111111111111111111111111111111111";

    for (const item of data.balances) {
      if (item.mint === SOL_MINT) {
        nativeBalance = item.balance;
        nativeBalanceUsd = item.usdValue ?? 0;
        continue;
      }

      tokens.push({
        tokenAddress: item.mint,
        symbol: item.symbol || "???",
        name: item.name || "Unknown",
        balance: item.balance,
        balanceUsd: item.usdValue ?? null,
        priceUsd: item.pricePerToken ?? null,
        priceChange24h: null,
        logoUrl: item.logoUri ?? null,
      });
    }

    // Sort by USD value desc
    tokens.sort((a, b) => (b.balanceUsd ?? 0) - (a.balanceUsd ?? 0));

    return {
      nativeBalance,
      nativeBalanceUsd,
      tokens,
      totalPortfolioUsd: data.totalUsdValue ?? 0,
    };
  }

  private async getWalletBalanceFallback(
    walletAddress: string
  ): Promise<WalletBalance> {
    const assets = await helius.getAssetsByOwner(walletAddress);
    const tokens: WalletTokenHolding[] = [];
    let totalPortfolioUsd = 0;

    for (const asset of assets) {
      if (!asset.token_info) continue;
      const balance =
        asset.token_info.balance / Math.pow(10, asset.token_info.decimals);
      const priceUsd = asset.token_info.price_info?.price_per_token ?? null;
      const balanceUsd = asset.token_info.price_info?.total_price ?? null;
      if (balanceUsd) totalPortfolioUsd += balanceUsd;

      tokens.push({
        tokenAddress: asset.id,
        symbol: asset.content?.metadata?.symbol ?? "???",
        name: asset.content?.metadata?.name ?? "Unknown",
        balance,
        balanceUsd,
        priceUsd,
        priceChange24h: null,
        logoUrl: asset.content?.links?.image ?? null,
      });
    }

    tokens.sort((a, b) => (b.balanceUsd ?? 0) - (a.balanceUsd ?? 0));

    return {
      nativeBalance: 0,
      nativeBalanceUsd: 0,
      tokens,
      totalPortfolioUsd,
    };
  }

  async getWalletTransactions(
    walletAddress: string,
    options?: TxQueryOptions
  ): Promise<Transaction[]> {
    const txns = await helius.getTransactionHistory(
      walletAddress,
      options?.limit ?? 50
    );

    // Collect all unique mints to resolve names + logos
    const mintSet = new Set<string>();
    for (const tx of txns) {
      for (const tt of tx.tokenTransfers ?? []) {
        if (tt.mint) mintSet.add(tt.mint);
      }
    }
    const assetMap = await helius.getAssetBatch([...mintSet]);

    const walletLower = walletAddress.toLowerCase();

    return txns.map((tx) => {
      const type = mapHeliusTxType(tx.type);
      const transfers = tx.tokenTransfers ?? [];
      const nativeTransfers = tx.nativeTransfers ?? [];

      // Determine the primary token involved and buy/sell side
      // For swaps: find what the wallet received (buy) vs sent (sell)
      // The "main" token is the non-SOL non-stablecoin one
      let primaryTransfer = transfers[0] ?? null;
      let side: "buy" | "sell" | null = null;

      if (type === "swap" && transfers.length > 0) {
        // Find the token received by the wallet (buy) and sent from wallet (sell)
        const received = transfers.find(
          (t) => t.toUserAccount?.toLowerCase() === walletLower
        );
        const sent = transfers.find(
          (t) => t.fromUserAccount?.toLowerCase() === walletLower
        );

        // Prefer the non-SOL/non-stable token as primary
        const receivedIsMain =
          received && !isNativeMint(received.mint) && !isStableMint(received.mint);
        const sentIsMain =
          sent && !isNativeMint(sent.mint) && !isStableMint(sent.mint);

        if (receivedIsMain) {
          primaryTransfer = received;
          side = "buy";
        } else if (sentIsMain) {
          primaryTransfer = sent;
          side = "sell";
        } else if (received) {
          primaryTransfer = received;
          side = "buy";
        } else if (sent) {
          primaryTransfer = sent;
          side = "sell";
        }
      } else if (type === "transfer" && primaryTransfer) {
        side =
          primaryTransfer.toUserAccount?.toLowerCase() === walletLower
            ? "buy"
            : "sell";
      }

      const mint = primaryTransfer?.mint ?? null;
      const asset = mint ? assetMap.get(mint) : null;

      return {
        hash: tx.signature,
        blockNumber: 0,
        timestamp: tx.timestamp,
        type,
        side,
        from: nativeTransfers[0]?.fromUserAccount ?? primaryTransfer?.fromUserAccount ?? walletAddress,
        to: nativeTransfers[0]?.toUserAccount ?? primaryTransfer?.toUserAccount ?? "",
        value: nativeTransfers[0]?.amount ?? 0,
        valueUsd: null,
        description: tx.description ?? "",
        source: tx.source ?? null,
        token: primaryTransfer
          ? {
              address: primaryTransfer.mint,
              symbol: asset?.symbol ?? "",
              name: asset?.name ?? "",
              logoUrl: asset?.logoUrl ?? null,
              amount: primaryTransfer.tokenAmount ?? 0,
              isNative: isNativeMint(primaryTransfer.mint),
              isStablecoin: isStableMint(primaryTransfer.mint),
            }
          : null,
        fee: tx.fee,
        status: "success" as const,
      };
    });
  }

  async getDeployedTokens(_walletAddress: string): Promise<DeployedToken[]> {
    // TODO: Implement via Solscan transaction history filtering
    return [];
  }

  async searchTokens(query: string): Promise<TokenSearchResult[]> {
    const results = await dexscreener.searchPairs(query);
    return results
      .filter((r) => r.chainId === "solana")
      .slice(0, 20)
      .map((pair) => ({
        address: pair.baseToken.address,
        chain: "solana" as const,
        name: pair.baseToken.name,
        symbol: pair.baseToken.symbol,
        logoUrl: pair.info?.imageUrl ?? null,
        priceUsd: parseFloat(pair.priceUsd) || null,
        volume24h: pair.volume?.h24 ?? null,
        liquidity: pair.liquidity?.usd ?? null,
      }));
  }
}

function mapHeliusTxType(
  type: string
): "swap" | "transfer" | "deploy" | "approve" | "other" {
  const t = type.toLowerCase();
  if (t.includes("swap")) return "swap";
  if (t.includes("transfer")) return "transfer";
  if (t.includes("create") || t.includes("deploy")) return "deploy";
  return "other";
}

const SOL_MINTS = new Set([
  "So11111111111111111111111111111111111111111",
  "So11111111111111111111111111111111111111112",
]);

const SOLANA_STABLES = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", // PYUSD
]);

function isNativeMint(mint: string): boolean {
  return SOL_MINTS.has(mint);
}

function isStableMint(mint: string): boolean {
  return SOLANA_STABLES.has(mint);
}
