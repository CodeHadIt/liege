import {
  fetchRobinhoodStockTokens,
  fetchTokensCreatedAgainst,
  enrichCreatedToken,
  rhExplorerTokenUrl,
  type RhStockToken,
  type CreatedToken,
} from "@/lib/api/robinhood-stocks";
import {
  getLatestBlock,
  getInitializeEvents,
  getTokenMeta,
  ZERO_ADDRESS,
} from "@/lib/api/long-onchain";
import { getBot } from "./bot";
import { escapeHtml, formatCompact, formatPrice } from "./utils/format";

// Currency symbols that indicate a stock's own price pool (not a token launched
// against it) — used to skip when the "other" side of an Initialize is a currency.
const QUOTE_SYMBOLS = new Set([
  "USDG", "USDC", "USDT", "DAI", "WETH", "ETH", "WBTC", "BTC", "WBNB", "BNB", "FRAX", "PYUSD",
]);

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
    // Begin watching this newly-added stock (by lowercase address, to match
    // on-chain event topics) for its inaugural token launch.
    awaitingFirstToken.set(s.contractAddress.toLowerCase(), { symbol: s.symbol, addedAt: Date.now() });
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
  addedAt: number;
}
const awaitingFirstToken = new Map<string, FirstTokenWatch>(); // key: lowercase stock contract
const WATCH_TTL_MS = 14 * 24 * 60 * 60 * 1000; // stop watching after 14 days with no launch
// Never scan more than this many blocks in one pass (after downtime, skip the gap).
const MAX_BLOCK_SPAN = 100_000;
let lastScannedBlock: number | null = null;

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
 * Real-time watcher: scans new Uniswap V4 PoolManager `Initialize` events on
 * Robinhood Chain and pings the moment a token is paired against a stock we're
 * watching (a newly-added stock). This is the actual on-chain creation event —
 * not a post-hoc DexScreener pool index — so it fires as the pool is created.
 *
 * A stock is watched from the block we first observe it; the first Initialize
 * pairing a non-currency token with it is the inaugural launch. One ping per
 * stock, then it stops watching.
 */
export async function pollLongOnchainCreations(): Promise<void> {
  const latest = await getLatestBlock();
  if (latest == null) return;

  // Baseline on first run; also advance the cursor when nothing is being watched
  // so we never backfill a huge history once a stock is added.
  if (lastScannedBlock == null || awaitingFirstToken.size === 0) {
    lastScannedBlock = latest;
    return;
  }
  if (latest <= lastScannedBlock) return;

  const from = Math.max(lastScannedBlock + 1, latest - MAX_BLOCK_SPAN);
  const events = await getInitializeEvents(from, latest);
  lastScannedBlock = latest;
  if (events.length === 0) return;

  // Drop stale watches once per pass (not per event).
  const now = Date.now();
  for (const [addr, w] of awaitingFirstToken) {
    if (now - w.addedAt > WATCH_TTL_MS) awaitingFirstToken.delete(addr);
  }

  const chatId = alertChatId();
  const stockSet = new Set([...seen].map((a) => a.toLowerCase()));

  for (const ev of events) {
    const watchedStock = awaitingFirstToken.has(ev.currency0)
      ? ev.currency0
      : awaitingFirstToken.has(ev.currency1)
        ? ev.currency1
        : null;
    if (!watchedStock) continue;

    const other = watchedStock === ev.currency0 ? ev.currency1 : ev.currency0;
    if (other === ZERO_ADDRESS || stockSet.has(other)) continue; // native ETH / stock↔stock

    const meta = await getTokenMeta(other);
    if (!meta || QUOTE_SYMBOLS.has(meta.symbol.toUpperCase())) continue; // a currency pool

    const w = awaitingFirstToken.get(watchedStock)!;
    awaitingFirstToken.delete(watchedStock); // one ping per new stock

    if (!chatId) {
      console.log(`[long] first token ${meta.symbol} vs ${w.symbol} — alert chat not set`);
      continue;
    }
    try {
      const token: CreatedToken = {
        tokenAddress: other,
        symbol: meta.symbol,
        name: meta.name,
        dexId: "Uniswap V4",
        pairCreatedAt: Date.now(),
        onChainCreatedAt: null,
        priceUsd: null,
        liquidityUsd: null,
        marketCap: null,
        pairUrl: null,
        imageUrl: meta.iconUrl,
      };
      // best-effort market stats (may be empty for a brand-new pool)
      await sendFirstTokenAlert(chatId, w.symbol, await enrichCreatedToken(token));
      console.log(`[long] alerted first token ${meta.symbol} vs ${w.symbol} (onchain)`);
    } catch (err) {
      console.error("[long] failed to send first-token alert:", err);
    }
  }
}

/**
 * Manual test: scan a historical block range for the first on-chain Initialize
 * pairing a token with the given stock, and ping it — exercises the real
 * getInitializeEvents → getTokenMeta → alert path used by the live watcher.
 */
export async function sendOnchainFirstTokenTest(
  chatId: string,
  stockSymbol: string,
  fromBlock: number,
  toBlock: number
): Promise<boolean> {
  const stocks = await fetchRobinhoodStockTokens();
  const stock = stocks.find((s) => s.symbol.toLowerCase() === stockSymbol.toLowerCase());
  if (!stock) return false;
  const stockAddr = stock.contractAddress.toLowerCase();
  const stockSet = new Set(stocks.map((s) => s.contractAddress.toLowerCase()));

  const events = await getInitializeEvents(fromBlock, toBlock);
  for (const ev of events) {
    const isStock = ev.currency0 === stockAddr || ev.currency1 === stockAddr;
    if (!isStock) continue;
    const other = ev.currency0 === stockAddr ? ev.currency1 : ev.currency0;
    if (other === ZERO_ADDRESS || stockSet.has(other)) continue;
    const meta = await getTokenMeta(other);
    if (!meta || QUOTE_SYMBOLS.has(meta.symbol.toUpperCase())) continue;

    const token: CreatedToken = {
      tokenAddress: other, symbol: meta.symbol, name: meta.name, dexId: "Uniswap V4",
      pairCreatedAt: null, onChainCreatedAt: null, priceUsd: null, liquidityUsd: null,
      marketCap: null, pairUrl: null, imageUrl: meta.iconUrl,
    };
    await sendFirstTokenAlert(chatId, stock.symbol, await enrichCreatedToken(token));
    console.log(`[long] (test) first onchain token ${meta.symbol} vs ${stock.symbol} at block ${ev.blockNumber}`);
    return true;
  }
  return false;
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
