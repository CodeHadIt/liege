# GMGN Address Page — Data Schema

**URL format:** `https://gmgn.ai/{chain}/address/{walletAddress}`

| Chain | GMGN chain param |
|---|---|
| Base | `base` |
| BSC | `bsc` |
| Ethereum | `eth` |

---

## ⚠️ Auth Requirement

Unlike the `token_holders` endpoint (which is Cloudflare-gated but publicly accessible after a session is established by visiting the token page), the wallet address page **requires a GMGN account login** to load holdings and activity data.

When not authenticated:
- The page fires only metadata calls (`/mrwapi/v1/timestamp`, `/api/v1/gas_price_list`, etc.)
- **No** `/vas/api/v1/wallet_holdings/` call is made
- The `wallet_holdings` endpoint returns HTTP 403 (Cloudflare WAF) from all contexts, even after the same Playwright session that successfully runs `token_holders`

The app therefore falls back to **Moralis EVM API** for wallet quick-view data. See `src/app/api/wallet/quick-view/route.ts`.

---

## Known Endpoint (Auth-gated)

```
GET /vas/api/v1/wallet_holdings/{chain}/{walletAddress}
    ?limit=50
    &orderby=usd_value
    &direction=desc
```

**HTTP 403** without GMGN session cookies.

---

## Expected `wallet_holdings` Response Schema

Inferred from the GMGN UI's visible Holdings columns and naming conventions from the `token_holders` endpoint:

```ts
interface GmgnWalletHoldingsResponse {
  code:    number;   // 0 = success
  reason:  string;
  message: string;
  data: {
    list: GmgnHolding[];
  };
}

interface GmgnHolding {
  /** Token contract address (lowercase) */
  token_address: string;

  /** Token symbol e.g. "KELLY" */
  symbol: string;

  /** Token name e.g. "KellyClaude" */
  name: string;

  /** Logo image URL */
  logo: string | null;

  /** Current token balance (decimal-adjusted) */
  balance: number;

  /** USD value of current balance at scrape time */
  usd_value: number;

  /** Average cost / buy price per token in USD */
  avg_cost: number;

  /** Average sell price per token in USD (0 if never sold) */
  avg_sold: number | null;

  /** Total USD spent buying (direct buys only) */
  history_bought_cost: number;

  /** Total USD received from selling (direct sells only) */
  history_sold_income: number;

  /** Realized profit/loss in USD (includes transfer flows, same calc as token_holders) */
  realized_profit: number;

  /** Unrealized profit/loss in USD at scrape time */
  unrealized_profit: number;

  /** Current price per token in USD */
  price: number | null;

  /** Number of buy transactions */
  buy_tx_count_cur: number;

  /** Number of sell transactions */
  sell_tx_count_cur: number;

  /** Unix timestamp (seconds) of last on-chain activity */
  last_active_timestamp: number | null;

  /** Unix timestamp of first buy */
  start_holding_at: number | null;

  /** Wallet-assigned tag e.g. "TOP1", "SMART" */
  wallet_tag_v2: string | null;

  /** Whether flagged as suspicious */
  is_suspicious: boolean;
}
```

---

## `wallet_holdings` Field Notes

| Field | Notes |
|---|---|
| `balance` | Decimal-adjusted (GMGN normalises, same as `token_holders`) |
| `usd_value` | `balance × price` at scrape time |
| `avg_cost` | Mean buy price across all buy txns |
| `avg_sold` | Mean sell price across all sell txns; `null` if never sold |
| `history_bought_cost` | Direct buys only — excludes transfer-in cost basis |
| `history_sold_income` | Direct sells only — excludes transfer-out income |
| `realized_profit` | GMGN's authoritative PnL: sold + transfer_out − bought − transfer_in |
| `unrealized_profit` | `balance × price − cost_basis` |

---

## Other Endpoint Patterns (all auth-gated)

The following endpoints are 404 (don't exist) or 403 (Cloudflare) from unauthenticated sessions:

| Endpoint | Purpose |
|---|---|
| `/vas/api/v1/wallet_activity/{chain}/{wallet}` | Swap/trade history feed |
| `/vas/api/v1/wallet_pnl/{chain}/{wallet}` | PnL over time chart data |
| `/vas/api/v1/wallet_stat/{chain}/{wallet}` | Summary stats (win rate, avg hold time) |

---

## Fallback: Moralis EVM Wallet API

Since GMGN requires login, the app uses **Moralis `deep-index.moralis.io/api/v2.2`** for EVM wallet quick-view data.

| Moralis endpoint | Data provided |
|---|---|
| `GET /wallets/{addr}/tokens?chain={moralisChain}` | Token balances + USD values (Positions tab) |
| `GET /wallets/{addr}/profitability?chain={moralisChain}` | Per-token realized PnL, buy/sell counts (PnL History + Top Buys tabs) |
| `GET /wallets/{addr}/history?chain={moralisChain}&limit=25` | Recent swap activity (Activity tab) |

Moralis chain IDs: `base → 0x2105`, `bsc → 0x38`, `ethereum → 0x1`

Implementation: `src/app/api/wallet/quick-view/route.ts` → `buildEvmQuickView()`

---

## Scraper Location

- **Token holders scraper** (works): `src/lib/api/gmgn-scraper.ts`
- **Wallet quick-view** (Moralis fallback): `src/app/api/wallet/quick-view/route.ts`
- **Cache key**: `wallet-quick:{chain}:{walletAddress}` — `CACHE_TTL.WALLET_QUICK` (60s)

---

## What GMGN Holdings Tab Shows (UI-observed fields)

From the address page UI (visible when logged in):

| Column | Description |
|---|---|
| Token | Logo + symbol + name |
| Balance | Current holdings amount |
| USD Value | Current balance in USD |
| Avg Buy | Average purchase price per token |
| Avg Sell | Average sell price per token |
| Bought | Total USD spent buying |
| Sold | Total USD received selling |
| Realized PnL | Net profit/loss on closed/partial positions |
| Unrealized PnL | Open position profit/loss at current price |
| Last Active | Timestamp of most recent transaction |
