import {
  fetchO1Quotes,
  fetchO1Launches,
  o1KeyConfigured,
  O1_CHAIN,
  type O1Quote,
  type O1Launch,
  type O1ChainId,
} from "@/lib/api/o1";
import { getAlertsBot, broadcastAlert, FEATURE } from "./alerts-bot";
import { FEED, resolveSeen, markSeen, type Feed } from "@/lib/api/feed-seen";
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
// Both stages read o1's public API, which needs O1_API_KEY. Without a key the
// pollers no-op with one warning rather than falling back to a guess — a stale
// hardcoded catalog is what the first version did, and it was already missing
// three stocks the day it shipped.

const O1_LAUNCH_URL = "https://launch.o1.exchange/token/create";

interface ChainConfig {
  id: O1ChainId;
  label: string;
  /** What o1 calls its stock tokens on this chain. */
  providerLabel: string;
  feed: Feed;
  explorer: (address: string) => string;
  chart: (address: string) => string;
}

const CHAINS: Record<string, ChainConfig> = {
  base: {
    id: O1_CHAIN.BASE,
    label: "Base",
    providerLabel: "Base Stock Token",
    feed: FEED.O1_BASE_STOCKS,
    explorer: (a) => `https://basescan.org/token/${a}`,
    chart: (a) => `https://dexscreener.com/base/${a}`,
  },
  rh: {
    id: O1_CHAIN.ROBINHOOD,
    label: "Robinhood Chain",
    providerLabel: "Robinhood Token",
    feed: FEED.O1_RH_STOCKS,
    explorer: (a) => `https://robinhoodchain.blockscout.com/token/${a}`,
    chart: (a) => `https://dexscreener.com/robinhood/${a}`,
  },
};

/**
 * Per-chain runtime state.
 *
 * Kept separate rather than shared: a quote address is only unique within a
 * chain, and o1 lists the same tickers on both — AAPL, NVDA and META all appear
 * on Base and Robinhood at different addresses. One shared map would let one
 * chain's window answer for the other's launch.
 */
interface ChainState {
  watchedQuotes: Map<string, WatchedQuote>;
  liveQuotes: Set<string>;
  seenLaunches: Set<string>;
  launchesSeeded: boolean;
}
const STATE = new Map<string, ChainState>();
function stateFor(key: string): ChainState {
  let s = STATE.get(key);
  if (!s) {
    s = { watchedQuotes: new Map(), liveQuotes: new Set(), seenLaunches: new Set(), launchesSeeded: false };
    STATE.set(key, s);
  }
  return s;
}

/** Never announce a launch older than this, even if a restart re-seeds. */
const MAX_ALERT_AGE_MS = 30 * 60 * 1000;

interface WatchedQuote {
  quote: O1Quote;
  openedAt: number;
  launchCount: number;
}

let warnedNoKey = false;

/** A stock, as opposed to ETH/USDC. o1 classifies these itself. */
function isStock(q: O1Quote): boolean {
  return q.route === "rwa";
}

export function formatO1QuoteAlert(q: O1Quote, c: ChainConfig): string {
  const lines: string[] = [];
  lines.push(`📈 <b>New stock pair on o1</b>  ·  ⛓ ${escapeHtml(c.label)}`);
  lines.push(`<i>You can now launch tokens paired against this stock.</i>`);
  lines.push("");
  lines.push(`<b>$${escapeHtml(q.symbol)}</b>`);
  lines.push(`🏷 ${escapeHtml(c.providerLabel)}  ·  ⛓ ${escapeHtml(c.label)}`);
  lines.push("");
  lines.push(`<code>${escapeHtml(q.address)}</code>`);
  lines.push(
    `🔭 <a href="${c.explorer(q.address)}">Explorer</a>` +
      `  ·  🚀 <a href="${O1_LAUNCH_URL}">Launch a token</a>`
  );
  return lines.join("\n");
}

export function formatO1LaunchAlert(l: O1Launch, q: O1Quote, launchNumber: number, c: ChainConfig): string {
  const lines: string[] = [];
  const first = launchNumber <= 1;
  lines.push(
    `${first ? "🥇" : "🔁"} <b>${first ? "First" : ordinal(launchNumber)} token vs $${escapeHtml(q.symbol)}</b>` +
      `  ·  ⛓ ${escapeHtml(c.label)}`
  );
  lines.push(
    first
      ? `<i>Inaugural launch paired to the newly-added stock on o1.</i>`
      : `<i>Launch ${launchNumber} against this stock, inside the ${LAUNCH_WINDOW_LABEL} window.</i>`
  );
  lines.push(`🚀 Launched on <b>o1</b>  ·  Uniswap v4 (locked)`);
  lines.push("");
  lines.push(`<b>${escapeHtml(l.name)}</b>  ·  <code>$${escapeHtml(l.symbol)}</code>`);
  lines.push(`🔗 <b>$${escapeHtml(l.symbol)}</b> ⇄ <b>$${escapeHtml(q.symbol)}</b>`);
  lines.push("");
  if (l.priceUsd != null) lines.push(`💵 Price:  <b>${escapeHtml(formatPrice(l.priceUsd))}</b>`);
  if (l.liquidityUsd != null) lines.push(`💧 Liquidity:  <b>$${escapeHtml(formatCompact(l.liquidityUsd))}</b>`);
  if (l.marketCapUsd != null) lines.push(`📊 Market Cap:  <b>$${escapeHtml(formatCompact(l.marketCapUsd))}</b>`);
  lines.push("");
  lines.push(`<code>${escapeHtml(l.tokenAddress)}</code>`);
  lines.push(
    [
      `🕐 ${escapeHtml(formatTimeAgo(Math.floor(l.createdAt / 1000)))}`,
      `🔭 <a href="${c.explorer(l.tokenAddress)}">Explorer</a>`,
      `📈 <a href="${c.chart(l.tokenAddress)}">Chart</a>`,
    ].join("  ·  ")
  );
  if (l.creator) lines.push(`👤 Dev: <code>${escapeHtml(l.creator)}</code>`);
  return lines.join("\n");
}

async function sendQuoteAlert(chatId: string, q: O1Quote, c: ChainConfig): Promise<void> {
  const bot = await getAlertsBot();
  await bot.api.sendMessage(chatId, formatO1QuoteAlert(q, c), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

async function sendLaunchAlert(chatId: string, l: O1Launch, q: O1Quote, n: number, c: ChainConfig): Promise<void> {
  const bot = await getAlertsBot();
  const text = formatO1LaunchAlert(l, q, n, c);
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

function missingKey(): boolean {
  if (o1KeyConfigured()) return false;
  if (!warnedNoKey) {
    console.warn("[o1] O1_API_KEY not set — o1 Base feeds disabled");
    warnedNoKey = true;
  }
  return true;
}

/**
 * One poll over the quote catalog: announce a stock becoming pairable and open
 * its 36h launch window.
 *
 * `selectable` is o1's own flag for "the launch form offers this", which is the
 * authoritative version of what the first implementation inferred from on-chain
 * supply. The full catalog is fetched (not `active_only`) so a stock switching
 * on is a visible transition rather than an arrival out of nowhere.
 *
 * The seen-set is persisted, so a redeploy resumes rather than re-seeding and
 * swallowing a stock that went live while the process was down.
 */
export async function pollO1Quotes(chainKey: keyof typeof CHAINS): Promise<void> {
  if (missingKey()) return;
  const c = CHAINS[chainKey];
  const st = stateFor(chainKey);

  const quotes = await fetchO1Quotes(c.id, false);
  if (quotes === null) return; // failed fetch — hold state
  const stocks = quotes.filter(isStock);
  if (stocks.length === 0) return;

  const live = stocks.filter((q) => q.selectable);

  const state = await resolveSeen(c.feed, st.liveQuotes);
  for (const k of state.seen) st.liveQuotes.add(k);

  if (state.firstRun) {
    const keys = live.map((q) => q.address);
    for (const k of keys) st.liveQuotes.add(k);
    await markSeen(c.feed, keys);
    console.log(
      `[o1:${chainKey}] seeded ${keys.length} live stock pairs of ${stocks.length} catalogued (first run — no alert on backlog)`
    );
    return;
  }

  for (const q of live) {
    if (state.seen.has(q.address)) continue;
    st.liveQuotes.add(q.address);
    await markSeen(c.feed, [q.address]);

    // Open the window on the same pass, so an inaugural launch seconds later is
    // still caught.
    st.watchedQuotes.set(q.address, { quote: q, openedAt: Date.now(), launchCount: 0 });

    try {
      await broadcastAlert(FEATURE.LAUNCH, (chatId) => sendQuoteAlert(chatId, q, c));
      console.log(`[o1:${chainKey}] alerted new Base stock pair: ${q.symbol}`);
    } catch (err) {
      console.error("[o1] failed to send quote alert:", err);
    }
  }
}

/**
 * One poll over the launch feed: report tokens launched against a watched stock.
 *
 * Every launch inside the window is reported, numbered — not only the first. The
 * burst that follows a new pair is the signal.
 */
export async function pollO1Launches(chainKey: keyof typeof CHAINS): Promise<void> {
  if (missingKey()) return;
  const c = CHAINS[chainKey];
  const st = stateFor(chainKey);

  const now = Date.now();
  for (const [addr, w] of st.watchedQuotes) {
    if (now - w.openedAt > LAUNCH_WINDOW_MS) {
      st.watchedQuotes.delete(addr);
      console.log(
        `[o1:${chainKey}] ${LAUNCH_WINDOW_LABEL} window closed for ${w.quote.symbol} — ${w.launchCount} launch(es) reported`
      );
    }
  }

  const launches = await fetchO1Launches(c.id, 50);
  if (launches === null) return; // failed fetch — hold state
  if (launches.length === 0) return;

  if (!st.launchesSeeded) {
    for (const l of launches) st.seenLaunches.add(l.tokenAddress);
    st.launchesSeeded = true;
    console.log(`[o1:${chainKey}] seeded ${launches.length} existing launches (no alert on backlog)`);
    return;
  }

  // Oldest-first so ordinals follow launch order.
  const fresh = launches
    .filter((l) => !st.seenLaunches.has(l.tokenAddress))
    .sort((a, b) => a.createdAt - b.createdAt);

  for (const l of fresh) {
    st.seenLaunches.add(l.tokenAddress);

    const w = st.watchedQuotes.get(l.quoteAddress);
    if (!w) continue; // not launched against a stock we're watching

    if (now - l.createdAt > MAX_ALERT_AGE_MS) {
      console.log(`[o1:${chainKey}] skipping stale launch ${l.symbol} (${Math.round((now - l.createdAt) / 60000)}m old)`);
      continue;
    }

    if (w.launchCount >= MAX_LAUNCHES_PER_WINDOW) {
      if (w.launchCount === MAX_LAUNCHES_PER_WINDOW) {
        w.launchCount++;
        console.log(`[o1:${chainKey}] ${w.quote.symbol} hit the ${MAX_LAUNCHES_PER_WINDOW}-launch cap — muting`);
      }
      continue;
    }
    w.launchCount++;

    try {
      await broadcastAlert(FEATURE.LAUNCH, (chatId) => sendLaunchAlert(chatId, l, w.quote, w.launchCount, c));
      console.log(`[o1:${chainKey}] alerted launch #${w.launchCount} ${l.symbol} vs ${w.quote.symbol}`);
    } catch (err) {
      console.error("[o1] failed to send launch alert:", err);
    }
  }

  if (st.seenLaunches.size > 5000) {
    st.seenLaunches.clear();
    for (const l of launches) st.seenLaunches.add(l.tokenAddress);
  }
}

/** Manual test: render the most recent stock-paired o1 launch on a chain. */
export async function sendO1TestPing(chatId: string, chainKey: keyof typeof CHAINS = "base"): Promise<boolean> {
  const c = CHAINS[chainKey];
  const [quotes, launches] = await Promise.all([
    fetchO1Quotes(c.id, false),
    fetchO1Launches(c.id, 30),
  ]);
  if (!quotes || !launches) return false;
  const byAddr = new Map(quotes.map((q) => [q.address, q]));
  const hit = launches.find((l) => byAddr.get(l.quoteAddress)?.route === "rwa");
  if (!hit) return false;
  await sendLaunchAlert(chatId, hit, byAddr.get(hit.quoteAddress)!, 1, c);
  return true;
}
