/**
 * Pump.fun quote-asset alerts.
 *
 * Same shape as every other launchpad we watch: ping when a new pairing asset
 * is added, then report the tokens launched against it for a fixed window.
 *
 * What differs is where each half of that comes from. The catalog is read from
 * the pump program's own Global account, so an addition is known the moment the
 * chain accepts it — no indexer, no scrape, and nothing to reconcile after a
 * restart. The launch feed is the opposite: pump.fun's API carries the quote
 * mint on every coin but will not filter by it, so the recent-creations feed is
 * pulled whole and matched here.
 */
import {
  fetchWhitelistedQuoteMints,
  fetchQuoteMintMeta,
  fetchCurvesForQuote,
  resolveCurveMint,
  fetchTokenMeta,
  fetchPumpCoin,
  BASELINE_QUOTE_MINTS,
  PUMP_CREATE_URL,
  type PumpCoin,
  type QuoteMintMeta,
} from "@/lib/api/pumpfun-quotes";
import { getAlertsBot, broadcastAlert, FEATURE } from "./alerts-bot";
import {
  LAUNCH_WINDOW_MS,
  LAUNCH_WINDOW_LABEL,
  MAX_LAUNCHES_PER_WINDOW,
  ordinal,
} from "./launch-window";
import { escapeHtml, formatCompact, formatTimeAgo } from "./utils/format";
import { FEED, resolveSeen, markSeen } from "@/lib/api/feed-seen";

const CHAIN_LABEL = "Solana";
const PLATFORM = "Pump.fun";

function solscanToken(mint: string): string {
  return `https://solscan.io/token/${mint}`;
}

// ── Quote catalog ────────────────────────────────────────────────────────────

const seenQuotes = new Set<string>();

interface WatchedQuote {
  quote: QuoteMintMeta;
  openedAt: number;
  launchCount: number;
}
/** Quote mint -> open launch window. */
const watchedQuotes = new Map<string, WatchedQuote>();

/**
 * Quotes whose window has already run its course.
 *
 * Needed because a window can now be opened by a launch as well as by the
 * catalog (see `ensureQuoteWatched`). Without this, the first launch after a
 * window expired would reopen it, and a quote that stayed popular would restart
 * its own 36h window indefinitely.
 */
const closedQuotes = new Set<string>();

/**
 * Make sure a non-baseline quote is being watched, announcing it if this is the
 * first we've heard of it.
 *
 * Both discovery paths funnel through here — the catalog read and the launch
 * feed — so whichever notices a new quote first announces it exactly once, and
 * the other finds it already known.
 *
 * Returns null when the quote is baseline or its window has already closed.
 */
async function ensureQuoteWatched(mint: string, announce: boolean): Promise<WatchedQuote | null> {
  const open = watchedQuotes.get(mint);
  if (open) return open;
  if (BASELINE_QUOTE_MINTS.has(mint)) return null;
  if (closedQuotes.has(mint)) return null;

  const meta = await fetchQuoteMintMeta(mint);
  const watch: WatchedQuote = { quote: meta, openedAt: Date.now(), launchCount: 0 };
  watchedQuotes.set(mint, watch);
  console.log(`[pumpfun] watching ${meta.symbol} for launches over ${LAUNCH_WINDOW_LABEL}`);

  if (!seenQuotes.has(mint)) {
    seenQuotes.add(mint);
    if (announce) {
      try {
        await broadcastAlert(FEATURE.LAUNCH, (chatId) => sendQuoteAlert(chatId, meta));
        console.log(`[pumpfun] alerted new quote asset: ${meta.symbol} (${mint})`);
      } catch (err) {
        console.error("[pumpfun] failed to send quote-asset alert:", err);
      }
    }
  }
  return watch;
}

export function formatPumpQuoteAlert(q: QuoteMintMeta): string {
  const lines: string[] = [];
  lines.push(`✨ <b>New Quote Asset on ${escapeHtml(PLATFORM)}</b>  ·  ⛓ ${escapeHtml(CHAIN_LABEL)}`);
  lines.push(`<i>New coins can now be launched paired against this asset.</i>`);
  lines.push("");
  lines.push(`<b>${escapeHtml(q.name)}</b>  ·  <code>$${escapeHtml(q.symbol)}</code>`);
  lines.push(`📈 Quote asset  ·  ⛓ ${escapeHtml(CHAIN_LABEL)}`);
  lines.push("");
  lines.push(`<code>${escapeHtml(q.mint)}</code>`);
  lines.push(
    `🔍 <a href="${solscanToken(q.mint)}">Solscan</a>` +
      `  ·  🚀 <a href="${PUMP_CREATE_URL}">Launch a coin</a>`
  );
  lines.push("");
  lines.push(`<i>Watching launches against $${escapeHtml(q.symbol)} for the next ${LAUNCH_WINDOW_LABEL}.</i>`);
  return lines.join("\n");
}

async function sendQuoteAlert(chatId: string, q: QuoteMintMeta): Promise<void> {
  const bot = await getAlertsBot();
  await bot.api.sendMessage(chatId, formatPumpQuoteAlert(q), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

/**
 * One catalog pass: alert when pump.fun whitelists a new quote mint.
 *
 * Baseline assets (SOL, USDC and the other stablecoins the program shipped
 * with) are recorded but never announced, so a redeploy can't mistake the
 * existing catalog for a listing. Anything else is reported: there is no
 * category field on-chain to classify a stock by, and inventing an allowlist of
 * expected stock symbols would silently swallow the first listing that didn't
 * match it — the exact failure mode the StonkFun denylist was written to avoid.
 */
export async function pollPumpFunQuoteMints(): Promise<void> {
  const mints = await fetchWhitelistedQuoteMints();
  // null means the account couldn't be read. Holding state is essential here:
  // treating a failed read as an empty catalog would re-announce every quote as
  // new on the next successful poll.
  if (mints === null) return;

  const state = await resolveSeen(FEED.PUMPFUN_QUOTES, seenQuotes);
  // Degraded (store unreachable) falls through on the in-memory set — the old
  // behaviour, which still alerts. Silence would be the worse failure here.
  for (const k of state.seen) seenQuotes.add(k);

  if (state.firstRun) {
    for (const m of mints) seenQuotes.add(m);
    await markSeen(FEED.PUMPFUN_QUOTES, mints);
    console.log(`[pumpfun] seeded ${mints.length} whitelisted quote mint(s) (first run — no alert on backlog)`);
    return;
  }

  const fresh = mints.filter((m) => !seenQuotes.has(m));
  for (const mint of fresh) {
    if (BASELINE_QUOTE_MINTS.has(mint)) {
      // Recorded so a suppressed asset isn't re-evaluated every pass.
      seenQuotes.add(mint);
      await markSeen(FEED.PUMPFUN_QUOTES, [mint]);
      console.log(`[pumpfun] skipping baseline quote ${mint} — not a new listing`);
      continue;
    }
    await ensureQuoteWatched(mint, true);
  }
}

// ── Launches inside the window ───────────────────────────────────────────────

/** Bonding curves already reported, so a re-enumeration doesn't repeat them. */
const reportedCurves = new Set<string>();

export function formatPumpLaunchAlert(
  q: QuoteMintMeta,
  coin: PumpCoin,
  launchNumber: number
): string {
  const lines: string[] = [];
  const first = launchNumber <= 1;
  lines.push(
    `${first ? "🥇" : "🔁"} <b>${first ? "First" : ordinal(launchNumber)} coin vs $${escapeHtml(q.symbol)} on ${escapeHtml(PLATFORM)}</b>` +
      `  ·  ⛓ ${escapeHtml(CHAIN_LABEL)}`
  );
  lines.push(
    first
      ? `<i>Inaugural launch paired to the newly-added quote asset.</i>`
      : `<i>Launch ${launchNumber} against this quote, inside the ${LAUNCH_WINDOW_LABEL} window.</i>`
  );
  lines.push("");
  lines.push(`<b>${escapeHtml(coin.name)}</b>  ·  <code>$${escapeHtml(coin.symbol)}</code>`);
  lines.push(`🔗 <b>$${escapeHtml(coin.symbol)}</b> ⇄ <b>$${escapeHtml(q.symbol)}</b>  ·  🏦 ${escapeHtml(PLATFORM)}`);

  if (coin.marketCapUsd != null) {
    lines.push(`📊 Market Cap:  <b>$${escapeHtml(formatCompact(coin.marketCapUsd))}</b>`);
  }

  const socials: string[] = [];
  if (coin.website) socials.push(`🌐 <a href="${escapeHtml(coin.website)}">Website</a>`);
  if (coin.twitter) socials.push(`𝕏 <a href="${escapeHtml(coin.twitter)}">Twitter</a>`);
  if (coin.telegram) socials.push(`✈️ <a href="${escapeHtml(coin.telegram)}">Telegram</a>`);
  if (socials.length) {
    lines.push("");
    lines.push(socials.join("     "));
  }

  lines.push("");
  lines.push(`<code>${escapeHtml(coin.mint)}</code>`);
  const footer: string[] = [];
  // Creation time comes from the frontend API, which may be unreachable — the
  // chain gives us the launch but not when it happened. Omit rather than print
  // a bogus age.
  if (coin.createdTimestamp > 0) footer.push(`🕐 ${escapeHtml(formatTimeAgo(coin.createdTimestamp))}`);
  footer.push(`🔍 <a href="${solscanToken(coin.mint)}">Solscan</a>`);
  footer.push(`📈 <a href="https://pump.fun/coin/${escapeHtml(coin.mint)}">Pump.fun</a>`);
  lines.push(footer.join("  ·  "));
  if (coin.creator) {
    lines.push(`👤 Dev: <code>${escapeHtml(coin.creator)}</code>`);
  }
  return lines.join("\n");
}

async function sendLaunchAlert(
  chatId: string,
  q: QuoteMintMeta,
  coin: PumpCoin,
  launchNumber: number
): Promise<void> {
  const bot = await getAlertsBot();
  const text = formatPumpLaunchAlert(q, coin, launchNumber);
  if (coin.imageUrl) {
    await bot.api
      .sendPhoto(chatId, coin.imageUrl, { caption: text, parse_mode: "HTML" })
      .catch(async () => {
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
 * One launch pass: enumerate, on-chain, every coin launched against each quote
 * we're watching.
 *
 * Detection is a memcmp query against `BondingCurve.quote_mint`, not a scan of
 * pump.fun's recent-creations feed. That feed was the original design and it had
 * to go: it sits behind a WAF that answered 403 to this machine after a burst of
 * requests, and the block persisted. A feed whose entire job is to not miss a
 * launch cannot have its only detection path behind something that can lock us
 * out silently.
 *
 * The on-chain query is strictly better on the property that matters. It returns
 * **every** curve for the quote — including ones created before we noticed the
 * quote existed — so there is no detection gap to reason about, where the HTTP
 * feed could only ever show a rolling window of recent creations.
 *
 * It is also why keying off the watched quotes is complete rather than a
 * dependency: the pump program *enforces* the whitelist, so a coin's quote is
 * necessarily one of the whitelisted mints. Enumerating the non-baseline ones
 * therefore covers every launch that could interest us, by construction.
 */
export async function pollPumpFunLaunches(): Promise<void> {
  const now = Date.now();
  for (const [mint, w] of watchedQuotes) {
    if (now - w.openedAt > LAUNCH_WINDOW_MS) {
      watchedQuotes.delete(mint);
      closedQuotes.add(mint);
      console.log(
        `[pumpfun] ${LAUNCH_WINDOW_LABEL} window closed for ${w.quote.symbol} — ${w.launchCount} launch(es) reported`
      );
    }
  }
  // Nothing whitelisted beyond the baseline means nothing to enumerate. Unlike
  // the HTTP design this costs no requests at all while idle, which is the
  // normal state.
  if (watchedQuotes.size === 0) return;

  for (const [quoteMint, w] of watchedQuotes) {
    const curves = await fetchCurvesForQuote(quoteMint);
    // null is an RPC failure, not an empty result — hold and retry next pass.
    if (curves === null) {
      console.error(`[pumpfun] curve enumeration failed for ${w.quote.symbol} — holding`);
      continue;
    }

    const fresh = curves.filter((c) => !reportedCurves.has(c.curve));
    if (fresh.length === 0) continue;

    // Resolve each curve to its coin, enriching from the frontend API where it
    // is reachable. Enrichment is optional by design — the chain already
    // supplies mint, creator and the pairing, and everything below degrades to
    // Metaplex metadata when the API is blocked.
    const resolved: Array<{ curve: string; coin: PumpCoin }> = [];
    for (const c of fresh) {
      // Mark before alerting: a curve that fails enrichment must not be retried
      // forever, and a partial failure must never replay an alert.
      reportedCurves.add(c.curve);
      const mint = await resolveCurveMint(c.curve);
      if (!mint) continue;

      const enriched = await fetchPumpCoin(mint);
      if (enriched) {
        resolved.push({ curve: c.curve, coin: enriched });
        continue;
      }
      const meta = await fetchTokenMeta(mint);
      resolved.push({
        curve: c.curve,
        coin: {
          mint,
          name: meta.name,
          symbol: meta.symbol,
          quoteMint,
          createdTimestamp: 0, // unknown without the API; the alert omits the age
          creator: c.creator,
          imageUrl: meta.imageUrl,
          website: null,
          twitter: null,
          telegram: null,
          marketCapUsd: null,
          bondingCurve: c.curve,
        },
      });
    }

    // Oldest-first where creation times are known, so ordinals follow launch
    // order. Coins with no timestamp keep enumeration order, after the dated
    // ones — there is nothing better to sort them by.
    resolved.sort((a, b) => {
      const ta = a.coin.createdTimestamp || Number.MAX_SAFE_INTEGER;
      const tb = b.coin.createdTimestamp || Number.MAX_SAFE_INTEGER;
      return ta - tb;
    });

    for (const { coin } of resolved) {
      // A launch older than the window itself predates the listing this feed is
      // about, so it isn't news even on a first enumeration.
      if (coin.createdTimestamp > 0 && now - coin.createdTimestamp > LAUNCH_WINDOW_MS) continue;

      if (w.launchCount >= MAX_LAUNCHES_PER_WINDOW) {
        if (w.launchCount === MAX_LAUNCHES_PER_WINDOW) {
          w.launchCount++;
          console.log(`[pumpfun] ${w.quote.symbol} hit the ${MAX_LAUNCHES_PER_WINDOW}-launch cap — muting`);
        }
        continue;
      }

      w.launchCount++;
      try {
        await broadcastAlert(FEATURE.LAUNCH, (chatId) => sendLaunchAlert(chatId, w.quote, coin, w.launchCount));
        console.log(`[pumpfun] alerted launch #${w.launchCount} ${coin.symbol} vs ${w.quote.symbol}`);
      } catch (err) {
        console.error("[pumpfun] failed to send launch alert:", err);
      }
    }
  }

  if (reportedCurves.size > 5000) reportedCurves.clear();
}

// ── Manual tests ─────────────────────────────────────────────────────────────

/** Send the current catalog's newest non-baseline quote (or USDC) as a sample. */
export async function sendPumpQuoteTestPing(chatId: string): Promise<boolean> {
  const mints = await fetchWhitelistedQuoteMints();
  if (!mints || mints.length === 0) return false;
  const pick = mints.find((m) => !BASELINE_QUOTE_MINTS.has(m)) ?? mints[mints.length - 1];
  await sendQuoteAlert(chatId, await fetchQuoteMintMeta(pick));
  return true;
}

/**
 * Send a launch alert built from a REAL coin, through the same on-chain path the
 * live watcher uses, so the format can be checked without waiting for a listing.
 *
 * `quoteMint` defaults to USDC — the only non-SOL quote pump.fun has whitelisted
 * — because it is the one quote with real curves to enumerate today. The
 * resulting alert is genuine in every respect except that USDC is a baseline
 * asset the live feed would not open a window for.
 */
export async function sendPumpLaunchTestPing(
  chatId: string,
  quoteMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  launchNumber = 1
): Promise<boolean> {
  const curves = await fetchCurvesForQuote(quoteMint);
  if (!curves || curves.length === 0) return false;
  const quoteMeta = await fetchQuoteMintMeta(quoteMint);

  for (const c of curves) {
    const mint = await resolveCurveMint(c.curve);
    if (!mint) continue;
    const enriched = await fetchPumpCoin(mint);
    const tokenMeta = await fetchTokenMeta(mint);
    // Prefer a coin whose metadata actually resolved, so the sample shows a real
    // name rather than the truncated-mint fallback.
    if (!enriched && tokenMeta.name.includes("\u2026")) continue;
    const coin: PumpCoin = enriched ?? {
      mint,
      name: tokenMeta.name,
      symbol: tokenMeta.symbol,
      quoteMint,
      createdTimestamp: 0,
      creator: c.creator,
      imageUrl: tokenMeta.imageUrl,
      website: null,
      twitter: null,
      telegram: null,
      marketCapUsd: null,
      bondingCurve: c.curve,
    };
    await sendLaunchAlert(chatId, quoteMeta, coin, launchNumber);
    return true;
  }
  return false;
}
