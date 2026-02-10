import { rateLimit } from "@/lib/rate-limiter";

const BASE_URL = "https://api.geckoterminal.com/api/v2";

export interface GeckoPool {
  id: string;
  attributes: {
    name: string;
    address: string;
    base_token_price_usd: string;
    quote_token_price_usd: string;
    base_token_price_native_currency: string;
    fdv_usd: string;
    market_cap_usd: string | null;
    reserve_in_usd: string;
    volume_usd: {
      h1: string;
      h6: string;
      h24: string;
    };
    price_change_percentage: {
      h1: string;
      h6: string;
      h24: string;
    };
    transactions: {
      h1: { buys: number; sells: number };
      h6: { buys: number; sells: number };
      h24: { buys: number; sells: number };
    };
    pool_created_at: string;
  };
  relationships?: {
    base_token?: { data: { id: string } };
    quote_token?: { data: { id: string } };
    dex?: { data: { id: string } };
  };
}

export interface GeckoOHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function fetchGecko<T>(path: string): Promise<T | null> {
  await rateLimit("geckoterminal");
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { Accept: "application/json" },
      next: { revalidate: 30 },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function getTokenPools(
  network: string,
  tokenAddress: string
): Promise<GeckoPool[]> {
  const data = await fetchGecko<{ data: GeckoPool[] }>(
    `/networks/${network}/tokens/${tokenAddress}/pools?sort=h24_volume_usd_desc&page=1`
  );
  return data?.data ?? [];
}

export async function getOHLCV(
  network: string,
  poolAddress: string,
  timeframe: string = "hour",
  aggregate: number = 1
): Promise<GeckoOHLCV[]> {
  const data = await fetchGecko<{
    data: {
      attributes: {
        ohlcv_list: [number, number, number, number, number, number][];
      };
    };
  }>(
    `/networks/${network}/pools/${poolAddress}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=300`
  );
  if (!data?.data?.attributes?.ohlcv_list) return [];
  return data.data.attributes.ohlcv_list.map(
    ([timestamp, open, high, low, close, volume]) => ({
      timestamp,
      open,
      high,
      low,
      close,
      volume,
    })
  );
}

export async function getTrendingPools(
  network?: string
): Promise<GeckoPool[]> {
  const path = network
    ? `/networks/${network}/trending_pools`
    : `/networks/trending_pools`;
  const data = await fetchGecko<{ data: GeckoPool[] }>(path);
  return data?.data ?? [];
}

export async function searchPools(
  query: string
): Promise<GeckoPool[]> {
  const data = await fetchGecko<{ data: GeckoPool[] }>(
    `/search/pools?query=${encodeURIComponent(query)}&page=1`
  );
  return data?.data ?? [];
}

export async function getNewPools(
  network?: string
): Promise<GeckoPool[]> {
  const path = network
    ? `/networks/${network}/new_pools`
    : `/networks/new_pools`;
  const data = await fetchGecko<{ data: GeckoPool[] }>(path);
  return data?.data ?? [];
}
