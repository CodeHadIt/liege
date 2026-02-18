import { writeFileSync } from "fs";

const DUNE_API_KEY = process.env.DUNE_API_KEY;
const QUERY_ID = 6707505;
const PAGE_SIZE = 32000; // Dune max per page

if (!DUNE_API_KEY) {
  console.error("DUNE_API_KEY not set");
  process.exit(1);
}

const headers = {
  "X-Dune-API-Key": DUNE_API_KEY,
  "Content-Type": "application/json",
};

// ─── Optimized SQL ──────────────────────────────────────────────────────────
// - 8h window instead of 24h (reduces deploys scan ~3x)
// - trade_counts with HAVING >= 10 (pre-filters low-activity tokens)
// - Single scan of dex_solana.trades (trade_data CTE does counting + pricing in one pass)
// - JOIN replaces IN subqueries (hash joins instead of correlated subqueries)
// - INNER JOIN instead of LEFT JOIN (no zero-trade tokens in output)
const QUERY_SQL = `
WITH deploys AS (
    SELECT
        account_arguments[1] AS token_address,
        block_time AS created_at
    FROM solana.instruction_calls
    WHERE executing_account = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
      AND bytearray_substring(data, 1, 8) = 0x181ec828051c0777
      AND block_time >= NOW() - INTERVAL '8' HOUR
      AND tx_success = TRUE
),

-- Single scan of dex_solana.trades: resolve token address, extract price data, and row number
trade_data AS (
    SELECT
        d.token_address,
        COALESCE(
            CASE WHEN t.token_bought_mint_address = d.token_address THEN t.token_bought_symbol END,
            CASE WHEN t.token_sold_mint_address = d.token_address THEN t.token_sold_symbol END,
            'Unknown'
        ) AS asset,
        t.amount_usd / NULLIF(
            CASE
                WHEN t.token_bought_mint_address = d.token_address THEN t.token_bought_amount
                WHEN t.token_sold_mint_address = d.token_address THEN t.token_sold_amount
                ELSE 0
            END, 0
        ) AS token_price,
        CASE
            WHEN t.token_bought_mint_address = d.token_address THEN t.token_bought_amount
            WHEN t.token_sold_mint_address = d.token_address THEN t.token_sold_amount
            ELSE 0
        END AS token_amount,
        ROW_NUMBER() OVER (
            PARTITION BY d.token_address
            ORDER BY t.block_time DESC
        ) AS rn
    FROM dex_solana.trades t
    INNER JOIN deploys d
        ON d.token_address = t.token_bought_mint_address
        OR d.token_address = t.token_sold_mint_address
    WHERE t.amount_usd >= 1
      AND t.block_time >= NOW() - INTERVAL '8' HOUR
),

-- Count trades per token and filter >= 10
trade_counts AS (
    SELECT
        token_address,
        COUNT(*) AS trade_count
    FROM trade_data
    GROUP BY 1
    HAVING COUNT(*) >= 10
),

-- Keep top 7 most recent trades per token for VWAP (only for tokens with >= 10 trades)
ranked_prices AS (
    SELECT
        td.token_address,
        td.asset,
        td.token_price,
        td.token_amount
    FROM trade_data td
    INNER JOIN trade_counts tc ON td.token_address = tc.token_address
    WHERE td.rn <= 7
      AND td.asset != 'Unknown'
)

SELECT
    RANK() OVER (ORDER BY
        SUM(r.token_price * r.token_amount) / NULLIF(SUM(r.token_amount), 0) * 1000000000
        DESC NULLS LAST
    ) AS rank,
    d.token_address,
    COALESCE(r.asset, 'Unknown') AS symbol,
    d.created_at,
    SUM(r.token_price * r.token_amount) / NULLIF(SUM(r.token_amount), 0) AS vwap_price,
    SUM(r.token_price * r.token_amount) / NULLIF(SUM(r.token_amount), 0) * 1000000000 AS market_cap,
    tc.trade_count
FROM deploys d
INNER JOIN trade_counts tc ON d.token_address = tc.token_address
INNER JOIN ranked_prices r ON d.token_address = r.token_address
GROUP BY d.token_address, d.created_at, r.asset, tc.trade_count
ORDER BY market_cap DESC NULLS LAST
`.trim();

async function updateQuery() {
  console.log("Updating Dune query SQL...");
  const res = await fetch(`https://api.dune.com/api/v1/query/${QUERY_ID}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ query_sql: QUERY_SQL }),
  });

  if (!res.ok) {
    console.warn(
      "  Could not update query (may need manual edit on dune.com):",
      await res.text()
    );
    return false;
  }

  console.log("  Query SQL updated successfully (8h window, >= 10 trades).");
  return true;
}

async function fetchWithRetry(url, opts, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fetch(url, opts);
    } catch (err) {
      console.log(`  Retry ${i + 1}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error("All retries failed");
}

async function run() {
  // 0. Update query SQL on Dune
  await updateQuery();

  // 1. Execute the query
  console.log(`\nExecuting Dune query ${QUERY_ID}...`);
  const execRes = await fetch(
    `https://api.dune.com/api/v1/query/${QUERY_ID}/execute`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ performance: "medium" }),
    }
  );
  const execData = await execRes.json();

  if (!execData.execution_id) {
    console.error("Failed to execute:", execData);
    process.exit(1);
  }

  const executionId = execData.execution_id;
  console.log(`Execution ID: ${executionId}`);

  // 2. Poll for completion
  while (true) {
    const statusRes = await fetchWithRetry(
      `https://api.dune.com/api/v1/execution/${executionId}/status`,
      { headers }
    );
    const statusData = await statusRes.json();
    const state = statusData.state;
    console.log(`Status: ${state}`);

    if (state === "QUERY_STATE_COMPLETED") break;
    if (
      state === "QUERY_STATE_FAILED" ||
      state === "QUERY_STATE_CANCELLED" ||
      state === "QUERY_STATE_EXPIRED"
    ) {
      console.error("Query failed:", statusData);
      process.exit(1);
    }

    await new Promise((r) => setTimeout(r, 5000));
  }

  // 3. Fetch ALL results with pagination
  console.log("\nFetching results (paginated)...");
  const allRows = [];
  let offset = 0;

  while (true) {
    const url = `https://api.dune.com/api/v1/execution/${executionId}/results?limit=${PAGE_SIZE}&offset=${offset}`;
    const resultsRes = await fetchWithRetry(url, { headers });
    const resultsData = await resultsRes.json();

    const rows = resultsData?.result?.rows ?? [];
    allRows.push(...rows);
    console.log(
      `  Page ${Math.floor(offset / PAGE_SIZE) + 1}: ${rows.length} rows (total: ${allRows.length})`
    );

    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  console.log(`\nTotal rows fetched: ${allRows.length}`);

  const output = {
    executed_at: new Date().toISOString(),
    query: "Pump.fun deploys in 8h with >= 10 trades, ranked by market cap",
    dune_query_id: QUERY_ID,
    execution_id: executionId,
    total_rows: allRows.length,
    data: allRows,
  };

  writeFileSync("dune-pf-8h-deploys.json", JSON.stringify(output, null, 2));
  console.log(`Saved ${allRows.length} rows to dune-pf-8h-deploys.json`);
}

run().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
