import { NextResponse } from "next/server";
import type {
  SharedHoldChain,
  SharedHolder,
  SharedHolderTokenData,
  SharedHolderTokenMeta,
  SharedHoldersRequest,
  SharedHoldersResponse,
} from "@/types/shared-holders";

const DEX_CHAIN: Record<SharedHoldChain, string> = {
  eth:  "ethereum",
  base: "base",
  bsc:  "bsc",
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

export const maxDuration = 120;

const MORALIS_BASE = "https://deep-index.moralis.io/api/v2.2";
const MORALIS_CHAIN: Record<SharedHoldChain, string> = {
  eth:  "eth",
  base: "base",
  bsc:  "bsc",
};
// Moralis wallet profitability is only supported on ETH and Base
const PROFITABILITY_CHAINS = new Set<SharedHoldChain>(["eth", "base"]);

// ── Moralis fetch helper ──────────────────────────────────────────────────────

async function moralisFetch<T>(path: string, params?: Record<string, string>): Promise<T | null> {
  const key = process.env.MORALIS_API_KEY;
  if (!key) return null;

  const url = new URL(`${MORALIS_BASE}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  try {
    const res = await fetch(url.toString(), {
      headers: { "X-API-Key": key, "Accept": "application/json" },
    });
    if (!res.ok) {
      console.error(`[moralis] ${res.status} ${url.pathname}`);
      return null;
    }
    const json = await res.json();
    if (url.pathname.includes("/profitability")) {
      console.log(`[moralis-profit] ${url.pathname.slice(-20)} raw keys:`, Object.keys(json));
      const first = Array.isArray(json?.result) ? json.result[0] : null;
      if (first) console.log(`[moralis-profit] first entry keys:`, Object.keys(first), "| sample:", JSON.stringify(first).slice(0, 200));
      else console.log(`[moralis-profit] result array:`, JSON.stringify(json).slice(0, 300));
    }
    return json;
  } catch {
    return null;
  }
}

// ── Types for Moralis responses ───────────────────────────────────────────────

interface MoralisHolder {
  owner_address: string;
  balance_formatted: string;
  usd_value: string | null;
  percentage_relative_to_total_supply: number | null;
  is_contract: boolean;
}

interface MoralisHoldersPage {
  result: MoralisHolder[];
  cursor: string | null;
}

interface MoralisProfitEntry {
  token_address: string;
  avg_buy_price_usd: string | null;
  total_usd_invested: string | null;
  total_tokens_bought: string | null;
  total_sold_usd: string | null;
  realized_profit_usd: string | null;
}

interface MoralisTokenMeta {
  address: string;
  name: string;
  symbol: string;
  decimals: string;
  total_supply_formatted: string | null;
  logo: string | null;
}

// ── Fetch all holders for a token (up to MAX_PAGES pages) ────────────────────

const MAX_PAGES = 5; // 500 holders max per token

async function fetchHolders(
  tokenAddress: string,
  moralisChain: string
): Promise<Map<string, { balance: string; usd: number; pct: number }>> {
  const map = new Map<string, { balance: string; usd: number; pct: number }>();
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params: Record<string, string> = { chain: moralisChain, limit: "100" };
    if (cursor) params.cursor = cursor;

    const data = await moralisFetch<MoralisHoldersPage>(
      `/erc20/${tokenAddress.toLowerCase()}/owners`,
      params
    );
    if (!data?.result?.length) break;

    for (const h of data.result) {
      if (h.is_contract) continue;
      const usd = parseFloat(h.usd_value ?? "0") || 0;
      if (usd < 1) continue; // filter < $1
      map.set(h.owner_address.toLowerCase(), {
        balance: h.balance_formatted,
        usd,
        pct: h.percentage_relative_to_total_supply ?? 0,
      });
    }

    cursor = data.cursor ?? null;
    if (!cursor) break;
  }

  return map;
}

// ── Fetch wallet profitability for two specific tokens ────────────────────────
// Moralis paginates profitability results — paginate until both tokens found.

interface MoralisProfitPage {
  result: MoralisProfitEntry[];
  cursor: string | null;
}

const MAX_PROFIT_PAGES = 10;

async function fetchProfitability(
  walletAddress: string,
  moralisChain: string,
  tokenA: string,
  tokenB: string
): Promise<Map<string, MoralisProfitEntry>> {
  const result = new Map<string, MoralisProfitEntry>();
  const targets = new Set([tokenA.toLowerCase(), tokenB.toLowerCase()]);
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PROFIT_PAGES; page++) {
    const params: Record<string, string> = { chain: moralisChain };
    if (cursor) params.cursor = cursor;

    const data = await moralisFetch<MoralisProfitPage>(
      `/wallets/${walletAddress}/profitability`,
      params
    );
    if (!data?.result?.length) break;

    for (const entry of data.result) {
      const addr = entry.token_address?.toLowerCase();
      if (addr && targets.has(addr)) result.set(addr, entry);
    }

    // Stop early if both tokens found
    if (result.size >= 2) break;

    console.log(`[profit] ${walletAddress.slice(0,8)} page${page+1}: ${data.result.length} entries, found=${[...result.keys()].join(",")||"none"}, cursor=${!!data.cursor}`);

    cursor = data.cursor ?? null;
    if (!cursor) break;
  }

  return result;
}

// ── Build SharedHolderTokenData ───────────────────────────────────────────────

function buildTokenData(
  holderInfo: { balance: string; usd: number; pct: number },
  profitEntry: MoralisProfitEntry | undefined,
  totalSupply: number | null
): SharedHolderTokenData {
  const investedUsd = profitEntry?.total_usd_invested != null
    ? parseFloat(profitEntry.total_usd_invested) || null
    : null;
  const soldUsd = profitEntry?.total_sold_usd != null
    ? parseFloat(profitEntry.total_sold_usd) || null
    : null;
  const avgBuyPrice = profitEntry?.avg_buy_price_usd != null
    ? parseFloat(profitEntry.avg_buy_price_usd) || null
    : null;
  const realizedPnl = profitEntry?.realized_profit_usd != null
    ? parseFloat(profitEntry.realized_profit_usd) || null
    : null;

  const buyMarketCap =
    avgBuyPrice != null && totalSupply != null && totalSupply > 0
      ? avgBuyPrice * totalSupply
      : null;

  // Total PnL = current balance + what you got from selling - what you put in
  const totalPnl =
    investedUsd != null
      ? holderInfo.usd + (soldUsd ?? 0) - investedUsd
      : null;

  return {
    balance: holderInfo.balance,
    balanceUsd: holderInfo.usd,
    percentage: holderInfo.pct,
    investedUsd,
    soldUsd,
    avgBuyPrice,
    buyMarketCap,
    realizedPnl,
    totalPnl,
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as SharedHoldersRequest;
    const { chain, addressA, addressB } = body;

    if (!chain || !MORALIS_CHAIN[chain]) {
      return NextResponse.json({ error: "Invalid chain. Use eth, base, or bsc." }, { status: 400 });
    }
    if (!addressA || !addressB || !/^0x[a-fA-F0-9]{40}$/.test(addressA) || !/^0x[a-fA-F0-9]{40}$/.test(addressB)) {
      return NextResponse.json({ error: "Provide two valid EVM contract addresses." }, { status: 400 });
    }
    if (addressA.toLowerCase() === addressB.toLowerCase()) {
      return NextResponse.json({ error: "Addresses must be different." }, { status: 400 });
    }

    const moralisChain = MORALIS_CHAIN[chain];
    const addrA = addressA.toLowerCase();
    const addrB = addressB.toLowerCase();

    // Fetch token metadata + holders + DexScreener images in parallel
    const [metaRaw, holdersA, holdersB, dexImgA, dexImgB] = await Promise.all([
      moralisFetch<MoralisTokenMeta[]>(
        `/erc20/metadata`,
        { chain: moralisChain, "addresses[0]": addrA, "addresses[1]": addrB }
      ),
      fetchHolders(addrA, moralisChain),
      fetchHolders(addrB, moralisChain),
      fetchDexImage(chain, addrA),
      fetchDexImage(chain, addrB),
    ]);

    const metaA = metaRaw?.find((m) => m.address?.toLowerCase() === addrA);
    const metaB = metaRaw?.find((m) => m.address?.toLowerCase() === addrB);
    const imageA = dexImgA ?? metaA?.logo ?? null;
    const imageB = dexImgB ?? metaB?.logo ?? null;

    const totalSupplyA = metaA?.total_supply_formatted != null
      ? parseFloat(metaA.total_supply_formatted) || null : null;
    const totalSupplyB = metaB?.total_supply_formatted != null
      ? parseFloat(metaB.total_supply_formatted) || null : null;

    // Intersect — wallets that hold both tokens with > $1 in each
    const commonAddresses = [...holdersA.keys()].filter((addr) => holdersB.has(addr));

    if (commonAddresses.length === 0) {
      const tokenAMeta: SharedHolderTokenMeta = {
        address: addrA,
        symbol: metaA?.symbol ?? "???",
        name: metaA?.name ?? "Unknown",
        decimals: parseInt(metaA?.decimals ?? "18"),
        priceUsd: null,
        marketCap: null,
        totalSupply: totalSupplyA,
        imageUrl: imageA,
      };
      const tokenBMeta: SharedHolderTokenMeta = {
        address: addrB,
        symbol: metaB?.symbol ?? "???",
        name: metaB?.name ?? "Unknown",
        decimals: parseInt(metaB?.decimals ?? "18"),
        priceUsd: null,
        marketCap: null,
        totalSupply: totalSupplyB,
        imageUrl: imageB,
      };
      const resp: SharedHoldersResponse = { holders: [], tokenA: tokenAMeta, tokenB: tokenBMeta, chain };
      return NextResponse.json(resp);
    }

    // Fetch profitability for all common holders in parallel (skip for BSC)
    const supportsProfit = PROFITABILITY_CHAINS.has(chain);
    const profitResults = supportsProfit
      ? await Promise.allSettled(
          commonAddresses.map((addr) =>
            fetchProfitability(addr, moralisChain, addrA, addrB)
          )
        )
      : null;

    // Build response holders
    const holders: SharedHolder[] = commonAddresses
      .map((addr, i) => {
        const profitMap =
          profitResults?.[i]?.status === "fulfilled"
            ? (profitResults[i] as PromiseFulfilledResult<Map<string, MoralisProfitEntry>>).value
            : undefined;

        const tokenAData = buildTokenData(
          holdersA.get(addr)!,
          profitMap?.get(addrA),
          totalSupplyA
        );
        const tokenBData = buildTokenData(
          holdersB.get(addr)!,
          profitMap?.get(addrB),
          totalSupplyB
        );

        const combinedPnl =
          tokenAData.totalPnl != null || tokenBData.totalPnl != null
            ? (tokenAData.totalPnl ?? 0) + (tokenBData.totalPnl ?? 0)
            : null;

        return { address: addr, tokenA: tokenAData, tokenB: tokenBData, combinedPnl };
      })
      .sort((a, b) => (b.combinedPnl ?? b.tokenA.balanceUsd + b.tokenB.balanceUsd) -
                       (a.combinedPnl ?? a.tokenA.balanceUsd + a.tokenB.balanceUsd));

    const tokenAMeta: SharedHolderTokenMeta = {
      address: addrA,
      symbol: metaA?.symbol ?? "???",
      name: metaA?.name ?? "Unknown",
      decimals: parseInt(metaA?.decimals ?? "18"),
      priceUsd: null,
      marketCap: null,
      totalSupply: totalSupplyA,
      imageUrl: metaA?.logo ?? null,
    };
    const tokenBMeta: SharedHolderTokenMeta = {
      address: addrB,
      symbol: metaB?.symbol ?? "???",
      name: metaB?.name ?? "Unknown",
      decimals: parseInt(metaB?.decimals ?? "18"),
      priceUsd: null,
      marketCap: null,
      totalSupply: totalSupplyB,
      imageUrl: metaB?.logo ?? null,
    };

    const response: SharedHoldersResponse = {
      holders,
      tokenA: tokenAMeta,
      tokenB: tokenBMeta,
      chain,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("[shared-holders]", error);
    return NextResponse.json({ error: "Failed to find shared holders." }, { status: 500 });
  }
}
