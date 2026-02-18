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

interface DuneExecuteResponse {
  execution_id: string;
}

interface DuneExecutionStatus {
  state: string;
  execution_ended_at?: string;
  result?: {
    rows: DuneRow[];
  };
}

export interface DuneTokenResult {
  tokens: PumpFunToken[];
  metadata: Map<string, { tradeCount: number; rank: number }>;
}

function logOldestAndNewest(rows: DuneRow[]): void {
  if (rows.length === 0) return;
  let oldest = rows[0], newest = rows[0];
  for (const row of rows) {
    if (row.created_at < oldest.created_at) oldest = row;
    if (row.created_at > newest.created_at) newest = row;
  }
  console.log(`[dune] Oldest coin: ${oldest.symbol} — created ${oldest.created_at}`);
  console.log(`[dune] Newest coin: ${newest.symbol} — created ${newest.created_at}`);

  const newestMs = new Date(newest.created_at).getTime();
  const diffMin = Math.round((Date.now() - newestMs) / 60000);
  console.log(`[dune] Newest coin age: ${diffMin} minutes ago (current UTC: ${new Date().toISOString()})`);
}

// In-memory store for the latest execution result (no TTL, no eviction)
let latestResult: { rows: DuneRow[]; executionTime: number } | null = null;
let pendingExecution: Promise<DuneRow[] | null> | null = null;

async function executeAndPoll(): Promise<DuneRow[] | null> {
  const timeStart = new Date(Date.now() - 8 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .replace("Z", "");
  console.log(`[dune] Triggering fresh execution for query ${QUERY_ID}, time_start=${timeStart}`);

  const execRes = await fetch(
    `https://api.dune.com/api/v1/query/${QUERY_ID}/execute`,
    {
      method: "POST",
      headers: {
        "X-Dune-API-Key": DUNE_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query_parameters: { time_start: timeStart },
      }),
      cache: "no-store",
    }
  );

  if (!execRes.ok) {
    const body = await execRes.text();
    console.error(`[dune] Execute failed: ${execRes.status} ${execRes.statusText} — ${body}`);
    return null;
  }

  const { execution_id }: DuneExecuteResponse = await execRes.json();
  console.log(`[dune] Execution started: ${execution_id}`);

  // Poll every 5s, max 4 minutes
  for (let i = 0; i < 48; i++) {
    await new Promise((r) => setTimeout(r, 5000));

    const statusRes = await fetch(
      `https://api.dune.com/api/v1/execution/${execution_id}/results`,
      {
        headers: { "X-Dune-API-Key": DUNE_API_KEY },
        cache: "no-store",
      }
    );

    if (!statusRes.ok) {
      console.log(`[dune] Poll ${i + 1}: status ${statusRes.status}, retrying...`);
      continue;
    }

    const status: DuneExecutionStatus = await statusRes.json();
    console.log(`[dune] Poll ${i + 1}: state=${status.state}`);

    if (status.state === "QUERY_STATE_COMPLETED" && status.result?.rows) {
      const rows = status.result.rows;
      const executionTime = status.execution_ended_at
        ? new Date(status.execution_ended_at).getTime()
        : Date.now();

      console.log(`[dune] ✓ Fresh execution complete: ${rows.length} rows`);
      logOldestAndNewest(rows);

      latestResult = { rows, executionTime };
      return rows;
    }

    if (status.state === "QUERY_STATE_FAILED" || status.state === "QUERY_STATE_CANCELLED") {
      console.error(`[dune] ✗ Execution ${status.state}`);
      return null;
    }
  }

  console.warn(`[dune] ✗ Execution timed out after 4 minutes of polling`);
  return null;
}

async function getFreshRows(): Promise<DuneRow[]> {
  // If there's already an execution in flight, await it
  if (pendingExecution) {
    console.log(`[dune] Execution already in flight, awaiting...`);
    const result = await pendingExecution;
    if (result) return result;
  }

  // Trigger new execution
  pendingExecution = executeAndPoll().finally(() => {
    pendingExecution = null;
  });

  const result = await pendingExecution;
  if (result) return result;

  // Execution failed — use last known result if available
  if (latestResult) {
    console.warn(`[dune] Execution failed, using last known result (${latestResult.rows.length} rows)`);
    return latestResult.rows;
  }

  throw new Error("Dune execution failed and no previous data available");
}

export async function fetchDuneTokens(period: Period): Promise<DuneTokenResult> {
  const rows = await getFreshRows();

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
