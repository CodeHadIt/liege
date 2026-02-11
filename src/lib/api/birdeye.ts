import { rateLimit } from "@/lib/rate-limiter";

const BASE_URL = "https://public-api.birdeye.so";

export interface BirdeyeTokenOverview {
  address: string;
  decimals: number;
  symbol: string;
  name: string;
  logoURI: string;
  liquidity: number;
  price: number;
  priceChange24hPercent: number;
  mc: number;
  v24hUSD: number;
  holder: number;
  supply: number;
  extensions?: {
    website?: string;
    twitter?: string;
    telegram?: string;
    description?: string;
  };
}

export interface BirdeyeOHLCV {
  unixTime: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

function getApiKey(): string {
  return process.env.BIRDEYE_API_KEY || "";
}

async function fetchBirdeye<T>(
  path: string,
  params?: Record<string, string>
): Promise<T | null> {
  const key = getApiKey();
  if (!key) return null;
  await rateLimit("birdeye");
  try {
    const url = new URL(`${BASE_URL}${path}`);
    if (params) {
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    }
    const res = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        "X-API-KEY": key,
        "x-chain": "solana",
      },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.data ?? json;
  } catch {
    return null;
  }
}

export async function getTokenOverview(
  tokenAddress: string
): Promise<BirdeyeTokenOverview | null> {
  return fetchBirdeye<BirdeyeTokenOverview>("/defi/token_overview", {
    address: tokenAddress,
  });
}

export async function getOHLCV(
  tokenAddress: string,
  timeframe: string,
  timeFrom?: number,
  timeTo?: number
): Promise<BirdeyeOHLCV[]> {
  const typeMap: Record<string, string> = {
    "1m": "1m",
    "5m": "5m",
    "15m": "15m",
    "1h": "1H",
    "4h": "4H",
    "1d": "1D",
  };
  const now = Math.floor(Date.now() / 1000);
  const params: Record<string, string> = {
    address: tokenAddress,
    type: typeMap[timeframe] || "1H",
    time_from: String(timeFrom || now - 86400 * 7),
    time_to: String(timeTo || now),
  };
  const data = await fetchBirdeye<{ items: BirdeyeOHLCV[] }>(
    "/defi/ohlcv",
    params
  );
  return data?.items ?? [];
}

export async function getTokenPrice(
  tokenAddress: string
): Promise<{ value: number; updateUnixTime: number } | null> {
  return fetchBirdeye("/defi/price", { address: tokenAddress });
}
