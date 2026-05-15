import { NextResponse } from "next/server";
import type {
  SharedHoldChain,
  SharedHolder,
  SharedHolderTokenData,
  SharedHolderTokenMeta,
  SharedHoldersRequest,
  SharedHoldersResponse,
} from "@/types/shared-holders";
import { scrapeGmgnHoldersPaginated, type GmgnTopTrader } from "@/lib/api/gmgn-scraper";
import { getAssetBatch, getMintInfo } from "@/lib/api/helius";
import * as toncenter from "@/lib/api/toncenter";
import * as tonapi from "@/lib/api/tonapi";

export const maxDuration = 120;

// ── Address validation ────────────────────────────────────────────────────────

const EVM_RE    = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TON_RE    = /^(?:EQ|UQ|Ef|Uf|kQ|kf|0Q|0f)[A-Za-z0-9_-]{46}$/;

function validateAddresses(chain: SharedHoldChain, a: string, b: string): string | null {
  const re = chain === "solana" ? SOLANA_RE : chain === "ton" ? TON_RE : EVM_RE;
  if (!re.test(a) || !re.test(b)) {
    if (chain === "solana") return "Provide two valid Solana mint addresses.";
    if (chain === "ton")    return "Provide two valid TON jetton addresses (EQ/UQ…).";
    return "Provide two valid EVM contract addresses (0x…).";
  }
  if (a === b) return "Addresses must be different.";
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
  addrA: string,
  addrB: string
): Promise<MoralisTokenMeta[] | null> {
  const key = process.env.MORALIS_API_KEY;
  if (!key) return null;
  const url = new URL(`${MORALIS_BASE}/erc20/metadata`);
  url.searchParams.set("chain", chain);
  url.searchParams.set("addresses[0]", addrA);
  url.searchParams.set("addresses[1]", addrB);
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

async function fetchSolanaTokenMeta(mintA: string, mintB: string): Promise<[SolTokenMeta, SolTokenMeta]> {
  const [assetMap, mintInfoA, mintInfoB] = await Promise.all([
    getAssetBatch([mintA, mintB]),
    getMintInfo(mintA),
    getMintInfo(mintB),
  ]);

  function toMeta(mint: string, mintInfo: Awaited<ReturnType<typeof getMintInfo>>): SolTokenMeta {
    const asset = assetMap.get(mint);
    const decimals = mintInfo?.decimals ?? 6;
    const rawSupply = mintInfo?.supply ? parseInt(mintInfo.supply) : null;
    const totalSupply = rawSupply != null ? rawSupply / Math.pow(10, decimals) : null;
    return {
      symbol:     asset?.symbol   ?? "???",
      name:       asset?.name     ?? "Unknown",
      imageUrl:   asset?.logoUrl  ?? null,
      totalSupply,
    };
  }

  return [toMeta(mintA, mintInfoA), toMeta(mintB, mintInfoB)];
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
    const { chain, addressA, addressB } = body;

    const VALID_CHAINS: SharedHoldChain[] = ["eth", "base", "bsc", "solana", "ton"];
    if (!chain || !VALID_CHAINS.includes(chain)) {
      return NextResponse.json({ error: "Invalid chain. Use eth, base, bsc, solana, or ton." }, { status: 400 });
    }

    const validationError = validateAddresses(chain, addressA ?? "", addressB ?? "");
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const isSolana = chain === "solana";
    const isTon    = chain === "ton";
    // TON + Solana addresses are case-sensitive; EVM are lowercased
    const addrA = isSolana || isTon ? addressA : addressA.toLowerCase();
    const addrB = isSolana || isTon ? addressB : addressB.toLowerCase();

    // ── TON: TonAPI for holders, TonCenter for metadata ───────────────────────
    if (isTon) {
      const [holdersRawA, holdersRawB, masterA, masterB, dexImgA, dexImgB] = await Promise.all([
        tonapi.getTonApiHolders(addrA, 200),
        tonapi.getTonApiHolders(addrB, 200),
        toncenter.getJettonMaster(addrA),
        toncenter.getJettonMaster(addrB),
        fetchDexImage("ton", addrA),
        fetchDexImage("ton", addrB),
      ]);

      const tiA = masterA?.tokenInfo;
      const tiB = masterB?.tokenInfo;
      const decimalsA = tiA?.decimals ?? 9;
      const decimalsB = tiB?.decimals ?? 9;
      const totalSupplyA = masterA?.total_supply
        ? toncenter.fromNano(masterA.total_supply, decimalsA) : null;
      const totalSupplyB = masterB?.total_supply
        ? toncenter.fromNano(masterB.total_supply, decimalsB) : null;

      // Fetch prices via DexScreener
      const [pairsA, pairsB] = await Promise.all([
        fetch(`https://api.dexscreener.com/tokens/v1/ton/${addrA}`, { signal: AbortSignal.timeout(6000) })
          .then((r) => r.ok ? r.json() : []).catch(() => []) as Promise<Array<{ priceUsd?: string; liquidity?: { usd?: number } }>>,
        fetch(`https://api.dexscreener.com/tokens/v1/ton/${addrB}`, { signal: AbortSignal.timeout(6000) })
          .then((r) => r.ok ? r.json() : []).catch(() => []) as Promise<Array<{ priceUsd?: string; liquidity?: { usd?: number } }>>,
      ]);
      const priceA = parseFloat(
        [...pairsA].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0]?.priceUsd ?? "0"
      ) || 0;
      const priceB = parseFloat(
        [...pairsB].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0]?.priceUsd ?? "0"
      ) || 0;

      // Build holder maps keyed by ownerFriendly address
      const mapA = new Map<string, { balance: number; percentage: number }>();
      const mapB = new Map<string, { balance: number; percentage: number }>();

      const sumA = holdersRawA.reduce((s, h) => s + parseFloat(h.balance), 0);
      const sumB = holdersRawB.reduce((s, h) => s + parseFloat(h.balance), 0);
      const denomA = totalSupplyA ?? toncenter.fromNano(String(Math.floor(sumA)), decimalsA);
      const denomB = totalSupplyB ?? toncenter.fromNano(String(Math.floor(sumB)), decimalsB);

      for (const h of holdersRawA) {
        const bal = toncenter.fromNano(h.balance, decimalsA);
        mapA.set(h.ownerFriendly, { balance: bal, percentage: denomA > 0 ? (bal / denomA) * 100 : 0 });
      }
      for (const h of holdersRawB) {
        const bal = toncenter.fromNano(h.balance, decimalsB);
        mapB.set(h.ownerFriendly, { balance: bal, percentage: denomB > 0 ? (bal / denomB) * 100 : 0 });
      }

      const tokenAMeta: SharedHolderTokenMeta = {
        address: addrA, symbol: tiA?.symbol ?? "???", name: tiA?.name ?? "Unknown",
        decimals: decimalsA, priceUsd: priceA || null, marketCap: null,
        totalSupply: totalSupplyA, imageUrl: dexImgA ?? tiA?.image ?? null,
      };
      const tokenBMeta: SharedHolderTokenMeta = {
        address: addrB, symbol: tiB?.symbol ?? "???", name: tiB?.name ?? "Unknown",
        decimals: decimalsB, priceUsd: priceB || null, marketCap: null,
        totalSupply: totalSupplyB, imageUrl: dexImgB ?? tiB?.image ?? null,
      };

      const commonAddresses = [...mapA.keys()].filter((addr) => mapB.has(addr));
      if (commonAddresses.length === 0) {
        return NextResponse.json({
          holders: [], tokenA: tokenAMeta, tokenB: tokenBMeta, chain,
        } satisfies SharedHoldersResponse);
      }

      const holders: SharedHolder[] = commonAddresses
        .map((addr) => {
          const hA = mapA.get(addr)!;
          const hB = mapB.get(addr)!;
          const balUsdA = priceA > 0 ? hA.balance * priceA : 0;
          const balUsdB = priceB > 0 ? hB.balance * priceB : 0;
          const tokenAData: SharedHolderTokenData = {
            balance: String(hA.balance), balanceUsd: balUsdA, percentage: hA.percentage,
            investedUsd: null, soldUsd: null, avgBuyPrice: null,
            buyMarketCap: null, realizedPnl: null, totalPnl: 0,
          };
          const tokenBData: SharedHolderTokenData = {
            balance: String(hB.balance), balanceUsd: balUsdB, percentage: hB.percentage,
            investedUsd: null, soldUsd: null, avgBuyPrice: null,
            buyMarketCap: null, realizedPnl: null, totalPnl: 0,
          };
          // No PnL data for TON — sort by combined holding USD value
          return { address: addr, tokenA: tokenAData, tokenB: tokenBData, combinedPnl: balUsdA + balUsdB };
        })
        .sort((a, b) => b.combinedPnl - a.combinedPnl);

      return NextResponse.json({
        holders, tokenA: tokenAMeta, tokenB: tokenBMeta, chain,
      } satisfies SharedHoldersResponse);
    }

    // Scrape GMGN holders for both tokens + fetch metadata + images — all in parallel
    const [rawHoldersA, rawHoldersB, metaResult, dexImgA, dexImgB] = await Promise.all([
      scrapeGmgnHoldersPaginated(chain, addrA),
      scrapeGmgnHoldersPaginated(chain, addrB),
      isSolana
        ? fetchSolanaTokenMeta(addrA, addrB)
        : fetchEvmTokenMeta(MORALIS_CHAIN[chain], addrA, addrB),
      fetchDexImage(chain, addrA),
      fetchDexImage(chain, addrB),
    ]);

    // Resolve metadata per chain
    let symbolA = "???", nameA = "Unknown", totalSupplyA: number | null = null, logoA: string | null = null;
    let symbolB = "???", nameB = "Unknown", totalSupplyB: number | null = null, logoB: string | null = null;

    if (isSolana) {
      const [mA, mB] = metaResult as unknown as [SolTokenMeta, SolTokenMeta];
      symbolA = mA.symbol; nameA = mA.name; totalSupplyA = mA.totalSupply; logoA = mA.imageUrl;
      symbolB = mB.symbol; nameB = mB.name; totalSupplyB = mB.totalSupply; logoB = mB.imageUrl;
    } else {
      const evmMeta = metaResult as MoralisTokenMeta[] | null;
      const mA = evmMeta?.find((m) => m.address?.toLowerCase() === addrA);
      const mB = evmMeta?.find((m) => m.address?.toLowerCase() === addrB);
      symbolA = mA?.symbol ?? "???"; nameA = mA?.name ?? "Unknown";
      totalSupplyA = mA?.total_supply_formatted != null ? parseFloat(mA.total_supply_formatted) || null : null;
      logoA = mA?.logo ?? null;
      symbolB = mB?.symbol ?? "???"; nameB = mB?.name ?? "Unknown";
      totalSupplyB = mB?.total_supply_formatted != null ? parseFloat(mB.total_supply_formatted) || null : null;
      logoB = mB?.logo ?? null;
    }

    const imageA = dexImgA ?? logoA ?? null;
    const imageB = dexImgB ?? logoB ?? null;

    // Filter: ≥$1 USD value, OR for Solana (pump.fun tokens often lack USD price)
    // fall back to balance > 0 so price-less tokens aren't excluded entirely.
    const meetsThreshold = (t: GmgnTopTrader) =>
      t.balanceUsd >= 1 || (isSolana && t.balance > 0);

    const holdersA = new Map<string, GmgnTopTrader>(
      rawHoldersA.filter(meetsThreshold).map((t) => [t.walletAddress, t])
    );
    const holdersB = new Map<string, GmgnTopTrader>(
      rawHoldersB.filter(meetsThreshold).map((t) => [t.walletAddress, t])
    );

    const tokenAMeta: SharedHolderTokenMeta = {
      address: addrA, symbol: symbolA, name: nameA,
      decimals: 18, priceUsd: null, marketCap: null,
      totalSupply: totalSupplyA, imageUrl: imageA,
    };
    const tokenBMeta: SharedHolderTokenMeta = {
      address: addrB, symbol: symbolB, name: nameB,
      decimals: 18, priceUsd: null, marketCap: null,
      totalSupply: totalSupplyB, imageUrl: imageB,
    };

    // Intersection
    const commonAddresses = [...holdersA.keys()].filter((addr) => holdersB.has(addr));

    if (commonAddresses.length === 0) {
      return NextResponse.json({
        holders: [], tokenA: tokenAMeta, tokenB: tokenBMeta, chain,
      } satisfies SharedHoldersResponse);
    }

    const holders: SharedHolder[] = commonAddresses
      .map((addr) => {
        const tokenAData = buildTokenData(holdersA.get(addr)!, totalSupplyA);
        const tokenBData = buildTokenData(holdersB.get(addr)!, totalSupplyB);
        const combinedPnl = tokenAData.totalPnl + tokenBData.totalPnl;
        return { address: addr, tokenA: tokenAData, tokenB: tokenBData, combinedPnl };
      })
      .sort((a, b) => b.combinedPnl - a.combinedPnl);

    return NextResponse.json({
      holders, tokenA: tokenAMeta, tokenB: tokenBMeta, chain,
    } satisfies SharedHoldersResponse);

  } catch (error) {
    console.error("[shared-holders]", error);
    return NextResponse.json({ error: "Failed to find shared holders." }, { status: 500 });
  }
}
