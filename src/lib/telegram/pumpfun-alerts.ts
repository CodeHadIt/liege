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
  fetchRecentPumpCoins,
  coinQuoteMint,
  BASELINE_QUOTE_MINTS,
  PUMP_CREATE_URL,
  type PumpCoin,
  type QuoteMintMeta,
} from "@/lib/api/pumpfun-quotes";
import { getAlertsBot, broadcastAlert } from "./alerts-bot";
import {
  LAUNCH_WINDOW_MS,
  LAUNCH_WINDOW_LABEL,
  MAX_LAUNCHES_PER_WINDOW,
  ordinal,
} from "./launch-window";
import { escapeHtml, formatCompact, formatTimeAgo } from "./utils/format";

const CHAIN_LABEL = "Solana";
const PLATFORM = "Pump.fun";

function solscanToken(mint: string): string {
  return `https://solscan.io/token/${mint}`;
}

// ── Quote catalog ────────────────────────────────────────────────────────────

const seenQuotes = new Set<string>();
let quotesSeeded = false;

interface WatchedQuote {
  quote: QuoteMintMeta;
  openedAt: number;
  launchCount: number;
}
/** Quote mint -> open launch window. */
const watchedQuotes = new Map<string, WatchedQuote>();

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

  if (!quotesSeeded) {
    for (const m of mints) seenQuotes.add(m);
    quotesSeeded = true;
    console.log(`[pumpfun] seeded ${seenQuotes.size} whitelisted quote mint(s) (no alert on backlog)`);
    return;
  }

  const fresh = mints.filter((m) => !seenQuotes.has(m));
  for (const mint of fresh) {
    // Recorded either way, so a suppressed asset isn't re-evaluated every pass.
    seenQuotes.add(mint);
    if (BASELINE_QUOTE_MINTS.has(mint)) {
      console.log(`[pumpfun] skipping baseline quote ${mint} — not a new listing`);
      continue;
    }
    try {
      const meta = await fetchQuoteMintMeta(mint);
      startQuoteWatch(meta);
      await broadcastAlert((chatId) => sendQuoteAlert(chatId, meta));
      console.log(`[pumpfun] alerted new quote asset: ${meta.symbol} (${mint})`);
    } catch (err) {
      console.error("[pumpfun] failed to send quote-asset alert:", err);
    }
  }
}

function startQuoteWatch(q: QuoteMintMeta): void {
  if (watchedQuotes.has(q.mint)) return;
  watchedQuotes.set(q.mint, { quote: q, openedAt: Date.now(), launchCount: 0 });
  console.log(`[pumpfun] watching ${q.symbol} for launches over ${LAUNCH_WINDOW_LABEL}`);
}

// ── Launches inside the window ───────────────────────────────────────────────

/**
 * Newest creation timestamp already processed, so a pass only considers coins
 * minted since the last one.
 */
let lastSeenCreatedAt = 0;
let launchesSeeded = false;

/** Mints already reported, guarding against a timestamp tie at the cursor. */
const alertedMints = new Set<string>();

/**
 * Never report a launch older than this. A coin that predates the window's
 * opening isn't a response to the new quote, and after an outage the feed
 * should resume rather than replay.
 */
const MAX_ALERT_AGE_MS = 30 * 60 * 1000;

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
  const footer = [
    `🕐 ${escapeHtml(formatTimeAgo(coin.createdTimestamp))}`,
    `🔍 <a href="${solscanToken(coin.mint)}">Solscan</a>`,
    `📈 <a href="https://pump.fun/coin/${escapeHtml(coin.mint)}">Pump.fun</a>`,
  ];
  lines.push(footer.join("  ·  "));
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
 * One launch pass: report new coins paired against a quote we're watching.
 *
 * Short-circuits before touching the network while no window is open, which is
 * the normal state — pump.fun has whitelisted one non-SOL quote in its history,
 * so this poller should cost nothing until the day a stock is listed.
 */
export async function pollPumpFunLaunches(): Promise<void> {
  const now = Date.now();
  for (const [mint, w] of watchedQuotes) {
    if (now - w.openedAt > LAUNCH_WINDOW_MS) {
      watchedQuotes.delete(mint);
      console.log(
        `[pumpfun] ${LAUNCH_WINDOW_LABEL} window closed for ${w.quote.symbol} — ${w.launchCount} launch(es) reported`
      );
    }
  }
  if (watchedQuotes.size === 0) return;

  // One page spans roughly three minutes of creations at the observed rate. If
  // the cursor is further back than that — a delayed pass, or a window that has
  // only just opened — pull more pages so the gap is actually covered instead of
  // being silently skipped.
  const gapMs = lastSeenCreatedAt > 0 ? now - lastSeenCreatedAt : 0;
  const pages = Math.min(4, Math.max(1, Math.ceil(gapMs / (3 * 60 * 1000))));

  const coins = await fetchRecentPumpCoins(pages);
  // null is a fetch failure, not a quiet minute — hold the cursor and retry.
  if (coins === null) return;
  if (coins.length === 0) return;

  const newest = Math.max(...coins.map((c) => c.createdTimestamp));

  if (!launchesSeeded) {
    // Start from the present. Coins minted before the watcher came up are not
    // launches against the new quote in any meaningful sense.
    lastSeenCreatedAt = newest;
    launchesSeeded = true;
    console.log(`[pumpfun] seeded launch cursor at ${new Date(newest).toISOString()}`);
    return;
  }

  // Oldest-first, so ordinals follow launch order rather than page order.
  const fresh = coins
    .filter((c) => c.createdTimestamp > lastSeenCreatedAt && !alertedMints.has(c.mint))
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  for (const coin of fresh) {
    const w = watchedQuotes.get(coinQuoteMint(coin));
    if (!w) continue; // paired against something we're not watching
    if (coin.createdTimestamp > 0 && now - coin.createdTimestamp > MAX_ALERT_AGE_MS) continue;

    if (w.launchCount >= MAX_LAUNCHES_PER_WINDOW) {
      if (w.launchCount === MAX_LAUNCHES_PER_WINDOW) {
        w.launchCount++;
        console.log(`[pumpfun] ${w.quote.symbol} hit the ${MAX_LAUNCHES_PER_WINDOW}-launch cap — muting`);
      }
      continue;
    }

    w.launchCount++;
    alertedMints.add(coin.mint);
    try {
      await broadcastAlert((chatId) => sendLaunchAlert(chatId, w.quote, coin, w.launchCount));
      console.log(`[pumpfun] alerted launch #${w.launchCount} ${coin.symbol} vs ${w.quote.symbol}`);
    } catch (err) {
      console.error("[pumpfun] failed to send launch alert:", err);
    }
  }

  lastSeenCreatedAt = Math.max(lastSeenCreatedAt, newest);
  if (alertedMints.size > 1000) alertedMints.clear();
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
 * Treat a recent coin as the first launch against its own quote so the launch
 * format can be checked without waiting for a listing.
 */
export async function sendPumpLaunchTestPing(chatId: string, symbol?: string): Promise<boolean> {
  const coins = await fetchRecentPumpCoins(1);
  if (!coins || coins.length === 0) return false;
  const coin = symbol
    ? coins.find((c) => c.symbol.toLowerCase() === symbol.toLowerCase())
    : coins[0];
  if (!coin) return false;
  const meta = await fetchQuoteMintMeta(coinQuoteMint(coin));
  await sendLaunchAlert(chatId, meta, coin, 1);
  return true;
}
