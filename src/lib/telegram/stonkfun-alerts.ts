import {
  fetchRecentCreations,
  enrichCreation,
  fetchQuoteTokens,
  STONKFUN_DEPLOYER,
  STONKFUN_BASE,
  type StonkFunCreation,
  type StonkFunTokenDetails,
  type QuoteToken,
} from "@/lib/api/stonkfun";
import { getAlertsBot, broadcastAlert } from "./alerts-bot";
import {
  LAUNCH_WINDOW_MS,
  LAUNCH_WINDOW_LABEL,
  MAX_LAUNCHES_PER_WINDOW,
  ordinal,
} from "./launch-window";
import { escapeHtml, formatCompact, formatPrice, formatTimeAgo } from "./utils/format";

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
 * PAUSED — alerting on every StonkFun launch was too noisy to be useful.
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
      await broadcastAlert((chatId) => sendAlert(chatId, details));
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

// ── Quote-token monitoring ────────────────────────────────────────────────────
// StonkFun's /launch page lets creators pick a "quote token" — the asset a new
// token is paired against. We watch that list and alert when a new one is added.

const seenQuotes = new Set<string>();
let quotesSeeded = false;

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

/**
 * Quote assets watched permanently, by explicit request, regardless of category.
 *
 * TEMPORARY — these are pinned by hand and expected to be removed. Deleting an
 * entry from this map is the whole removal procedure; nothing else refers to it.
 *
 * A pinned quote deviates from a normal watch in three ways, all deliberate:
 *
 *   1. It bypasses SUPPRESSED_CATEGORIES. RAY is a `custom` quote — a
 *      creator-nominated on-chain token — and `custom` is exactly what the
 *      denylist exists to silence. Pinning is the narrow, auditable exception
 *      rather than a hole in the category rule.
 *   2. It never expires. The 36h window exists because a NEWLY-ADDED pair is
 *      briefly interesting; RAY is not new, and the ask is ongoing coverage.
 *   3. It is not capped at MAX_LAUNCHES_PER_WINDOW. The request is every coin
 *      launched against it, so truncating at 25 would defeat the point.
 *
 * Keyed by quote mint.
 */
const PINNED_QUOTE_MINTS = new Map<string, string>([
  ["4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", "RAY (Raydium)"],
]);

function isPinnedQuote(mint: string): boolean {
  return PINNED_QUOTE_MINTS.has(mint);
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
  lines.push(
    `🔍 <a href="https://solscan.io/token/${q.quoteMint}">Solscan</a>` +
    `  ·  🚀 <a href="${STONKFUN_BASE}/launch">Launch a token</a>`
  );
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

  if (!quotesSeeded) {
    for (const q of quotes) seenQuotes.add(q.quoteMint);
    quotesSeeded = true;
    console.log(`[stonkfun] seeded ${seenQuotes.size} existing quote tokens (no alert on backlog)`);
    // Pinned quotes are already in the catalog, so seeding would otherwise bury
    // them with everything else and they'd never be watched. Registered here
    // WITHOUT announcing them — they are not new listings, and the point is the
    // launches against them.
    for (const q of quotes) {
      if (isPinnedQuote(q.quoteMint)) startQuoteWatch(q);
    }
    return;
  }

  const fresh = quotes.filter((q) => !seenQuotes.has(q.quoteMint));
  if (fresh.length === 0) return;

  for (const q of fresh) {
    // Recorded either way, so a later listing of the same asset isn't treated as
    // new — but only stock-like assets are announced or watched.
    seenQuotes.add(q.quoteMint);
    if (!isAlertableQuote(q.category)) {
      console.log(`[stonkfun] skipping quote ${q.symbol} — category "${q.category}" is not alertable`);
      continue;
    }
    startQuoteWatch(q);
    try {
      await broadcastAlert((chatId) => sendQuoteAlert(chatId, q));
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

// ── First token launched against a newly-added quote ──────────────────────────
// Same shape as the Robinhood Chain and BNB Chain watchers: once a pairing asset
// appears, ping the first token actually launched against it, then stop.
//
// Detection differs from BNB Chain in one way that shapes everything below.
//
// On BNB Chain the launchpad emits (token, paymentToken) in a single creation
// event, so a launch and its pair are known together, atomically, at the moment
// the curve is deployed. StonkFun gives no such event. Its mint IS on-chain and
// immediate (Helius TOKEN_MINT from the platform deployer), but the pool is
// seeded in a LATER transaction, so the mint tx names only the new token —
// verified by probe-stonkfun-pair.ts, which found exactly one mint and no quote
// in five consecutive launches. Reading the pair back from the token's own
// history doesn't work either: its early transactions route through SOL and USDC
// via aggregators, so several "known quote" candidates appear with nothing to
// distinguish the real one.
//
// So the pair comes from the token's deepest indexed pool, which means it is not
// known at mint time and arrives some seconds later. Two consequences:
//   - a creation may need several passes before its pair resolves, hence the
//     pending queue with bounded retries rather than a single fixed delay;
//   - pools are NOT indexed in launch order, so resolution order says nothing
//     about launch order. The queue is therefore drained strictly oldest-first
//     and stops at the first unresolved creation, so a token can never be
//     announced as "first" while an older launch's pair is still unknown.

interface WatchedQuote {
  quote: QuoteToken;
  openedAt: number;
  launchCount: number;
  /** Pinned watches never expire and are never capped. */
  pinned: boolean;
}
const watchedQuotes = new Map<string, WatchedQuote>(); // key: quote mint

/** Creations seen but not yet matched to a pair, with how many passes we've tried. */
interface PendingCreation {
  creation: StonkFunCreation;
  attempts: number;
}
const pending = new Map<string, PendingCreation>(); // key: mint
// A StonkFun pool is normally indexed within a minute; give it well past that
// before dropping the creation, but don't hold mints forever.
const MAX_RESOLVE_ATTEMPTS = 10;

function startQuoteWatch(q: QuoteToken): void {
  if (watchedQuotes.has(q.quoteMint)) return;
  const pinned = isPinnedQuote(q.quoteMint);
  watchedQuotes.set(q.quoteMint, { quote: q, openedAt: Date.now(), launchCount: 0, pinned });
  console.log(
    pinned
      ? `[stonkfun] PINNED watch on ${q.symbol} (${q.category}) — every launch, no window, no cap`
      : `[stonkfun] watching ${q.symbol} (${q.category}) for launches over ${LAUNCH_WINDOW_LABEL}`
  );
}

export function formatStonkFunLaunchAlert(
  q: QuoteToken,
  d: StonkFunTokenDetails,
  launchNumber: number
): string {
  const lines: string[] = [];
  const first = launchNumber <= 1;
  // A pinned quote is not a new listing, so the "first / inaugural" framing
  // would be actively wrong — RAY has been available for a while and the ask is
  // simply every coin launched against it.
  const pinned = isPinnedQuote(q.quoteMint);

  if (pinned) {
    lines.push(
      `🌊 <b>New coin vs $${escapeHtml(q.symbol)} on StonkFun</b>  ·  ⛓ ${escapeHtml(CHAIN_LABEL)}`
    );
    lines.push(`<i>Launch #${launchNumber} against $${escapeHtml(q.symbol)} since tracking began.</i>`);
  } else {
    lines.push(
      `${first ? "🥇" : "🔁"} <b>${first ? "First" : ordinal(launchNumber)} token vs $${escapeHtml(q.symbol)} on StonkFun</b>` +
        `  ·  ⛓ ${escapeHtml(CHAIN_LABEL)}`
    );
    lines.push(
      first
        ? `<i>Inaugural launch paired to the newly-added quote asset.</i>`
        : `<i>Launch ${launchNumber} against this quote, inside the ${LAUNCH_WINDOW_LABEL} window.</i>`
    );
  }
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
export async function pollStonkFunFirstTokens(): Promise<void> {
  const now = Date.now();
  for (const [mint, w] of watchedQuotes) {
    if (w.pinned) continue; // pinned watches run until removed by hand
    if (now - w.openedAt > LAUNCH_WINDOW_MS) {
      watchedQuotes.delete(mint);
      console.log(
        `[stonkfun] ${LAUNCH_WINDOW_LABEL} window closed for ${w.quote.symbol} — ${w.launchCount} launch(es) reported`
      );
    }
  }

  // Track creations on EVERY pass, even when nothing is being watched. A new
  // quote is noticed up to one catalog poll after it appears, and a token can be
  // launched against it inside that gap. If tracking only began once a watch
  // existed, that launch would land in the seed set and be discarded — and the
  // NEXT token would then be announced as the first, which is worse than silence.
  const creations = await fetchRecentCreations(25);
  if (creations.length === 0) return;

  if (!seeded) {
    for (const c of creations) seen.add(c.mint);
    seeded = true;
    console.log(`[stonkfun] seeded ${seen.size} existing creations (no alert on backlog)`);
    return;
  }

  // Queue anything new, oldest-first, so the true first wins if several land at once.
  const nowSec = now / 1000;
  for (const c of creations.filter((x) => !seen.has(x.mint)).reverse()) {
    seen.add(c.mint);
    if (c.timestamp > 0 && nowSec - c.timestamp > MAX_ALERT_AGE_SECONDS) continue;
    pending.set(c.mint, { creation: c, attempts: 0 });
  }
  if (seen.size > 1000) {
    seen.clear();
    for (const c of creations) seen.add(c.mint);
  }

  // Forget creations that aged out of the alert window, so a quiet spell doesn't
  // leave a stale queue to resolve when a quote is finally added.
  for (const [mint, p] of pending) {
    if (p.creation.timestamp > 0 && nowSec - p.creation.timestamp > MAX_ALERT_AGE_SECONDS) {
      pending.delete(mint);
    }
  }

  // Resolving a pair costs an indexer lookup per creation, so only do it when
  // there is actually a quote to match against. The queue above still filled, so
  // the moment a quote IS added its recent launches are already waiting.
  if (watchedQuotes.size === 0) return;

  const queued = [...pending.values()].sort((a, b) => a.creation.timestamp - b.creation.timestamp);
  for (const p of queued) {
    const mint = p.creation.mint;
    try {
      const details = await enrichCreation(p.creation);
      if (!details.pairedAddress) {
        // Pool not indexed yet. Retry next pass, and give up eventually.
        if (++p.attempts >= MAX_RESOLVE_ATTEMPTS) {
          pending.delete(mint);
          console.log(`[stonkfun] gave up resolving pair for ${details.symbol}`);
          continue;
        }
        // Stop the pass here rather than moving on. Pools are not indexed in
        // launch order, so a younger creation can resolve first — and if it
        // pairs against the same quote it would be announced as the "first",
        // permanently beating a token that actually launched earlier. While an
        // older pair is unknown, no younger one can be judged first.
        return;
      }

      pending.delete(mint); // pair known — this creation is settled either way

      // Match the deepest pool's quote first — that is the token's real pairing
      // and the right answer for a normal watch. Then fall back to ANY quote the
      // token trades against, but only for pinned assets: a token launched
      // against RAY routinely picks up a deeper SOL or USDC pool within minutes,
      // which would otherwise hide the launch quote and lose the alert.
      let w = watchedQuotes.get(details.pairedAddress);
      if (!w) {
        for (const addr of details.quoteAddresses ?? []) {
          const candidate = watchedQuotes.get(addr);
          if (candidate?.pinned) {
            w = candidate;
            break;
          }
        }
      }
      if (!w) continue; // paired against something we're not watching

      // Every launch in the window is reported, not only the first — but a
      // runaway pair is capped rather than allowed to flood the feed.
      // The cap is a safety valve for a runaway NEW pair. A pinned quote was
      // asked for explicitly and in full, so it is exempt.
      if (!w.pinned && w.launchCount >= MAX_LAUNCHES_PER_WINDOW) {
        if (w.launchCount === MAX_LAUNCHES_PER_WINDOW) {
          w.launchCount++;
          console.log(`[stonkfun] ${w.quote.symbol} hit the ${MAX_LAUNCHES_PER_WINDOW}-launch cap — muting`);
        }
        continue;
      }
      w.launchCount++;
      await broadcastAlert((chatId) => sendLaunchAlert(chatId, w.quote, details, w.launchCount));
      console.log(`[stonkfun] alerted launch #${w.launchCount} ${details.symbol} vs ${w.quote.symbol}`);
    } catch (err) {
      pending.delete(mint);
      console.error("[stonkfun] first-token check failed:", err);
    }
  }
}

/**
 * Manual test: treat the most recent creation as if it were the first launch
 * against its own pair, so the format can be verified without waiting.
 */
export async function sendStonkFunFirstTokenTestPing(chatId: string, symbol?: string): Promise<boolean> {
  const [creations, quotes] = await Promise.all([fetchRecentCreations(10), fetchQuoteTokens()]);
  for (const c of creations) {
    const details = await enrichCreation(c);
    if (!details.pairedAddress) continue;
    const quote = quotes.find((q) => q.quoteMint === details.pairedAddress);
    if (!quote) continue;
    if (symbol && quote.symbol.toLowerCase() !== symbol.toLowerCase()) continue;
    await sendLaunchAlert(chatId, quote, details, 1);
    return true;
  }
  return false;
}
