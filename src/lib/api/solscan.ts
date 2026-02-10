import { rateLimit } from "@/lib/rate-limiter";

const BASE_URL = "https://pro-api.solscan.io/v2.0";

function getApiKey(): string {
  return process.env.SOLSCAN_API_KEY || "";
}

async function fetchSolscan<T>(path: string): Promise<T | null> {
  const key = getApiKey();
  await rateLimit("solscan");
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (key) headers["token"] = key;
    const res = await fetch(`${BASE_URL}${path}`, { headers });
    if (!res.ok) return null;
    const json = await res.json();
    return json.data ?? json;
  } catch {
    return null;
  }
}

export interface SolscanTokenMeta {
  address: string;
  name: string;
  symbol: string;
  icon: string;
  decimals: number;
  holder: number;
  supply: string;
  tag: string[];
  website?: string;
  twitter?: string;
  telegram?: string;
  coingeckoId?: string;
}

export interface SolscanHolder {
  address: string;
  amount: number;
  decimals: number;
  owner: string;
  rank: number;
}

export async function getTokenMeta(
  tokenAddress: string
): Promise<SolscanTokenMeta | null> {
  return fetchSolscan<SolscanTokenMeta>(`/token/meta?address=${tokenAddress}`);
}

export async function getTokenHolders(
  tokenAddress: string,
  limit = 20,
  offset = 0
): Promise<SolscanHolder[]> {
  const data = await fetchSolscan<{ items: SolscanHolder[] }>(
    `/token/holders?address=${tokenAddress}&page_size=${limit}&page=${offset + 1}`
  );
  return data?.items ?? [];
}

export async function getTokenTransactions(
  tokenAddress: string,
  limit = 20
): Promise<unknown[]> {
  const data = await fetchSolscan<{ items: unknown[] }>(
    `/token/transfer?address=${tokenAddress}&page_size=${limit}&page=1`
  );
  return data?.items ?? [];
}
