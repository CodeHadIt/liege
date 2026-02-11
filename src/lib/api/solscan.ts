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
  // Solscan Pro API v2.0 caps page_size at 40, so paginate if needed
  const pageSize = Math.min(limit, 40);
  const pages = Math.ceil(limit / pageSize);
  const allHolders: SolscanHolder[] = [];

  for (let page = 0; page < pages; page++) {
    const currentPageSize = Math.min(pageSize, limit - allHolders.length);
    const data = await fetchSolscan<
      | { items: SolscanHolder[] }
      | { result: SolscanHolder[] }
      | SolscanHolder[]
    >(
      `/token/holders?address=${tokenAddress}&page_size=${currentPageSize}&page=${offset + page + 1}`
    );
    if (!data) break;

    let holders: SolscanHolder[];
    if (Array.isArray(data)) {
      holders = data;
    } else if ("items" in data && Array.isArray(data.items)) {
      holders = data.items;
    } else if ("result" in data && Array.isArray(data.result)) {
      holders = data.result;
    } else {
      break;
    }

    allHolders.push(...holders);
    if (holders.length < currentPageSize) break; // no more pages
  }

  return allHolders;
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
