import { serverCache, CACHE_TTL } from "@/lib/cache";
import type { PumpFunToken } from "@/types/token";

const DUNE_API_KEY = process.env.DUNE_API_KEY!;
const QUERY_ID = 6707505;

type Period = "30m" | "1h" | "2h" | "4h" | "8h";

const PERIOD_MS: Record<Period, number> = {
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "2h": 2 * 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "8h": 8 * 60 * 60 * 1000,
};

interface DuneRow {
  token_address: string;
  symbol: string;
  vwap_price: number;
  market_cap: number;
  created_at: string;
  trade_count: number;
  rank: number;
}

interface DuneResponse {
  execution_ended_at: string;
  result: {
    rows: DuneRow[];
  };
}

interface DuneCacheEntry {
  rows: DuneRow[];
  executionTime: number;
}

export interface DuneTokenResult {
  tokens: PumpFunToken[];
  metadata: Map<string, { tradeCount: number; rank: number }>;
}

async function fetchDuneRaw(): Promise<DuneCacheEntry> {
  const cacheKey = `dune:query:${QUERY_ID}`;
  const cached = serverCache.get<DuneCacheEntry>(cacheKey);
  if (cached) return cached;

  const res = await fetch(
    `https://api.dune.com/api/v1/query/${QUERY_ID}/results`,
    {
      headers: { "X-Dune-API-Key": DUNE_API_KEY },
    }
  );

  if (!res.ok) {
    throw new Error(`Dune API error: ${res.status} ${res.statusText}`);
  }

  const json: DuneResponse = await res.json();
  const rows = json.result?.rows ?? [];
  const executionTime = json.execution_ended_at
    ? new Date(json.execution_ended_at).getTime()
    : Date.now();

  console.log(`[dune] Fetched ${rows.length} rows, executed at ${json.execution_ended_at}`);

  const entry: DuneCacheEntry = { rows, executionTime };
  serverCache.set(cacheKey, entry, CACHE_TTL.DUNE_RESULTS);
  return entry;
}

export async function fetchDuneTokens(period: Period): Promise<DuneTokenResult> {
  const { rows } = await fetchDuneRaw();

  // Anchor cutoff to the newest token in the dataset so shorter
  // periods always return a meaningful subset of the data.
  let maxCreated = 0;
  for (const row of rows) {
    const ms = new Date(row.created_at).getTime();
    if (ms > maxCreated) maxCreated = ms;
  }
  const cutoff = maxCreated - PERIOD_MS[period];

  const tokens: PumpFunToken[] = [];
  const metadata = new Map<string, { tradeCount: number; rank: number }>();

  for (const row of rows) {
    const createdMs = new Date(row.created_at).getTime();
    if (createdMs < cutoff) continue;

    tokens.push({
      address: row.token_address,
      symbol: row.symbol,
      name: row.symbol,
      logoUrl: null,
      priceUsd: row.vwap_price,
      fdv: row.market_cap,
      liquidity: null,
      createdAt: row.created_at,
    });

    metadata.set(row.token_address, {
      tradeCount: row.trade_count,
      rank: row.rank,
    });
  }

  return { tokens, metadata };
}
