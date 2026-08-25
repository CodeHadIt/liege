import {
  O1_BASE_STOCKS,
  O1_BASE_CRYPTO_QUOTES,
  fetchO1BaseLaunches,
  fetchO1StockSupplies,
  o1StockByAddress,
  type O1Launch,
  type O1Stock,
} from "@/lib/api/o1-base";
import { getAlertsBot, broadcastAlert, FEATURE } from "./alerts-bot";
import { FEED, resolveSeen, markSeen } from "@/lib/api/feed-seen";
import {
  LAUNCH_WINDOW_MS,
  LAUNCH_WINDOW_LABEL,
  MAX_LAUNCHES_PER_WINDOW,
  ordinal,
} from "./launch-window";
import { escapeHtml, formatCompact, formatPrice, formatTimeAgo } from "./utils/format";

// ── o1 exchange on Base ──────────────────────────────────────────────────────
//
// Same two-stage shape as every other launchpad here: ping when a stock becomes
// pairable, then ping the tokens launched against it for 36h.
//
// What differs is how "pairable" is detected. o1's site is behind a Vercel
// checkpoint that 429s every non-browser request, so the catalog cannot be
// scraped on a schedule. Instead the ten Base Stock Tokens are known statically
// and their liveness is read on-chain: a stock is pairable once its token has
// supply. All ten are deployed and all ten have fresh prices, so neither of
// those distinguishes them — supply does, and it matches o1's launch form
// exactly.

const CHAIN_LABEL = "Base";
const O1_LAUNCH_URL = "https://launch.o1.exchange/token/create";

/** Never announce a launch older than this, even if a restart re-seeds. */
const MAX_ALERT_AGE_MS = 30 * 60 * 1000;

interface WatchedStock {
  stock: O1Stock;
  openedAt: number;
  launchCount: number;
}
const watchedStocks = new Map<string, WatchedStock>(); // key: lowercase address

/** Stocks known live, so only a transition is announced. */
const liveStocks = new Set<string>();
/** Launch tokens already reported. */
const seenLaunches = new Set<string>();
/** Quote addresses already warned about as unknown, so the log is not spammed. */
const warnedUnknownQuotes = new Set<string>();

function baseScanToken(address: string): string {
  return `https://basescan.org/token/${address}`;
}

export function formatO1StockAlert(s: O1Stock, supply: number): string {
  const lines: string[] = [];
  lines.push(`📈 <b>New stock pair on o1</b>  ·  ⛓ ${escapeHtml(CHAIN_LABEL)}`);
  lines.push(`<i>You can now launch tokens paired against this stock.</i>`);
  lines.push("");
  lines.push(`<b>${escapeHtml(s.name)}</b>  ·  <code>$${escapeHtml(s.symbol)}</code>`);
  lines.push(`🏷 Base Stock Token  ·  ⛓ ${escapeHtml(CHAIN_LABEL)}`);
  lines.push(`🪙 Supply live: <b>${escapeHtml(formatCompact(supply))}</b>`);
  lines.push("");
  lines.push(`<code>${escapeHtml(s.address)}</code>`);
  lines.push(
    `🔭 <a href="${baseScanToken(s.address)}">Basescan</a>` +
      `  ·  🚀 <a href="${O1_LAUNCH_URL}">Launch a token</a>`
  );
  return lines.join("\n");
}

export function formatO1LaunchAlert(l: O1Launch, stock: O1Stock, launchNumber: number): string {
  const lines: string[] = [];
  const first = launchNumber <= 1;
  lines.push(
    `${first ? "🥇" : "🔁"} <b>${first ? "First" : ordinal(launchNumber)} token vs $${escapeHtml(stock.symbol)}</b>` +
      `  ·  ⛓ ${escapeHtml(CHAIN_LABEL)}`
  );
  lines.push(
    first
      ? `<i>Inaugural launch paired to the newly-added stock on o1.</i>`
      : `<i>Launch ${launchNumber} against this stock, inside the ${LAUNCH_WINDOW_LABEL} window.</i>`
  );
  lines.push(`🚀 Launched on <b>o1</b>  ·  Uniswap v4 (locked)`);
  lines.push("");
  lines.push(`<b>${escapeHtml(l.name)}</b>  ·  <code>$${escapeHtml(l.symbol)}</code>`);
  lines.push(`🔗 <b>$${escapeHtml(l.symbol)}</b> ⇄ <b>$${escapeHtml(stock.symbol)}</b>`);
  lines.push("");
  if (l.priceUsd != null) lines.push(`💵 Price:  <b>${escapeHtml(formatPrice(l.priceUsd))}</b>`);
  if (l.liquidityUsd != null) lines.push(`💧 Liquidity:  <b>$${escapeHtml(formatCompact(l.liquidityUsd))}</b>`);
  if (l.marketCapUsd != null) lines.push(`📊 Market Cap:  <b>$${escapeHtml(formatCompact(l.marketCapUsd))}</b>`);
  lines.push("");
  lines.push(`<code>${escapeHtml(l.tokenAddress)}</code>`);
  const footer = [
    `🕐 ${escapeHtml(formatTimeAgo(Math.floor(l.createdAt / 1000)))}`,
    `🔭 <a href="${baseScanToken(l.tokenAddress)}">Basescan</a>`,
    `📈 <a href="https://dexscreener.com/base/${escapeHtml(l.tokenAddress)}">Chart</a>`,
  ];
  lines.push(footer.join("  ·  "));
  if (l.creator) lines.push(`👤 Dev: <code>${escapeHtml(l.creator)}</code>`);
  return lines.join("\n");
}

async function sendStockAlert(chatId: string, s: O1Stock, supply: number): Promise<void> {
  const bot = await getAlertsBot();
  await bot.api.sendMessage(chatId, formatO1StockAlert(s, supply), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

async function sendLaunchAlert(
  chatId: string,
  l: O1Launch,
  stock: O1Stock,
  n: number
): Promise<void> {
  const bot = await getAlertsBot();
  const text = formatO1LaunchAlert(l, stock, n);
  if (l.imageUrl) {
    await bot.api
      .sendPhoto(chatId, l.imageUrl, { caption: text, parse_mode: "HTML" })
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
 * One poll over the stock catalog: announce a stock becoming pairable and open
 * its 36h launch window.
 *
 * The seen-set is persisted, so a redeploy resumes rather than re-seeding and
 * silently swallowing a stock that went live while the process was down — the
 * failure that lost HOODon on Flap.
 */
export async function pollO1BaseStocks(): Promise<void> {
  const supplies = await fetchO1StockSupplies();
  if (supplies.size === 0) return; // every RPC failed — hold state

  const live = O1_BASE_STOCKS.filter((s) => (supplies.get(s.address) ?? 0) > 0);
  if (live.length === 0) return;

  const state = await resolveSeen(FEED.O1_BASE_STOCKS, liveStocks);
  for (const k of state.seen) liveStocks.add(k);

  if (state.firstRun) {
    const keys = live.map((s) => s.address);
    for (const k of keys) liveStocks.add(k);
    await markSeen(FEED.O1_BASE_STOCKS, keys);
    console.log(`[o1] seeded ${keys.length} live Base stock pairs (first run — no alert on backlog)`);
    return;
  }

  for (const s of live) {
    if (state.seen.has(s.address)) continue;
    liveStocks.add(s.address);
    await markSeen(FEED.O1_BASE_STOCKS, [s.address]);

    // Open the launch window on the same pass, so the inaugural launch is caught
    // even if it lands seconds later.
    watchedStocks.set(s.address, { stock: s, openedAt: Date.now(), launchCount: 0 });

    try {
      const supply = supplies.get(s.address) ?? 0;
      await broadcastAlert(FEATURE.LAUNCH, (chatId) => sendStockAlert(chatId, s, supply));
      console.log(`[o1] alerted new Base stock pair: ${s.symbol} (${s.name})`);
    } catch (err) {
      console.error("[o1] failed to send stock alert:", err);
    }
  }
}

/**
 * One poll over the launch feed: report tokens launched against a watched stock.
 *
 * Every launch inside the window is reported, numbered — not only the first. The
 * burst that follows a new pair is the signal.
 */
export async function pollO1BaseLaunches(): Promise<void> {
  const now = Date.now();
  for (const [addr, w] of watchedStocks) {
    if (now - w.openedAt > LAUNCH_WINDOW_MS) {
      watchedStocks.delete(addr);
      console.log(
        `[o1] ${LAUNCH_WINDOW_LABEL} window closed for ${w.stock.symbol} — ${w.launchCount} launch(es) reported`
      );
    }
  }

  const launches = await fetchO1BaseLaunches(50);
  if (launches === null) return; // failed fetch — hold state
  if (launches.length === 0) return;

  // Surface catalog drift. o1's site cannot be polled, so the stock list is
  // static; a launch against a quote that is neither a known stock nor a crypto
  // quote means o1 added one and this list needs extending.
  for (const l of launches) {
    if (o1StockByAddress(l.quoteAddress)) continue;
    if (O1_BASE_CRYPTO_QUOTES.has(l.quoteAddress)) continue;
    if (warnedUnknownQuotes.has(l.quoteAddress)) continue;
    warnedUnknownQuotes.add(l.quoteAddress);
    console.warn(
      `[o1] UNKNOWN quote ${l.quoteSymbol} (${l.quoteAddress}) — not in O1_BASE_STOCKS, catalog may need updating`
    );
  }

  if (seenLaunches.size === 0) {
    for (const l of launches) seenLaunches.add(l.tokenAddress);
    console.log(`[o1] seeded ${launches.length} existing launches (no alert on backlog)`);
    return;
  }

  // Oldest-first so ordinals follow launch order.
  const fresh = launches
    .filter((l) => !seenLaunches.has(l.tokenAddress))
    .sort((a, b) => a.createdAt - b.createdAt);

  for (const l of fresh) {
    seenLaunches.add(l.tokenAddress);

    const w = watchedStocks.get(l.quoteAddress);
    if (!w) continue; // not launched against a stock we're watching

    if (now - l.createdAt > MAX_ALERT_AGE_MS) {
      console.log(`[o1] skipping stale launch ${l.symbol} (${Math.round((now - l.createdAt) / 60000)}m old)`);
      continue;
    }

    if (w.launchCount >= MAX_LAUNCHES_PER_WINDOW) {
      if (w.launchCount === MAX_LAUNCHES_PER_WINDOW) {
        w.launchCount++;
        console.log(`[o1] ${w.stock.symbol} hit the ${MAX_LAUNCHES_PER_WINDOW}-launch cap — muting`);
      }
      continue;
    }
    w.launchCount++;

    try {
      await broadcastAlert(FEATURE.LAUNCH, (chatId) => sendLaunchAlert(chatId, l, w.stock, w.launchCount));
      console.log(`[o1] alerted launch #${w.launchCount} ${l.symbol} vs ${w.stock.symbol}`);
    } catch (err) {
      console.error("[o1] failed to send launch alert:", err);
    }
  }

  if (seenLaunches.size > 5000) {
    seenLaunches.clear();
    for (const l of launches) seenLaunches.add(l.tokenAddress);
  }
}

/** Manual test: render the most recent o1 Base launch. */
export async function sendO1TestPing(chatId: string): Promise<boolean> {
  const launches = await fetchO1BaseLaunches(20);
  const hit = launches?.find((l) => o1StockByAddress(l.quoteAddress));
  if (!hit) return false;
  await sendLaunchAlert(chatId, hit, o1StockByAddress(hit.quoteAddress)!, 1);
  return true;
}
