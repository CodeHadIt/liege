import { NextResponse } from "next/server";
import { getChainProvider, isChainSupported } from "@/lib/chains/registry";
import { CHAIN_CONFIGS } from "@/config/chains";
import * as helius from "@/lib/api/helius";
import * as toncenter from "@/lib/api/toncenter";
import { searchPairs } from "@/lib/api/dexscreener";
import { scrapeGmgnTopTraders } from "@/lib/api/gmgn-scraper";
import { serverCache, CACHE_TTL } from "@/lib/cache";
import type { ChainId } from "@/types/chain";
import type {
  TopTrader,
  TopTradersResponse,
  TraderTier,
  StablecoinBalance,
} from "@/types/traders";

// Known stablecoin mints on Solana
const SOLANA_STABLES: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": "PYUSD",
};

function getTier(pnlUsd: number): TraderTier {
  const abs = Math.abs(pnlUsd);
  if (abs >= 50_000) return "whale";
  if (abs >= 10_000) return "dolphin";
  if (abs >= 1_000) return "fish";
  if (abs >= 100) return "crab";
  return "shrimp";
}

// Allow up to 120s on Vercel Pro — GMGN scraping takes ~25s
export const maxDuration = 120;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ chain: string; address: string }> }
) {
  try {
    const { chain, address } = await params;

    if (!isChainSupported(chain)) {
      return NextResponse.json(
        { error: `Chain "${chain}" not supported` },
        { status: 400 }
      );
    }

    const chainId = chain as ChainId;
    const cacheKey = `top-traders:${chainId}:${address}`;
    const cached = serverCache.get<TopTradersResponse>(cacheKey);
    if (cached) return NextResponse.json(cached);

    const provider = getChainProvider(chainId);
    const chainConfig = CHAIN_CONFIGS[chainId];

    const pairData = await provider.getPairData(address);
    const priceUsd = pairData?.priceUsd ?? null;
    const marketCap = pairData?.marketCap ?? null;
    const tokenSymbol = pairData?.primaryPair?.baseToken?.symbol ?? "???";

    let traders: TopTrader[] = [];

    // ── TON: TonCenter holders + per-wallet enrichment ────────────────────────
    if (chainId === "ton") {
      // Fetch TON price once
      let tonPrice = 0;
      try {
        const tonPairs = await searchPairs("USDT TON").catch(() => []);
        const tonPair  = tonPairs.find(
          (p) => p.chainId === "ton" && p.quoteToken.symbol === "USDT" &&
                 (p.baseToken.symbol === "TON" || p.baseToken.symbol === "TONCOIN")
        ) ?? tonPairs.find((p) => p.chainId === "ton" && (p.liquidity?.usd ?? 0) > 10_000);
        if (tonPair) tonPrice = 1 / (parseFloat(tonPair.priceNative) || 1);
      } catch { /* skip */ }

      const holders = await provider.getTopHolders(address, 50);

      // Enrich in batches of 5 to avoid flooding TonCenter
      const enriched: TopTrader[] = [];
      const BATCH = 5;
      for (let i = 0; i < holders.length; i += BATCH) {
        const batch = holders.slice(i, i + BATCH);
        const results = await Promise.allSettled(
          batch.map(async (h) => {
            const walletAddr = h.address;

            const [account, jettons, transfers] = await Promise.all([
              toncenter.getAccount(walletAddr).catch(() => null),
              toncenter.getWalletJettons(walletAddr, 50).catch(() => []),
              toncenter.getJettonTransfersByToken(walletAddr, address, 50).catch(() => []),
            ]);

            const nativeBal    = account ? toncenter.nanotonToTon(account.balance) : 0;
            const nativeBalUsd = nativeBal * tonPrice;

            // USDT balance
            const usdtJetton = jettons.find(
              (j) => j.jetton.toLowerCase() === toncenter.USDT_JETTON_MASTER.toLowerCase()
            );
            const usdtBal = usdtJetton
              ? toncenter.fromNano(usdtJetton.balance, usdtJetton.decimals)
              : 0;
            const stablecoins: StablecoinBalance[] = usdtBal > 0
              ? [{ symbol: "USDT", balance: usdtBal, balanceUsd: usdtBal }]
              : [];

            // Trade history from transfers
            const buys  = transfers.filter((t) => t.destination_wallet === walletAddr || t.destination === walletAddr);
            const sells = transfers.filter((t) => t.source_wallet === walletAddr || t.source === walletAddr);
            const lastTs = transfers[0]?.transaction_now ?? null;
            const tradeCount = transfers.length;

            const remainingTokensUsd = priceUsd ? h.balance * priceUsd : 0;

            return {
              walletAddress:      walletAddr,
              nativeBalance:      nativeBal,
              nativeBalanceUsd:   nativeBalUsd,
              stablecoinTotal:    usdtBal,
              stablecoins,
              avgBuyAmount:       buys.length > 0
                ? buys.reduce((s, t) => s + toncenter.fromNano(t.amount, t.decimals), 0) / buys.length
                : 0,
              avgBuyAmountUsd:    0, // No reliable price-at-time data
              avgBuyMarketCap:    null,
              avgSellMarketCap:   null,
              avgSellPrice:       null,
              realizedPnl:        0,
              realizedPnlUsd:     0,
              remainingTokens:    h.balance,
              remainingTokensUsd,
              lastTradeTimestamp: lastTs,
              tier:               getTier(remainingTokensUsd) as TraderTier,
              tradeCount,
            } satisfies TopTrader;
          })
        );
        for (const r of results) {
          if (r.status === "fulfilled") enriched.push(r.value);
        }
      }

      traders = enriched;
    }

    // ── EVM: GMGN scraper → top holders fallback ──────────────────────────────
    if (chainId !== "solana" && chainId !== "ton") {
      const gmgnTraders = await scrapeGmgnTopTraders(chainId, address).catch(
        (err) => {
          console.error(`[top-traders] GMGN scrape failed:`, err);
          return [];
        }
      );

      if (gmgnTraders.length > 0) {
        traders = gmgnTraders.map((t) => {
          const nativeEth = parseInt(t.nativeBalanceWei) / 1e18 || 0;
          return {
            walletAddress: t.walletAddress,
            nativeBalance: nativeEth,
            nativeBalanceUsd: 0,
            stablecoinTotal: 0,
            stablecoins: [] as StablecoinBalance[],
            avgBuyAmount: t.historyBoughtCostUsd > 0 && t.avgCostUsd > 0
              ? t.historyBoughtCostUsd / t.avgCostUsd
              : 0,
            avgBuyAmountUsd: t.historyBoughtCostUsd,
            avgBuyMarketCap: null,
            avgSellMarketCap: null,
            avgSellPrice: t.avgSoldUsd > 0 ? t.avgSoldUsd : null,
            realizedPnl: priceUsd && priceUsd > 0 ? t.realizedProfitUsd / priceUsd : 0,
            realizedPnlUsd: t.realizedProfitUsd,
            remainingTokens: t.balance,
            remainingTokensUsd: t.balanceUsd,
            lastTradeTimestamp: t.lastActiveTimestamp,
            tier: getTier(t.realizedProfitUsd),
            tradeCount: t.buyCount + t.sellCount,
          } satisfies TopTrader;
        });
      } else {
        // Fall back to top holders if GMGN returns nothing
        console.log(`[top-traders] GMGN returned 0 for ${address}, falling back to holders`);
        const holders = await provider.getTopHolders(address, 50);
        traders = holders.map((h) => ({
          walletAddress: h.address,
          nativeBalance: 0,
          nativeBalanceUsd: 0,
          stablecoinTotal: 0,
          stablecoins: [] as StablecoinBalance[],
          avgBuyAmount: 0,
          avgBuyAmountUsd: 0,
          avgBuyMarketCap: null,
          avgSellMarketCap: null,
          avgSellPrice: null,
          realizedPnl: 0,
          realizedPnlUsd: 0,
          remainingTokens: h.balance,
          remainingTokensUsd: priceUsd ? h.balance * priceUsd : 0,
          lastTradeTimestamp: null,
          tier: "shrimp" as TraderTier,
          tradeCount: 0,
        }));
      }
    }

    // ── Solana: Helius holder + swap history ───────────────────────────────────
    if (chainId === "solana") {
      const holders = await provider.getTopHolders(address, 50);

      const ownerMap = await helius.getMultipleAccountOwners(
        holders.map((h) => h.address)
      );
      const ownerAddresses = holders.map(
        (h) => ownerMap.get(h.address) ?? h.address
      );

      const traderPromises = ownerAddresses.map(async (walletAddr, idx) => {
        const holder = holders[idx];
        try {
          const walletBalance = await provider.getWalletBalance(walletAddr);

          const stablecoins: StablecoinBalance[] = [];
          let stablecoinTotal = 0;
          for (const tok of walletBalance.tokens) {
            const stableSymbol = SOLANA_STABLES[tok.tokenAddress] ?? null;
            if (stableSymbol) {
              const bal = tok.balanceUsd ?? tok.balance;
              stablecoins.push({
                symbol: stableSymbol,
                balance: tok.balance,
                balanceUsd: tok.balanceUsd ?? tok.balance,
              });
              stablecoinTotal += bal;
            }
          }

          const history = await helius.getWalletHistoryAll(walletAddr, {
            maxPages: 1,
            limit: 100,
            type: "SWAP",
          });

          const buys: { amount: number; timestamp: number }[] = [];
          const sells: { amount: number; timestamp: number }[] = [];

          for (const tx of history) {
            if (tx.error || !tx.timestamp) continue;
            const netChanges = new Map<string, number>();
            for (const bc of tx.balanceChanges) {
              netChanges.set(bc.mint, (netChanges.get(bc.mint) ?? 0) + bc.amount);
            }
            const tokenChange = netChanges.get(address);
            if (!tokenChange || tokenChange === 0) continue;
            if (tokenChange > 0) buys.push({ amount: tokenChange, timestamp: tx.timestamp });
            else sells.push({ amount: Math.abs(tokenChange), timestamp: tx.timestamp });
          }

          const totalBoughtTokens = buys.reduce((s, b) => s + b.amount, 0);
          const totalSoldTokens = sells.reduce((s, b) => s + b.amount, 0);
          const tradeCount = buys.length + sells.length;
          const avgBuyAmount = buys.length > 0 ? totalBoughtTokens / buys.length : 0;
          const allTimestamps = [...buys, ...sells].map((x) => x.timestamp);
          const lastTradeTimestamp = allTimestamps.length > 0 ? Math.max(...allTimestamps) : null;

          const remaining = holder.balance;
          const realizedPnlTokens = totalSoldTokens - totalBoughtTokens + remaining;
          const realizedPnlUsd = priceUsd ? realizedPnlTokens * priceUsd : 0;

          return {
            walletAddress: walletAddr,
            nativeBalance: walletBalance.nativeBalance,
            nativeBalanceUsd: walletBalance.nativeBalanceUsd,
            stablecoinTotal,
            stablecoins,
            avgBuyAmount,
            avgBuyAmountUsd: priceUsd ? avgBuyAmount * priceUsd : 0,
            avgBuyMarketCap: buys.length > 0 ? marketCap : null,
            avgSellMarketCap: sells.length > 0 ? marketCap : null,
            avgSellPrice: sells.length > 0 ? priceUsd : null,
            realizedPnl: realizedPnlTokens,
            realizedPnlUsd,
            remainingTokens: remaining,
            remainingTokensUsd: priceUsd ? remaining * priceUsd : 0,
            lastTradeTimestamp,
            tier: getTier(Math.abs(realizedPnlUsd)),
            tradeCount,
          } satisfies TopTrader;
        } catch {
          return {
            walletAddress: walletAddr,
            nativeBalance: 0,
            nativeBalanceUsd: 0,
            stablecoinTotal: 0,
            stablecoins: [] as StablecoinBalance[],
            avgBuyAmount: 0,
            avgBuyAmountUsd: 0,
            avgBuyMarketCap: null,
            avgSellMarketCap: null,
            avgSellPrice: null,
            realizedPnl: 0,
            realizedPnlUsd: 0,
            remainingTokens: holder.balance,
            remainingTokensUsd: priceUsd ? holder.balance * priceUsd : 0,
            lastTradeTimestamp: null,
            tier: "shrimp" as TraderTier,
            tradeCount: 0,
          } satisfies TopTrader;
        }
      });

      const BATCH = 5;
      for (let i = 0; i < traderPromises.length; i += BATCH) {
        const batch = await Promise.all(traderPromises.slice(i, i + BATCH));
        traders.push(...batch);
      }

      traders.sort((a, b) => Math.abs(b.realizedPnlUsd) - Math.abs(a.realizedPnlUsd));
    }

    const response: TopTradersResponse = {
      traders: traders.slice(0, 50),
      tokenSymbol,
      tokenPriceUsd: priceUsd,
      nativeSymbol: chainConfig.nativeCurrency.symbol,
    };

    serverCache.set(cacheKey, response, CACHE_TTL.TOP_TRADERS);

    return NextResponse.json(response);
  } catch (error) {
    console.error("Top traders error:", error);
    return NextResponse.json(
      { error: "Failed to fetch top traders" },
      { status: 500 }
    );
  }
}
