# GMGN Scraper — Field Reference

Two distinct data shapes are returned depending on which scraper function is called.

---

## 1. `GmgnTopTrader` — Token holder / trader data

Returned by:
- `scrapeGmgnTopTraders(chain, tokenAddress)` — sorted by realized PnL
- `scrapeGmgnTopHolders(chain, tokenAddress)` — sorted by current balance
- `scrapeGmgnHoldersPaginated(chain, tokenAddress, maxPages)` — paginated, sorted by balance

### Fields

| Our field | Raw GMGN field | Type | Description |
|---|---|---|---|
| `walletAddress` | `address` | `string` | The wallet address |
| `realizedProfitUsd` | `realized_profit` | `number` | Total USD profit already locked in from completed sells |
| `unrealizedProfitUsd` | `unrealized_profit` | `number` | Unrealized USD profit on tokens still held (based on current price) |
| `historyBoughtCostUsd` | `history_bought_cost` | `number` | Total USD spent buying this token across all time |
| `historySoldIncomeUsd` | `history_sold_income` | `number` | Total USD received from all sells of this token |
| `balance` | `balance` | `number` | Current token balance (in token units, not USD) |
| `balanceUsd` | `usd_value` | `number` | Current USD value of the held balance |
| `avgCostUsd` | `avg_cost` | `number` | Average buy price **per token** in USD (total cost ÷ total tokens bought) |
| `avgSoldUsd` | `avg_sold` | `number` | Average sell price **per token** in USD |
| `buyCount` | `buy_tx_count_cur` | `number` | Number of buy transactions |
| `sellCount` | `sell_tx_count_cur` | `number` | Number of sell transactions |
| `lastActiveTimestamp` | `last_active_timestamp` | `number \| null` | Unix timestamp (seconds) of the wallet's most recent activity on this token |
| `openTimestamp` | `open_timestamp` | `number \| null` | Unix timestamp (seconds) when the wallet **first bought** this token — this is the hold start date |
| `nativeBalanceWei` | `native_balance` | `string` | Native chain balance in wei (ETH/BNB/SOL) as a raw string |
| `supplyPercent` | `percent` / `supply_percent` | `number` | % of total token supply held by this wallet (0 if unavailable) |

### Hold time

**Yes — hold time is derivable.** Use `openTimestamp` as the start and the current time as the end:

```ts
const holdSeconds = Math.floor(Date.now() / 1000) - (holder.openTimestamp ?? 0);
```

`openTimestamp` is `null` if the wallet has never bought (e.g. received tokens via airdrop/transfer only).

### Average buy market cap

`avgCostUsd` is price-per-token, not market cap. To get the average buy market cap:

```
avgBuyMC = avgCostUsd / currentPrice × currentMC
```

Or equivalently, since `avgBuyMC / currentMC = avgCostUsd / currentPrice`:

```ts
const multiple = holder.avgCostUsd / currentPrice;  // e.g. 20 = bought at 20× current price
const avgBuyMc = multiple * currentMC;
```

This is how `/diamond` filters holders: `avgCostUsd >= 20 × currentPrice`.

---

## 2. `GmgnWalletHolding` — Wallet-level holdings data

Returned by:
- `scrapeGmgnWalletHoldings(chain, walletAddress)` — navigates to a wallet's GMGN page

This gives **per-token PnL data for a specific wallet** (used by `/wallet`).

### Fields

| Our field | Raw GMGN field | Type | Description |
|---|---|---|---|
| `tokenAddress` | `token.address` / `address` | `string` | The token's contract address |
| `symbol` | `token.symbol` / `symbol` | `string` | Token ticker symbol |
| `realizedPnlUsd` | `realized_profit` | `number` | Realized profit/loss in USD for this token |
| `unrealizedPnlUsd` | `unrealized_profit` | `number` | Unrealized P&L on currently held amount |
| `totalPnlUsd` | `realized_profit + unrealized_profit` | `number` | Combined total P&L |
| `investedUsd` | `cost` / `history_bought_cost` | `number` | Total USD invested into this token |
| `currentValueUsd` | `usd_value` | `number` | Current USD value of remaining holdings |
| `lastActiveTimestamp` | `last_active_timestamp` | `number \| null` | Unix timestamp of last trade activity on this token |

> **Note:** `GmgnWalletHolding` does **not** include `openTimestamp` (hold start date) or `avgCostUsd` (average buy price). Those fields are only available in `GmgnTopTrader` (token-level scrape).

---

## Field availability by function

| Field | `scrapeGmgnTopTraders` | `scrapeGmgnTopHolders` | `scrapeGmgnHoldersPaginated` | `scrapeGmgnWalletHoldings` |
|---|:---:|:---:|:---:|:---:|
| `walletAddress` | ✅ | ✅ | ✅ | ❌ |
| `realizedProfitUsd` | ✅ | ✅ | ✅ | ✅ (`realizedPnlUsd`) |
| `unrealizedProfitUsd` | ✅ | ✅ | ✅ | ✅ (`unrealizedPnlUsd`) |
| `historyBoughtCostUsd` | ✅ | ✅ | ✅ | ✅ (`investedUsd`) |
| `historySoldIncomeUsd` | ✅ | ✅ | ✅ | ❌ |
| `balance` (token units) | ✅ | ✅ | ✅ | ❌ |
| `balanceUsd` | ✅ | ✅ | ✅ | ✅ (`currentValueUsd`) |
| `avgCostUsd` | ✅ | ✅ | ✅ | ❌ |
| `avgSoldUsd` | ✅ | ✅ | ✅ | ❌ |
| `buyCount` / `sellCount` | ✅ | ✅ | ✅ | ❌ |
| `openTimestamp` (hold start) | ✅ | ✅ | ✅ | ❌ |
| `lastActiveTimestamp` | ✅ | ✅ | ✅ | ✅ |
| `supplyPercent` | ✅ | ✅ | ✅ | ❌ |
| `symbol` | ❌ | ❌ | ❌ | ✅ |
| `tokenAddress` | ❌ | ❌ | ❌ | ✅ |
