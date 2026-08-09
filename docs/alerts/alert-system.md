# Liège Alerts — How Each Chain's Alert Feed Works

Reference for the push-alert system: what is watched on each chain, how a launch
is detected, what triggers a ping, and where each feed's accuracy ends.

> **Keep this current.** Whenever a change to alert behaviour is settled and
> accepted, update this file in the same commit. It is the source of truth for
> how the feeds behave — a stale entry here is worse than no entry, because the
> limitations sections are what tell you whether an alert can be trusted.

**Last updated:** 2026-08-09

---

## 1. The shared model

Every feed follows the same two-stage shape:

1. **A pairing asset is added** — a tokenized stock, or any other asset a
   launchpad lets you price a new token against. Ping.
2. **The first token is launched against it** — one ping per asset, then that
   watch stops.

The second stage is the valuable one. It answers "someone just added NVIDIA as a
quote — what is the first thing anyone launched against it?", which is only
interesting once.

Deliberately **not** covered: pinging on every launch. That was the original
StonkFun behaviour and it buried the signal (see §3).

### Watch keys are per platform

A stock being live on one launchpad says nothing about another. `AAPLB` may have
been on Flap for months and appear on Four.meme today — the first Four.meme
launch against it is its own event and gets its own ping. Watches are therefore
keyed by `(platform, asset)`, never by asset alone.

### Seeding

Every feed seeds silently on its first pass: the existing catalog is recorded
without alerting. You only ever get pings for things added *after* the process
came online. This is why a redeploy never floods the channel.

### Watch lifetime

A first-token watch expires after **14 days** with no launch, on every chain.

---

## 2. Delivery — the Liège Alerts bot

A separate, private bot from the main Liège command bot.

| | |
|---|---|
| Code | [`src/lib/telegram/alerts-bot.ts`](../../src/lib/telegram/alerts-bot.ts) |
| Webhook | `POST /api/telegram/alerts` ([route](../../src/app/api/telegram/alerts/route.ts)) |
| Commands | `/start`, `/help`, `/status`, `/id` |

**Environment**

| Variable | Purpose |
|---|---|
| `TELEGRAM_ALERTS_API_KEY` | Bot token. Absent → all pings silently disabled (pollers still run). |
| `TELEGRAM_ALERTS_WEBHOOK_SECRET` | Optional `x-telegram-bot-api-secret-token` check. Mismatch → 401, inbound commands break; **push alerts are unaffected**, they never touch the webhook. |
| `ALERTS_ALLOWLIST` | Comma/space-separated chat IDs that may use the bot *and* receive alerts. Empty → no recipients → nothing sends. |

Legacy `STONKFUN_ALERT_CHAT_ID` / `LONG_ALERT_CHAT_ID` / `SUNRISE_ALERT_CHAT_ID`
are still honoured as a fallback allow-list when `ALERTS_ALLOWLIST` is unset.

`broadcastAlert()` isolates per-recipient failures, so one bad chat cannot block
delivery to the rest.

### Scheduling

All pollers are registered in
[`src/instrumentation.ts`](../../src/instrumentation.ts), gated on
`NEXT_RUNTIME === "nodejs"`. That guard is load-bearing: the alert modules pull
in the Telegram bot, which transitively imports `playwright-core`, which cannot
be bundled for the Edge runtime.

| Poller | Interval |
|---|---|
| StonkFun quote tokens | 60s |
| StonkFun first token | 30s |
| Sunrise stock pairs | 60s |
| Robinhood registry stocks | 60s |
| Robinhood on-chain first token | 30s |
| Flap Robinhood-chain quotes | 120s |
| BNB Chain stock quotes | 120s |
| BNB Chain on-chain launches | 20s |

Catalog polls are slow (assets are added on the order of days); launch watchers
are fast, and short-circuit entirely while nothing is being watched.

### Chain labelling

Flap runs the same launchpad on **both** BNB Chain and Robinhood Chain with
overlapping stocks, so "new stock quote on Flap" is ambiguous on its own. Every
alert names its chain in the headline and beside the asset class. `⛓` is
reserved for the chain marker and used for nothing else.

---

## 3. Solana — StonkFun

| | |
|---|---|
| Code | [`stonkfun-alerts.ts`](../../src/lib/telegram/stonkfun-alerts.ts), [`api/stonkfun.ts`](../../src/lib/api/stonkfun.ts) |
| Quote catalog | `GET https://www.stonkfun.xyz/api/quote-tokens` (public JSON) |
| Launch detection | Helius enhanced API, `TOKEN_MINT` from the platform deployer |
| Deployer | `5CEbueQnq1Ym2uSSx2xXds3jQAqT1BDnkA59RZobSPAG` |

StonkFun is custodial: every token is minted by one deployer wallet. A genuine
launch mints **exactly 1,000,000,000** units — the deployer also does fee and
utility mints with odd amounts and no metadata, and the supply check is what
filters those out.

### Alerts

**New quote token** — any category, since the ask covers stocks *and* custom
on-chain assets:

| Category | Label |
|---|---|
| `xstock` | 📈 Tokenized Stock |
| `prestock` | 🌅 Pre-Market Stock |
| `currency` | 💱 Currency |
| `backpack` | 🎒 Backpack |
| `tessera` | 🧩 Tessera |
| `custom` | 🪙 On-chain Asset |

**First token vs that quote** — one ping, then the watch closes.

### Pair resolution — the hard part

This feed is architecturally weaker than BNB Chain, and it is worth
understanding why before trusting a ping.

The mint is on-chain and immediate. **The pair is not.** StonkFun seeds the pool
in a *later* transaction, so the mint transaction names only the new token —
verified by [`probe-stonkfun-pair.ts`](../../scripts/probe-stonkfun-pair.ts),
which found exactly one mint and no quote across five consecutive launches.

Reading the pair back from the token's own history also fails: early trades route
through Jupiter/DFLOW aggregators, so SOL, USDC *and* the real quote all appear
as candidates with nothing to separate them.

So the pair comes from the token's **deepest indexed pool**, which arrives some
seconds after the mint. Two consequences drive the implementation:

- A creation may need several passes before its pair resolves → a **pending
  queue** with bounded retries (`MAX_RESOLVE_ATTEMPTS = 10`, ~5 min at 30s).
- **Pools are not indexed in launch order**, so resolution order says nothing
  about launch order. The queue is drained strictly oldest-first and **stops at
  the first unresolved creation** — otherwise a younger token whose pool indexed
  sooner could be announced as "first" and permanently beat an earlier launch.

Creations are tracked on **every** pass, even with nothing watched. A quote is
noticed up to one catalog poll (60s) after it appears, and a token can be
launched in that gap; if tracking only began once a watch existed, that launch
would land in the seed set and the *next* token would be wrongly announced as
first. Only pair *resolution* is gated on a watch existing, so the cost profile
is unchanged.

Other bounds: creations older than **15 minutes** are never queued; queued
creations are dropped once they age past the same window.

### Known limitations

- **A dropped creation can produce a wrong "first".** If a pool never indexes
  within 10 passes, that creation is discarded while its watch stays open, so a
  later token could be reported as first. Ordering holds up to the drop; the drop
  itself cannot be made safe without an on-chain pair.
- **Deepest pool ≠ launch pool** in principle. Low risk here because only mints
  under 15 minutes old are considered, when the launch pool is normally the only
  one.

### Paused: the every-launch feed

`pollStonkFunCreations` and `formatStonkFunAlert` still exist and work, but are
**not scheduled**. They pinged on every mint, which drowned out the signal.
Re-enable by scheduling `pollStonkFunCreations` in `instrumentation.ts` — nothing
else needs changing.

---

## 4. Solana — Sunrise

| | |
|---|---|
| Code | [`sunrise-alerts.ts`](../../src/lib/telegram/sunrise-alerts.ts), [`api/sunrise.ts`](../../src/lib/api/sunrise.ts) |
| Source | `https://sunrise.xyz/tokens` — parsed from the page's embedded RSC JSON |

Sunrise has no list API; the tradable set is server-rendered into `/tokens`. The
parser pulls each token's fields individually rather than relying on field order,
so a reordering upstream doesn't break it.

**Alerts:** new stock pair only. `ALERT_ASSET_CLASSES` is currently `{"stock"}` —
that single constant is where to widen coverage to commodities or crypto.

**No first-token watcher.** Sunrise lists assets tradable against USDC rather
than running a launchpad, so "first token launched against it" has no meaning
here.

---

## 5. Robinhood Chain (4663)

| | |
|---|---|
| Code | [`long-alerts.ts`](../../src/lib/telegram/long-alerts.ts), [`api/long-onchain.ts`](../../src/lib/api/long-onchain.ts), [`api/robinhood-stocks.ts`](../../src/lib/api/robinhood-stocks.ts) |
| Explorer | `https://robinhoodchain.blockscout.com` |

### Two independent quote sources

1. **Robinhood's official asset registry** — `https://api.robinhood.com/rhj/assets`,
   filtered to assets with a chain-4663 deployment. This is what Long draws its
   base pairs from.
2. **Flap's Robinhood-chain catalog** — read from Flap's app bundle (§6). **Not**
   a subset of the registry: it carries third-party issues such as `HOODon`, so
   it is a genuinely additional source of "a new stock is tradable".

Both feed the same on-chain first-token watcher, and stocks from both are
union'd into the set used to ignore stock↔stock pools.

### First-token detection — on-chain

Launches are Uniswap V4 pools created through the singleton PoolManager.

| | |
|---|---|
| PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| `Initialize` topic0 | `0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438` |
| Indexed args | `currency0`, `currency1` (topics 2 and 3); `hooks` is data word 2 |

Read via Blockscout `getLogs`. A watched stock paired with a **non-currency**
token is the inaugural launch. Skipped: the zero address (native ETH), other
stocks, and anything whose symbol is a known currency (`USDG`, `USDC`, `USDT`,
`DAI`, `WETH`, `ETH`, `WBTC`, `BTC`, `WBNB`, `BNB`, `FRAX`, `PYUSD`) — those are
the stock's own price pool.

Scanning only ever moves forward from the block a watch began, so an older token
can never be mistaken for the first. `MAX_BLOCK_SPAN = 100_000` — after downtime
the gap is skipped rather than backfilled.

### Launchpad attribution

Every launchpad here goes through the same Uniswap V4 PoolManager, so the
frontend is inferred, most-specific first:

1. **Branded launch-tx router** — `LongLauncher`
   `0x22e99278308b393ea1260859b181ad7e78f5eeed`; Flap's portal
   `0x26605f322f7ff986f381bb9a6e3f5dab0beaeb09`. Flap's is a bare
   `TransparentUpgradeableProxy`, so its verified name reveals nothing — **only
   the address identifies it**.
2. **The launched token's deployer factory** — Pons
   `0x3711cea4feade896c913c68f01eda97cb06d1a42`. Pons creates plain no-hook
   pools, so the token's origin is the only signal.
3. **The token's verified contract name** — substring match on the brand.
4. **Known hook address** — no hook → Uniswap V4 / pools.trade; Doppler
   `0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544`; Klik
   `0x745d717620052a97a22deee2e5eba59583f3e0cc`.
5. **The hook's own contract name**, then a generic Uniswap V4 fallback.

Many launches route through generic Multicall3 / ERC-4337 EntryPoint, which hides
the frontend — hence the fallback chain rather than relying on step 1.

---

## 6. BNB Chain (56)

Two launchpads let you price a token in a tokenized stock. Both use Binance's
tokenized equities (**bStocks** — `AAPLB`, `NVDAB`, `TSLAB`…), so the same asset
appears on either, with **identical contract addresses**.

| | |
|---|---|
| Code | [`bsc-stock-alerts.ts`](../../src/lib/telegram/bsc-stock-alerts.ts), [`api/bsc-onchain.ts`](../../src/lib/api/bsc-onchain.ts), [`api/flap.ts`](../../src/lib/api/flap.ts), [`api/four-meme.ts`](../../src/lib/api/four-meme.ts) |
| RPC | Public BNB Chain endpoints, rotated on failure — **no API key** |

### Quote catalogs

**Four.meme** — no catalog API. The create page server-renders the full list into
its RSC payload as `ssrConfig.commonConfig`. Status `PUBLISH` = selectable now,
`INIT` = staged but not live.

**Flap** — no catalog API, and the launch page renders only the *active* tab, so
the RWA tab never reaches the HTML. Both lists ship in the app bundle:

- `paymentTokens[]` — symbol → address, decimals, logo
- `launchPaymentTokenCatalog[]` — symbol → `category` (`rwa` | `crypto`) and
  `status` (`coming-soon` when not yet tradable)

Joined by symbol. Entries with no `paymentTokens` match are assets announced but
not yet deployed — these are the **upcoming stocks**, which is how the roadmap
(Meta, Amazon, Palantir, Intel…) is visible ahead of launch. The hashed
`main-app-*.js` URL is re-resolved from the launch page on every poll, so a
redeploy just changes the URL followed.

Flap's bundle also carries its **Robinhood-chain** catalog (chain 4663), which is
what §5 consumes.

### Alerts

Two distinct events per asset, per platform:

1. **Listed** — appears in the catalog. For Flap this includes `coming-soon`
   entries, which is the early signal.
2. **Went live** — a previously-announced asset becomes selectable. This is what
   starts the first-token watch.

### Asset classification

Flap tags every payment token `rwa` or `crypto` — authoritative. Four.meme
carries no asset class, so it is classified against Flap's catalog by **address**
(authoritative, since both use the same bStock contracts) then by symbol. A
Four.meme-first listing falls through as "other" and still alerts, just without
the stock headline.

Commodities (`XAUT`, `PAXG`, `XAGT`) sit in the same `rwa` bucket as equities and
are labelled "Tokenized commodity" rather than being called stocks.

### First-token detection — bonding-curve events

Detection reads the **bonding-curve creation event**, so a launch is caught as
the curve is deployed — not when an indexer notices a pool. This matters: a curve
that never migrates may never produce an indexed pool at all.

| Platform | Contract | topic0 | Quote |
|---|---|---|---|
| Flap | portal `0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0` | `0x3ceb902d3c555c21c3415b6aa839104b18e4825b2f8324011ff979089a507a8c` | **Inline** — data is `[token, paymentToken]` |
| Four.meme | TokenManager2 `0x5c952063c7fc8610ffdb798152d69f0b9550762b` | `0x396d5e902b675b032348d3d2e9517ee8f0c4a926603fbc075d3d282ff00cad20` | **Not in the event** |

Four.meme's event carries creator, token, id, name/symbol offsets and supply, but
no quote. It is read back per token from `TokenManagerHelper3`
`0xf251f83e40a78868fcfa3fa4599dad6494e46034`, `getTokenInfo(address)` (selector
`0x1f69565f`), where `quote` is the third returned word. One `eth_call` per
launch, and only for platforms currently being watched.

A quote of the zero address means the token is priced in native BNB — ignored.

Metadata: Four.meme's event carries name and symbol; Flap's does not, so ERC-20
`name()` / `symbol()` are read from the token. Market stats are best-effort from
DexScreener and the alert renders without them ("Fresh curve — no market data
indexed yet") rather than waiting.

### RPC handling

Free BSC endpoints rate-limit hard and cap `getLogs` spans, so:

- Ranges are chunked at **1,000 blocks** (`LOG_CHUNK`).
- `MAX_BLOCK_SPAN = 5_000` per pass; after downtime the gap is skipped.
- **A failed `getLogs` returns `null`, not an empty array**, and the poller holds
  its cursor to retry. This is essential: an empty array is indistinguishable
  from "no launches", and combined with an advancing cursor it would silently
  skip blocks while looking perfectly healthy.

### Identifying which launchpad made a token

Useful when auditing after the fact, because DexScreener reports where liquidity
*currently* lives, not where a token launched — a Flap token that completed its
curve and migrated shows as `pancakeswap`, hiding its origin.

Bytecode is the reliable fingerprint:

| Platform | Fingerprint |
|---|---|
| Flap | EIP-1167 minimal proxy → `0x024f18294970b5c76c0691b87f138a0317156422` |
| Four.meme | Plain contract, ~13,584 bytes |

### Known limitations

- **Historical backfill is not possible on free RPCs.** Public endpoints will not
  serve `getLogs` more than roughly a couple of days back, so "the first token
  ever launched against X" cannot be resolved by scanning without an archival
  RPC. This never affects the live watcher, which only scans forward from the
  block a watch begins.

---

## 7. Rate limits

Token-bucket per upstream, in
[`src/lib/rate-limiter.ts`](../../src/lib/rate-limiter.ts):

| Bucket | Burst | Refill/s | Used by |
|---|---|---|---|
| `bscrpc` | 20 | 5 | BNB Chain launch watcher |
| `robinscan` | 10 | 2 | Robinhood Blockscout |
| `dexscreener` | 60 | 1 | Market stats everywhere |
| `helius` | 20 | 8 | StonkFun mints + metadata |
| `stonkfun` / `sunrise` / `robinhood` | 10 | 0.5 | Catalog polls |
| `flap` | 6 | 0.2 | Launch page + app bundle |
| `fourmeme` | 5 | 0.2 | Create-page scrape |

Flap and Four.meme are scraped pages rather than APIs, so they poll gently — new
quote assets are listed on the order of days, not seconds.

---

## 8. Verification scripts

None of these send to Telegram unless stated. All load `.env.local` where needed.

| Script | Purpose |
|---|---|
| [`probe-bsc-stocks.ts`](../../scripts/probe-bsc-stocks.ts) | Dump both BNB Chain quote catalogs, live and upcoming |
| [`probe-bsc-first-token.ts`](../../scripts/probe-bsc-first-token.ts) | Scan recent blocks for curve creations, resolve quotes, render alerts |
| [`probe-stonkfun-pair.ts`](../../scripts/probe-stonkfun-pair.ts) | Show whether a StonkFun mint tx reveals its quote (it does not) |
| [`probe-alert-formats.ts`](../../scripts/probe-alert-formats.ts) | Render every alert format against live data |
| [`test-bsc-first-token-ping.ts`](../../scripts/test-bsc-first-token-ping.ts) | Find the first token vs a stock and **send** it, if the bot is configured |
