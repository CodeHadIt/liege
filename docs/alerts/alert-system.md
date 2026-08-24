# Liège Alerts — How Each Chain's Alert Feed Works

Reference for the push-alert system: what is watched on each chain, how a launch
is detected, what triggers a ping, and where each feed's accuracy ends.

> **Keep this current.** Whenever a change to alert behaviour is settled and
> accepted, update this file in the same commit. It is the source of truth for
> how the feeds behave — a stale entry here is worse than no entry, because the
> limitations sections are what tell you whether an alert can be trusted.

**Last updated:** 2026-08-24 (durable seen-sets for catalog watchers)

---

There are two families of feed here, and they answer different questions:

- **§3–§8 — launch feeds.** A new pairing asset appears on a launchpad; the first
  token launched against it gets a ping. These watch *platforms*.
- **§11–§13 — alpha feeds.** Wallets and devs with a track record get watched, and
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
pools.fun, Four.meme, and anything added later — shares one definition instead of inventing its own.

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
| `ALERTS_PLATINUM_IDS` | Chat IDs receiving **every** feed. |
| `ALERTS_GOLD_IDS` | Chat IDs receiving the shared feeds only (see tiers below). |
| `ALERTS_ALLOWLIST` | Legacy single-tier list. Used only when **both** tier vars are unset, in which case everyone on it is treated as **platinum** — so behaviour is unchanged until tiers are configured. Empty → no recipients → nothing sends. |
| `ALPHA_LIBRARY_CUTOFF` | ISO timestamp. Alpha wallets added on or before it form the frozen "library" Gold sees. Unset/invalid → **Gold confluence is disabled entirely**, never treated as "everything is library". |

Legacy `STONKFUN_ALERT_CHAT_ID` / `LONG_ALERT_CHAT_ID` / `SUNRISE_ALERT_CHAT_ID`
are still honoured as a fallback allow-list when `ALERTS_ALLOWLIST` is unset.

`broadcastAlert()` isolates per-recipient failures, so one bad chat cannot block
delivery to the rest.

### Commands, and what they must never say

`/start` and `/status` both answer one question — is this chat allowed or not —
and nothing else:

| | Allowed | Not allowed |
|---|---|---|
| `/start` | "You are on the allowlist… you will now start receiving on-chain alerts" | "You cannot start using this bot unless you are on the allowlist" + their ID |
| `/status` | "You are allowed to use this bot" | "You do not have permission to use this bot" + their ID |

**No reply names a tier, a feed, or a chain.** A Gold user must not be able to
infer that other feeds exist, and a stranger should learn nothing about what the
bot does. This is why the old `/start` feed list and `/status` recipient count
were removed rather than made tier-aware — there is no wording of "here is what
you get" that does not also imply "here is what you don't".

`/start`, `/status`, `/id` and `/help` are reachable by anyone, so a stranger can
be told where they stand and can find their own ID to send on. Every other update
from a non-allow-listed chat is dropped **without a reply**.

### Tiers

Two tiers. Delivery goes through `broadcastAlert(feature, send)`, and
`recipientsFor(feature)` is the **only** path from a feed to a chat ID — a feed
cannot reach anyone without declaring which tiers may see it. Feeds must never
call `alertRecipients()`, which exists solely as the bot's interaction gate.

| Feature | Platinum | Gold |
|---|---|---|
| `launch` — all launchpad feeds (§3–§8) | ✅ | ✅ |
| `alpha.confluence.gold` — confluence over the frozen library | — | ✅ |
| `alpha.confluence.platinum` — confluence over **all** wallets | ✅ | — |
| `ath.daily` — the $2M ATH digest and its promotion announcement | ✅ | — |
| `deployer` — alpha deployer launches (§13) | ✅ | — |
| `alpha.solana` — Solana alpha wallet deploys and buys (§11b) | ✅ | — |

The two `alpha.confluence.*` features are deliberately **disjoint**: each tier
gets its own evaluation of the state machine (§11), so routing both to Platinum
would double-report the same token.

An ID appearing in both tier vars resolves to **platinum**, so a config mistake
cannot silently demote the owner. An unrecognised feature id logs an error and
sends to nobody — the failure mode is silence, not a leak.

### Durable seen-sets

A catalog watcher (new stock, new quote asset) alerts on anything not in its
seen-set, and seeds that set silently on its first pass so a redeploy does not
replay the whole catalog.

Holding that set **in memory** made the seed run again on every restart, which
silently absorbed anything listed while the process was down. Because these
watchers only ever alert on the transition to "unseen", a swallowed listing can
never be announced later — it is lost, not delayed. It also never gets a launch
watch opened, so launches against it go unreported too.

The set now lives in `feed_seen` (`(feed, key)`), so a restart resumes.

| Feed | Key |
|---|---|
| `long.rh.stocks` | stock contract |
| `flap.rh.quotes` | quote address |
| `bsc.quotes` | quote address |
| `pumpfun.quotes` | quote mint |
| `sunrise.pairs` | pair address |
| `stonkfun.quotes` | quote mint |

`firstRun` is measured on the **stored** set alone, before the in-memory union: a
restarted process has a populated memory and an empty store only on a genuine
first run, and conflating the two would re-seed and reintroduce the bug.

**When the store is unreachable** (missing table, transient error) the watcher
falls back to the in-memory set — the old behaviour, which still alerts — and
writes nothing, so the store stays authoritative and resumes when reachable.
Going silent was the first design and it was wrong: a watcher that stops
reporting because a table is missing turns a deployment-ordering problem into
missed listings, which is the failure this exists to prevent.

Separate from `feed_cursors`: a cursor answers "how far through an ordered stream
am I", which suits a feed with a timestamp or block height. A catalog has no
ordering, so the question is membership, not position.

**Not covered.** Block-cursor watchers (`pools.fun`, Long's on-chain
`Initialize`, BNB bonding curves) hold their last-scanned block in memory and
re-baseline to `latest` on restart, so they skip the gap rather than replaying
it. Same shape of loss, different fix — not addressed here.

### Scheduling

All pollers are registered in
[`src/instrumentation.ts`](../../src/instrumentation.ts), gated on
`NEXT_RUNTIME === "nodejs"`. That guard is load-bearing: the alert modules pull
in the Telegram bot, which transitively imports `playwright-core`, which cannot
be bundled for the Edge runtime.

| Poller | Interval |
|---|---|
| StonkFun quote tokens | 60s |
| StonkFun launches (windowed + pinned) | 30s |
| Pump.fun quote assets | 60s |
| Pump.fun launch window | 60s |
| Sunrise stock pairs | 60s |
| Robinhood registry stocks | 60s |
| Robinhood on-chain first token | 30s |
| Flap Robinhood-chain quotes | 120s |
| BNB Chain stock quotes | 120s |
| BNB Chain on-chain launches | 20s |
| pools.fun quote assets | 60s |
| pools.fun launches | 30s |

Catalog polls are slow (assets are added on the order of days); launch watchers
are fast, and short-circuit entirely while nothing is being watched.

### Buy links

Solana alerts carry a **🪐 Buy on Jup** link in the footer:

```
https://jup.ag/?sell=<USDC mint>&buy=<token mint>
```

The sell side is pinned to **USDC** (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`)
rather than SOL, so the amount someone types on Jupiter is the amount they are
risking in dollars.

`jupiterBuyUrl()` in [`utils/format.ts`](../../src/lib/telegram/utils/format.ts)
returns **null** for a missing or malformed mint, and callers omit the link
rather than emitting one that opens Jupiter on a broken pair. It also refuses
USDC itself, since buying USDC with USDC is not a trade.

Present on: StonkFun windowed launches, pinned launches, the every-launch feed,
Airdrop Mode, and the new-quote-token alert. The quote alert links the **pairing
asset**, since buying that ahead of the launches priced against it is the reason
to act on that alert.

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
| Cursor | `feed_cursors` row `stonkfun.launches` ([`api/feed-cursors.ts`](../../src/lib/api/feed-cursors.ts)) |
| Quote catalog | `GET https://www.stonkfun.xyz/api/quote-tokens` (public JSON) |
| Launch detection | `GET /api/public/v1/launches` — StonkFun's own ledger, quote mint included, `since` + pagination |
| Deployer | `5CEbueQnq1Ym2uSSx2xXds3jQAqT1BDnkA59RZobSPAG` |

StonkFun is custodial: every token is minted by one deployer wallet. A genuine
launch mints **exactly 1,000,000,000** units — the deployer also does fee and
utility mints with odd amounts and no metadata, and the supply check is what
filters those out.

#### Why the `type=TOKEN_MINT` filter is not used

Asking Helius for `type=TOKEN_MINT` directly is the obvious implementation and it
was the original one. It is wrong: Helius answers that filter with **HTTP 404**
and `{"error":"Failed to find events within the search period"}` whenever it
cannot fill the requested count inside its scan window — which for this deployer
is most of the time, since mints are sparse against a constant stream of
transfers and swaps. Paired with a `!res.ok → []` guard, an ordinary 404 was
indistinguishable from "nothing launched", so **the feed went quiet at random**.
Observed directly: one call 404'd while the very next unfiltered call showed a
real mint.

The fetch is now unfiltered (always 200) and filtered in code. The trade-off is
lookback depth — at a measured **10.4 tx/min** for this deployer, 100
transactions covers about **10 minutes**, where the type filter reached back
hours. That is still ~20× headroom for a 30s poll, and `MAX_ALERT_AGE_SECONDS`
(15 min) means older launches wouldn't be alerted on anyway; but an outage longer
than ~10 minutes now drops a launch rather than catching up.

Note that **zero creations is usually the correct answer**, not a failure:
genuine launches are sparse — one in the last 1,200 transactions when this was
measured — while the deployer mints `amount=1` utility tokens constantly.

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

### Pinned quotes — every launch against a watched asset

A pinned quote is reported in full: **every** coin launched against it, no
category filter, no 36h window, no launch cap.

| Asset | Mint | Pinned | Removed |
|---|---|---|---|
| **TTWO** (Take-Two Interactive) | `TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo` | 2026-08-21 | — |
| RAY (Raydium) | `4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R` | 2026-08-13 | 2026-08-14 |

Pinning or unpinning is one `[mint, label]` entry in `PINNED_QUOTE_MINTS`
([`stonkfun-alerts.ts`](../../src/lib/telegram/stonkfun-alerts.ts)); nothing else
refers to that map.

**Expected volume for TTWO: ~5.4 launches/day**, measured over the 13 days since
GTA6 opened the pairing, peaking at 22 on day one. This is a busy pin.

#### A pin is genuinely unrestricted

Three separate mechanisms could each have capped a pin, and all three are now
explicitly taught not to:

| # | Mechanism | Fix |
|---|---|---|
| 1 | A 36h window opening on the pinned quote | `startQuoteWatch` returns early for a pinned mint |
| 2 | The windowed branch taking precedence | pinned is read **before** the window in the poll loop |
| 3 | `MAX_ALERTS_PER_PASS` (25) | pinned launches are exempt, and the loop `continue`s instead of `break`ing |

Number 1 never came up for RAY, which was `custom` and therefore excluded by the
category denylist. **TTWO is `backpack`, which is not denied**, so a window could
genuinely have opened over it.

Number 3 is the subtle one: that cap is a flood guard for catching up after
downtime and it *drops* what it skips — the cursor advances past the whole pass
regardless. It also used to `break`, so a burst of windowed launches would
swallow any pinned launches sitting behind them in the same batch.

Verified by simulation against the shipped decision logic: 60 pinned launches all
alert with the window cap already exceeded, and 5 pinned launches all get through
behind 40 windowed ones while the windowed set stays correctly capped at 25.

#### Detection uses StonkFun's own launches feed, NOT the mint detector

`GET /api/launches` returns the last 100 launches — measured at **~12 hours of
coverage, roughly 8 launches an hour** — and names `quoteMint` and `quoteSymbol`
**in the same record as the token**. No pool lookup, no deepest-pool inference,
no ambiguity.

This is not a convenience. **The `TOKEN_MINT` detector cannot see these launches
at all.** A token launched against a quote like RAY produces no `TOKEN_MINT`
transaction from the deployer: the supply arrives as Raydium **SWAP** legs (a
900M and a 100M),
with only a small transfer back to the deployer. `$713`
(`FELbdqrBvrhRA7214SiGCktyoAeH2nZEnwnQFDH8uYW9`) is **absent from 2,200 deployer
transactions covering its entire lifetime**, yet sits in `/api/launches` with
`quoteMint` = RAY.

The first implementation of this feature was built on the mint detector plus
pair-matching, and would have been silently blind to exactly the launches it was
asked to report — it was only caught because the reported example mints were
checked against the real pipeline rather than assumed to work.

Behaviour: seeds silently on first pass (the feed spans ~12h; replaying that into
the channel on restart would be worse than missing one), skips launches older
than 1 hour, numbers launches "since tracking began", and reports newest-last so
the count reads in launch order.

This detection path is now shared with the main feed, which was migrated onto
`/api/launches` for the same reason — see below.

### Launch detection — StonkFun's own launches feed

`GET /api/launches` returns the last 100 launches and names **`quoteMint` and
`quoteSymbol` in the same record as the token**. The pairing is therefore exact
and atomic — the same property the BNB Chain watchers get from a bonding-curve
event — with no pool lookup, no retry queue and no ordering constraints.

#### The detector this replaced had gone silently dead

The original design read the deployer's `TOKEN_MINT` transactions and inferred
the pair from the token's deepest indexed pool. **StonkFun moved its launch
mechanism to Raydium SWAP legs**, so the 1B-supply `TOKEN_MINT` signature it
keyed on stopped occurring.

Measured before the migration:

| | |
|---|---|
| Real launches in a 3-hour window (`/api/launches`) | **23** |
| Of those the `TOKEN_MINT` detector would have caught | **0** |
| Qualifying `TOKEN_MINT`s in 1,000 deployer transactions | **0** |

Missed launches included `SPYX`, `QQQX`, `MSFTX` and `GMEX` — tokenized stock
quotes, exactly what this feed exists to report. The poller still ran, still
logged, and never found anything: **no error, no alert, no signal.**

It was found only because a report about a *different* feature (the pinned RAY
quote) was checked against real example mints rather than assumed to work.

#### What went with it

The pending queue, `MAX_RESOLVE_ATTEMPTS`, and the ordering stall that halted a
pass on the first unresolved creation all existed solely because the quote was
unknown at mint time. With the quote supplied up front, all of it is gone.

Market stats and socials are still fetched per matching launch, but they are
strictly best-effort: pairing, name, symbol and mint come from the feed, so a
token too new to be indexed is reported rather than delayed.

#### Both watch kinds share one fetch

Windowed quotes (a newly-added pairing asset, capped and time-limited) and
pinned quotes are served from a single `/api/launches` read per pass. A quote
cannot be both — pinned assets are `custom`, which the denylist keeps out of the
windowed set — and the windowed path is checked first regardless, so a future
overlap would produce one alert rather than two.

### Airdrop Mode — CLOSED, code retained

**This watcher is not scheduled and sends nothing.** It was a 24h watch, the
window is over, and it was closed on 2026-08-19.

It is unscheduled in [`instrumentation.ts`](../../src/instrumentation.ts) rather
than left to its own expiry check: at the moment it was closed the deadline had
not yet passed, so relying on the timestamp would have kept it pinging. Not
scheduling it is the only state that cannot ping.

To reopen: schedule `pollStonkFunAirdropLaunches` on a 30s interval **and** set
`STONKFUN_AIRDROP_WATCH_UNTIL` to a future ISO timestamp — its internal guard
will otherwise refuse to alert past the old deadline. Nothing else needs
changing.

The rest of this section describes how it works, for whoever reopens it.

| | |
|---|---|
| Code | [`stonkfun-airdrop-alerts.ts`](../../src/lib/telegram/stonkfun-airdrop-alerts.ts) |
| Detection | `GET /api/launches` (**internal**) — `airdropBps` inline |
| Poll | 30s (when scheduled) |
| Feature | `launch` (all tiers) |
| Expiry | `STONKFUN_AIRDROP_WATCH_UNTIL`, default `2026-08-19T14:00:00Z` (elapsed) |

Airdrop Mode holds a share of supply **out of the pool** and distributes it to
holders of the quote token being paired against — reward-mode launches only,
capped at 50% of supply, recipient set snapshotted and frozen at quote time.

It runs as its own pass rather than a filter inside the launch watcher, because
it answers a different question. The launch watcher asks *"was this launched
against an asset we are watching"*; here the launch **option** is the signal,
whatever it paired against.

**Detection must use the internal feed.** The public ledger exposes no airdrop
flag and no airdrop filter, so the only alternative is one
`/tokens/{mint}/airdrop` request per launch — establishing the feature's start
date cost 1,593 of them. The internal feed carries `airdropBps` on every record,
which makes this one request per pass. Recipient count and source come from the
per-token endpoint as best-effort enrichment that can never delay an alert.

**The watcher expires at a fixed timestamp**, not "24h from process start" — the
latter would silently extend the window on every redeploy, so a watch meant to
end tonight could still be running next week. Past the deadline the poller
no-ops. That guard is a backstop, not the off switch: the off switch is not
scheduling it.

Feature history: the first airdrop launch was **2026-08-17T20:34:48Z**,
established by probing all 1,593 launches between 2026-08-12 and that timestamp
individually — every one returned `airdrop: null`.

### Resuming after downtime — the durable cursor

The watcher keeps its position in `feed_cursors` under `stonkfun.launches`, and
resumes with `?since=<cursor>`.

This replaced a silent data-loss bug, which was the real cost of the old design
— **not** the 100-record window. Position lived in a module-level flag, so every
restart re-seeded from the live feed and returned without alerting: anything
launched during the downtime was absorbed into the seed set and never reported.
That was paid on each redeploy, not merely during rare outages, and it produced
no error to notice.

| | |
|---|---|
| No cursor (first ever run) | Seed one page silently — the backlog is history, not news |
| Cursor present | Fetch everything since it, oldest-first, and report it |
| Fetch failure | Hold the cursor; never advance over launches never seen |

Bounds on a resumed pass: launches older than **6h** are skipped as history, and
at most **25** alerts are sent per pass, so a long outage cannot dump a day of
backlog into the channel. The cursor advances past everything the pass *saw* —
including launches skipped as stale, unwatched or over a cap — so a restart
cannot reconsider them.

`setFeedCursor` only ever moves forward, so a late page or two instances racing
cannot rewind the feed into a replay. A missing `feed_cursors` table degrades to
the old behaviour (silent seed) rather than throwing.

### Why the public API, not the internal one

Detection reads `/api/public/v1/launches`, not the internal `/api/launches`.
Both are served from the same ledger — compared over an 18.9h overlap they
agreed on **all 100 records, in both directions** — but only the public one
supports `since` and real pagination, which is what makes the cursor possible.

The internal feed's 100-record cap was never the practical constraint: measured
at **5.3 launches/hour**, it covers ~18.9h, which is **~2,274x** headroom at a
30s poll.

Quirk worth knowing: an out-of-range `page` serves page 1 again rather than an
empty list, so the fetcher stops when a page adds no new mints instead of
trusting the page number alone.

### Known limitations

- **The ledger omits some launches.** `B8Pejdbb…` has a live platform pool yet is
  absent from all 3,695 records; the two pre-launch test tokens (`BUhtmXJt…`,
  `Ahtv2MSt…`) are absent too. Anything the ledger drops is invisible to this
  feed, and the public API does not fix that — it is the same ledger.
  **Scope unmeasured:** all three known omissions are from 2026-07-23, the
  platform's first day, which is consistent with only early/test launches having
  been dropped. Whether omissions continue today has not been checked; doing so
  needs the deployer's mint history swept against the ledger.
- The 6h catch-up bound means an outage longer than that still loses the launches
  before it — deliberately, since a day-old launch is not news.
- `pollStonkFunCreations` (the paused every-launch feed) is **not merely paused,
  it is non-functional** — it reads the same dead `TOKEN_MINT` path. Reviving it
  means rebuilding it on `fetchStonkFunLaunches`.

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

### Pinned stocks — permanent, uncapped watches

`PINNED_RH_STOCKS` in [`long-alerts.ts`](../../src/lib/telegram/long-alerts.ts)
holds stocks watched permanently rather than for the usual 36h.

| Asset | Address | Pinned |
|---|---|---|
| **HOODon** (Ondo's tokenized Robinhood stock, on Flap) | `0xfb5b5778d45ae47f15323fb59b666c655174a79c` | 2026-08-24 |

A pin is re-asserted on **every pass**, not just at startup, and it neither
expires nor caps. That is the point: a normal watch is opened only at the moment
a stock is first seen as new, so it can only ever be opened once — and if that
moment is missed, it is missed permanently.

**HOODon is why this exists.** It was in the catalog, on the right chain, `rwa`
and `available` — it passed every filter. What swallowed it was the seed: the
seen-set is in-memory, so each redeploy re-seeds it silently, and a stock that
appears while the process is restarting is absorbed with no alert **and no watch
opened**, so launches against it go unreported too. Twelve deploys landed between
2026-08-17 and 2026-08-21.

> HOODon's pin fixes one asset. The class is fixed separately — see
> §2 "Durable seen-sets".

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

### Launch detection — on-chain, by quote

Launches are found with a **memcmp query against `BondingCurve.quote_mint`**,
not by scanning pump.fun's recent-creations feed.

| | |
|---|---|
| Method | `getProgramAccountsV2` (plain `getProgramAccounts` is refused — the program has ~10M accounts) |
| Filters | `dataSize: 115` + `memcmp` at offset **83** = the quote mint |
| Curve → mint | `getTokenAccountsByOwner(curve)` — BondingCurve has no mint field and its PDA is one-way, so the link comes from the token account the curve holds |

The first implementation scanned `frontend-api-v3.pump.fun/coins` and filtered
client-side. **That endpoint sits behind a WAF and started returning 403 to this
machine after a burst of requests — a block that persisted across headers and
retries.** A feed whose entire job is to not miss a launch cannot have its only
detection path behind something that can lock us out silently, so detection moved
to the chain and the HTTP feed was demoted to optional enrichment.

The on-chain query is also better on the property that matters. It returns
**every** curve for a quote, including ones created before we noticed the quote
existed, where the HTTP feed could only ever show a rolling window of recent
creations. There is no detection gap to reason about.

That is also why keying off the watched quotes is *complete* rather than a
dependency — the earlier concern that motivated filtering on the quote instead of
a watchlist. The pump program **enforces** the whitelist, so a coin's quote is
necessarily one of the whitelisted mints; enumerating the non-baseline ones
therefore covers every launch that could interest us, by construction.

With no window open, the pass makes **no request at all**.

### Naming a launched coin

Metadata comes from **Helius DAS (`getAsset`)**, not Metaplex. Pump.fun mints
under **Token-2022 and stores metadata in the mint's own metadata extension**, so
a Metaplex metadata account does not exist — reading Metaplex first returned
nothing for every pump coin tested, and alerts rendered with a truncated mint
where the name should be. DAS resolves both schemes and supplies the image too.

Enrichment from the frontend API (market cap, socials, creation time) is strictly
optional and every alert degrades cleanly without it: when it is unavailable the
age line is omitted rather than faked, and name, symbol, image, dev and the
pairing all still come from the chain.

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

Same order as above — DAS, then Metaplex, then Jupiter as a last resort. Reading
the chain before an indexer is deliberate: a stock quote is interesting on the
day it lists, which is exactly when a third-party token list is least likely to
know about it.

### Known limitations

- **Window state is in-memory.** A redeploy mid-window loses the open watch and
  the launch cursor. Same as every other platform here; noted rather than fixed.
- **No stock quote has ever been listed**, so the launch half of this feed has
  been verified against USDC-quoted coins — 158 real bonding curves enumerated,
  resolved to mints and rendered as alerts — and against a fixture using the real
  NVIDIA xStock mint. Not against a live listing.
- **Creation time depends on the frontend API**, which is currently blocked from
  at least one of our egress addresses. When it is unavailable the alert omits
  the age line, and launch ordering within a batch falls back to enumeration
  order rather than true launch order.

---

## 8. Robinhood Chain — pools.fun

SushiSwap's launchpad on Robinhood Chain. **Not pools.trade**, which is a
different platform on the same chain.

| | |
|---|---|
| Code | [`poolsfun-alerts.ts`](../../src/lib/telegram/poolsfun-alerts.ts), [`api/pools-fun.ts`](../../src/lib/api/pools-fun.ts) |
| Factory | `PartyFactory` `0x626c3d09b65bf5d1d40e0d5f25e19fa49783b3d4` (verified) |
| Deployed | 2026-08-11 09:55:56 UTC, block 33,570,152 |
| Quote catalog | `PairedAssetCurveSet` / `PairedAssetCurveRemoved` events |
| Launch detection | `TokenLaunched` event |

pools.fun has no public API and no UI listing launches, so everything is read
from the chain. That is the ideal case rather than a limitation here, because
the factory is verified and its events carry exactly what both stages need.

### Why this is the strongest feed of the set

```
TokenLaunched(address indexed token, address indexed pool, address pairedAsset,
              address indexed creator, address deployer, address feeRecipient,
              int24 startTick, string metadataUri, uint256 devBuyAmountOut)
```

The token **and** its paired asset arrive together, atomically, in the launch
transaction. Compare:

- **StonkFun** (§3) — the pair only resolves once an indexer catches up to a pool
  created in a *later* transaction, needing a retry queue and strict ordering.
- **Pump.fun** (§7) — detection had to move on-chain after the HTTP feed blocked
  us.
- **pools.fun** — one `getLogs`, no indexer, no HTTP dependency, no inference.

`pairedAsset` is the first non-indexed word of the event data; token, pool and
creator come from the indexed topics.

### Baseline assets

The factory shipped with exactly two pairing currencies, both set in its
deployment block, and has added none since:

| Asset | Address | Launches (first 28h) |
|---|---|---|
| WETH | `0x0bd7d308f8e1639fab988df18a8011f41eacad73` | 731 |
| USDG (Global Dollar) | `0x5fc5360d0400a0fd4f2af552add042d716f1d168` | 27 |

Both are suppressed by name — they are the platform's base currencies, not
listings. **A stock quote would be a third asset**, added via
`setPairedAssetCurve` by the factory owner
(`0xd86ec279ad4871483f6c3d7ce54ad00067f120e9`). That is the event this feed
exists for, and it has not happened yet.

Classification is a denylist for the same reason as everywhere else: the event
carries no category, and an allowlist of expected stock symbols would silently
swallow the first listing that didn't match it.

### The two-cursor gap, and the backfill that closes it

The catalog and launch pollers keep independent cursors, so by the time a listing
is noticed the launch cursor may already have advanced past the block that
listed it — and the inaugural launch, the most interesting one, would fall in
that gap. When a window opens, the listing's own block is recorded as a pending
backfill and the next launch pass reaches back to it.

`setPairedAssetCurve` followed by a removal inside one scan range is also
handled: `allowedPairedAsset` is checked before announcing, so a window is never
opened for an asset that no longer stands.

### Hostile token names

Names and symbols are chosen by whoever launches the token, and a real pools.fun
launch was observed with a **newline inside its name**. `escapeHtml` stops tags
but not layout — a name containing `\n📊 Market Cap: $10M` would render as its
own line and read as a field the bot produced. All token-supplied strings are
whitespace-collapsed and length-capped before formatting.

### Volume, and why the launch watcher short-circuits

The factory averaged **648 launches/day in its first 28 hours** (a launch-day
rush), settling to **247 in the following 24h** — essentially all against WETH.
Scanning that unconditionally would be pointless work, so the launch pass makes
no request at all while no non-baseline asset is watched, which is the normal
state. `MAX_LAUNCHES_PER_WINDOW` (25) bounds a busy window.

### Known limitations

- **Windows are in-memory**, as everywhere else — a redeploy mid-window loses it.
- **`MAX_BLOCK_SPAN` is 200,000 blocks** (~5.5h at this chain's ~0.1s blocks).
  An outage longer than that skips the gap rather than replaying it, so a listing
  during a long outage would be missed entirely.
- Market stats are best-effort: a token seconds old is usually not indexed yet,
  and the alert is sent without price/liquidity/market cap rather than delayed.

---

## 9. Rate limits

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

## 10. Verification scripts

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

## 11. Robinhood Chain — alpha wallet confluence

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

### Tiering — two evaluations, one per audience

Gold and Platinum each get their **own run** of the confluence state machine,
because the alert fires on the *Nth distinct wallet* and the tiers count
different wallets:

| Audience | Counts | Delivered to |
|---|---|---|
| `platinum` | Every active alpha wallet | Platinum only |
| `gold` | Only wallets with `added_at <= ALPHA_LIBRARY_CUTOFF` | Gold only |

A window therefore belongs to an audience: `alpha_confluence.audience`, with the
uniqueness key `(chain, audience, token_address, first_buy_at)`. The same token
can hold one open episode per audience, with its own ordinals and its own
"since first ping" baseline.

A buy by a wallet the audience cannot see does not open a window, advance a
count, or occupy an ordinal — it is filtered both at entry and when the window's
buys are replayed. Without that, Gold could be told "wallet #3" having never been
shown #1 and #2.

**The message body is identical for both tiers** — labels, addresses, buy
amounts, all of it. The gate decides *which wallets can trigger an alert*, never
how much an alert says. A redacted Gold variant was considered and rejected: two
templates means a future edit can leak Platinum data into the Gold one.

Gold is skipped entirely unless it has both subscribers and a valid cutoff, so
the failure mode of a missing `ALPHA_LIBRARY_CUTOFF` is that Gold receives
nothing — not that it receives the newest wallets.

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

## 11b. Solana — alpha wallet watcher

| | |
|---|---|
| Code | [`solana-alpha-alerts.ts`](../../src/lib/telegram/solana-alpha-alerts.ts) |
| Wallets | `alpha_wallets` where `chain = 'solana'` |
| Watched | `CyberLeeks` (deployer), `CyberLeeks-Funder` (its funding collector) |
| Added by | [`scripts/add-alpha-wallet.ts`](../../scripts/add-alpha-wallet.ts) |
| Poll | 30s |
| Feature | `alpha.solana` — **Platinum only** |

Watches hand-picked Solana wallets and reports seven kinds of event:

| Kind | Trigger |
|---|---|
| `deploy` | wallet mints a token |
| `liquidity` | wrapped SOL **and** a token leave together — a pool being seeded |
| `buy` | token in, value out |
| `sell` | token out, value in |
| `burn` | supply destroyed |
| `sent` | token out, nothing back |
| `received` | token in, nothing paid — **spam-gated** |

Order matters in classification: a pool seed also looks like a send, and a sale
also looks like a send, so the specific readings are tested first.

**This is not the Robinhood confluence model** (§11). That one stays silent until
a second alpha wallet buys the same token, which is correct at 88 wallets and
useless at one — it would never fire.

### Two things that make or break it

**Spam is gated on the token being real, not on the transfer.** Only `received`
— tokens arriving for nothing — has to prove itself, by having at least **$5k of
pool liquidity**. Everything the wallet paid for, deployed, seeded, sold or burnt
is reported regardless of depth, because the wallet's own money or supply makes
it intentional.

A trade additionally needs `>= 0.05 SOL` (or $10 stablecoin) to move, so a free
transfer is never read as a buy. These wallets are dusted constantly — the first
watched wallet received two unsolicited `…pump` tokens in three days, each with
zero SOL paid.

**Transfers are read, not Helius's `type`.** That field reports `UNKNOWN` or
`TRANSFER` for most pump.fun and Raydium activity — 16 of the last 20
transactions on the first wallet were `UNKNOWN` — so keying on `type === "SWAP"`
would miss nearly everything.

Deploys are reported regardless of spend: minting costs almost nothing in SOL and
is the highest-value event here.

## 12. Robinhood Chain — daily ATH scan

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

### Promotion criteria

A wallet is promoted to alpha only when **both** hold:

| | |
|---|---|
| Distinct $2M runners it was a top-30 trader on | **2 or more** |
| Combined realised PnL across those runners | **≥ $20,000** (`MIN_COMBINED_PNL_USD`) |

The PnL floor was added after the fact and is the more important of the two.
Two top-30 appearances are easy to reach with tiny size: the list had filled with
wallets whose two appearances together made a few hundred dollars — one pair of
tokens accounted for most of them — which says nothing about skill or conviction.
Applying the bar retroactively removed **40 of 108** wallets.

It is enforced on **every** write path (the daily scan's promotion and
`scripts/seed-alpha-wallets.ts`) and checked *before* both the upsert and the
ping, so a wallet under the bar is never stored and never announced.
`scripts/prune-alpha-wallets.ts` applies it to existing rows; it deletes rather
than deactivates, and holds back any row with a NULL PnL rather than guessing.

### Already-recorded tokens are never re-reported

A token already in `ath_tokens` is skipped outright — no re-ping, no re-capture,
no upsert — checked before its price history is resolved.

This was a bug worth recording. The guard used to read
`athAt < cutoff && known.has(token)`, which never decided anything: the plain
`athAt < cutoff` check beside it already skipped everything older than the
window. So a token recorded yesterday whose peak was **still inside** the rolling
24h window passed straight through and was re-processed and re-announced the
following night. HMM and STONKBROKER both went out twice that way.

## 13. Robinhood Chain — alpha deployer alerts

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
  means something different — see the note in §14.
- A transient API failure reads as "no history", which would understate a
  denominator and overstate a rate.

---

## 14. Open items

- **Tokenized stocks are in `ath_tokens`.** NVDA and SPCX qualify on market cap
  but are tokenized equities, not launched coins — the same category as the
  WETH/USDG exclusions. They currently produce the only alpha deployer
  (`RH_nvda_spcx_Dep`), whose "dev" is whoever deployed the stock contract rather
  than a memecoin dev. Worth excluding by the same rule.
- **Deployer resolution is not unified.** The daily scan still resolves creators
  via Blockscout while the backfill uses GMGN. Both are needed — GMGN has no
  creator for tokenized stocks — but the split is incidental rather than designed.
