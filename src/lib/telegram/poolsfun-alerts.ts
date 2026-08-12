/**
 * pools.fun alerts — SushiSwap's launchpad on Robinhood Chain.
 *
 * Not to be confused with pools.trade, a different platform on the same chain.
 *
 * Same two-stage shape as every other launchpad: ping when a new pairing asset
 * is added, then report every token launched against it for 36h.
 *
 * Both halves come from the factory's own events, which makes this the strongest
 * feed of the set. `TokenLaunched` carries the token and its `pairedAsset`
 * together, atomically, in the launch transaction — so unlike StonkFun there is
 * no pool to wait on and no pair to infer, and unlike pump.fun there is no HTTP
 * dependency that can block us.
 */
import {
  getLatestBlock,
  getPairedAssetsSet,
  getPairedAssetsRemoved,
  getTokenLaunches,
  isAllowedPairedAsset,
  BASELINE_PAIRED_ASSETS,
  BASELINE_SYMBOLS,
  POOLS_FUN_URL,
  POOLS_FUN_FACTORY,
} from "@/lib/api/pools-fun";
import { getTokenMeta } from "@/lib/api/long-onchain";
import {
  enrichCreatedToken,
  rhExplorerTokenUrl,
  type CreatedToken,
} from "@/lib/api/robinhood-stocks";
import { getAlertsBot, broadcastAlert } from "./alerts-bot";
import {
  LAUNCH_WINDOW_MS,
  LAUNCH_WINDOW_LABEL,
  MAX_LAUNCHES_PER_WINDOW,
  ordinal,
} from "./launch-window";
import { escapeHtml, formatCompact, formatPrice } from "./utils/format";

const CHAIN_LABEL = "Robinhood Chain";
const PLATFORM = "pools.fun";

/**
 * Flatten a token-supplied name or symbol before it goes into an alert.
 *
 * Anyone can launch here and choose these strings, and a real launch was seen
 * with a newline inside its name. `escapeHtml` stops tags but not layout: a
 * name containing "\n📊 Market Cap: $10M" would render as its own line and read
 * as a field this bot produced. Collapsing whitespace and capping the length
 * keeps a hostile name to the one line it is supposed to occupy.
 */
function sanitizeText(s: string, max = 64): string {
  const flat = (s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Never scan more than this in one pass. After downtime the gap is skipped
 * rather than replayed — at ~0.1s blocks a long outage would otherwise mean an
 * enormous catch-up scan and a flood of stale pings.
 */
const MAX_BLOCK_SPAN = 200_000;

// ── Quote (paired) assets ────────────────────────────────────────────────────

interface WatchedAsset {
  address: string;
  symbol: string;
  name: string;
  openedAt: number;
  launchCount: number;
}

/** Assets we've already evaluated, so each is judged once. */
const seenAssets = new Set<string>(BASELINE_PAIRED_ASSETS);
/** Asset address -> open launch window. */
const watchedAssets = new Map<string, WatchedAsset>();
/** Assets whose window has run its course; never reopened by a later launch. */
const closedAssets = new Set<string>();

/**
 * Blocks a newly-watched asset needs the launch scan to cover.
 *
 * The two pollers keep independent cursors, so by the time a quote is noticed
 * the launch cursor may already have moved past the block that listed it. Any
 * token launched in that gap — including the inaugural one, which is the most
 * interesting — would be skipped. Recording the listing block here forces the
 * next launch pass to reach back far enough to catch them.
 */
let pendingBackfillBlock: number | null = null;

let quoteCursor: number | null = null;
let launchCursor: number | null = null;

export function formatPoolsFunQuoteAlert(a: WatchedAsset): string {
  const lines: string[] = [];
  lines.push(`✨ <b>New Quote Asset on ${escapeHtml(PLATFORM)}</b>  ·  ⛓ ${escapeHtml(CHAIN_LABEL)}`);
  lines.push(`<i>New tokens can now be launched paired against this asset.</i>`);
  lines.push("");
  lines.push(`<b>${escapeHtml(sanitizeText(a.name || a.symbol))}</b>  ·  <code>$${escapeHtml(sanitizeText(a.symbol, 24))}</code>`);
  lines.push(`📈 Quote asset  ·  🍣 SushiSwap launchpad  ·  ⛓ ${escapeHtml(CHAIN_LABEL)}`);
  lines.push("");
  lines.push(`<code>${escapeHtml(a.address)}</code>`);
  lines.push(
    `🔭 <a href="${rhExplorerTokenUrl(a.address)}">Blockscout</a>` +
      `  ·  🚀 <a href="${POOLS_FUN_URL}">pools.fun</a>`
  );
  lines.push("");
  lines.push(`<i>Watching launches against $${escapeHtml(sanitizeText(a.symbol, 24))} for the next ${LAUNCH_WINDOW_LABEL}.</i>`);
  return lines.join("\n");
}

async function sendQuoteAlert(chatId: string, a: WatchedAsset): Promise<void> {
  const bot = await getAlertsBot();
  await bot.api.sendMessage(chatId, formatPoolsFunQuoteAlert(a), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

/**
 * One catalog pass: alert when pools.fun allows a new pairing asset.
 *
 * WETH and USDG are the factory's base currencies — both were set in its
 * deployment block and neither is a listing — so they are suppressed by name.
 * Everything else is reported: the event carries no category to classify a stock
 * by, and an allowlist of expected stock symbols would silently swallow the
 * first listing that didn't match it.
 */
export async function pollPoolsFunQuoteAssets(): Promise<void> {
  const latest = await getLatestBlock();
  if (latest === null) return;

  if (quoteCursor === null) {
    // Seed at the head: only assets added after we came online are reported.
    quoteCursor = latest;
    console.log(`[poolsfun] seeded quote cursor at block ${latest} (${seenAssets.size} baseline assets known)`);
    return;
  }

  const from = Math.max(quoteCursor + 1, latest - MAX_BLOCK_SPAN);
  if (from > latest) return;

  const [added, removed] = await Promise.all([
    getPairedAssetsSet(from, latest),
    getPairedAssetsRemoved(from, latest),
  ]);
  // null is an RPC failure — hold the cursor rather than skip the range.
  if (added === null || removed === null) return;

  for (const ev of added) {
    if (seenAssets.has(ev.asset)) continue;
    seenAssets.add(ev.asset);

    // An asset could be set and removed inside one scan range; confirm it still
    // stands before announcing a window we'd never fill.
    const allowed = await isAllowedPairedAsset(ev.asset);
    if (allowed === false) {
      console.log(`[poolsfun] ${ev.asset} was set then removed — not alerting`);
      continue;
    }

    const meta = await getTokenMeta(ev.asset);
    const watch: WatchedAsset = {
      address: ev.asset,
      symbol: meta?.symbol ?? `${ev.asset.slice(0, 6)}…`,
      name: meta?.name ?? "",
      openedAt: Date.now(),
      launchCount: 0,
    };
    watchedAssets.set(ev.asset, watch);
    // Make sure the launch scan reaches back to the listing block itself.
    pendingBackfillBlock =
      pendingBackfillBlock === null ? ev.block : Math.min(pendingBackfillBlock, ev.block);

    console.log(`[poolsfun] watching ${watch.symbol} for launches over ${LAUNCH_WINDOW_LABEL}`);
    try {
      await broadcastAlert((chatId) => sendQuoteAlert(chatId, watch));
      console.log(`[poolsfun] alerted new quote asset: ${watch.symbol} (${ev.asset})`);
    } catch (err) {
      console.error("[poolsfun] failed to send quote-asset alert:", err);
    }
  }

  for (const ev of removed) {
    const w = watchedAssets.get(ev.asset);
    if (!w) continue;
    watchedAssets.delete(ev.asset);
    closedAssets.add(ev.asset);
    console.log(`[poolsfun] ${w.symbol} de-listed — closing window after ${w.launchCount} launch(es)`);
  }

  quoteCursor = latest;
}

// ── Launches against a watched asset ─────────────────────────────────────────

export function formatPoolsFunLaunchAlert(
  a: WatchedAsset,
  t: CreatedToken,
  creator: string,
  launchNumber: number
): string {
  const lines: string[] = [];
  const first = launchNumber <= 1;
  lines.push(
    `${first ? "🥇" : "🔁"} <b>${first ? "First" : ordinal(launchNumber)} token vs $${escapeHtml(sanitizeText(a.symbol, 24))} on ${escapeHtml(PLATFORM)}</b>` +
      `  ·  ⛓ ${escapeHtml(CHAIN_LABEL)}`
  );
  lines.push(
    first
      ? `<i>Inaugural launch paired to the newly-added quote asset.</i>`
      : `<i>Launch ${launchNumber} against this quote, inside the ${LAUNCH_WINDOW_LABEL} window.</i>`
  );
  lines.push(`🍣 Launched on <a href="${POOLS_FUN_URL}">pools.fun</a>  ·  ⛓ ${escapeHtml(CHAIN_LABEL)}`);
  lines.push("");
  lines.push(`<b>${escapeHtml(sanitizeText(t.name || t.symbol))}</b>  ·  <code>$${escapeHtml(sanitizeText(t.symbol, 24))}</code>`);
  lines.push(`🔗 <b>$${escapeHtml(sanitizeText(t.symbol, 24))}</b> ⇄ <b>$${escapeHtml(sanitizeText(a.symbol, 24))}</b>`);

  const stat: string[] = [];
  if (t.priceUsd != null) stat.push(`💵 ${escapeHtml(formatPrice(t.priceUsd))}`);
  if (t.liquidityUsd != null) stat.push(`💧 $${escapeHtml(formatCompact(t.liquidityUsd))}`);
  if (t.marketCap != null) stat.push(`📊 $${escapeHtml(formatCompact(t.marketCap))}`);
  if (stat.length) lines.push(stat.join("  ·  "));

  lines.push("");
  lines.push(`<code>${escapeHtml(t.tokenAddress)}</code>`);
  const links = [`🔭 <a href="${rhExplorerTokenUrl(t.tokenAddress)}">Blockscout</a>`];
  if (t.pairUrl) links.push(`📈 <a href="${escapeHtml(t.pairUrl)}">Chart</a>`);
  lines.push(links.join("  ·  "));
  lines.push(`👤 Dev: <code>${escapeHtml(creator)}</code>`);
  return lines.join("\n");
}

async function sendLaunchAlert(
  chatId: string,
  a: WatchedAsset,
  t: CreatedToken,
  creator: string,
  launchNumber: number
): Promise<void> {
  const bot = await getAlertsBot();
  await bot.api.sendMessage(chatId, formatPoolsFunLaunchAlert(a, t, creator, launchNumber), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

/**
 * One launch pass: report tokens launched against a watched quote asset.
 *
 * Short-circuits before any request while nothing is watched, which is the
 * normal state — pools.fun has only ever had WETH and USDG, and both are
 * baseline. Note this scan would otherwise be far from free: the factory has
 * been averaging a few hundred launches a day, essentially all against WETH.
 */
export async function pollPoolsFunLaunches(): Promise<void> {
  const now = Date.now();
  for (const [addr, w] of watchedAssets) {
    if (now - w.openedAt > LAUNCH_WINDOW_MS) {
      watchedAssets.delete(addr);
      closedAssets.add(addr);
      console.log(
        `[poolsfun] ${LAUNCH_WINDOW_LABEL} window closed for ${w.symbol} — ${w.launchCount} launch(es) reported`
      );
    }
  }
  if (watchedAssets.size === 0) {
    pendingBackfillBlock = null;
    return;
  }

  const latest = await getLatestBlock();
  if (latest === null) return;

  if (launchCursor === null) {
    launchCursor = latest;
    console.log(`[poolsfun] seeded launch cursor at block ${latest}`);
    return;
  }

  // Reach back to a newly-listed asset's own block when one is pending, so the
  // inaugural launch can't fall into the gap between the two cursors.
  const start = pendingBackfillBlock !== null
    ? Math.min(launchCursor + 1, pendingBackfillBlock)
    : launchCursor + 1;
  const from = Math.max(start, latest - MAX_BLOCK_SPAN);
  if (from > latest) return;

  const launches = await getTokenLaunches(from, latest);
  // null is an RPC failure — hold the cursor so the range is retried, not lost.
  if (launches === null) return;

  // Oldest-first so ordinals follow launch order.
  launches.sort((x, y) => x.block - y.block);

  for (const l of launches) {
    const w = watchedAssets.get(l.pairedAsset);
    if (!w) continue; // paired against WETH/USDG or something we're not watching

    if (w.launchCount >= MAX_LAUNCHES_PER_WINDOW) {
      if (w.launchCount === MAX_LAUNCHES_PER_WINDOW) {
        w.launchCount++;
        console.log(`[poolsfun] ${w.symbol} hit the ${MAX_LAUNCHES_PER_WINDOW}-launch cap — muting`);
      }
      continue;
    }

    const meta = await getTokenMeta(l.token);
    const base: CreatedToken = {
      tokenAddress: l.token,
      symbol: meta?.symbol ?? "?",
      name: meta?.name ?? "",
      dexId: "sushiswap",
      pairCreatedAt: null,
      onChainCreatedAt: null,
      priceUsd: null,
      liquidityUsd: null,
      marketCap: null,
      pairUrl: null,
      imageUrl: meta?.iconUrl ?? null,
    };
    // Market stats are best-effort: a token seconds old is usually not indexed
    // yet, and the alert is still worth sending without them.
    const enriched = await enrichCreatedToken(base).catch(() => base);

    w.launchCount++;
    try {
      await broadcastAlert((chatId) => sendLaunchAlert(chatId, w, enriched, l.creator, w.launchCount));
      console.log(`[poolsfun] alerted launch #${w.launchCount} ${enriched.symbol} vs ${w.symbol}`);
    } catch (err) {
      console.error("[poolsfun] failed to send launch alert:", err);
    }
  }

  launchCursor = latest;
  pendingBackfillBlock = null;
}

// ── Manual tests ─────────────────────────────────────────────────────────────

/**
 * Render a quote-asset alert for an arbitrary address, so the format can be
 * checked without waiting for pools.fun to list something.
 */
export async function sendPoolsFunQuoteTestPing(chatId: string, asset: string): Promise<boolean> {
  const meta = await getTokenMeta(asset);
  if (!meta) return false;
  await sendQuoteAlert(chatId, {
    address: asset.toLowerCase(),
    symbol: meta.symbol,
    name: meta.name,
    openedAt: Date.now(),
    launchCount: 0,
  });
  return true;
}

/**
 * Send a launch alert built from a REAL pools.fun launch, through the same path
 * the live watcher uses. Defaults to the most recent launch on the factory.
 */
export async function sendPoolsFunLaunchTestPing(
  chatId: string,
  launchNumber = 1
): Promise<boolean> {
  const latest = await getLatestBlock();
  if (latest === null) return false;
  // A day of blocks — the factory averages a few hundred launches a day, so this
  // reliably contains one without an unbounded scan.
  const launches = await getTokenLaunches(Math.max(0, latest - 864_000), latest);
  if (!launches || launches.length === 0) return false;

  const l = launches[launches.length - 1];
  const assetMeta = await getTokenMeta(l.pairedAsset);
  const tokenMeta = await getTokenMeta(l.token);
  const base: CreatedToken = {
    tokenAddress: l.token,
    symbol: tokenMeta?.symbol ?? "?",
    name: tokenMeta?.name ?? "",
    dexId: "sushiswap",
    pairCreatedAt: null,
    onChainCreatedAt: null,
    priceUsd: null,
    liquidityUsd: null,
    marketCap: null,
    pairUrl: null,
    imageUrl: tokenMeta?.iconUrl ?? null,
  };
  const enriched = await enrichCreatedToken(base).catch(() => base);
  await sendLaunchAlert(
    chatId,
    {
      address: l.pairedAsset,
      symbol: assetMeta?.symbol ?? BASELINE_SYMBOLS[l.pairedAsset] ?? "?",
      name: assetMeta?.name ?? "",
      openedAt: Date.now(),
      launchCount: 0,
    },
    enriched,
    l.creator,
    launchNumber
  );
  return true;
}

/** Exposed for diagnostics — which factory this feed watches. */
export const POOLS_FUN_WATCHED_FACTORY = POOLS_FUN_FACTORY;
