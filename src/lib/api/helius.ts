import { rateLimit } from "@/lib/rate-limiter";

function getRpcUrl(): string {
  const url = process.env.HELIUS_RPC_URL;
  if (url && !url.endsWith("api-key=")) return url;
  // Build Helius RPC URL from API key if available
  const key = process.env.HELIUS_API_KEY;
  if (key) return `https://mainnet.helius-rpc.com/?api-key=${key}`;
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
    const separator = path.includes("?") ? "&" : "?";
    const res = await fetch(
      `https://api.helius.xyz/v0${path}${separator}api-key=${key}`,
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

export interface LargestAccount {
  address: string;
  amount: string;
  decimals: number;
  uiAmount: number;
  uiAmountString: string;
}

export async function getTokenLargestAccounts(
  mintAddress: string
): Promise<LargestAccount[]> {
  interface LargestResult {
    value: LargestAccount[];
  }
  const result = await rpcCall<LargestResult>("getTokenLargestAccounts", [
    mintAddress,
  ]);
  return result?.value ?? [];
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

/**
 * Resolve token account PDAs to their owner wallet addresses.
 * Batches in groups of 100 (Solana RPC limit for getMultipleAccounts).
 */
export async function getMultipleAccountOwners(
  tokenAccounts: string[]
): Promise<Map<string, string>> {
  const ownerMap = new Map<string, string>();
  if (tokenAccounts.length === 0) return ownerMap;

  const BATCH_SIZE = 100;
  for (let i = 0; i < tokenAccounts.length; i += BATCH_SIZE) {
    const batch = tokenAccounts.slice(i, i + BATCH_SIZE);
    interface MultiAccountResult {
      value: (
        | {
            data: {
              parsed: {
                info: { owner: string };
              };
            };
          }
        | null
      )[];
    }
    const result = await rpcCall<MultiAccountResult>("getMultipleAccounts", [
      batch,
      { encoding: "jsonParsed" },
    ]);
    if (result?.value) {
      result.value.forEach((account, idx) => {
        const owner = account?.data?.parsed?.info?.owner;
        if (owner) {
          ownerMap.set(batch[idx], owner);
        }
      });
    }
  }

  return ownerMap;
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

// ─── Wallet History (v1 REST) ───

export interface WalletHistoryBalanceChange {
  mint: string;
  amount: number;
  decimals: number;
}

export interface WalletHistoryTransaction {
  signature: string;
  timestamp: number | null;
  slot: number;
  fee: number;
  feePayer: string;
  error: string | null;
  balanceChanges: WalletHistoryBalanceChange[];
}

export interface WalletHistoryResponse {
  data: WalletHistoryTransaction[];
  pagination: {
    hasMore: boolean;
    nextCursor: string | null;
  };
}

/**
 * Fetch wallet transaction history using
 * GET https://api.helius.xyz/v1/wallet/{wallet}/history
 *
 * Supports pagination via `before` cursor and filtering by `type` (e.g. SWAP, TRANSFER).
 */
export async function getWalletHistory(
  walletAddress: string,
  options?: {
    limit?: number;
    before?: string;
    type?: string;
  }
): Promise<WalletHistoryResponse | null> {
  const key = getApiKey();
  if (!key) return null;
  await rateLimit("helius");
  try {
    const params = new URLSearchParams({ "api-key": key });
    if (options?.limit) params.set("limit", options.limit.toString());
    if (options?.before) params.set("before", options.before);
    if (options?.type) params.set("type", options.type);
    params.set("tokenAccounts", "balanceChanged");

    const res = await fetch(
      `https://api.helius.xyz/v1/wallet/${walletAddress}/history?${params}`,
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/**
 * Fetch multiple pages of wallet history, up to maxPages.
 */
export async function getWalletHistoryAll(
  walletAddress: string,
  options?: {
    maxPages?: number;
    limit?: number;
    type?: string;
  }
): Promise<WalletHistoryTransaction[]> {
  const maxPages = options?.maxPages ?? 3;
  const limit = options?.limit ?? 100;
  const allTxns: WalletHistoryTransaction[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const res = await getWalletHistory(walletAddress, {
      limit,
      before: cursor,
      type: options?.type,
    });
    if (!res || res.data.length === 0) break;
    allTxns.push(...res.data);
    if (!res.pagination.hasMore || !res.pagination.nextCursor) break;
    cursor = res.pagination.nextCursor;
  }

  return allTxns;
}

// ─── Wallet Balances (v1 REST) ───

export interface HeliusWalletBalance {
  mint: string;
  symbol: string;
  name: string;
  balance: number;
  decimals: number;
  usdValue: number | null;
  pricePerToken: number | null;
  logoUri?: string;
  tokenProgram?: string;
}

export interface HeliusWalletBalancesResponse {
  balances: HeliusWalletBalance[];
  totalUsdValue: number;
}

/**
 * Fetch all token balances (including SOL) for a wallet using
 * GET https://api.helius.xyz/v1/wallet/{wallet}/balances
 */
export async function getWalletBalances(
  walletAddress: string
): Promise<HeliusWalletBalancesResponse | null> {
  const key = getApiKey();
  if (!key) return null;
  await rateLimit("helius");
  try {
    const res = await fetch(
      `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${key}`,
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// ─── DAS Asset Resolution ───

export interface AssetInfo {
  symbol: string;
  name: string;
  logoUrl: string | null;
}

/**
 * Batch-resolve mint addresses to token symbol/name using Helius DAS getAssetBatch.
 * Returns a Map of mint → { symbol, name }.
 */
export async function getAssetBatch(
  mintAddresses: string[]
): Promise<Map<string, AssetInfo>> {
  const result = new Map<string, AssetInfo>();
  if (mintAddresses.length === 0) return result;

  const key = getApiKey();
  if (!key) return result;

  const BATCH = 100;
  for (let i = 0; i < mintAddresses.length; i += BATCH) {
    const batch = mintAddresses.slice(i, i + BATCH);
    await rateLimit("helius");
    try {
      const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getAssetBatch",
          params: { ids: batch },
        }),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const items = json.result ?? [];
      for (const item of items) {
        if (item?.id && item?.content?.metadata) {
          result.set(item.id, {
            symbol: item.content.metadata.symbol || "???",
            name: item.content.metadata.name || "Unknown",
            logoUrl: item.content?.links?.image ?? null,
          });
        }
      }
    } catch {
      // continue with next batch
    }
  }

  return result;
}
