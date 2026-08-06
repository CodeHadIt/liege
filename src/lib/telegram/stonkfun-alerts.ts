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
import { getBot } from "./bot";
import { escapeHtml, formatCompact, formatPrice, formatTimeAgo } from "./utils/format";

// In-memory dedupe of mints we've already processed. Seeded on first poll so we
// only alert on tokens created AFTER the system comes online (not the backlog).
const seen = new Set<string>();
let seeded = false;

// Never alert on a launch older than this, even if it somehow escapes dedupe
// (e.g. after a container restart re-seeds). Keeps pings to genuinely new tokens.
const MAX_ALERT_AGE_SECONDS = 15 * 60;

function alertChatId(): string {
  return process.env.STONKFUN_ALERT_CHAT_ID || "";
}

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
  const bot = await getBot();
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
 * One poll cycle: detect new StonkFun creations and ping the configured chat.
 * Safe to call on an interval — dedupes by mint and seeds silently on first run.
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

  const chatId = alertChatId();
  const nowSec = Date.now() / 1000;
  for (const c of fresh) {
    seen.add(c.mint);
    if (c.timestamp > 0 && nowSec - c.timestamp > MAX_ALERT_AGE_SECONDS) {
      console.log(`[stonkfun] skipping stale launch ${c.symbol} (${Math.round((nowSec - c.timestamp) / 60)}m old)`);
      continue;
    }
    if (!chatId) {
      console.log(`[stonkfun] new token ${c.symbol} (${c.mint}) — STONKFUN_ALERT_CHAT_ID not set, skipping ping`);
      continue;
    }
    try {
      const details = await enrichCreation(c);
      await sendAlert(chatId, details);
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
  custom:   "⛓ On-chain Asset",
};

export function formatQuoteTokenAlert(q: QuoteToken): string {
  const lines: string[] = [];
  lines.push(`✨ <b>New Quote Token on StonkFun</b>`);
  lines.push(`<i>You can now pair new launches against this asset.</i>`);
  lines.push("");
  lines.push(`<b>${escapeHtml(q.name || q.symbol)}</b>  ·  <code>$${escapeHtml(q.symbol)}</code>`);
  lines.push(`🏷 ${escapeHtml(CATEGORY_LABEL[q.category] ?? q.category)}`);
  lines.push("");
  lines.push(`<code>${escapeHtml(q.quoteMint)}</code>`);
  lines.push(
    `🔍 <a href="https://solscan.io/token/${q.quoteMint}">Solscan</a>` +
    `  ·  🚀 <a href="${STONKFUN_BASE}/launch">Launch a token</a>`
  );
  return lines.join("\n");
}

async function sendQuoteAlert(chatId: string, q: QuoteToken): Promise<void> {
  const bot = await getBot();
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

  const chatId = alertChatId();
  for (const q of fresh) {
    seenQuotes.add(q.quoteMint);
    if (!chatId) {
      console.log(`[stonkfun] new quote token ${q.symbol} — STONKFUN_ALERT_CHAT_ID not set, skipping ping`);
      continue;
    }
    try {
      await sendQuoteAlert(chatId, q);
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
