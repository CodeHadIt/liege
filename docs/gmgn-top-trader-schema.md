# GmgnTopTrader — Data Structure

Source: `https://gmgn.ai/vas/api/v1/token_holders/{chain}/{tokenAddress}?orderby=realized_profit&direction=desc&limit=100`

Fetched via Playwright (browser session required for cookies/auth). Returns up to 100 traders sorted by `realized_profit` descending, **including wallets that have fully exited** (balance = 0).

---

## TypeScript Interface

```ts
interface GmgnTopTrader {
  walletAddress:        string;   // EVM address e.g. "0xacaf...354a"
  realizedProfitUsd:    number;   // Historical realized PnL in USD (actual, not approximated)
  unrealizedProfitUsd:  number;   // Unrealized PnL in USD at time of scrape (0 if fully exited)
  historyBoughtCostUsd: number;   // Total USD spent buying (direct buys only, excludes transfers in)
  historySoldIncomeUsd: number;   // Total USD received from selling (direct sells only)
  balance:              number;   // Current token balance (0 = fully exited)
  balanceUsd:           number;   // Current USD value of balance at scrape time
  avgCostUsd:           number;   // Average buy price in USD per token
  avgSoldUsd:           number;   // Average sell price in USD per token (0 if never sold)
  buyCount:             number;   // Number of buy transactions
  sellCount:            number;   // Number of sell transactions
  lastActiveTimestamp:  number | null; // Unix timestamp (seconds) of last on-chain activity
  nativeBalanceWei:     string;   // Native token balance in wei (ETH/BNB etc.), convert ÷ 1e18
}
```

---

## Field Notes

| Field | Type | Example | Notes |
|---|---|---|---|
| `walletAddress` | string | `0x5c83...902f` | Lowercase EVM address |
| `realizedProfitUsd` | number | `226051.87` | **Key field.** `historySoldIncomeUsd - historyBoughtCostUsd + transfer_out_income - transfer_in_cost`. Includes transfer flows, which is why it can diverge from simply sold - bought. |
| `unrealizedProfitUsd` | number | `13770.01` | Based on current price × remaining balance. `0` for fully exited wallets. |
| `historyBoughtCostUsd` | number | `7512.52` | USD spent on direct buys only. Does **not** include tokens received via transfer. |
| `historySoldIncomeUsd` | number | `22551.75` | USD received from direct sells only. Does **not** include tokens sent via transfer. |
| `balance` | number | `557900930` | Raw token units (not adjusted for decimals — GMGN already normalises). |
| `balanceUsd` | number | `15630.59` | `balance × currentPriceUsd` at scrape time. |
| `avgCostUsd` | number | `0.0000021` | Mean price paid per token across all buys. |
| `avgSoldUsd` | number | `0.0000580` | Mean price received per token across all sells. |
| `buyCount` | number | `7` | Count of buy txns (direct purchases only). |
| `sellCount` | number | `36` | Count of sell txns (direct sales only). |
| `lastActiveTimestamp` | number | `1773030327` | Unix seconds. `null` if no activity recorded. |
| `nativeBalanceWei` | string | `"188934926217716298"` | Raw wei string. Divide by `1e18` to get ETH/BNB. |

---

## Why `realizedProfitUsd` ≠ `historySoldIncomeUsd - historyBoughtCostUsd`

GMGN accounts for **token transfers** (in and out) in addition to direct buys/sells:

```
realizedProfitUsd =
    historySoldIncomeUsd          // USD from direct sells
  + history_transfer_out_income   // USD value when tokens were transferred out
  - historyBoughtCostUsd          // USD spent on direct buys
  - history_transfer_in_cost      // USD cost basis of tokens received via transfer
```

Example — wallet `0x5c83...902f` (top trader, $226K PnL):
- Direct buys: $7,512 | Direct sells: $22,551
- Transfer in: ~8B tokens at $217,093 cost basis
- Transfer out: ~8.2B tokens at $424,606 value
- **Net: $226,051 realized**

This is why simply doing `sold - bought` understates or overstates PnL for wallets that move tokens between wallets.

---

## Raw API Response Shape

```json
{
  "code": 0,
  "reason": "",
  "message": "success",
  "data": {
    "list": [
      {
        "address": "0x5c83dea71c8df2afc1d6e40bb3c79239b328902f",
        "native_balance": "1367185211436852",
        "balance": 0,
        "amount_cur": 0,
        "usd_value": 0,
        "history_bought_cost": 7512.518562874251,
        "history_sold_income": 22551.751441735207,
        "history_transfer_in_amount": 8029232672.475982,
        "history_transfer_in_cost": 217093.0306205628,
        "history_transfer_out_amount": 8194598112.572606,
        "history_transfer_out_income": 424606.0114881289,
        "realized_profit": 226051.87199606228,
        "realized_pnl": 1.0223692866859946,
        "unrealized_profit": 0,
        "unrealized_pnl": null,
        "avg_cost": 0.00000955459210494264,
        "avg_sold": 0.00004329064372547361,
        "buy_tx_count_cur": 3,
        "sell_tx_count_cur": 7,
        "transfer_in_count": 5,
        "transfer_out_count": 4,
        "last_active_timestamp": 1774210005,
        "start_holding_at": 1773379743,
        "end_holding_at": 1774210005,
        "wallet_tag_v2": "TOP1",
        "tags": [],
        "maker_token_tags": [],
        "is_suspicious": false,
        "is_on_curve": true
      }
    ]
  }
}
```

---

## Scraper Location

- **Scraper:** `src/lib/api/gmgn-scraper.ts` → `scrapeGmgnTopTraders(chain, tokenAddress)`
- **API route:** `src/app/api/token/[chain]/[address]/top-traders/route.ts`
- **Cache key:** `gmgn-top-traders:{chain}:{tokenAddress}`
- **Cache TTL:** `CACHE_TTL.TOP_TRADERS`

## Chain Mapping

| App ChainId | GMGN chain param |
|---|---|
| `base` | `base` |
| `bsc` | `bsc` |
| `ethereum` | `eth` |
