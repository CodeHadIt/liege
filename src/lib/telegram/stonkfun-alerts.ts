import {
  fetchRecentCreations,
  enrichCreation,
  fetchQuoteTokens,
  fetchStonkFunLaunches,
  type StonkFunLaunch,
  STONKFUN_DEPLOYER,
  STONKFUN_BASE,
  type StonkFunCreation,
  type StonkFunTokenDetails,
  type QuoteToken,
} from "@/lib/api/stonkfun";
import { getAlertsBot, broadcastAlert, FEATURE } from "./alerts-bot";
import { getFeedCursor, setFeedCursor } from "@/lib/api/feed-cursors";
import {
  LAUNCH_WINDOW_MS,
  LAUNCH_WINDOW_LABEL,
  MAX_LAUNCHES_PER_WINDOW,
  ordinal,
} from "./launch-window";
import { escapeHtml, formatCompact, formatPrice, formatTimeAgo, jupiterBuyUrl } from "./utils/format";
import { FEED, resolveSeen, markSeen } from "@/lib/api/feed-seen";

// StonkFun runs on Solana; every alert here is labelled with that so the feed
// reads consistently next to the multi-chain launchpads (Flap in particular
// ships the same stock on both BNB Chain and Robinhood Chain).
const CHAIN_LABEL = "Solana";

// In-memory dedupe of mints we've already processed. Seeded on first poll so we
// only consider tokens created AFTER the system comes online (not the backlog).
const seen = new Set<string>();
let seeded = false;

// Never alert on a launch older than this, even if it somehow escapes dedupe
// (e.g. after a container restart re-seeds). Keeps pings to genuinely new tokens.
const MAX_ALERT_AGE_SECONDS = 15 * 60;

function solscanToken(mint: string): string {
  return `https://solscan.io/token/${mint}`;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatStonkFunAlert(d: StonkFunTokenDetails): string {
  const lines: string[] = [];

  lines.push(`🚀 <b>New StonkFun Launch</b>`);
  lines.push(`<b>${escapeHtml(d.name)}</b>  ·  <code>$${escapeHtml(d.symbol)}</code>`);
  lines.push("");

  // Pairing — the headline feature of StonkFun
  if (d.pairedSymbol) {
    const dex = d.dex ? `  ·  🏦 ${escapeHtml(titleCase(d.dex))}` : "";
    lines.push(`🔗 <b>$${escapeHtml(d.symbol)}</b> ⇄ <b>$${escapeHtml(d.pairedSymbol)}</b>${dex}`);
  } else {
    lines.push(`🔗 Pair: <i>indexing…</i>`);
  }
  lines.push("");

  // Market stats — one clean line each
  if (d.priceUsd     != null) lines.push(`💵 Price:  <b>${escapeHtml(formatPrice(d.priceUsd))}</b>`);
  if (d.liquidityUsd != null) lines.push(`💧 Liquidity:  <b>$${escapeHtml(formatCompact(d.liquidityUsd))}</b>`);
  if (d.marketCap    != null) lines.push(`📊 Market Cap:  <b>$${escapeHtml(formatCompact(d.marketCap))}</b>`);

  // Socials
  const socials: string[] = [];
  if (d.website)  socials.push(`🌐 <a href="${escapeHtml(d.website)}">Website</a>`);
  if (d.twitter)  socials.push(`𝕏 <a href="${escapeHtml(d.twitter)}">Twitter</a>`);
  if (d.telegram) socials.push(`✈️ <a href="${escapeHtml(d.telegram)}">Telegram</a>`);
  if (socials.length) {
    lines.push("");
    lines.push(socials.join("     "));
  }

  // Footer — contract + quick links
  lines.push("");
  lines.push(`<code>${escapeHtml(d.mint)}</code>`);
  const footer: string[] = [`🕐 ${escapeHtml(formatTimeAgo(d.timestamp))}`, `🔍 <a href="${solscanToken(d.mint)}">Solscan</a>`];
  if (d.pairUrl) footer.push(`📈 <a href="${escapeHtml(d.pairUrl)}">Chart</a>`);
  const jupA = jupiterBuyUrl(d.mint);
  if (jupA) footer.push(`🪐 <a href="${jupA}">Buy on Jup</a>`);
  lines.push(footer.join("  ·  "));
  // Custodial launchpad — the on-chain minter is always the platform deployer.
  lines.push(`👤 Minted by StonkFun (<code>${STONKFUN_DEPLOYER.slice(0, 4)}…${STONKFUN_DEPLOYER.slice(-4)}</code>)`);

  return lines.join("\n");
}

async function sendAlert(chatId: string, details: StonkFunTokenDetails): Promise<void> {
  const bot = await getAlertsBot();
  const text = formatStonkFunAlert(details);
  if (details.imageUrl) {
    await bot.api
      .sendPhoto(chatId, details.imageUrl, { caption: text, parse_mode: "HTML" })
      .catch(async () => {
        // Image URL may be unreachable — fall back to a text message
        await bot.api.sendMessage(chatId, text, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
      });
  } else {
    await bot.api.sendMessage(chatId, text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  }
}

/**
 * PAUSED, and no longer functional as written.
 *
 * It was paused because alerting on every launch was too noisy. It would now
 * also report nothing at all: it reads fetchRecentCreations, which detects the
 * 1B-supply TOKEN_MINT signature that StonkFun has stopped producing (see the
 * launch-watcher notes below). Reviving the every-launch feed means rebuilding
 * it on fetchStonkFunLaunches, not just re-scheduling this function.
 *
 * The feed now follows the same shape as the Robinhood Chain and BNB Chain
 * watchers: ping when a new pairing asset is ADDED, then ping the FIRST token
 * launched against it (see pollStonkFunFirstTokens). This function and
 * formatStonkFunAlert are kept so the every-launch feed can be switched back on
 * by re-scheduling it in instrumentation.ts — nothing else references it.
 */
export async function pollStonkFunCreations(): Promise<void> {
  const creations = await fetchRecentCreations(25);
  if (creations.length === 0) return;

  if (!seeded) {
    for (const c of creations) seen.add(c.mint);
    seeded = true;
    console.log(`[stonkfun] seeded ${seen.size} existing creations (no alert on backlog)`);
    return;
  }

  // Process new mints oldest-first so pings arrive in creation order.
  const fresh: StonkFunCreation[] = creations.filter((c) => !seen.has(c.mint)).reverse();
  if (fresh.length === 0) return;

  const nowSec = Date.now() / 1000;
  for (const c of fresh) {
    seen.add(c.mint);
    if (c.timestamp > 0 && nowSec - c.timestamp > MAX_ALERT_AGE_SECONDS) {
      console.log(`[stonkfun] skipping stale launch ${c.symbol} (${Math.round((nowSec - c.timestamp) / 60)}m old)`);
      continue;
    }
    try {
      const details = await enrichCreation(c);
      await broadcastAlert(FEATURE.LAUNCH, (chatId) => sendAlert(chatId, details));
      console.log(`[stonkfun] alerted: ${details.symbol} vs ${details.pairedSymbol ?? "?"}`);
    } catch (err) {
      console.error("[stonkfun] failed to send alert:", err);
    }
  }

  // Keep the dedupe set bounded.
  if (seen.size > 1000) {
    seen.clear();
    for (const c of creations) seen.add(c.mint);
  }
}

/**
 * Manual end-to-end test: enrich the most recent real creation and send it to a
 * chat. Used to verify the pipeline + formatting without waiting for a new mint.
 */
export async function sendStonkFunTestPing(chatId: string): Promise<boolean> {
  const creations = await fetchRecentCreations(5);
  if (creations.length === 0) return false;
  const details = await enrichCreation(creations[0]);
  await sendAlert(chatId, details);
  return true;
}


// ── Pinned quotes — every launch against a watched asset ─────────────────────
//
// A pinned quote is reported for EVERY coin launched against it: no category
// filter, no 36h window, no launch cap. Unpinning is deleting its entry below;
// nothing else refers to this map.
//
// Currently pinned:
//   TTWO — Take-Two Interactive. Requested 2026-08-21. Runs ~5.4 launches/day
//          measured over 13 days, peaking at 22 the day GTA6 opened it, so this
//          is a busy pin rather than an occasional one.
//
// A pin is UNRESTRICTED, and three separate mechanisms had to be taught that:
//
//   1. No window is opened for a pinned mint (startQuoteWatch returns early).
//      RAY was `custom`, which the denylist keeps out of the windowed set, so
//      this never came up. TTWO is `backpack`, which is not denied.
//   2. Pinned is read BEFORE the window in pollStonkFunLaunches. Reading the
//      window first handed a pinned quote to the capped, expiring branch.
//   3. Pinned launches are exempt from MAX_ALERTS_PER_PASS, and that loop
//      `continue`s rather than `break`s — a windowed burst used to swallow
//      pinned launches sitting behind it in the same batch.
//
// Any one of those left in place would silently cap a pin that is supposed to
// be uncapped, which is the one failure pinning exists to prevent.
//
// RAY (4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R) was pinned 2026-08-13 by
// request and removed 2026-08-14, having served its purpose.
//
// If this is revived: detection must NOT go through fetchRecentCreations. That
// path reconstructs launches from the deployer's TOKEN_MINT transactions, and a
// token launched against a quote like RAY produces no TOKEN_MINT at all — the
// supply arrives as Raydium SWAP legs (900M + 100M), with only a small transfer
// back to the deployer. $713 (FELbdqrBvrhRA7214SiGCktyoAeH2nZEnwnQFDH8uYW9) was
// absent from 2,200 deployer transactions covering its entire lifetime, yet sat
// in /api/launches with quoteMint = RAY. Anything built on the mint feed would
// be silently blind to exactly the launches pinning is asked for.
//
// StonkFun's own launches feed names the quote mint in the same record as the
// token, so the match is exact and needs no pool lookup or deepest-pool
// inference.

const PINNED_QUOTE_MINTS = new Map<string, string>([
  ["TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo", "TTWO (Take-Two Interactive)"],
]);

export function formatPinnedLaunchAlert(l: StonkFunLaunch, launchNumber: number): string {
  const lines: string[] = [];
  lines.push(
    `🌊 <b>New coin vs $${escapeHtml(l.quoteSymbol)} on StonkFun</b>  ·  ⛓ ${escapeHtml(CHAIN_LABEL)}`
  );
  lines.push(`<i>Launch #${launchNumber} against $${escapeHtml(l.quoteSymbol)} since tracking began.</i>`);
  lines.push("");
  lines.push(`<b>${escapeHtml(l.name)}</b>  ·  <code>$${escapeHtml(l.symbol)}</code>`);
  lines.push(
    `🔗 <b>$${escapeHtml(l.symbol)}</b> ⇄ <b>$${escapeHtml(l.quoteSymbol)}</b>` +
      (l.launchpad ? `  ·  🏦 ${escapeHtml(titleCase(l.launchpad))}` : "")
  );
  if (l.startMarketCapUsd != null) {
    lines.push(`📊 Launch MC:  <b>$${escapeHtml(formatCompact(l.startMarketCapUsd))}</b>`);
  }
  lines.push("");
  lines.push(`<code>${escapeHtml(l.mint)}</code>`);
  const footer = [`🕐 ${escapeHtml(formatTimeAgo(Date.parse(l.createdAt) || 0))}`, `🔍 <a href="${solscanToken(l.mint)}">Solscan</a>`];
  footer.push(`📈 <a href="https://dexscreener.com/solana/${escapeHtml(l.mint)}">Chart</a>`);
  const jupP = jupiterBuyUrl(l.mint);
  if (jupP) footer.push(`🪐 <a href="${jupP}">Buy on Jup</a>`);
  lines.push(footer.join("  ·  "));
  if (l.creator) lines.push(`👤 Dev: <code>${escapeHtml(l.creator)}</code>`);
  return lines.join("\n");
}

async function sendPinnedAlert(chatId: string, l: StonkFunLaunch, launchNumber: number): Promise<void> {
  const bot = await getAlertsBot();
  const text = formatPinnedLaunchAlert(l, launchNumber);
  if (l.logoUrl) {
    await bot.api
      .sendPhoto(chatId, l.logoUrl, { caption: text, parse_mode: "HTML" })
      .catch(async () => {
        await bot.api.sendMessage(chatId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      });
  } else {
    await bot.api.sendMessage(chatId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  }
}

/** Running count per pinned quote, for the "#N since tracking began" line. */
const pinnedCounts = new Map<string, number>();

/**
 * Manual test: render the most recent pinned-quote launch. Returns false while
 * PINNED_QUOTE_MINTS is empty, since no launch can match.
 */
export async function sendPinnedQuoteTestPing(chatId: string): Promise<boolean> {
  const launches = await fetchStonkFunLaunches();
  if (!launches) return false;
  const hit = launches.find((l) => PINNED_QUOTE_MINTS.has(l.quoteMint));
  if (!hit) return false;
  await sendPinnedAlert(chatId, hit, 1);
  return true;
}

// ── Quote-token monitoring ────────────────────────────────────────────────────
// StonkFun's /launch page lets creators pick a "quote token" — the asset a new
// token is paired against. We watch that list and alert when a new one is added.

const seenQuotes = new Set<string>();

/**
 * Quote categories NOT worth alerting on.
 *
 * `custom` is any on-chain token a creator nominates as a pairing asset — a
 * memecoin paired against another memecoin. It is not the signal this feed
 * exists for, and it dominates the catalog: 140 of 185 listed quotes. Including
 * it buried the stock listings the feed was built to surface.
 *
 * Expressed as a denylist rather than an allowlist on purpose. The catalog holds
 * categories beyond the obvious ones — `leverage` and `solana` alongside
 * xstock, prestock, currency, backpack and tessera — and an allowlist would have
 * silently dropped those, and would drop any category StonkFun adds later.
 * Everything that isn't a creator-nominated token is worth knowing about.
 */
const SUPPRESSED_CATEGORIES = new Set(["custom"]);

function isAlertableQuote(category: string): boolean {
  return !SUPPRESSED_CATEGORIES.has((category ?? "").toLowerCase());
}

const CATEGORY_LABEL: Record<string, string> = {
  xstock:   "📈 Tokenized Stock",
  prestock: "🌅 Pre-Market Stock",
  currency: "💱 Currency",
  backpack: "🎒 Backpack",
  tessera:  "🧩 Tessera",
  custom:   "🪙 On-chain Asset",
};

export function formatQuoteTokenAlert(q: QuoteToken): string {
  const lines: string[] = [];
  lines.push(`✨ <b>New Quote Token on StonkFun</b>  ·  ⛓ ${escapeHtml(CHAIN_LABEL)}`);
  lines.push(`<i>You can now pair new launches against this asset.</i>`);
  lines.push("");
  lines.push(`<b>${escapeHtml(q.name || q.symbol)}</b>  ·  <code>$${escapeHtml(q.symbol)}</code>`);
  lines.push(`${escapeHtml(CATEGORY_LABEL[q.category] ?? q.category)}  ·  ⛓ ${escapeHtml(CHAIN_LABEL)}`);
  lines.push("");
  lines.push(`<code>${escapeHtml(q.quoteMint)}</code>`);
  const quoteFooter = [
    `🔍 <a href="https://solscan.io/token/${q.quoteMint}">Solscan</a>`,
    `🚀 <a href="${STONKFUN_BASE}/launch">Launch a token</a>`,
  ];
  // The pairing asset itself is buyable, and buying it ahead of the launches
  // that will be priced against it is the reason to care about this alert.
  const jupQ = jupiterBuyUrl(q.quoteMint);
  if (jupQ) quoteFooter.push(`🪐 <a href="${jupQ}">Buy on Jup</a>`);
  lines.push(quoteFooter.join("  ·  "));
  return lines.join("\n");
}

async function sendQuoteAlert(chatId: string, q: QuoteToken): Promise<void> {
  const bot = await getAlertsBot();
  const text = formatQuoteTokenAlert(q);
  if (q.logoUrl) {
    await bot.api
      .sendPhoto(chatId, q.logoUrl, { caption: text, parse_mode: "HTML" })
      .catch(async () => {
        await bot.api.sendMessage(chatId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      });
  } else {
    await bot.api.sendMessage(chatId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  }
}

/**
 * One poll cycle for quote tokens: alert when StonkFun adds a new pairing asset.
 * Seeds the existing list silently on first run.
 */
export async function pollStonkFunQuoteTokens(): Promise<void> {
  const quotes = await fetchQuoteTokens();
  if (quotes.length === 0) return;

  const state = await resolveSeen(FEED.STONKFUN_QUOTES, seenQuotes);
  // Degraded (store unreachable) falls through on the in-memory set — the old
  // behaviour, which still alerts. Silence would be the worse failure here.
  for (const k of state.seen) seenQuotes.add(k);

  if (state.firstRun) {
    const keys = quotes.map((q) => q.quoteMint);
    for (const k of keys) seenQuotes.add(k);
    await markSeen(FEED.STONKFUN_QUOTES, keys);
    console.log(`[stonkfun] seeded ${keys.length} existing quote tokens (first run — no alert on backlog)`);
    return;
  }

  const fresh = quotes.filter((q) => !seenQuotes.has(q.quoteMint));
  if (fresh.length === 0) return;

  for (const q of fresh) {
    // Recorded either way, so a later listing of the same asset isn't treated as
    // new — but only stock-like assets are announced or watched.
    seenQuotes.add(q.quoteMint);
    await markSeen(FEED.STONKFUN_QUOTES, [q.quoteMint]);
    if (!isAlertableQuote(q.category)) {
      console.log(`[stonkfun] skipping quote ${q.symbol} — category "${q.category}" is not alertable`);
      continue;
    }
    startQuoteWatch(q);
    try {
      await broadcastAlert(FEATURE.LAUNCH, (chatId) => sendQuoteAlert(chatId, q));
      console.log(`[stonkfun] alerted new quote token: ${q.symbol} (${q.category})`);
    } catch (err) {
      console.error("[stonkfun] failed to send quote-token alert:", err);
    }
  }
}

/** Manual test: send the newest existing quote token so the format can be verified. */
export async function sendQuoteTokenTestPing(chatId: string): Promise<boolean> {
  const quotes = await fetchQuoteTokens();
  if (quotes.length === 0) return false;
  await sendQuoteAlert(chatId, quotes[0]);
  return true;
}

// ── Launches against a watched quote ─────────────────────────────────────────
//
// Reads StonkFun's own launches feed, which names the quote mint in the same
// record as the token. That makes the pairing exact and atomic — the same
// property the BNB Chain watchers get from a bonding-curve event.
//
// This replaced a detector built on the deployer's TOKEN_MINT transactions plus
// deepest-pool pair inference. That approach had stopped working entirely:
// StonkFun moved its launch mechanism to Raydium SWAP legs, so the 1B-supply
// TOKEN_MINT signature it keyed on no longer occurs. Measured before the switch:
// 23 real launches in a 3-hour window, of which the detector saw ZERO, with
// zero qualifying TOKEN_MINTs in 1,000 deployer transactions. The feed had gone
// silently dead — it still ran, still logged, and never found anything.
//
// The old design also carried a pending queue, bounded resolve retries and an
// ordering stall, all of which existed only because the quote was unknown at
// mint time and arrived later from an indexer. With the quote supplied up front,
// none of that is needed and all of it is gone.

interface WatchedQuote {
  quote: QuoteToken;
  openedAt: number;
  launchCount: number;
}
const watchedQuotes = new Map<string, WatchedQuote>(); // key: quote mint


function startQuoteWatch(q: QuoteToken): void {
  if (watchedQuotes.has(q.quoteMint)) return;
  // A pinned quote is uncapped and unexpiring by definition. Opening a 36h
  // window over one would hand it to the windowed branch, which reapplies the
  // launch cap and then goes quiet when the window closes — the opposite of
  // what pinning means.
  if (PINNED_QUOTE_MINTS.has(q.quoteMint)) {
    console.log(`[stonkfun] ${q.symbol} is pinned — not opening a ${LAUNCH_WINDOW_LABEL} window`);
    return;
  }
  watchedQuotes.set(q.quoteMint, { quote: q, openedAt: Date.now(), launchCount: 0 });
  console.log(`[stonkfun] watching ${q.symbol} (${q.category}) for launches over ${LAUNCH_WINDOW_LABEL}`);
}

export function formatStonkFunLaunchAlert(
  q: QuoteToken,
  d: StonkFunTokenDetails,
  launchNumber: number
): string {
  const lines: string[] = [];
  const first = launchNumber <= 1;
  lines.push(
    `${first ? "🥇" : "🔁"} <b>${first ? "First" : ordinal(launchNumber)} token vs $${escapeHtml(q.symbol)} on StonkFun</b>` +
      `  ·  ⛓ ${escapeHtml(CHAIN_LABEL)}`
  );
  lines.push(
    first
      ? `<i>Inaugural launch paired to the newly-added quote asset.</i>`
      : `<i>Launch ${launchNumber} against this quote, inside the ${LAUNCH_WINDOW_LABEL} window.</i>`
  );
  lines.push(`${escapeHtml(CATEGORY_LABEL[q.category] ?? q.category)}  ·  ⛓ ${escapeHtml(CHAIN_LABEL)}`);
  lines.push("");
  lines.push(`<b>${escapeHtml(d.name)}</b>  ·  <code>$${escapeHtml(d.symbol)}</code>`);
  const dex = d.dex ? `  ·  🏦 ${escapeHtml(titleCase(d.dex))}` : "";
  lines.push(`🔗 <b>$${escapeHtml(d.symbol)}</b> ⇄ <b>$${escapeHtml(q.symbol)}</b>${dex}`);

  const stat: string[] = [];
  if (d.priceUsd != null) stat.push(`💵 ${escapeHtml(formatPrice(d.priceUsd))}`);
  if (d.liquidityUsd != null) stat.push(`💧 $${escapeHtml(formatCompact(d.liquidityUsd))}`);
  if (d.marketCap != null) stat.push(`📊 $${escapeHtml(formatCompact(d.marketCap))}`);
  if (stat.length) lines.push(stat.join("  ·  "));

  const socials: string[] = [];
  if (d.website) socials.push(`🌐 <a href="${escapeHtml(d.website)}">Website</a>`);
  if (d.twitter) socials.push(`𝕏 <a href="${escapeHtml(d.twitter)}">Twitter</a>`);
  if (d.telegram) socials.push(`✈️ <a href="${escapeHtml(d.telegram)}">Telegram</a>`);
  if (socials.length) {
    lines.push("");
    lines.push(socials.join("     "));
  }

  lines.push("");
  lines.push(`<code>${escapeHtml(d.mint)}</code>`);
  const footer = [`🕐 ${escapeHtml(formatTimeAgo(d.timestamp))}`, `🔍 <a href="${solscanToken(d.mint)}">Solscan</a>`];
  if (d.pairUrl) footer.push(`📈 <a href="${escapeHtml(d.pairUrl)}">Chart</a>`);
  const jup = jupiterBuyUrl(d.mint);
  if (jup) footer.push(`🪐 <a href="${jup}">Buy on Jup</a>`);
  lines.push(footer.join("  ·  "));
  return lines.join("\n");
}

async function sendLaunchAlert(
  chatId: string,
  q: QuoteToken,
  d: StonkFunTokenDetails,
  launchNumber: number
): Promise<void> {
  const bot = await getAlertsBot();
  const text = formatStonkFunLaunchAlert(q, d, launchNumber);
  if (d.imageUrl) {
    await bot.api
      .sendPhoto(chatId, d.imageUrl, { caption: text, parse_mode: "HTML" })
      .catch(async () => {
        await bot.api.sendMessage(chatId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      });
  } else {
    await bot.api.sendMessage(chatId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  }
}

/**
 * One poll cycle: pick up new StonkFun mints and, once their pair resolves,
 * ping any that are the first launch against a quote asset we're watching.
 * Does nothing at all while no quote is being watched.
 */
/** Launch mints already handled, so each is reported exactly once. */
const seenLaunches = new Set<string>();

/** Cursor identity in `feed_cursors`. */
const LAUNCH_FEED = "stonkfun.launches";

/** In-process copy of the cursor, so a poll costs one read only on first pass. */
let cursor: string | null = null;
let cursorLoaded = false;

/**
 * How far back a resumed watcher will still report.
 *
 * Larger than the steady-state staleness bound because catching up is the whole
 * point: after a deploy, a launch from an hour ago is still inside its 36h watch
 * window and still worth knowing about. Anything older than this is treated as
 * history and skipped, so a long outage cannot dump a day of backlog.
 */
const CATCHUP_MAX_AGE_SECONDS = 6 * 60 * 60;

/** Ceiling on alerts from one pass, so a huge gap cannot flood the channel. */
const MAX_ALERTS_PER_PASS = 25;

/**
 * One poll cycle over StonkFun's launch feed.
 *
 * Handles both kinds of watch from a SINGLE fetch:
 *   - windowed quotes  — a newly-added pairing asset, capped and time-limited
 *   - pinned quotes    — watched in full by request; none pinned today, so this
 *                        path is dormant rather than removed (see above)
 *
 * A quote cannot be both: pinned assets are `custom`, which the category
 * denylist keeps out of the windowed set. The windowed path is checked first
 * regardless, so a future overlap would produce one alert, not two.
 */
export async function pollStonkFunLaunches(): Promise<void> {
  const now = Date.now();
  for (const [mint, w] of watchedQuotes) {
    if (now - w.openedAt > LAUNCH_WINDOW_MS) {
      watchedQuotes.delete(mint);
      console.log(
        `[stonkfun] ${LAUNCH_WINDOW_LABEL} window closed for ${w.quote.symbol} — ${w.launchCount} launch(es) reported`
      );
    }
  }

  // The cursor survives restarts, so a redeploy resumes where the last pass
  // finished instead of re-seeding and silently dropping the downtime.
  if (!cursorLoaded) {
    cursor = await getFeedCursor(LAUNCH_FEED);
    cursorLoaded = true;
    if (cursor) console.log(`[stonkfun] resuming launches from ${cursor}`);
  }

  // Seeding only needs enough to establish a position, so it reads one page.
  // Resuming may have a real backlog to walk, so it is allowed to paginate —
  // 10 pages is ~8 days of downtime at the observed launch rate.
  const launches = await fetchStonkFunLaunches({ since: cursor, maxPages: cursor ? 10 : 1 });
  // null is a fetch failure, not an empty feed — hold the cursor rather than
  // advance it over launches we never saw.
  if (launches === null) return;
  if (launches.length === 0) return;

  // No cursor means this feed has never run. Seed silently: the backlog is
  // history, not news.
  if (cursor === null) {
    for (const l of launches) {
      seenLaunches.add(l.mint);
      if (PINNED_QUOTE_MINTS.has(l.quoteMint)) {
        pinnedCounts.set(l.quoteMint, (pinnedCounts.get(l.quoteMint) ?? 0) + 1);
      }
    }
    cursor = launches[0].createdAt; // feed is newest-first
    await setFeedCursor(LAUNCH_FEED, cursor);
    console.log(`[stonkfun] seeded ${launches.length} launches from the feed (no alert on backlog)`);
    return;
  }

  // Oldest-first so ordinals and running counts follow launch order.
  const fresh = launches
    .filter((l) => !seenLaunches.has(l.mint))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  let alertsThisPass = 0;

  for (const l of fresh) {
    seenLaunches.add(l.mint);

    // Pinned wins over a window. Reading the window first would hand a pinned
    // quote to the capped, expiring branch.
    const pinned = PINNED_QUOTE_MINTS.has(l.quoteMint);
    const w = pinned ? undefined : watchedQuotes.get(l.quoteMint);
    if (!w && !pinned) continue; // launched against something we're not watching

    const ageMs = now - (Date.parse(l.createdAt) || now);
    if (ageMs > CATCHUP_MAX_AGE_SECONDS * 1000) {
      console.log(`[stonkfun] skipping stale launch ${l.symbol} (${Math.round(ageMs / 60000)}m old)`);
      continue;
    }

    // The per-pass cap is a flood guard for catching up after downtime, and it
    // DROPS what it skips — the cursor advances past the whole pass either way.
    // A pinned quote is meant to be uncapped, so it is exempt: losing one of its
    // launches to a burst is precisely the outcome pinning exists to prevent.
    if (!pinned && alertsThisPass >= MAX_ALERTS_PER_PASS) {
      console.log(
        `[stonkfun] hit the ${MAX_ALERTS_PER_PASS}-alert cap for this pass — remaining windowed backlog skipped`
      );
      continue;
    }
    if (!pinned) alertsThisPass++;

    if (w) {
      // Every launch in the window is reported, not only the first — but a
      // runaway pair is capped rather than allowed to flood the feed.
      if (w.launchCount >= MAX_LAUNCHES_PER_WINDOW) {
        if (w.launchCount === MAX_LAUNCHES_PER_WINDOW) {
          w.launchCount++;
          console.log(`[stonkfun] ${w.quote.symbol} hit the ${MAX_LAUNCHES_PER_WINDOW}-launch cap — muting`);
        }
        continue;
      }
      w.launchCount++;
      // Market stats and socials are a best-effort extra: the pairing, name and
      // launch cap already come from the feed, so a token too new to be indexed
      // is still reported rather than delayed.
      const details = await enrichLaunch(l);
      try {
        await broadcastAlert(FEATURE.LAUNCH, (chatId) => sendLaunchAlert(chatId, w.quote, details, w.launchCount));
        console.log(`[stonkfun] alerted launch #${w.launchCount} ${l.symbol} vs ${w.quote.symbol}`);
      } catch (err) {
        console.error("[stonkfun] failed to send launch alert:", err);
      }
    } else {
      const n = (pinnedCounts.get(l.quoteMint) ?? 0) + 1;
      pinnedCounts.set(l.quoteMint, n);
      try {
        await broadcastAlert(FEATURE.LAUNCH, (chatId) => sendPinnedAlert(chatId, l, n));
        console.log(`[stonkfun] alerted pinned launch #${n} ${l.symbol} vs ${l.quoteSymbol}`);
      } catch (err) {
        console.error("[stonkfun] failed to send pinned launch alert:", err);
      }
    }
  }

  // Advance past everything this pass saw, including launches that were skipped
  // as stale, unwatched or over a cap — they have been considered and must not
  // be reconsidered after a restart. Only a fetch failure (handled above) leaves
  // the cursor where it was.
  const newest = launches[0]?.createdAt;
  if (newest && (!cursor || Date.parse(newest) > Date.parse(cursor))) {
    cursor = newest;
    await setFeedCursor(LAUNCH_FEED, newest);
  }

  if (seenLaunches.size > 5000) {
    seenLaunches.clear();
    for (const l of launches) seenLaunches.add(l.mint);
  }
}

/**
 * Turn a feed launch into the shape the alert formatter expects, adding market
 * stats and socials where an indexer already knows about the token.
 *
 * Never throws and never blocks the alert: the fields that matter (pairing,
 * name, symbol, mint) come from the feed itself.
 */
async function enrichLaunch(l: StonkFunLaunch): Promise<StonkFunTokenDetails> {
  const base: StonkFunTokenDetails = {
    mint: l.mint,
    symbol: l.symbol,
    signature: "",
    timestamp: Math.floor((Date.parse(l.createdAt) || Date.now()) / 1000),
    name: l.name,
    imageUrl: l.logoUrl,
    description: null,
    website: null,
    twitter: null,
    telegram: null,
    pairedSymbol: l.quoteSymbol,
    pairedAddress: l.quoteMint,
    dex: l.launchpad,
    priceUsd: null,
    liquidityUsd: null,
    marketCap: l.startMarketCapUsd,
    pairUrl: null,
  };
  try {
    const d = await enrichCreation({
      mint: l.mint,
      symbol: l.symbol,
      signature: "",
      timestamp: base.timestamp,
    });
    return {
      ...d,
      // The feed is authoritative on the pairing; never let a deeper SOL pool
      // overwrite the quote the token was actually launched against.
      name: d.name || l.name,
      symbol: d.symbol || l.symbol,
      imageUrl: d.imageUrl ?? l.logoUrl,
      pairedSymbol: l.quoteSymbol,
      pairedAddress: l.quoteMint,
      dex: d.dex ?? l.launchpad,
      marketCap: d.marketCap ?? l.startMarketCapUsd,
    };
  } catch {
    return base;
  }
}

/**
 * Manual test: send the most recent real launch as if it were the first against
 * its own quote, so the format can be checked without waiting.
 *
 * Reads the launches feed, so it exercises the same source the watcher uses.
 */
export async function sendStonkFunFirstTokenTestPing(chatId: string, symbol?: string): Promise<boolean> {
  const [launches, quotes] = await Promise.all([fetchStonkFunLaunches(), fetchQuoteTokens()]);
  if (!launches) return false;
  for (const l of launches) {
    const quote = quotes.find((q) => q.quoteMint === l.quoteMint);
    if (!quote) continue;
    if (symbol && quote.symbol.toLowerCase() !== symbol.toLowerCase()) continue;
    await sendLaunchAlert(chatId, quote, await enrichLaunch(l), 1);
    return true;
  }
  return false;
}
