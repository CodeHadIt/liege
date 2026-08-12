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
  resolveLaunchpad,
  ZERO_ADDRESS,
  type Launchpad,
} from "@/lib/api/long-onchain";
import {
  fetchFlapPaymentTokens,
  flapLogoUrl,
  flapLaunchUrl,
  FLAP_ROBINHOOD_CHAIN_ID,
  type FlapPaymentToken,
} from "@/lib/api/flap";
import { getAlertsBot, broadcastAlert } from "./alerts-bot";
import {
  LAUNCH_WINDOW_MS,
  LAUNCH_WINDOW_LABEL,
  MAX_LAUNCHES_PER_WINDOW,
  ordinal,
} from "./launch-window";
import { escapeHtml, formatCompact, formatPrice } from "./utils/format";

// Currency symbols that indicate a stock's own price pool (not a token launched
// against it) — used to skip when the "other" side of an Initialize is a currency.
const QUOTE_SYMBOLS = new Set([
  "USDG", "USDC", "USDT", "DAI", "WETH", "ETH", "WBTC", "BTC", "WBNB", "BNB", "FRAX", "PYUSD",
]);

const LONG_CREATE_URL = "https://app.long.xyz/create";

// Flap ships the same launchpad — and overlapping stocks — on both Robinhood
// Chain and BNB Chain, so alerts from this file name the chain explicitly.
// The BNB Chain side lives in bsc-stock-alerts.ts and labels itself the same way.
const CHAIN_LABEL = "Robinhood Chain";

// In-memory dedupe, seeded on first poll so we only alert on stocks added after
// the system comes online.
const seen = new Set<string>();
let seeded = false;

export function formatLongStockAlert(t: RhStockToken): string {
  // Names look like "Take-Two Interactive Software • Robinhood Token"
  const company = t.name.split("•")[0].trim() || t.symbol;

  const lines: string[] = [];
  lines.push(`📈 <b>New Stock on ${escapeHtml(CHAIN_LABEL)}</b>`);
  lines.push(`<i>New base pair — tradable on Long.</i>`);
  lines.push("");
  lines.push(`<b>${escapeHtml(company)}</b>  ·  <code>$${escapeHtml(t.symbol)}</code>`);
  const meta = ["🏷 Stock · Robinhood Token", `⛓ ${CHAIN_LABEL}`];
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
  const bot = await getAlertsBot();
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

  for (const s of fresh) {
    seen.add(s.contractAddress);
    // Begin watching this newly-added stock (by lowercase address, to match
    // on-chain event topics) for its inaugural token launch.
    watchedStocks.set(s.contractAddress.toLowerCase(), { symbol: s.symbol, openedAt: Date.now(), launchCount: 0 });
    try {
      await broadcastAlert((chatId) => sendAlert(chatId, s));
      console.log(`[long] alerted new stock: ${s.symbol} (${s.name})`);
    } catch (err) {
      console.error("[long] failed to send alert:", err);
    }
  }
}

// ── First token launched against a newly-added stock ──────────────────────────

interface WatchedStock {
  symbol: string;
  openedAt: number;
  launchCount: number;
}
// Every launch against a newly-added stock is reported for a fixed window, not
// just the inaugural one — the burst that follows a new pair is the signal.
const watchedStocks = new Map<string, WatchedStock>(); // key: lowercase stock contract
// Never scan more than this many blocks in one pass (after downtime, skip the gap).
const MAX_BLOCK_SPAN = 100_000;
let lastScannedBlock: number | null = null;

function formatLaunchpadLine(p: Launchpad): string {
  const verb = p.via ? "Launched via" : "Launched on";
  const label = p.url
    ? `<a href="${escapeHtml(p.url)}">${escapeHtml(p.name)}</a>`
    : `<b>${escapeHtml(p.name)}</b>`;
  return `🚀 ${verb} ${label}`;
}

export function formatFirstTokenAlert(
  stockSymbol: string,
  t: CreatedToken,
  platform?: Launchpad,
  launchNumber = 1
): string {
  const lines: string[] = [];
  const first = launchNumber <= 1;
  lines.push(
    `${first ? "🥇" : "🔁"} <b>${first ? "First" : ordinal(launchNumber)} token vs $${escapeHtml(stockSymbol)}</b>` +
      `  ·  ⛓ ${escapeHtml(CHAIN_LABEL)}`
  );
  lines.push(
    first
      ? `<i>Inaugural launch paired to the newly-added stock on ${escapeHtml(CHAIN_LABEL)}.</i>`
      : `<i>Launch ${launchNumber} against this stock, inside the ${LAUNCH_WINDOW_LABEL} window.</i>`
  );
  if (platform) lines.push(`${formatLaunchpadLine(platform)}  ·  ⛓ ${escapeHtml(CHAIN_LABEL)}`);
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

async function sendLaunchAlert(
  chatId: string,
  stockSymbol: string,
  t: CreatedToken,
  launchNumber: number,
  platform?: Launchpad
): Promise<void> {
  const bot = await getAlertsBot();
  const text = formatFirstTokenAlert(stockSymbol, t, platform, launchNumber);
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
  if (lastScannedBlock == null || watchedStocks.size === 0) {
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
  for (const [addr, w] of watchedStocks) {
    if (now - w.openedAt > LAUNCH_WINDOW_MS) {
      watchedStocks.delete(addr);
      console.log(`[long] ${LAUNCH_WINDOW_LABEL} window closed for ${w.symbol} — ${w.launchCount} launch(es) reported`);
    }
  }

  // Every stock we know of on this chain, from either source — a pool pairing
  // two of them is not a launch.
  const stockSet = new Set([...seen, ...flapStockAddresses].map((a) => a.toLowerCase()));

  for (const ev of events) {
    const watchedStock = watchedStocks.has(ev.currency0)
      ? ev.currency0
      : watchedStocks.has(ev.currency1)
        ? ev.currency1
        : null;
    if (!watchedStock) continue;

    const other = watchedStock === ev.currency0 ? ev.currency1 : ev.currency0;
    if (other === ZERO_ADDRESS || stockSet.has(other)) continue; // native ETH / stock↔stock

    const meta = await getTokenMeta(other);
    if (!meta || QUOTE_SYMBOLS.has(meta.symbol.toUpperCase())) continue; // a currency pool

    const w = watchedStocks.get(watchedStock)!;
    if (w.launchCount >= MAX_LAUNCHES_PER_WINDOW) {
      if (w.launchCount === MAX_LAUNCHES_PER_WINDOW) {
        w.launchCount++;
        console.log(`[long] ${w.symbol} hit the ${MAX_LAUNCHES_PER_WINDOW}-launch cap — muting`);
      }
      continue;
    }
    w.launchCount++;

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
      // identify which launchpad created the pool (best-effort)
      const platform = await resolveLaunchpad(ev.hooks, ev.txHash, other);
      // best-effort market stats (may be empty for a brand-new pool)
      const enriched = await enrichCreatedToken(token);
      await broadcastAlert((chatId) => sendLaunchAlert(chatId, w.symbol, enriched, w.launchCount, platform));
      console.log(`[long] alerted launch #${w.launchCount} ${meta.symbol} vs ${w.symbol} on ${platform.name}`);
    } catch (err) {
      console.error("[long] failed to send first-token alert:", err);
    }
  }
}

// ── Flap on Robinhood Chain ───────────────────────────────────────────────────
// Long isn't the only launchpad pricing tokens in tokenized stocks on Robinhood
// Chain — Flap runs there too, with its own quote catalog. That catalog is not
// a subset of Robinhood's asset registry (it carries third-party issues such as
// HOODon), so it's a genuinely additional source of "a new stock is tradable".
// New Flap stocks feed the same on-chain first-token watcher as registry ones.

const flapSeen = new Set<string>(); // lowercase addresses, dedupe for alerts
const flapStockAddresses = new Set<string>(); // union'd into the on-chain stock filter
let flapSeeded = false;

export function formatFlapRhStockAlert(t: FlapPaymentToken): string {
  // Names look like "Apple • Robinhood Token" — keep the company, drop the issuer.
  const company = t.name.split("•")[0].trim() || t.symbol;

  const lines: string[] = [];
  lines.push(`📈 <b>New Stock Quote on Flap</b>  ·  ⛓ ${escapeHtml(CHAIN_LABEL)}`);
  lines.push(`<i>Tradable as a launch pair on ${escapeHtml(CHAIN_LABEL)}.</i>`);
  lines.push("");
  lines.push(`<b>${escapeHtml(company)}</b>  ·  <code>$${escapeHtml(t.symbol)}</code>`);
  lines.push(`🏷 Tokenized stock  ·  ⛓ ${escapeHtml(CHAIN_LABEL)}`);
  lines.push("");
  if (t.address) {
    lines.push(`<code>${escapeHtml(t.address)}</code>`);
    lines.push(
      `🔭 <a href="${rhExplorerTokenUrl(t.address)}">Blockscout</a>` +
        `  ·  🚀 <a href="${escapeHtml(flapLaunchUrl("robinhood"))}">Launch on Flap</a>`
    );
  } else {
    lines.push(`<i>Contract not deployed yet.</i>`);
    lines.push(`🚀 <a href="${escapeHtml(flapLaunchUrl("robinhood"))}">Flap</a>`);
  }
  return lines.join("\n");
}

async function sendFlapRhAlert(chatId: string, t: FlapPaymentToken): Promise<void> {
  const bot = await getAlertsBot();
  const text = formatFlapRhStockAlert(t);
  const logo = flapLogoUrl(t.logoUrl);
  if (logo) {
    await bot.api
      .sendPhoto(chatId, logo, { caption: text, parse_mode: "HTML" })
      .catch(async () => {
        await bot.api.sendMessage(chatId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      });
  } else {
    await bot.api.sendMessage(chatId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  }
}

/**
 * One poll cycle over Flap's Robinhood Chain quote catalog. Alerts on newly
 * listed tokenized stocks and hands them to the on-chain first-token watcher.
 * Seeds silently on first run.
 */
export async function pollFlapRobinhoodStocks(): Promise<void> {
  const all = await fetchFlapPaymentTokens();
  const stocks = all.filter(
    (t) => t.chainId === FLAP_ROBINHOOD_CHAIN_ID && t.category === "rwa" && t.status === "available"
  );
  if (stocks.length === 0) return;

  for (const s of stocks) {
    if (s.address) flapStockAddresses.add(s.address.toLowerCase());
  }

  if (!flapSeeded) {
    for (const s of stocks) flapSeen.add(s.address ?? s.symbol.toLowerCase());
    flapSeeded = true;
    console.log(`[long] seeded ${flapSeen.size} existing Flap stock quotes on Robinhood Chain`);
    return;
  }

  for (const s of stocks) {
    const key = s.address ?? s.symbol.toLowerCase();
    if (flapSeen.has(key)) continue;
    flapSeen.add(key);

    if (s.address) {
      // Watch for the inaugural launch, same as a registry-sourced stock.
      watchedStocks.set(s.address.toLowerCase(), { symbol: s.symbol, openedAt: Date.now(), launchCount: 0 });
    }
    try {
      await broadcastAlert((chatId) => sendFlapRhAlert(chatId, s));
      console.log(`[long] alerted new Flap stock quote: ${s.symbol} (${s.name})`);
    } catch (err) {
      console.error("[long] failed to send Flap stock alert:", err);
    }
  }
}

/** Manual test: send an existing Flap Robinhood-chain stock to verify the format. */
export async function sendFlapRhTestPing(chatId: string, symbol?: string): Promise<boolean> {
  const all = await fetchFlapPaymentTokens();
  const stocks = all.filter((t) => t.chainId === FLAP_ROBINHOOD_CHAIN_ID && t.category === "rwa");
  if (stocks.length === 0) return false;
  const pick = symbol ? stocks.find((s) => s.symbol.toLowerCase() === symbol.toLowerCase()) : stocks[0];
  if (!pick) return false;
  await sendFlapRhAlert(chatId, pick);
  return true;
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
    const platform = await resolveLaunchpad(ev.hooks, ev.txHash, other);
    await sendLaunchAlert(chatId, stock.symbol, await enrichCreatedToken(token), 1, platform);
    console.log(`[long] (test) first onchain token ${meta.symbol} vs ${stock.symbol} on ${platform.name} at block ${ev.blockNumber}`);
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
  await sendLaunchAlert(chatId, stock.symbol, await enrichCreatedToken(tokens[0]), 1);
  return true;
}
