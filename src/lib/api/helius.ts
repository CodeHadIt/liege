import { rateLimit } from "@/lib/rate-limiter";

function getRpcUrl(): string {
  const url = process.env.HELIUS_RPC_URL;
  if (url && !url.endsWith("api-key=")) return url;
  return "https://api.mainnet-beta.solana.com";
}

function getApiKey(): string {
  return process.env.HELIUS_API_KEY || "";
}

async function rpcCall<T>(method: string, params: unknown[]): Promise<T | null> {
  await rateLimit("helius");
  try {
    const res = await fetch(getRpcUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.result ?? null;
  } catch {
    return null;
  }
}

async function heliusApi<T>(path: string): Promise<T | null> {
  const key = getApiKey();
  if (!key) return null;
  await rateLimit("helius");
  try {
    const res = await fetch(
      `https://api.helius.xyz/v0${path}?api-key=${key}`,
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export interface MintAccountInfo {
  mintAuthority: string | null;
  supply: string;
  decimals: number;
  isInitialized: boolean;
  freezeAuthority: string | null;
}

export async function getMintInfo(
  mintAddress: string
): Promise<MintAccountInfo | null> {
  interface AccountResult {
    value: {
      data: { parsed: { info: MintAccountInfo } };
    } | null;
  }
  const result = await rpcCall<AccountResult>("getAccountInfo", [
    mintAddress,
    { encoding: "jsonParsed" },
  ]);
  if (!result?.value?.data?.parsed?.info) return null;
  return result.value.data.parsed.info;
}

export interface HeliusAsset {
  id: string;
  content?: {
    metadata?: { name: string; symbol: string };
    links?: { image?: string };
  };
  token_info?: {
    balance: number;
    decimals: number;
    price_info?: { price_per_token: number; total_price: number };
  };
}

export async function getAssetsByOwner(
  ownerAddress: string
): Promise<HeliusAsset[]> {
  const key = getApiKey();
  if (!key) return [];
  await rateLimit("helius");
  try {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAssetsByOwner",
        params: {
          ownerAddress,
          displayOptions: { showFungible: true },
          limit: 100,
        },
      }),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return json.result?.items ?? [];
  } catch {
    return [];
  }
}

export interface HeliusTransaction {
  signature: string;
  timestamp: number;
  type: string;
  source: string;
  fee: number;
  description: string;
  nativeTransfers?: {
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }[];
  tokenTransfers?: {
    fromUserAccount: string;
    toUserAccount: string;
    mint: string;
    tokenAmount: number;
    tokenStandard: string;
  }[];
}

export async function getTransactionHistory(
  address: string,
  limit = 50
): Promise<HeliusTransaction[]> {
  const data = await heliusApi<HeliusTransaction[]>(
    `/addresses/${address}/transactions?limit=${limit}`
  );
  return data ?? [];
}
