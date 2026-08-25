import {
  fetchBasestonkLaunches,
  resolvePairToken,
  isStockPair,
  type BasestonkLaunch,
  type PairToken,
} from "@/lib/api/basestonk";
import { getAlertsBot, broadcastAlert, FEATURE } from "./alerts-bot";
import { FEED, resolveSeen, markSeen } from "@/lib/api/feed-seen";
import {
  LAUNCH_WINDOW_MS,
  LAUNCH_WINDOW_LABEL,
  MAX_LAUNCHES_PER_WINDOW,
  ordinal,
} from "./launch-window";
import { escapeHtml, formatCompact, formatPrice, formatTimeAgo } from "./utils/format";

// ── basestonk on Base ────────────────────────────────────────────────────────
//
// Same two-stage shape as every other launchpad here — ping when a stock becomes
// pairable, then ping the tokens launched against it for 36h — with one honest
// difference in how stage one is triggered.
//
// StonkFun and o1 both publish a catalog of pairable assets, so a stock can be
// announced the moment it is REGISTERED, before anyone uses it. basestonk
// publishes no such endpoint (every plausible path 404s; the picker is built
// from an obfuscated bundle). The only authoritative statement basestonk makes
// about a pair token is a launch that used it.
//
// So discovery here is reactive: a new stock pair is announced when the first
// token launches against it. In practice both alerts fire in the same pass —
// "new stock pair" immediately followed by "1st token vs $X" — because the
// launch that reveals the pair also opens its window. What is lost versus the
// catalog platforms is only the lead time between a stock being added and being
// used, not the launches themselves.
//
// Both stages are driven from ONE poller rather than two. The pair catalog is
// derived from the launch feed, so splitting them would mean two reads of the
// same list racing to decide which came first.

const BASESTONK_URL = "https://basestonk.io";

const explorer = (a: string) => `https://basescan.org/token/${a}`;
const chart = (a: string) => `https://dexscreener.com/base/${a}`;
const tokenPage = (a: string) => `${BASESTONK_URL}/token/${a}`;

/** Never announce a launch older than this, even if a restart re-seeds. */
const MAX_ALERT_AGE_MS = 30 * 60 * 1000;

interface WatchedPair {
  pair: PairToken;
  openedAt: number;
  launchCount: number;
}

const watchedPairs = new Map<string, WatchedPair>();
/** In-memory mirror of the durable stock seen-set. */
const knownStocks = new Set<string>();
const seenLaunches = new Set<string>();
let launchesSeeded = false;

function providerLabel(p: PairToken): string {
  return p.kind === "coinbase-stock" ? "Coinbase tokenized stock" : "ST0x wrapped stock";
}

export function formatBasestonkPairAlert(p: PairToken): string {
  const lines: string[] = [];
  lines.push(`📈 <b>New stock pair on basestonk</b>  ·  ⛓ Base`);
  lines.push(`<i>Tokens can now be launched paired against this stock.</i>`);
  lines.push("");
  lines.push(`<b>$${escapeHtml(p.symbol)}</b>  ·  ${escapeHtml(p.name)}`);
  lines.push(`🏷 ${escapeHtml(providerLabel(p))}  ·  ⛓ Base`);
  lines.push("");
  lines.push(`<code>${escapeHtml(p.address)}</code>`);
  lines.push(
    `🔭 <a href="${explorer(p.address)}">Explorer</a>` +
      `  ·  🚀 <a href="${BASESTONK_URL}/create/">Launch a token</a>`
  );
  return lines.join("\n");
}

export function formatBasestonkLaunchAlert(l: BasestonkLaunch, p: PairToken, launchNumber: number): string {
  const lines: string[] = [];
  const first = launchNumber <= 1;
  lines.push(`${first ? "🥇" : "🔁"} <b>${first ? "First" : ordinal(launchNumber)} token vs $${escapeHtml(p.symbol)}</b>  ·  ⛓ Base`);
  lines.push(
    first
      ? `<i>Inaugural launch paired to the newly-added stock on basestonk.</i>`
      : `<i>Launch ${launchNumber} against this stock, inside the ${LAUNCH_WINDOW_LABEL} window.</i>`
  );
  lines.push(`🚀 Launched on <b>basestonk</b>${l.generation ? `  ·  ${escapeHtml(l.generation)}` : ""}`);
  lines.push("");
  lines.push(`<b>${escapeHtml(l.name)}</b>  ·  <code>$${escapeHtml(l.symbol)}</code>`);
  lines.push(`🔗 <b>$${escapeHtml(l.symbol)}</b> ⇄ <b>$${escapeHtml(p.symbol)}</b>`);
  lines.push("");
  if (l.priceUsd != null) lines.push(`💵 Price:  <b>${escapeHtml(formatPrice(l.priceUsd))}</b>`);
  if (l.liquidityUsd != null) lines.push(`💧 Liquidity:  <b>$${escapeHtml(formatCompact(l.liquidityUsd))}</b>`);
  if (l.marketCapUsd != null) lines.push(`📊 Market Cap:  <b>$${escapeHtml(formatCompact(l.marketCapUsd))}</b>`);
  if (l.holders != null) lines.push(`👥 Holders:  <b>${l.holders}</b>`);
  lines.push("");
  lines.push(`<code>${escapeHtml(l.address)}</code>`);
  lines.push(
    [
      `🕐 ${escapeHtml(formatTimeAgo(Math.floor(l.createdAt / 1000)))}`,
      `🔭 <a href="${explorer(l.address)}">Explorer</a>`,
      `📈 <a href="${chart(l.address)}">Chart</a>`,
      `🟦 <a href="${tokenPage(l.address)}">basestonk</a>`,
    ].join("  ·  ")
  );
  if (l.creator) lines.push(`👤 Dev: <code>${escapeHtml(l.creator)}</code>`);
  return lines.join("\n");
}

async function sendPairAlert(chatId: string, p: PairToken): Promise<void> {
  const bot = await getAlertsBot();
  await bot.api.sendMessage(chatId, formatBasestonkPairAlert(p), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

async function sendLaunchAlert(chatId: string, l: BasestonkLaunch, p: PairToken, n: number): Promise<void> {
  const bot = await getAlertsBot();
  const text = formatBasestonkLaunchAlert(l, p, n);
  if (l.imageUrl) {
    await bot.api.sendPhoto(chatId, l.imageUrl, { caption: text, parse_mode: "HTML" }).catch(async () => {
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
 * Resolve every distinct pair token in a batch of launches.
 *
 * Classification is cached per address, so after the first pass this costs
 * nothing for pairs already seen and three ERC-20 reads for a genuinely new one.
 * A pair that fails to resolve is skipped rather than treated as "not a stock" —
 * it will be retried on the next pass.
 */
async function resolvePairs(launches: BasestonkLaunch[]): Promise<Map<string, PairToken>> {
  const out = new Map<string, PairToken>();
  for (const addr of new Set(launches.map((l) => l.pairToken))) {
    const p = await resolvePairToken(addr);
    if (p) out.set(addr, p);
  }
  return out;
}

/**
 * One pass: discover stock pairs from the launch feed, then report launches
 * against the ones inside their window.
 *
 * Pair discovery runs BEFORE launch reporting so that the launch which reveals a
 * new stock finds an open window and is reported as its inaugural launch, rather
 * than being dropped for arriving a pass too early.
 */
export async function pollBasestonk(): Promise<void> {
  const now = Date.now();

  for (const [addr, w] of watchedPairs) {
    if (now - w.openedAt > LAUNCH_WINDOW_MS) {
      watchedPairs.delete(addr);
      console.log(
        `[basestonk] ${LAUNCH_WINDOW_LABEL} window closed for ${w.pair.symbol} — ${w.launchCount} launch(es) reported`
      );
    }
  }

  const launches = await fetchBasestonkLaunches(100);
  if (launches === null) return; // failed fetch — hold state
  if (launches.length === 0) return;

  const pairs = await resolvePairs(launches);
  const stocks = [...pairs.values()].filter(isStockPair);

  // ── Stage 1: stock pairs ───────────────────────────────────────────────────
  const state = await resolveSeen(FEED.BASESTONK_STOCKS, knownStocks);
  for (const k of state.seen) knownStocks.add(k);

  if (state.firstRun) {
    const keys = stocks.map((p) => p.address);
    for (const k of keys) knownStocks.add(k);
    if (!state.degraded) await markSeen(FEED.BASESTONK_STOCKS, keys);
    for (const l of launches) seenLaunches.add(l.address);
    launchesSeeded = true;
    console.log(
      `[basestonk] seeded ${keys.length} stock pairs and ${launches.length} launches (first run — no alert on backlog)`
    );
    return;
  }

  for (const p of stocks) {
    if (state.seen.has(p.address)) continue;
    knownStocks.add(p.address);
    if (!state.degraded) await markSeen(FEED.BASESTONK_STOCKS, [p.address]);

    // Open the window on the same pass, so the launch that revealed this pair is
    // reported as its inaugural launch below.
    watchedPairs.set(p.address, { pair: p, openedAt: now, launchCount: 0 });

    try {
      await broadcastAlert(FEATURE.LAUNCH, (chatId) => sendPairAlert(chatId, p));
      console.log(`[basestonk] alerted new stock pair: ${p.symbol} (${p.kind})`);
    } catch (err) {
      console.error("[basestonk] failed to send pair alert:", err);
    }
  }

  // Surface unclassified pair tokens once, so a third stock family arriving
  // shows up in the logs as a candidate instead of silently counting as crypto.
  for (const p of pairs.values()) {
    if (isStockPair(p) || knownStocks.has(p.address)) continue;
    knownStocks.add(p.address);
    console.log(`[basestonk] pair token not classified as a stock: ${p.symbol} (${p.name}, ${p.decimals}d) ${p.address}`);
  }

  // ── Stage 2: launches against watched stock pairs ──────────────────────────
  if (!launchesSeeded) {
    for (const l of launches) seenLaunches.add(l.address);
    launchesSeeded = true;
    console.log(`[basestonk] seeded ${launches.length} existing launches (no alert on backlog)`);
    return;
  }

  // Oldest-first so ordinals follow launch order.
  const fresh = launches.filter((l) => !seenLaunches.has(l.address)).sort((a, b) => a.createdAt - b.createdAt);

  for (const l of fresh) {
    seenLaunches.add(l.address);

    const w = watchedPairs.get(l.pairToken);
    if (!w) continue; // not launched against a stock we're watching

    if (now - l.createdAt > MAX_ALERT_AGE_MS) {
      console.log(
        `[basestonk] skipping stale launch ${l.symbol} (${Math.round((now - l.createdAt) / 60000)}m old)`
      );
      continue;
    }

    if (w.launchCount >= MAX_LAUNCHES_PER_WINDOW) {
      if (w.launchCount === MAX_LAUNCHES_PER_WINDOW) {
        w.launchCount++;
        console.log(`[basestonk] ${w.pair.symbol} hit the ${MAX_LAUNCHES_PER_WINDOW}-launch cap — muting`);
      }
      continue;
    }
    w.launchCount++;

    try {
      await broadcastAlert(FEATURE.LAUNCH, (chatId) => sendLaunchAlert(chatId, l, w.pair, w.launchCount));
      console.log(`[basestonk] alerted launch #${w.launchCount} ${l.symbol} vs ${w.pair.symbol}`);
    } catch (err) {
      console.error("[basestonk] failed to send launch alert:", err);
    }
  }

  if (seenLaunches.size > 5000) {
    seenLaunches.clear();
    for (const l of launches) seenLaunches.add(l.address);
  }
}

/** Manual test: render the most recent stock-paired basestonk launch. */
export async function sendBasestonkTestPing(chatId: string): Promise<boolean> {
  const launches = await fetchBasestonkLaunches(100);
  if (!launches) return false;
  const pairs = await resolvePairs(launches);
  const hit = launches.find((l) => {
    const p = pairs.get(l.pairToken);
    return p && isStockPair(p);
  });
  if (!hit) return false;
  await sendLaunchAlert(chatId, hit, pairs.get(hit.pairToken)!, 1);
  return true;
}
