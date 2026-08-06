import {
  fetchRobinhoodStockTokens,
  fetchTokensCreatedAgainst,
  enrichCreatedToken,
  rhExplorerTokenUrl,
  type RhStockToken,
  type CreatedToken,
} from "@/lib/api/robinhood-stocks";
import { getBot } from "./bot";
import { escapeHtml, formatCompact, formatPrice } from "./utils/format";

const LONG_CREATE_URL = "https://app.long.xyz/create";

// In-memory dedupe, seeded on first poll so we only alert on stocks added after
// the system comes online.
const seen = new Set<string>();
let seeded = false;

function alertChatId(): string {
  return process.env.LONG_ALERT_CHAT_ID || process.env.STONKFUN_ALERT_CHAT_ID || "";
}

export function formatLongStockAlert(t: RhStockToken): string {
  // Names look like "Take-Two Interactive Software • Robinhood Token"
  const company = t.name.split("•")[0].trim() || t.symbol;

  const lines: string[] = [];
  lines.push(`📈 <b>New Stock on Robinhood Chain</b>`);
  lines.push(`<i>New base pair — tradable on Long.</i>`);
  lines.push("");
  lines.push(`<b>${escapeHtml(company)}</b>  ·  <code>$${escapeHtml(t.symbol)}</code>`);
  const meta = ["🏷 Stock · Robinhood Token"];
  if (t.isin) meta.push(`🔢 ${escapeHtml(t.isin)}`);
  lines.push(meta.join("  ·  "));
  lines.push("");
  lines.push(`<code>${escapeHtml(t.contractAddress)}</code>`);
  lines.push(
    `🔭 <a href="${rhExplorerTokenUrl(t.contractAddress)}">Blockscout</a>` +
    `  ·  🟢 <a href="${LONG_CREATE_URL}">Trade on Long</a>`
  );
  return lines.join("\n");
}

async function sendAlert(chatId: string, t: RhStockToken): Promise<void> {
  const bot = await getBot();
  const text = formatLongStockAlert(t);
  if (t.logoUrl) {
    await bot.api
      .sendPhoto(chatId, t.logoUrl, { caption: text, parse_mode: "HTML" })
      .catch(async () => {
        await bot.api.sendMessage(chatId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      });
  } else {
    await bot.api.sendMessage(chatId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  }
}

/**
 * One poll cycle: alert when a new tokenized stock appears on Robinhood Chain
 * (the pool Long draws its base pairs from). Seeds the existing list silently.
 */
export async function pollLongStocks(): Promise<void> {
  const stocks = await fetchRobinhoodStockTokens();
  if (stocks.length === 0) return;

  if (!seeded) {
    for (const s of stocks) seen.add(s.contractAddress);
    seeded = true;
    console.log(`[long] seeded ${seen.size} existing Robinhood stock tokens (no alert on backlog)`);
    return;
  }

  const fresh = stocks.filter((s) => !seen.has(s.contractAddress));
  if (fresh.length === 0) return;

  const chatId = alertChatId();
  for (const s of fresh) {
    seen.add(s.contractAddress);
    // Begin watching this newly-added stock for its inaugural token launch.
    awaitingFirstToken.set(s.contractAddress, { symbol: s.symbol, seen: null, addedAt: Date.now() });
    if (!chatId) {
      console.log(`[long] new stock ${s.symbol} — alert chat not set, skipping ping`);
      continue;
    }
    try {
      await sendAlert(chatId, s);
      console.log(`[long] alerted new stock: ${s.symbol} (${s.name})`);
    } catch (err) {
      console.error("[long] failed to send alert:", err);
    }
  }
}

// ── First token launched against a newly-added stock ──────────────────────────

interface FirstTokenWatch {
  symbol: string;
  /** Baseline token set at watch start (null until seeded); a token not in here is a new launch. */
  seen: Set<string> | null;
  addedAt: number;
}
const awaitingFirstToken = new Map<string, FirstTokenWatch>(); // key: stock contract
const WATCH_TTL_MS = 14 * 24 * 60 * 60 * 1000; // stop watching after 14 days with no launch

export function formatFirstTokenAlert(stockSymbol: string, t: CreatedToken): string {
  const lines: string[] = [];
  lines.push(`🥇 <b>First token vs $${escapeHtml(stockSymbol)}</b>`);
  lines.push(`<i>Inaugural launch paired to the newly-added stock.</i>`);
  lines.push("");
  lines.push(`<b>${escapeHtml(t.name || t.symbol)}</b>  ·  <code>$${escapeHtml(t.symbol)}</code>`);
  lines.push(`🔗 <b>$${escapeHtml(t.symbol)}</b> ⇄ <b>$${escapeHtml(stockSymbol)}</b>${t.dexId ? `  ·  🏦 ${escapeHtml(t.dexId)}` : ""}`);

  const stat: string[] = [];
  if (t.priceUsd != null)     stat.push(`💵 ${escapeHtml(formatPrice(t.priceUsd))}`);
  if (t.liquidityUsd != null) stat.push(`💧 $${escapeHtml(formatCompact(t.liquidityUsd))}`);
  if (t.marketCap != null)    stat.push(`📊 $${escapeHtml(formatCompact(t.marketCap))}`);
  if (stat.length) lines.push(stat.join("  ·  "));

  lines.push("");
  lines.push(`<code>${escapeHtml(t.tokenAddress)}</code>`);
  const links = [`🔭 <a href="${rhExplorerTokenUrl(t.tokenAddress)}">Blockscout</a>`];
  if (t.pairUrl) links.push(`📈 <a href="${escapeHtml(t.pairUrl)}">Chart</a>`);
  links.push(`🟢 <a href="${LONG_CREATE_URL}">Long</a>`);
  lines.push(links.join("  ·  "));
  return lines.join("\n");
}

async function sendFirstTokenAlert(chatId: string, stockSymbol: string, t: CreatedToken): Promise<void> {
  const bot = await getBot();
  const text = formatFirstTokenAlert(stockSymbol, t);
  if (t.imageUrl) {
    await bot.api
      .sendPhoto(chatId, t.imageUrl, { caption: text, parse_mode: "HTML" })
      .catch(async () => {
        await bot.api.sendMessage(chatId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      });
  } else {
    await bot.api.sendMessage(chatId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  }
}

/**
 * For each newly-added stock we're watching, detect the first token launched
 * against it and ping once. On the first pass per stock we snapshot the existing
 * tokens (baseline) so a pre-existing token is never mistaken for the inaugural
 * launch; the first token beyond the baseline is the winner.
 */
export async function pollLongFirstTokens(): Promise<void> {
  if (awaitingFirstToken.size === 0) return;
  const chatId = alertChatId();
  // Exclude other stock contracts (a stock↔stock pool isn't a launch).
  const excl = new Set([...seen].map((a) => a.toLowerCase()));

  for (const [stockAddr, w] of awaitingFirstToken) {
    if (Date.now() - w.addedAt > WATCH_TTL_MS) {
      awaitingFirstToken.delete(stockAddr);
      continue;
    }
    const tokens = await fetchTokensCreatedAgainst(stockAddr, excl);

    if (w.seen === null) {
      w.seen = new Set(tokens.map((t) => t.tokenAddress));
      continue; // baseline established this pass
    }

    const fresh = tokens.filter((t) => !w.seen!.has(t.tokenAddress));
    if (fresh.length === 0) continue;

    // The inaugural launch = earliest-created among the new tokens.
    const first = fresh.sort((a, b) => (a.pairCreatedAt ?? 0) - (b.pairCreatedAt ?? 0))[0];
    awaitingFirstToken.delete(stockAddr); // one ping per new stock

    if (!chatId) {
      console.log(`[long] first token ${first.symbol} vs ${w.symbol} — alert chat not set`);
      continue;
    }
    try {
      await sendFirstTokenAlert(chatId, w.symbol, await enrichCreatedToken(first));
      console.log(`[long] alerted first token ${first.symbol} vs ${w.symbol}`);
    } catch (err) {
      console.error("[long] failed to send first-token alert:", err);
    }
  }
}

/** Manual test: send an existing stock so the format can be verified. */
export async function sendLongTestPing(chatId: string, symbol?: string): Promise<boolean> {
  const stocks = await fetchRobinhoodStockTokens();
  if (stocks.length === 0) return false;
  const pick = symbol ? stocks.find((s) => s.symbol.toLowerCase() === symbol.toLowerCase()) : stocks[0];
  await sendAlert(chatId, pick ?? stocks[0]);
  return true;
}

/** Manual test: send the FIRST token launched against a given stock. */
export async function sendFirstTokenTestPing(chatId: string, stockSymbol: string): Promise<boolean> {
  const stocks = await fetchRobinhoodStockTokens();
  const stock = stocks.find((s) => s.symbol.toLowerCase() === stockSymbol.toLowerCase());
  if (!stock) return false;
  const excl = new Set(stocks.map((s) => s.contractAddress.toLowerCase()));
  const tokens = await fetchTokensCreatedAgainst(stock.contractAddress, excl);
  if (tokens.length === 0) return false;
  // fetchTokensCreatedAgainst returns oldest-first → [0] is the first launch
  await sendFirstTokenAlert(chatId, stock.symbol, await enrichCreatedToken(tokens[0]));
  return true;
}
