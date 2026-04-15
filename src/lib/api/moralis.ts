import { rateLimit } from "@/lib/rate-limiter";

const BASE_URL = "https://solana-gateway.moralis.io";
const EVM_BASE_URL = "https://deep-index.moralis.io/api/v2.2";

const MORALIS_CHAIN: Record<string, string> = {
  base: "base",
  bsc:  "bsc",
  eth:  "eth",
};

/**
 * Fetch a token's image URL from Moralis ERC20 metadata for EVM chains.
 * Returns null if unavailable or not found.
 */
export async function getEvmTokenImage(
  chain: string,
  address: string
): Promise<string | null> {
  const apiKey = process.env.MORALIS_API_KEY;
  if (!apiKey) return null;

  const moralisChain = MORALIS_CHAIN[chain];
  if (!moralisChain) return null;

  await rateLimit("moralis");
  try {
    const params = new URLSearchParams({ chain: moralisChain });
    params.append("addresses[0]", address.toLowerCase());
    const res = await fetch(`${EVM_BASE_URL}/erc20/metadata?${params}`, {
      headers: { Accept: "application/json", "X-API-Key": apiKey },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const token = Array.isArray(data) ? data[0] : null;
    return token?.logo ?? null;
  } catch {
    return null;
  }
}

export interface MoralisPumpToken {
  tokenAddress: string;
  name: string;
  symbol: string;
  logo: string | null;
  priceUsd: string | null;
  liquidity: string | null;
  fullyDilutedValuation: string | null;
  createdAt: string;
}

export interface MoralisPumpResponse {
  cursor: string | null;
  pageSize: number;
  result: MoralisPumpToken[];
}

async function fetchMoralis<T>(path: string): Promise<T | null> {
  const apiKey = process.env.MORALIS_API_KEY;
  if (!apiKey) {
    console.error("MORALIS_API_KEY not configured");
    return null;
  }

  await rateLimit("moralis");
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: {
        Accept: "application/json",
        "X-API-Key": apiKey,
      },
      next: { revalidate: 30 },
    });
    if (!res.ok) {
      console.error(`Moralis API error: ${res.status} ${res.statusText}`);
      return null;
    }
    return res.json();
  } catch (error) {
    console.error("Moralis fetch error:", error);
    return null;
  }
}

export async function getPumpFunNewTokens(
  limit: number = 100,
  cursor?: string
): Promise<MoralisPumpResponse | null> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  return fetchMoralis<MoralisPumpResponse>(
    `/token/mainnet/exchange/pumpfun/new?${params}`
  );
}
