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

export const maxDuration = 120;

// ── Address validation ────────────────────────────────────────────────────────

const EVM_RE    = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function validateAddresses(chain: SharedHoldChain, a: string, b: string): string | null {
  const re = chain === "solana" ? SOLANA_RE : EVM_RE;
  if (!re.test(a) || !re.test(b)) {
    return chain === "solana"
      ? "Provide two valid Solana mint addresses."
      : "Provide two valid EVM contract addresses (0x…).";
  }
  const norm = chain === "solana"
    ? (s: string) => s          // Solana: case-sensitive
    : (s: string) => s.toLowerCase();
  if (norm(a) === norm(b)) return "Addresses must be different.";
  return null;
}

// ── DexScreener image ─────────────────────────────────────────────────────────

const DEX_CHAIN: Record<SharedHoldChain, string> = {
  eth:    "ethereum",
  base:   "base",
  bsc:    "bsc",
  solana: "solana",
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

    const VALID_CHAINS: SharedHoldChain[] = ["eth", "base", "bsc", "solana"];
    if (!chain || !VALID_CHAINS.includes(chain)) {
      return NextResponse.json({ error: "Invalid chain. Use eth, base, bsc, or solana." }, { status: 400 });
    }

    const validationError = validateAddresses(chain, addressA ?? "", addressB ?? "");
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const isSolana = chain === "solana";
    const addrA = isSolana ? addressA : addressA.toLowerCase();
    const addrB = isSolana ? addressB : addressB.toLowerCase();

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
