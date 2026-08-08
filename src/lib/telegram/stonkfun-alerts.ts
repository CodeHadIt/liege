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
    return;
  }

  const fresh = quotes.filter((q) => !seenQuotes.has(q.quoteMint));
  if (fresh.length === 0) return;

  for (const q of fresh) {
    seenQuotes.add(q.quoteMint);
    startFirstTokenWatch(q);
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
// Detection differs from BNB Chain in one way worth knowing. The mint itself is
// on-chain and immediate (Helius TOKEN_MINT from StonkFun's deployer), but
// StonkFun seeds the pool in a LATER transaction, so the mint tx never names the
// quote — verified by probe-stonkfun-pair.ts. Reading it back on-chain is
// ambiguous too, because the token's early transactions route through SOL/USDC.
// The pair therefore comes from the token's deepest indexed pool, retried across
// passes while the pool is still being indexed.

interface QuoteWatch {
  quote: QuoteToken;
  addedAt: number;
}
const awaitingFirstToken = new Map<string, QuoteWatch>(); // key: quote mint
const WATCH_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Creations seen but not yet matched to a pair, with how many passes we've tried. */
interface PendingCreation {
  creation: StonkFunCreation;
  attempts: number;
}
const pending = new Map<string, PendingCreation>(); // key: mint
// A StonkFun pool is normally indexed within a minute; give it well past that
// before dropping the creation, but don't hold mints forever.
const MAX_RESOLVE_ATTEMPTS = 10;

function startFirstTokenWatch(q: QuoteToken): void {
  if (awaitingFirstToken.has(q.quoteMint)) return;
  awaitingFirstToken.set(q.quoteMint, { quote: q, addedAt: Date.now() });
  console.log(`[stonkfun] watching ${q.symbol} (${q.category}) for its first launch`);
}

export function formatStonkFunFirstTokenAlert(q: QuoteToken, d: StonkFunTokenDetails): string {
  const lines: string[] = [];
  lines.push(`🥇 <b>First token vs $${escapeHtml(q.symbol)} on StonkFun</b>  ·  ⛓ ${escapeHtml(CHAIN_LABEL)}`);
  lines.push(`<i>Inaugural launch paired to the newly-added quote asset.</i>`);
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

async function sendFirstTokenAlert(chatId: string, q: QuoteToken, d: StonkFunTokenDetails): Promise<void> {
  const bot = await getAlertsBot();
  const text = formatStonkFunFirstTokenAlert(q, d);
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
  for (const [mint, w] of awaitingFirstToken) {
    if (now - w.addedAt > WATCH_TTL_MS) {
      awaitingFirstToken.delete(mint);
      console.log(`[stonkfun] stopped watching ${w.quote.symbol} — no launch in 14 days`);
    }
  }
  if (awaitingFirstToken.size === 0) {
    pending.clear();
    return;
  }

  const creations = await fetchRecentCreations(25);
  if (creations.length === 0) return;

  if (!seeded) {
    for (const c of creations) seen.add(c.mint);
    seeded = true;
    console.log(`[stonkfun] seeded ${seen.size} existing creations (no alert on backlog)`);
    return;
  }

  // Queue anything new, oldest-first, so the true first wins if several land at once.
  const nowSec = Date.now() / 1000;
  for (const c of creations.filter((x) => !seen.has(x.mint)).reverse()) {
    seen.add(c.mint);
    if (c.timestamp > 0 && nowSec - c.timestamp > MAX_ALERT_AGE_SECONDS) continue;
    pending.set(c.mint, { creation: c, attempts: 0 });
  }
  if (seen.size > 1000) {
    seen.clear();
    for (const c of creations) seen.add(c.mint);
  }

  const queued = [...pending.values()].sort((a, b) => a.creation.timestamp - b.creation.timestamp);
  for (const p of queued) {
    const mint = p.creation.mint;
    try {
      const details = await enrichCreation(p.creation);
      if (!details.pairedAddress) {
        // Pool not indexed yet — try again next pass, then give up.
        if (++p.attempts >= MAX_RESOLVE_ATTEMPTS) {
          pending.delete(mint);
          console.log(`[stonkfun] gave up resolving pair for ${details.symbol}`);
        }
        continue;
      }

      pending.delete(mint); // pair known — this creation is settled either way
      const w = awaitingFirstToken.get(details.pairedAddress);
      if (!w) continue; // paired against something we're not watching

      awaitingFirstToken.delete(details.pairedAddress); // one ping per quote
      await broadcastAlert((chatId) => sendFirstTokenAlert(chatId, w.quote, details));
      console.log(`[stonkfun] alerted first token ${details.symbol} vs ${w.quote.symbol}`);
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
    await sendFirstTokenAlert(chatId, quote, details);
    return true;
  }
  return false;
}
