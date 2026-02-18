# Dune SQL: Pump.fun Deploys (8h, Optimized)

## Optimizations Applied

| Optimization | Before | After |
|-------------|--------|-------|
| Time window | 24h | 8h (~3x fewer tokens to scan) |
| Trade filter | `trade_count >= 1` | `trade_count >= 10` (pre-filters low-activity tokens) |
| Join type | LEFT JOIN (includes 0-trade tokens) | INNER JOIN (only tokens with trades) |
| `dex_solana.trades` scans | 2 full scans (trade_counts + token_prices) | 1 single scan (`trade_data` CTE) |
| Subquery pattern | `IN (SELECT ...)` correlated subqueries | `INNER JOIN` (hash joins) |

## The Query

```sql
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

trade_counts AS (
    SELECT
        token_address,
        COUNT(*) AS trade_count
    FROM trade_data
    GROUP BY 1
    HAVING COUNT(*) >= 10
),

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
```

## How It Works

### 1. `deploys` CTE
Finds every token created by the pump.fun program in the last 8h using the `create` instruction discriminator (`0x181ec828051c0777`). `account_arguments[1]` is the new token mint address.

### 2. `trade_data` CTE (single scan optimization)
Joins `dex_solana.trades` against `deploys` once, extracting:
- Token address (resolved from buy or sell side)
- Symbol, price, and amount per trade
- Row number partitioned by token (for VWAP top-7 selection)

This replaces the old approach of scanning `dex_solana.trades` twice (once for counting, once for pricing).

### 3. `trade_counts` CTE
Counts trades per token from `trade_data` and filters to only tokens with >= 10 trades. This pre-filters before the expensive VWAP calculation.

### 4. `ranked_prices` CTE
Keeps the 7 most recent trades per token (only for tokens that passed the trade count filter) for VWAP calculation.

### 5. Final SELECT
Computes VWAP price and market cap (price * 1B supply), ranks by market cap descending. Uses INNER JOINs throughout — no zero-trade tokens in output.

## Dune Query ID

**ID:** `6707505` — https://dune.com/queries/6707505

The script at `scripts/dune-query.mjs` executes this query and saves results to `dune-pf-8h-deploys.json`.
