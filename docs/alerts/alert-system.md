# Liège Alerts — How Each Chain's Alert Feed Works

Reference for the push-alert system: what is watched on each chain, how a launch
is detected, what triggers a ping, and where each feed's accuracy ends.

> **Keep this current.** Whenever a change to alert behaviour is settled and
> accepted, update this file in the same commit. It is the source of truth for
> how the feeds behave — a stale entry here is worse than no entry, because the
> limitations sections are what tell you whether an alert can be trusted.

**Last updated:** 2026-08-12 (pump.fun quote monitoring)

---

There are two families of feed here, and they answer different questions:

- **§3–§7 — launch feeds.** A new pairing asset appears on a launchpad; the first
  token launched against it gets a ping. These watch *platforms*.
- **§10–§12 — alpha feeds.** Wallets and devs with a track record get watched, and
  their next move gets a ping. These watch *people*.

## 1. The shared model

Every feed follows the same two-stage shape:

1. **A pairing asset is added** — a tokenized stock, or any other asset a
   launchpad lets you price a new token against. Ping.
2. **Tokens are launched against it** — every launch inside a **36h window**
   gets a ping, numbered, not only the first.

The second stage is the valuable one. It answers "someone just added NVIDIA as a
quote — what is being built against it?" The window exists because the burst that
follows a new pair is the signal; reporting only the inaugural launch threw away
everything after it. `MAX_LAUNCHES_PER_WINDOW` (25) is a safety valve for a
runaway pair, and the watcher logs when it trips rather than going quiet.

Both constants live in [`launch-window.ts`](../../src/lib/telegram/launch-window.ts)
so every platform — StonkFun, Pump.fun, Long, Pons, Flap, pools.trade,
Four.meme, and anything added later — shares one definition instead of inventing its own.

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

A launch watch runs for **36 hours** from the moment the quote asset is seen,
on every chain, then closes whether or not anything launched.

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
| Pump.fun quote assets | 60s |
| Pump.fun launch window | 60s |
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

**New quote token** — every category except `custom`, which is a creator-
nominated on-chain token (a memecoin paired against another memecoin). That
category dominates the catalog at 140 of 185 listed quotes and buried the stock
listings this feed exists for. Expressed as a denylist rather than an allowlist,
because the catalog carries categories beyond the obvious ones — `leverage` and
`solana` among them — and an allowlist would silently drop those and anything
StonkFun adds later.

| Category | Label |
|---|---|
| `xstock` | 📈 Tokenized Stock |
| `prestock` | 🌅 Pre-Market Stock |
| `currency` | 💱 Currency |
| `backpack` | 🎒 Backpack |
| `tessera` | 🧩 Tessera |
| `custom` | 🪙 On-chain Asset |

**Launches against that quote** — every token launched inside the 36h window,
numbered, not just the first.

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

## 7. Solana — Pump.fun

Watches pump.fun's quote-asset whitelist and reports coins launched against a
newly-added one. Same two-stage shape as every other platform; what is unusual
is that both stages read from different worlds — the catalog from the chain, the
launches from an HTTP API.

Code: [`src/lib/api/pumpfun-quotes.ts`](../../src/lib/api/pumpfun-quotes.ts),
[`src/lib/telegram/pumpfun-alerts.ts`](../../src/lib/telegram/pumpfun-alerts.ts).

### The quote catalog is on-chain, not an API

Unlike StonkFun, Flap and Four.meme, pump.fun serves no catalog. `/create` is
client-rendered, and every plausible route on `frontend-api-v3.pump.fun`
(`/quote-tokens`, `/pairs`, `/config`, `/coins/quote-mints`, …) returns 404. The
frontend bundle explained why: the list is never fetched. It is read from the
chain into a `supportedCurrencies` array on a program account.

The pump program publishes its **Anchor IDL on-chain**, which settles the layout
exactly rather than by guesswork:

| | |
|---|---|
| Program | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` |
| Global PDA | seeds `["global"]` → `4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf` |
| Field | `Global.whitelisted_quote_mints` |
| Offset | **1013** bytes |
| Instructions | `add_quote_mint` / `remove_quote_mint` |

The offset is computed by summing every field ahead of it after the 8-byte
discriminator, and then **confirmed against the live account**: it is 1045 bytes
with USDC occupying the final 32. Computed and observed agree, so the reader
isn't trusting an IDL that could describe a different deployed version.

Reading the account beats watching `add_quote_mint` calls: it is one
`getAccountInfo`, there is no history to replay, and a restart re-reads the truth
instead of reconstructing it.

The field is `[pubkey; 1]` today, but the program has an `extend_account`
instruction — adding a quote grows the account. The reader therefore parses from
the offset to the **end of the account**, so a longer array is picked up
automatically rather than silently truncated to the first entry.

**Current state:** the whitelist holds exactly one mint, USDC. No stock quote
exists on pump.fun yet, which is precisely what this feed is waiting for.

### Alerts

1. **Quote asset added** — a mint appears in `whitelisted_quote_mints` that
   wasn't there before. Names the asset, links Solscan and `/create`, and states
   that the 36h window has opened.
2. **Coin launched against it** — every launch inside the window, numbered
   (`🥇 First`, `🔁 3rd`), capped at 25.

### Asset classification

There is **no category field on-chain**, so a stock cannot be distinguished from
anything else by inspection. Rather than invent an allowlist of expected stock
symbols — which would silently swallow the first listing that didn't match it —
the feed reports every newly-whitelisted mint and suppresses a small explicit
**baseline** set (SOL, wrapped SOL, USDC, USDT, USD1). Those are the assets the
program shipped with, not listings.

Seeding already prevents the baseline from alerting; naming it explicitly means a
redeploy can't announce the existing catalog as a fresh listing either. This is
the same denylist reasoning as StonkFun's `custom` suppression (§3).

### Launch detection — pull and filter

Pump.fun's `/coins` endpoint carries `quote_mint` on every coin but **will not
filter by it**: `quoteMint`, `quote_mint`, `quoteMints` and `quote` are all
ignored and the response comes back all-SOL. So the recent-creations feed is
pulled whole and matched locally.

That is affordable because the firehose is slower than it looks — measured at
**~21 coins/minute**, and one page (the server caps `limit` at 70) covers a
little over three minutes. A 60s poll therefore carries roughly 3× headroom. If
the cursor is further back than one page covers — a delayed pass, or a window
that just opened — the reader pages back up to 4 pages so the gap is genuinely
covered rather than skipped.

The pass **short-circuits before any network call while no window is open**,
which is the normal state. Until a stock is listed, this poller costs nothing.

SOL appears in the feed under two spellings — the system-program sentinel
`111…111` (native) and the wrapped-SOL mint. Both are treated as SOL; neither is
ever watched.

### RPC failover

Both reads here are `getAccountInfo` against known accounts, and they try Helius
first, then the public endpoint. The fallback is not decoration: Helius returns
HTTP 429 *"max usage reached"* once the account's credits are spent, and with a
single endpoint the catalog read would fail indefinitely — **the feature going
quiet while looking healthy**. This was observed during development, not
theorised: the first end-to-end run returned no catalog for exactly that reason.

A failed read returns `null`, never an empty array. The distinction matters: a
caller treating a failed read as "the catalog is empty" would re-announce every
quote as newly added the moment the node recovered.

### Naming a new quote

Metaplex metadata is read **from the chain first**, with an indexer (Jupiter)
only as fallback. A stock quote is interesting on the day it lists, which is
exactly when a third-party token list is least likely to know about it — whereas
its metadata account exists from mint.

### Known limitations

- **Window state is in-memory.** A redeploy mid-window loses the open watch and
  the launch cursor. Same as every other platform here; noted rather than fixed.
- **No stock quote has ever been listed**, so the launch half of this feed has
  been verified against USDC-quoted coins (which do exist and do flow through the
  same path) rather than against a real stock listing.

---

## 8. Rate limits

Token-bucket per upstream, in
[`src/lib/rate-limiter.ts`](../../src/lib/rate-limiter.ts):

| Bucket | Burst | Refill/s | Used by |
|---|---|---|---|
| `bscrpc` | 20 | 5 | BNB Chain launch watcher |
| `robinscan` | 10 | 2 | Robinhood Blockscout |
| `dexscreener` | 60 | 1 | Market stats everywhere |
| `helius` | 20 | 8 | StonkFun mints + metadata, Pump.fun account reads |
| `pumpfun` | 10 | 0.5 | Pump.fun `/coins` launch feed |
| `stonkfun` / `sunrise` / `robinhood` | 10 | 0.5 | Catalog polls |
| `flap` | 6 | 0.2 | Launch page + app bundle |
| `fourmeme` | 5 | 0.2 | Create-page scrape |

Flap and Four.meme are scraped pages rather than APIs, so they poll gently — new
quote assets are listed on the order of days, not seconds.

---

## 9. Verification scripts

None of these send to Telegram unless stated. All load `.env.local` where needed.

| Script | Purpose |
|---|---|
| [`probe-bsc-stocks.ts`](../../scripts/probe-bsc-stocks.ts) | Dump both BNB Chain quote catalogs, live and upcoming |
| [`probe-bsc-first-token.ts`](../../scripts/probe-bsc-first-token.ts) | Scan recent blocks for curve creations, resolve quotes, render alerts |
| [`probe-stonkfun-pair.ts`](../../scripts/probe-stonkfun-pair.ts) | Show whether a StonkFun mint tx reveals its quote (it does not) |
| [`probe-alert-formats.ts`](../../scripts/probe-alert-formats.ts) | Render every alert format against live data |
| [`test-bsc-first-token-ping.ts`](../../scripts/test-bsc-first-token-ping.ts) | Find the first token vs a stock and **send** it, if the bot is configured |
| [`probe-alpha-buys.ts`](../../scripts/probe-alpha-buys.ts) | Dry-run alpha-wallet buy detection over recent blocks |
| [`test-alpha-confluence-ping.ts`](../../scripts/test-alpha-confluence-ping.ts) | **Send** a mock confluence sequence using real wallet labels |
| [`test-alpha-nft-ping.ts`](../../scripts/test-alpha-nft-ping.ts) | **Send** an NFT confluence ping built from real on-chain mints |
| [`run-ath-scan.ts`](../../scripts/run-ath-scan.ts) | Run the daily scan manually (`--dry`, `--hours N`, `--refresh-mc`) |
| [`backfill-ath-tokens.ts`](../../scripts/backfill-ath-tokens.ts) | Seed ath_tokens + traders from the research dataset |
| [`backfill-deployers.ts`](../../scripts/backfill-deployers.ts) | Promote alpha deployers and build their deploy histories |
| [`seed-alpha-wallets.ts`](../../scripts/seed-alpha-wallets.ts) | Seed alpha_wallets from the research dataset |


---

## 10. Robinhood Chain — alpha wallet confluence

| | |
|---|---|
| Code | [`alpha-watcher.ts`](../../src/lib/telegram/alpha-watcher.ts), [`alpha-alerts.ts`](../../src/lib/telegram/alpha-alerts.ts), [`api/rh-onchain.ts`](../../src/lib/api/rh-onchain.ts) |
| Tables | `alpha_wallets`, `alpha_buys`, `alpha_confluence` |
| Poll | 30s |

**Alpha wallets** are addresses that were top-30 traders on two or more tokens
which reached a $2M ATH market cap, with automated wallets excluded. They are
labelled `<CHAIN>_<coin1>_<coin2>_<pnl>` — e.g. `RH_cashcat_tendies_1.7M` — where
the two coins are the wallet's biggest winners, so the label says what the wallet
is known for.

**One wallet buying is not the signal.** Nothing fires on a first buy. The first
alert goes out when a SECOND alpha wallet buys the same token, and wallets 3, 4
and 5 each get a follow-up carrying the move since the first ping. Four pings
maximum, then the token stops being watched.

### Detection

One `eth_getLogs` per poll: ERC-20 `Transfer` with the indexed recipient
OR-filtered across every alpha wallet. Cost does not grow with the watchlist,
which is what allows a 30s poll. Blockscout's REST API cannot express that
filter, so this uses the chain's JSON-RPC — which 403s without browser
`Origin`/`Referer` headers.

A transfer IN is not a buy. Each candidate is confirmed by checking the alpha
wallet **sent** the transaction that delivered the asset; otherwise airdrops and
transfers between a user's own addresses would count toward confluence.

### NFTs

ERC-721 shares ERC-20's `Transfer` topic0 exactly — they differ only in arity
(3 topics vs 4, with the id indexed). Conflating them made an NFT collection read
as a token every alpha wallet was "buying" for $0: 452 phantom buys and 31
alerts. They are now told apart and both are tracked, on their own terms:

- Count of ids received IS the amount; mints arrive batched (50 in one tx is routine)
- No pool, so cost is the native value on the transaction, and supply/holders
  stand in for market cap
- Floor comes from OpenSea's public per-collection v2 endpoints, which do index
  this chain. Collections OpenSea doesn't list fall back to the lowest recent
  on-chain fill, and only that path is captioned as derived

### Thresholds

| | | |
|---|---|---|
| `MIN_BUY_USD` | $250 | Buys below this don't drive confluence |
| `CONFLUENCE_WINDOW_MS` | 4h | Measured from the first alpha buy |
| `WINDOW_REOPEN_COOLDOWN_MS` | 24h | After a window closes |
| `MAX_WALLETS_TO_ALERT` | 5 | Four pings maximum |

The size floor is load-bearing, not a nicety. Robinhood Chain runs 0.1s blocks
and these wallets trade constantly, so two of them touching the same token is
ordinary: unfiltered, the feed fires ~173 times a day. Measured rates by floor —
$0 → ~173/day, $250 → ~58, $500 → ~29. **NFTs are exempt**, because free mints
are the norm and a USD floor would suppress every one; their noise is bounded by
confluence, the cooldown and the ping cap instead.

Unpriced buys are recorded but never counted. They used to count, on the
reasoning that an unpriced token is the earliest case worth catching — in
practice it meant anything unpriceable bypassed the floor entirely.

### Known limitations

- **A transient RPC failure is indistinguishable from a quiet range.** `getLogs`
  returning null holds the cursor, but a partial read cannot be detected.
- The node caps `getLogs` at 10,000 matches and returns an ERROR. That error is
  deterministic, so a naive retry loops forever — ranges split in half instead.

---

## 11. Robinhood Chain — daily ATH scan

| | |
|---|---|
| Code | [`ath-daily-scan.ts`](../../src/lib/telegram/ath-daily-scan.ts), [`api/ath-tokens.ts`](../../src/lib/api/ath-tokens.ts) |
| Tables | `ath_tokens`, `ath_token_traders`, `token_deployers`, `ath_scan_runs` |
| Runs | 23:00 UTC daily |

Finds tokens that reached a $2M ATH market cap in the last 24h, records them with
their top 30 traders, then cross-references those traders against **every ATH
token ever recorded**. A wallet that was a top trader on two or more separate
runners has repeated across independent winners, so it is promoted to the alpha
list automatically and announced in caps — reserved for this because it is the
rarest and highest-value message the bot sends. A normal-tone digest of the day's
runners follows.

`ath_token_traders` is the load-bearing table: cross-referencing today's traders
against past winners is impossible without storing the past winners, so the
corpus IS the mechanism rather than a record of it.

### Scheduling

The clock is checked every minute rather than a timer being set once — a long
timer drifts over days, and a redeploy at the wrong moment would skip the day
entirely. Runs are claimed by UTC date in `ath_scan_runs`, so repeated checks and
multiple instances still produce exactly one run.

**Weekly market-cap refresh** runs Sunday 23:00 UTC on the same minute tick,
updating `current_mc_usd` for recorded tokens. Guarded in memory rather than the
database: it only overwrites a price and a timestamp, so a duplicate run after a
restart costs a few requests and changes nothing.

### Filters, and why each exists

| Filter | Reason |
|---|---|
| Candidate FDV ≥ $100k | Without it the scan prices thousands of dust pools nightly. A heuristic — the first thing to revisit if a known runner is missed. |
| ATH ≤ $500M | Thin pools print absurd daily highs. A dry run produced "Cashcow, ATH $1,876,560,000,000". Held back and logged. |
| Not WETH/USDG/USDe/Index… | They trade here but weren't launched here, and clear $2M every day by definition. |
| Contracts excluded from promotion | GMGN's trader list is flow-derived, so the V4 PoolManager appears in nearly every token. It **was** promoted once, as `RH_pipedog_dogo_17.8B` on $17.8B of "PnL". |
| ≥1,000 trades on a token | Automation. Median top-30 trader makes ~23. |

The contract guard lives in `ath-tokens.ts` and is shared by all three paths that
write to `alpha_wallets`, rather than each carrying its own copy.

---

## 12. Robinhood Chain — alpha deployer alerts

| | |
|---|---|
| Code | [`deployer-alerts.ts`](../../src/lib/telegram/deployer-alerts.ts), [`api/alpha-deployers.ts`](../../src/lib/api/alpha-deployers.ts) |
| Tables | `token_deployers`, `deployer_launches` |
| Poll | 120s |

A repeat deployer is a different signal to a repeat trader: the trader found the
winner, the deployer made it. Devs behind two or more $2M runners are labelled
`<CHAIN>_<coin1>_<coin2>_Dep` — the trailing `Dep` is constant, so the two lists
never read alike — and watched for their next launch. Alerts use builder emojis
(🏗️ 🔨 ⚒️ 🧱 👷) to distinguish them at a glance.

The alert carries the new token plus the dev's full track record: every previous
runner with ATH and current market cap, and a **20x success rate**.

### The success rate

Launch market cap is a **constant $5k** — the bonding-curve start on this chain —
so 20x means exactly **$100k ATH**, comparably, for every token. Deriving launch
cap per token was tried and rejected: it came from a pool's first candle, and any
token that migrated off its curve has a deeper pool opening long after launch, so
CASHCAT read as launching at $117M and a ~4,000x run looked like 1.8x.

Two counts live on `token_deployers` and must never be confused:

| Column | Meaning |
|---|---|
| `ath_token_count` | Deploys that reached $2M ATH — the runners |
| `total_deploys` | **Every** token shipped — the rate's denominator |

Measuring hits against `ath_tokens` alone would always return 100%, since a token
only enters that table by clearing $2M. The failures are the entire point of a
rate.

### Where dev data comes from

GMGN resolves a token's creator and that dev's full token list, each with its ATH
market cap and launchpad — two calls replacing a Blockscout creation-tx trace, a
paginated walk for `create2` internal transactions, and a GeckoTerminal lookup
per deploy.

Two traps worth remembering:

- **The returned list is authoritative, not the counters.** GMGN reports
  `inner_count + open_count` = 18 for a dev whose list holds 7; the 7 is what the
  site shows and what basedbot confirms.
- **`dev.creator_address` is empty when GMGN doesn't know**, and `dev.address` is
  the TOKEN's address. Reading the latter as a fallback returned a token as its
  own deployer — wrong, and indistinguishable from right. Unknown returns null
  and falls back to the chain.

### Detection

A launch is a **create/create2 internal transaction**, not a method name and not
a mint. Method names don't generalise across launchpads. Mints looked universal
but aren't: a factory creates the token without minting in the same transaction,
and the deploy transactions here carry zero token transfers.

### Known limitations

- Tokenized stocks (NVDA, SPCX) have no GMGN dev record, since they aren't
  launched coins. Those fall back to the chain, where the deployer resolves but
  means something different — see the note in §13.
- A transient API failure reads as "no history", which would understate a
  denominator and overstate a rate.

---

## 13. Open items

- **The Helius account is over quota.** Every request returns HTTP 429 *"max
  usage reached"*. Pump.fun's reads fall back to the public Solana endpoint and
  are unaffected (§7), but the heavier Helius-only consumers — StonkFun mint
  detection and the enhanced-transaction readers — have no such fallback and are
  degraded until the plan is topped up. `HELIUS_RPC_URL` is also set to a
  malformed value ending in `api-key=` with no key; the code already ignores it
  in favour of `HELIUS_API_KEY`, so this is untidy rather than broken.

- **Tokenized stocks are in `ath_tokens`.** NVDA and SPCX qualify on market cap
  but are tokenized equities, not launched coins — the same category as the
  WETH/USDG exclusions. They currently produce the only alpha deployer
  (`RH_nvda_spcx_Dep`), whose "dev" is whoever deployed the stock contract rather
  than a memecoin dev. Worth excluding by the same rule.
- **Deployer resolution is not unified.** The daily scan still resolves creators
  via Blockscout while the backfill uses GMGN. Both are needed — GMGN has no
  creator for tokenized stocks — but the split is incidental rather than designed.
