import { NextResponse } from "next/server";
import type {
  SharedHoldChain,
  SharedHolder,
  SharedHolderTokenData,
  SharedHolderTokenMeta,
  SharedHoldersRequest,
  SharedHoldersResponse,
} from "@/types/shared-holders";
import { scrapeGmgnHoldersPaginated, warmupBrowser, type GmgnTopTrader } from "@/lib/api/gmgn-scraper";
import { getAssetBatch, getMintInfo } from "@/lib/api/helius";
import * as toncenter from "@/lib/api/toncenter";
import * as tonapi from "@/lib/api/tonapi";

export const maxDuration = 180;

// ── Address validation ────────────────────────────────────────────────────────

const EVM_RE    = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TON_RE    = /^(?:EQ|UQ|Ef|Uf|kQ|kf|0Q|0f)[A-Za-z0-9_-]{46}$/;

function validateAddresses(chain: SharedHoldChain, addresses: string[]): string | null {
  const re = chain === "solana" ? SOLANA_RE : chain === "ton" ? TON_RE : EVM_RE;
  for (const addr of addresses) {
    if (!re.test(addr)) {
      if (chain === "solana") return "Provide valid Solana mint addresses.";
      if (chain === "ton")    return "Provide valid TON jetton addresses (EQ/UQ…).";
      return "Provide valid EVM contract addresses (0x…).";
    }
  }
  if (new Set(addresses).size !== addresses.length) return "All addresses must be different.";
  return null;
}

// ── DexScreener image ─────────────────────────────────────────────────────────

const DEX_CHAIN: Record<SharedHoldChain, string> = {
  eth:    "ethereum",
  base:   "base",
  bsc:    "bsc",
  solana: "solana",
  ton:    "ton",
};

async function fetchDexImage(chain: SharedHoldChain, address: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/tokens/v1/${DEX_CHAIN[chain]}/${address}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return null;
    const pairs: Array<{ info?: { imageUrl?: string } }> = await res.json();
    if (!Array.isArray(pairs) || pairs.length === 0) return null;
    return pairs[0]?.info?.imageUrl ?? null;
  } catch {
    return null;
  }
}

// ── EVM token metadata via Moralis ────────────────────────────────────────────

const MORALIS_BASE  = "https://deep-index.moralis.io/api/v2.2";
const MORALIS_CHAIN: Record<string, string> = {
  eth:  "eth",
  base: "base",
  bsc:  "bsc",
};

interface MoralisTokenMeta {
  address: string;
  name: string;
  symbol: string;
  decimals: string;
  total_supply_formatted: string | null;
  logo: string | null;
}

async function fetchEvmTokenMeta(
  chain: string,
  addresses: string[]
): Promise<MoralisTokenMeta[] | null> {
  const key = process.env.MORALIS_API_KEY;
  if (!key) return null;
  const url = new URL(`${MORALIS_BASE}/erc20/metadata`);
  url.searchParams.set("chain", chain);
  addresses.forEach((addr, i) => url.searchParams.set(`addresses[${i}]`, addr));
  try {
    const res = await fetch(url.toString(), {
      headers: { "X-API-Key": key, Accept: "application/json" },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// ── Solana token metadata via Helius ──────────────────────────────────────────

interface SolTokenMeta {
  symbol: string;
  name: string;
  imageUrl: string | null;
  totalSupply: number | null;
}

async function fetchSolanaTokenMeta(mints: string[]): Promise<SolTokenMeta[]> {
  const [assetMap, mintInfos] = await Promise.all([
    getAssetBatch(mints),
    Promise.all(mints.map(getMintInfo)),
  ]);

  return mints.map((mint, i) => {
    const asset = assetMap.get(mint);
    const mintInfo = mintInfos[i];
    const decimals = mintInfo?.decimals ?? 6;
    const rawSupply = mintInfo?.supply ? parseInt(mintInfo.supply) : null;
    const totalSupply = rawSupply != null ? rawSupply / Math.pow(10, decimals) : null;
    return {
      symbol:     asset?.symbol   ?? "???",
      name:       asset?.name     ?? "Unknown",
      imageUrl:   asset?.logoUrl  ?? null,
      totalSupply,
    };
  });
}

// ── Build per-token data from GMGN holder record ──────────────────────────────

function buildTokenData(trader: GmgnTopTrader, totalSupply: number | null): SharedHolderTokenData {
  const investedUsd = trader.historyBoughtCostUsd > 0 ? trader.historyBoughtCostUsd : null;
  const soldUsd     = trader.historySoldIncomeUsd > 0 ? trader.historySoldIncomeUsd : null;
  const avgBuyPrice = trader.avgCostUsd > 0 ? trader.avgCostUsd : null;
  const buyMarketCap =
    avgBuyPrice != null && totalSupply != null && totalSupply > 0
      ? avgBuyPrice * totalSupply
      : null;

  return {
    balance:      String(trader.balance),
    balanceUsd:   trader.balanceUsd,
    percentage:   trader.supplyPercent,
    investedUsd,
    soldUsd,
    avgBuyPrice,
    buyMarketCap,
    realizedPnl:  trader.realizedProfitUsd,
    totalPnl:     trader.realizedProfitUsd + trader.unrealizedProfitUsd,
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as SharedHoldersRequest;
    const { chain, addresses } = body;

    const VALID_CHAINS: SharedHoldChain[] = ["eth", "base", "bsc", "solana", "ton"];
    if (!chain || !VALID_CHAINS.includes(chain)) {
      return NextResponse.json({ error: "Invalid chain. Use eth, base, bsc, solana, or ton." }, { status: 400 });
    }
    if (!Array.isArray(addresses) || addresses.length < 2 || addresses.length > 5) {
      return NextResponse.json({ error: "Provide 2–5 token addresses." }, { status: 400 });
    }

    const validationError = validateAddresses(chain, addresses);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const isSolana = chain === "solana";
    const isTon    = chain === "ton";
    const addrs = addresses.map((addr) => (isSolana || isTon) ? addr : addr.toLowerCase());

    // ── TON: TonAPI for holders, TonCenter for metadata ───────────────────────
    if (isTon) {
      const [holdersRaws, masters, dexImgs] = await Promise.all([
        Promise.all(addrs.map((addr) => tonapi.getTonApiHolders(addr, 200))),
        Promise.all(addrs.map((addr) => toncenter.getJettonMaster(addr))),
        Promise.all(addrs.map((addr) => fetchDexImage("ton", addr))),
      ]);

      const pricePairs = await Promise.all(
        addrs.map((addr) =>
          fetch(`https://api.dexscreener.com/tokens/v1/ton/${addr}`, { signal: AbortSignal.timeout(6000) })
            .then((r) => r.ok ? r.json() : []).catch(() => []) as Promise<Array<{ priceUsd?: string; liquidity?: { usd?: number } }>>
        )
      );
      const prices = pricePairs.map((pairs) =>
        parseFloat([...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0]?.priceUsd ?? "0") || 0
      );

      const holderMaps = holdersRaws.map((holdersRaw, i) => {
        const ti = masters[i]?.tokenInfo;
        const decimals = ti?.decimals ?? 9;
        const totalSupply = masters[i]?.total_supply
          ? toncenter.fromNano(masters[i].total_supply, decimals) : null;
        const sum = holdersRaw.reduce((s, h) => s + parseFloat(h.balance), 0);
        const denom = totalSupply ?? toncenter.fromNano(String(Math.floor(sum)), decimals);
        const map = new Map<string, { balance: number; percentage: number }>();
        for (const h of holdersRaw) {
          const bal = toncenter.fromNano(h.balance, decimals);
          map.set(h.ownerFriendly, { balance: bal, percentage: denom > 0 ? (bal / denom) * 100 : 0 });
        }
        return map;
      });

      const tokenMetas: SharedHolderTokenMeta[] = addrs.map((addr, i) => {
        const ti = masters[i]?.tokenInfo;
        const decimals = ti?.decimals ?? 9;
        const totalSupply = masters[i]?.total_supply ? toncenter.fromNano(masters[i].total_supply, decimals) : null;
        return {
          address: addr, symbol: ti?.symbol ?? "???", name: ti?.name ?? "Unknown",
          decimals, priceUsd: prices[i] || null, marketCap: null,
          totalSupply, imageUrl: dexImgs[i] ?? ti?.image ?? null,
        };
      });

      const commonAddresses = [...holderMaps[0].keys()].filter((addr) => holderMaps.every((m) => m.has(addr)));
      if (commonAddresses.length === 0) {
        return NextResponse.json({ holders: [], tokens: tokenMetas, chain } satisfies SharedHoldersResponse);
      }

      const holders: SharedHolder[] = commonAddresses
        .map((addr) => {
          const tokens: SharedHolderTokenData[] = holderMaps.map((map, i) => {
            const h = map.get(addr)!;
            const balUsd = prices[i] > 0 ? h.balance * prices[i] : 0;
            return {
              balance: String(h.balance), balanceUsd: balUsd, percentage: h.percentage,
              investedUsd: null, soldUsd: null, avgBuyPrice: null,
              buyMarketCap: null, realizedPnl: null, totalPnl: 0,
            };
          });
          // TON has no PnL data — sort by combined holding value
          const combinedPnl = tokens.reduce((s, t) => s + t.balanceUsd, 0);
          return { address: addr, tokens, combinedPnl };
        })
        .sort((a, b) => b.combinedPnl - a.combinedPnl);

      return NextResponse.json({ holders, tokens: tokenMetas, chain } satisfies SharedHoldersResponse);
    }

    // ── GMGN (Solana / EVM) ───────────────────────────────────────────────────
    // Start metadata + image fetches immediately (no Playwright, fast)
    const metaPromise = isSolana
      ? fetchSolanaTokenMeta(addrs)
      : fetchEvmTokenMeta(MORALIS_CHAIN[chain], addrs);
    const dexImgsPromise = Promise.all(addrs.map((addr) => fetchDexImage(chain, addr)));

    // Scrape holders one at a time — concurrent Playwright sessions overwhelm
    // GMGN's bot detection and cause all sessions to return 0 holders.
    // Pre-warm the browser so the first token's waitForResponse timer isn't
    // eaten by Chromium cold-start latency.
    await warmupBrowser();
    const rawHoldersAll: Awaited<ReturnType<typeof scrapeGmgnHoldersPaginated>>[] = [];
    for (const addr of addrs) {
      rawHoldersAll.push(await scrapeGmgnHoldersPaginated(chain, addr));
    }

    const [metaResult, dexImgs] = await Promise.all([metaPromise, dexImgsPromise]);

    const metaArr = addrs.map((addr, i) => {
      if (isSolana) {
        const m = (metaResult as SolTokenMeta[])[i];
        return { symbol: m.symbol, name: m.name, totalSupply: m.totalSupply, logo: m.imageUrl };
      }
      const evmMeta = metaResult as MoralisTokenMeta[] | null;
      const m = evmMeta?.find((x) => x.address?.toLowerCase() === addr);
      return {
        symbol: m?.symbol ?? "???",
        name: m?.name ?? "Unknown",
        totalSupply: m?.total_supply_formatted != null ? parseFloat(m.total_supply_formatted) || null : null,
        logo: m?.logo ?? null,
      };
    });

    const tokenMetas: SharedHolderTokenMeta[] = addrs.map((addr, i) => ({
      address: addr,
      symbol: metaArr[i].symbol,
      name: metaArr[i].name,
      decimals: 18,
      priceUsd: null,
      marketCap: null,
      totalSupply: metaArr[i].totalSupply,
      imageUrl: dexImgs[i] ?? metaArr[i].logo ?? null,
    }));

    const meetsThreshold = (t: GmgnTopTrader) =>
      t.balanceUsd >= 1 || (isSolana && t.balance > 0);

    const holderMaps = rawHoldersAll.map((rawHolders) =>
      new Map<string, GmgnTopTrader>(
        rawHolders.filter(meetsThreshold).map((t) => [t.walletAddress, t])
      )
    );

    const commonAddresses = [...holderMaps[0].keys()].filter((addr) => holderMaps.every((m) => m.has(addr)));
    if (commonAddresses.length === 0) {
      return NextResponse.json({ holders: [], tokens: tokenMetas, chain } satisfies SharedHoldersResponse);
    }

    const holders: SharedHolder[] = commonAddresses
      .map((addr) => {
        const tokens: SharedHolderTokenData[] = holderMaps.map((map, i) =>
          buildTokenData(map.get(addr)!, metaArr[i].totalSupply)
        );
        const combinedPnl = tokens.reduce((s, t) => s + t.totalPnl, 0);
        return { address: addr, tokens, combinedPnl };
      })
      .sort((a, b) => b.combinedPnl - a.combinedPnl);

    return NextResponse.json({ holders, tokens: tokenMetas, chain } satisfies SharedHoldersResponse);

  } catch (error) {
    console.error("[shared-holders]", error);
    return NextResponse.json({ error: "Failed to find shared holders." }, { status: 500 });
  }
}
