import type { PumpFunToken } from "@/types/token";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";

function getRpcUrl(): string {
  const url = process.env.HELIUS_RPC_URL;
  if (url && !url.endsWith("api-key=")) return url;
  if (HELIUS_API_KEY) return `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
  return "https://api.mainnet-beta.solana.com";
}

// Pump.fun mint authority — only involved in creates + revocations, ~1700 tx/hr
const PUMPFUN_MINT_AUTHORITY = "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM";

type Period = "30m" | "1h" | "2h" | "4h" | "8h";

const PERIOD_MS: Record<Period, number> = {
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "2h": 2 * 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "8h": 8 * 60 * 60 * 1000,
};

interface EnhancedTransaction {
  signature: string;
  timestamp: number;
  type: string;
  source: string;
  tokenTransfers?: { mint: string }[];
}

export interface HeliusTokenResult {
  tokens: PumpFunToken[];
  metadata: Map<string, { tradeCount: number; rank: number }>;
}

// In-memory cache so batch pagination doesn't re-fetch from Helius every time
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let cachedResult: { period: Period; data: HeliusTokenResult; fetchedAt: number } | null = null;

/** Fetch pump.fun CREATE transactions using Helius Enhanced Transactions API. */
async function fetchPumpFunDeploys(windowMs: number): Promise<{ address: string; createdAt: number }[]> {
  const cutoffSec = Math.floor((Date.now() - windowMs) / 1000);
  const deploys: { address: string; createdAt: number }[] = [];
  const seen = new Set<string>();
  let beforeSig = "";
  let pageCount = 0;

  const baseUrl = `https://api.helius.xyz/v0/addresses/${PUMPFUN_MINT_AUTHORITY}/transactions?api-key=${HELIUS_API_KEY}&type=CREATE&limit=100`;

  console.log(`[helius] Fetching pump.fun deploys from last ${windowMs / 60000} minutes...`);

  while (true) {
    pageCount++;
    const url = beforeSig ? `${baseUrl}&before=${beforeSig}` : baseUrl;

    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        console.error(`[helius] Enhanced API failed: ${res.status} ${res.statusText}`);
        break;
      }

      const data: EnhancedTransaction[] = await res.json();
      if (!Array.isArray(data) || data.length === 0) break;

      let reachedCutoff = false;

      for (const tx of data) {
        if (tx.timestamp < cutoffSec) {
          reachedCutoff = true;
          break;
        }
        const mint = tx.tokenTransfers?.[0]?.mint;
        if (mint && !seen.has(mint)) {
          seen.add(mint);
          deploys.push({ address: mint, createdAt: tx.timestamp * 1000 });
        }
      }

      console.log(`[helius] Page ${pageCount}: ${data.length} txs, ${deploys.length} tokens so far`);

      if (reachedCutoff) break;

      beforeSig = data[data.length - 1].signature;

      // Safety: max 200 pages
      if (pageCount >= 200) {
        console.warn(`[helius] Hit page limit (${pageCount} pages), stopping`);
        break;
      }
    } catch (err) {
      console.error(`[helius] Enhanced API exception:`, err);
      break;
    }
  }

  // Sort by creation time descending (newest first)
  deploys.sort((a, b) => b.createdAt - a.createdAt);

  const oldest = deploys[deploys.length - 1];
  const newest = deploys[0];
  console.log(`[helius] ═══ Total coins deployed: ${deploys.length} ═══`);
  if (newest) {
    const newestAge = Math.round((Date.now() - newest.createdAt) / 60000);
    console.log(`[helius] Newest coin: ${newest.address} — created ${new Date(newest.createdAt).toISOString()} (${newestAge} min ago)`);
  }
  if (oldest) {
    const oldestAge = Math.round((Date.now() - oldest.createdAt) / 60000);
    console.log(`[helius] Oldest coin: ${oldest.address} — created ${new Date(oldest.createdAt).toISOString()} (${oldestAge} min ago)`);
  }
  console.log(`[helius] Pages fetched: ${pageCount}`);

  return deploys;
}

/** Batch resolve token addresses to symbol/name using Helius DAS getAssetBatch. */
async function resolveTokenMetadata(
  addresses: string[]
): Promise<Map<string, { symbol: string; name: string }>> {
  const result = new Map<string, { symbol: string; name: string }>();
  const BATCH = 100;

  for (let i = 0; i < addresses.length; i += BATCH) {
    const batch = addresses.slice(i, i + BATCH);
    try {
      const res = await fetch(getRpcUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getAssetBatch",
          params: { ids: batch },
        }),
        cache: "no-store",
      });
      if (!res.ok) continue;
      const json = await res.json();
      const items = json.result ?? [];
      for (const item of items) {
        if (item?.id && item?.content?.metadata) {
          result.set(item.id, {
            symbol: item.content.metadata.symbol || "???",
            name: item.content.metadata.name || "Unknown",
          });
        }
      }
    } catch {
      // continue
    }
  }

  return result;
}

export async function fetchHeliusTokens(period: Period): Promise<HeliusTokenResult> {
  // Return cached result if same period and still fresh
  if (cachedResult && cachedResult.period === period && Date.now() - cachedResult.fetchedAt < CACHE_TTL) {
    console.log(`[helius] Using cached result (${cachedResult.data.tokens.length} tokens, ${Math.round((Date.now() - cachedResult.fetchedAt) / 1000)}s old)`);
    return cachedResult.data;
  }

  console.log(`[helius] fetchHeliusTokens called with period=${period}`);
  const windowMs = PERIOD_MS[period];
  const allDeploys = await fetchPumpFunDeploys(windowMs);

  console.log(`[helius] Period ${period}: ${allDeploys.length} tokens fetched`);

  // Resolve metadata for all tokens
  const addresses = allDeploys.map((d) => d.address);
  const meta = await resolveTokenMetadata(addresses);

  const tokens: PumpFunToken[] = [];
  const metadata = new Map<string, { tradeCount: number; rank: number }>();

  for (let i = 0; i < allDeploys.length; i++) {
    const deploy = allDeploys[i];
    const info = meta.get(deploy.address);
    tokens.push({
      address: deploy.address,
      symbol: info?.symbol || "???",
      name: info?.name || "Unknown",
      logoUrl: null,
      priceUsd: null,
      fdv: null,
      liquidity: null,
      createdAt: new Date(deploy.createdAt).toISOString(),
    });
    // Helius doesn't provide trade count; rank by position (newest first)
    metadata.set(deploy.address, { tradeCount: 0, rank: i + 1 });
  }

  const result = { tokens, metadata };
  cachedResult = { period, data: result, fetchedAt: Date.now() };
  return result;
}
