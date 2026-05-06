import { CHAIN_CONFIGS } from "@/config/chains";
import type { ChainConfig } from "@/types/chain";
import type {
  HolderEntry,
  OHLCVBar,
  SafetySignals,
  SafetyFlag,
  Timeframe,
  TokenSearchResult,
} from "@/types/token";
import type {
  DeployedToken,
  Transaction,
  TxQueryOptions,
  WalletTokenHolding,
} from "@/types/wallet";
import type { ChainProvider, PairData, TokenMetadata, WalletBalance } from "../types";
import * as dexscreener from "@/lib/api/dexscreener";
import * as geckoterminal from "@/lib/api/geckoterminal";
import * as toncenter from "@/lib/api/toncenter";
import type { PairInfo } from "@/types/token";

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseDexScreenerPair(pair: dexscreener.DexScreenerPair): PairInfo {
  return {
    pairAddress: pair.pairAddress,
    dexId:       pair.dexId,
    dexName:     pair.dexId,
    baseToken:   { address: pair.baseToken.address, symbol: pair.baseToken.symbol },
    quoteToken:  { address: pair.quoteToken.address, symbol: pair.quoteToken.symbol },
    priceUsd:    parseFloat(pair.priceUsd) || 0,
    liquidity: {
      usd:   pair.liquidity?.usd   ?? 0,
      base:  pair.liquidity?.base  ?? 0,
      quote: pair.liquidity?.quote ?? 0,
    },
    volume24h: pair.volume?.h24 ?? 0,
    url:       pair.url,
  };
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class TonChainProvider implements ChainProvider {
  readonly config: ChainConfig = CHAIN_CONFIGS.ton;

  // ── Pair data (price, MC, liquidity) ───────────────────────────────────────

  async getPairData(tokenAddress: string): Promise<PairData | null> {
    // Primary: DexScreener — already indexes TON DEXes (DeDust, STON.fi)
    const dsPairs = await dexscreener.getTokenPairs("ton", tokenAddress);
    if (dsPairs.length > 0) {
      const sorted  = dsPairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      const primary = sorted[0];
      const pairs   = sorted.map(parseDexScreenerPair);
      const totalLiquidity = sorted.reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0) || null;

      return {
        pairs,
        primaryPair: pairs[0],
        priceUsd:    parseFloat(primary.priceUsd) || null,
        priceNative: parseFloat(primary.priceNative) || null,
        volume24h:   primary.volume?.h24 ?? null,
        liquidity:   totalLiquidity,
        marketCap:   primary.marketCap ?? null,
        fdv:         primary.fdv ?? null,
        priceChange: {
          h1:  primary.priceChange?.h1  ?? null,
          h6:  primary.priceChange?.h6  ?? null,
          h24: primary.priceChange?.h24 ?? null,
        },
        txns24h:   primary.txns?.h24 ?? null,
        createdAt: primary.pairCreatedAt
          ? Math.floor(primary.pairCreatedAt / 1000)
          : null,
        logoUrl: primary.info?.imageUrl ?? null,
      };
    }

    // Fallback: GeckoTerminal
    const gtPools = await geckoterminal.getTokenPools("ton", tokenAddress);
    if (gtPools.length > 0) {
      const pool = gtPools[0];
      const attr = pool.attributes;
      return {
        pairs:       [],
        primaryPair: null,
        priceUsd:    parseFloat(attr.base_token_price_usd) || null,
        priceNative: parseFloat(attr.base_token_price_native_currency) || null,
        volume24h:   parseFloat(attr.volume_usd.h24) || null,
        liquidity:   parseFloat(attr.reserve_in_usd) || null,
        marketCap:   attr.market_cap_usd ? parseFloat(attr.market_cap_usd) : null,
        fdv:         parseFloat(attr.fdv_usd) || null,
        priceChange: {
          h1:  parseFloat(attr.price_change_percentage.h1)  || null,
          h6:  parseFloat(attr.price_change_percentage.h6)  || null,
          h24: parseFloat(attr.price_change_percentage.h24) || null,
        },
        txns24h:   attr.transactions?.h24 ?? null,
        createdAt: attr.pool_created_at
          ? Math.floor(new Date(attr.pool_created_at).getTime() / 1000)
          : null,
        logoUrl: null,
      };
    }

    return null;
  }

  // ── Token metadata ─────────────────────────────────────────────────────────

  async getTokenMetadata(tokenAddress: string): Promise<TokenMetadata | null> {
    const master = await toncenter.getJettonMaster(tokenAddress);
    if (!master) return null;

    const ti = master.tokenInfo;
    const decimals = ti?.decimals ?? 9;
    const totalSupplyRaw = master.total_supply ?? "0";
    const totalSupply = toncenter.fromNano(totalSupplyRaw, decimals);

    // Extract socials from token_info.extra
    const extra = (ti?.extra ?? {}) as Record<string, string>;

    return {
      address:     master.userFriendly,
      name:        ti?.name    ?? "Unknown",
      symbol:      ti?.symbol  ?? "???",
      decimals,
      logoUrl:     ti?.image   ?? null,
      totalSupply,
      holderCount: null,   // TonCenter doesn't expose holder count cheaply
      website:     extra.website  ?? null,
      twitter:     extra.twitter  ?? extra.x ?? null,
      telegram:    extra.telegram ?? null,
      description: ti?.description ?? null,
    };
  }

  // ── Top holders ────────────────────────────────────────────────────────────

  async getTopHolders(tokenAddress: string, limit = 20): Promise<HolderEntry[]> {
    const [master, wallets] = await Promise.all([
      toncenter.getJettonMaster(tokenAddress),
      toncenter.getJettonHolders(tokenAddress, limit),
    ]);

    const decimals   = master?.tokenInfo?.decimals ?? 9;
    const totalRaw   = BigInt(master?.total_supply ?? "0");
    const totalFloat = toncenter.fromNano(totalRaw.toString(), decimals);

    return wallets.map((w) => {
      const balance    = toncenter.fromNano(w.balance, decimals);
      const percentage = totalFloat > 0 ? (balance / totalFloat) * 100 : 0;
      return {
        address:    w.ownerFriendly,
        balance,
        percentage,
        isContract: null,
        label:      null,
      };
    });
  }

  // ── Safety signals ─────────────────────────────────────────────────────────

  async getSafetySignals(tokenAddress: string): Promise<SafetySignals> {
    const master = await toncenter.getJettonMaster(tokenAddress);
    const flags: SafetyFlag[] = [];

    if (!master) {
      return {
        mintAuthorityRevoked:  null,
        freezeAuthorityRevoked: null,
        isMutable:             null,
        isSourceVerified:      null,
        isProxy:               null,
        isHoneypot:            null,
        hasOwnerFunctions:     null,
        flags: [],
      };
    }

    // Mintable / admin check
    const adminRenounced = master.adminRenounced;
    if (adminRenounced) {
      flags.push({
        severity:    "safe",
        label:       "Admin Renounced",
        description: "The admin key is the zero address or mint is disabled — no further minting possible.",
      });
    } else {
      flags.push({
        severity:    "warning",
        label:       "Admin Active",
        description: "A live admin address can still mint additional tokens.",
      });
    }

    if (master.mintable && !adminRenounced) {
      flags.push({
        severity:    "warning",
        label:       "Mintable",
        description: "Token supply can be increased by the admin.",
      });
    }

    return {
      mintAuthorityRevoked:  adminRenounced,
      freezeAuthorityRevoked: null,   // TON doesn't have freeze authority
      isMutable:             !adminRenounced,
      isSourceVerified:      null,
      isProxy:               null,
      isHoneypot:            null,
      hasOwnerFunctions:     !adminRenounced,
      flags,
    };
  }

  // ── Price history ──────────────────────────────────────────────────────────

  async getPriceHistory(
    tokenAddress: string,
    timeframe: Timeframe
  ): Promise<OHLCVBar[]> {
    // Use GeckoTerminal for OHLCV — it supports TON network
    const gtPools = await geckoterminal.getTokenPools("ton", tokenAddress);
    if (gtPools.length === 0) return [];

    const poolAddr = gtPools[0].attributes.address;

    const TF_MAP: Record<Timeframe, { tf: string; aggregate: number }> = {
      "1m":  { tf: "minute", aggregate: 1  },
      "5m":  { tf: "minute", aggregate: 5  },
      "15m": { tf: "minute", aggregate: 15 },
      "1h":  { tf: "hour",   aggregate: 1  },
      "4h":  { tf: "hour",   aggregate: 4  },
      "1d":  { tf: "day",    aggregate: 1  },
    };

    const { tf, aggregate } = TF_MAP[timeframe] ?? { tf: "hour", aggregate: 1 };

    return geckoterminal.getOHLCV("ton", poolAddr, tf, aggregate);
  }

  // ── Wallet balance ─────────────────────────────────────────────────────────

  async getWalletBalance(walletAddress: string): Promise<WalletBalance> {
    const [account, jettons] = await Promise.all([
      toncenter.getAccount(walletAddress),
      toncenter.getWalletJettons(walletAddress, 50),
    ]);

    const nativeBal     = account ? toncenter.nanotonToTon(account.balance) : 0;
    // TON price via DexScreener search for WTON or use 0 if unavailable
    const nativeBalUsd  = 0; // Price fetched separately in aggregator

    const tokens: WalletTokenHolding[] = jettons
      .filter((j) => j.symbol)
      .map((j) => ({
        tokenAddress:  j.jetton,
        symbol:        j.symbol ?? "???",
        name:          j.name   ?? j.symbol ?? "???",
        logoUrl:       null,
        balance:       toncenter.fromNano(j.balance, j.decimals),
        balanceUsd:    null,
        priceUsd:      null,
        priceChange24h: null,
      }));

    return {
      nativeBalance:    nativeBal,
      nativeBalanceUsd: nativeBalUsd,
      tokens,
      totalPortfolioUsd: 0,
    };
  }

  // ── Wallet transactions ────────────────────────────────────────────────────

  async getWalletTransactions(
    walletAddress: string,
    options?: TxQueryOptions
  ): Promise<Transaction[]> {
    const limit = options?.limit ?? 20;
    const txns  = await toncenter.getTransactions(walletAddress, limit);

    return txns.map((tx): Transaction => {
      const inVal  = tx.in_msg?.value ? toncenter.nanotonToTon(tx.in_msg.value) : 0;
      const outVal = tx.out_msgs[0]?.value
        ? toncenter.nanotonToTon(tx.out_msgs[0].value)
        : 0;
      const value  = Math.max(inVal, outVal);
      const isSend = tx.out_msgs.length > 0 && outVal > 0;

      return {
        hash:        tx.hash,
        blockNumber: 0,
        timestamp:   tx.now,
        type:        "transfer",
        side:        isSend ? "sell" : "buy",
        from:        tx.in_msg?.source            ?? walletAddress,
        to:          tx.out_msgs[0]?.destination  ?? walletAddress,
        value,
        valueUsd:    null,
        description: isSend
          ? `Sent ${value.toFixed(4)} TON`
          : `Received ${value.toFixed(4)} TON`,
        source:  null,
        token:   null,
        fee:     tx.total_fees ? toncenter.nanotonToTon(tx.total_fees) : 0,
        status:  "success",
      };
    });
  }

  // ── Deployed tokens ────────────────────────────────────────────────────────

  async getDeployedTokens(_walletAddress: string): Promise<DeployedToken[]> {
    return [];
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  async searchTokens(query: string): Promise<TokenSearchResult[]> {
    const pairs = await dexscreener.searchPairs(query);
    return pairs
      .filter((p) => p.chainId === "ton")
      .slice(0, 10)
      .map((p) => ({
        address:  p.baseToken.address,
        chain:    "ton",
        name:     p.baseToken.name,
        symbol:   p.baseToken.symbol,
        logoUrl:  p.info?.imageUrl ?? null,
        priceUsd: parseFloat(p.priceUsd) || null,
        volume24h: p.volume?.h24 ?? null,
        liquidity: p.liquidity?.usd ?? null,
      }));
  }
}
