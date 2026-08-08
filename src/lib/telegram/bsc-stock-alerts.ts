import { fetchFourMemeQuoteTokens, FOUR_MEME_CREATE_URL } from "@/lib/api/four-meme";
import {
  fetchFlapPaymentTokens,
  flapLogoUrl,
  flapLaunchUrl,
  FLAP_BSC_CHAIN_ID,
  type FlapPaymentToken,
} from "@/lib/api/flap";
import {
  getLatestBscBlock,
  getFlapLaunches,
  getFourMemeLaunches,
  getFourMemeQuote,
  getBscTokenMeta,
  ZERO_ADDRESS,
  type BscLaunch,
} from "@/lib/api/bsc-onchain";
import { fetchBscTokenStats, bscExplorerTokenUrl } from "@/lib/api/bsc-launches";
import { getAlertsBot, broadcastAlert } from "./alerts-bot";
import { escapeHtml, formatCompact, formatPrice } from "./utils/format";

// ── Tokenized-stock quote assets on BNB Chain ─────────────────────────────────
// Two launchpads let you create a token priced in a tokenized stock rather than
// a currency: Four.meme and Flap. Both draw on Binance's tokenized equities
// ("bStocks" — AAPLB, NVDAB, TSLAB…), so the same asset can appear on either.
//
// Everything here is tracked PER PLATFORM. A stock being live on Flap says
// nothing about Four.meme: the first token launched against AAPLB on Four.meme
// is its own event, and worth its own ping, even if Flap has had AAPLB for
// months. So both the quote watch and the first-token watch are keyed by
// (platform, stock).

export type Platform = "flap" | "fourmeme";

const PLATFORM_LABEL: Record<Platform, string> = {
  flap: "Flap",
  fourmeme: "Four.meme",
};
const PLATFORM_URL: Record<Platform, string> = {
  flap: flapLaunchUrl("bnb"),
  fourmeme: FOUR_MEME_CREATE_URL,
};

export interface StockQuote {
  platform: Platform;
  symbol: string;
  name: string;
  /** null for assets announced but not yet deployed */
  address: string | null;
  logoUrl: string | null;
  /** selectable as a launch quote right now */
  live: boolean;
  /** whether this is a real-world asset rather than a crypto quote */
  kind: "stock" | "other";
}

/** Stable identity across polls — symbol, since upcoming assets have no address. */
function keyOf(q: StockQuote): string {
  return `${q.platform}:${q.symbol.toLowerCase()}`;
}

// ── Classifying Four.meme's quote assets ──────────────────────────────────────
// Four.meme's catalog carries no asset class, so we lean on Flap's, which tags
// every payment token `rwa` or `crypto` and already lists ~40 bStocks including
// unlaunched ones. Matching by address (authoritative — both platforms use the
// same bStock contracts) then by symbol covers anything Flap knows about; a
// Four.meme-first listing falls through as "other" and still alerts, just
// without the stock headline.
let rwaAddresses = new Set<string>();
let rwaSymbols = new Set<string>();

function rememberRwa(flap: FlapPaymentToken[]): void {
  const addrs = new Set<string>();
  const syms = new Set<string>();
  for (const t of flap) {
    if (t.category !== "rwa") continue;
    if (t.address) addrs.add(t.address.toLowerCase());
    syms.add(t.symbol.toLowerCase());
  }
  if (addrs.size || syms.size) {
    rwaAddresses = addrs;
    rwaSymbols = syms;
  }
}

function classify(address: string | null, symbol: string): "stock" | "other" {
  if (address && rwaAddresses.has(address.toLowerCase())) return "stock";
  if (rwaSymbols.has(symbol.toLowerCase())) return "stock";
  return "other";
}

// Both launchpads file commodities under the same "rwa" bucket as equities, so
// label those accurately rather than calling tokenized gold a stock.
const COMMODITY_SYMBOLS = new Set(["XAUT", "PAXG", "XAGT"]);

function assetLabel(q: StockQuote): string {
  if (COMMODITY_SYMBOLS.has(q.symbol.toUpperCase())) return "🏷 Tokenized commodity";
  if (q.kind === "stock") return "🏷 Tokenized stock · bStocks";
  return "🏷 Quote asset";
}

// ── Fetching both catalogs into one shape ─────────────────────────────────────

async function fetchAllQuotes(): Promise<StockQuote[]> {
  const [flap, four] = await Promise.all([
    fetchFlapPaymentTokens(),
    fetchFourMemeQuoteTokens(),
  ]);

  rememberRwa(flap);

  const out: StockQuote[] = [];

  for (const t of flap) {
    // Flap serves several chains from one bundle; BNB Chain is the one that
    // carries the bStock quote assets we're tracking here.
    if (t.chainId !== FLAP_BSC_CHAIN_ID) continue;
    if (t.category !== "rwa") continue; // crypto quotes aren't the signal
    out.push({
      platform: "flap",
      symbol: t.symbol,
      name: t.name,
      address: t.address,
      logoUrl: flapLogoUrl(t.logoUrl),
      live: t.status === "available",
      kind: "stock",
    });
  }

  for (const t of four) {
    if (t.networkCode.toUpperCase() !== "BSC") continue;
    out.push({
      platform: "fourmeme",
      symbol: t.symbol,
      name: t.symbol,
      address: t.address,
      logoUrl: t.logoUrl,
      live: t.live,
      kind: classify(t.address, t.symbol),
    });
  }

  return out;
}

// ── Alert state ───────────────────────────────────────────────────────────────
// Seeded on the first poll so we never ping the existing backlog.
const seen = new Map<string, { live: boolean }>();
let seeded = false;

/**
 * Stocks awaiting their inaugural launch ON A GIVEN PLATFORM, keyed by
 * `platform:stockAddress`. The same stock can legitimately be watched twice —
 * once per launchpad — and each gets its own ping.
 */
export interface FirstTokenWatch {
  platform: Platform;
  stockAddress: string;
  symbol: string;
  name: string;
  addedAt: number;
}
const awaitingFirstToken = new Map<string, FirstTokenWatch>();
const WATCH_TTL_MS = 14 * 24 * 60 * 60 * 1000; // give up after 14 quiet days

function watchKey(platform: Platform, stockAddress: string): string {
  return `${platform}:${stockAddress.toLowerCase()}`;
}

// ── Formatting ────────────────────────────────────────────────────────────────

export function formatStockQuoteAlert(q: StockQuote, event: "listed" | "live"): string {
  const platform = PLATFORM_LABEL[q.platform];
  const lines: string[] = [];

  if (event === "live") {
    lines.push(`📈 <b>New Stock Quote live on ${escapeHtml(platform)}</b>`);
    lines.push(`<i>You can now launch a token priced in this stock.</i>`);
  } else if (q.live) {
    lines.push(`📈 <b>New Stock Quote on ${escapeHtml(platform)}</b>`);
    lines.push(`<i>Listed and already tradable as a launch pair.</i>`);
  } else {
    lines.push(`🕒 <b>Upcoming Stock Quote on ${escapeHtml(platform)}</b>`);
    lines.push(`<i>Announced as a launch pair — not tradable yet.</i>`);
  }

  lines.push("");
  lines.push(`<b>${escapeHtml(q.name)}</b>  ·  <code>$${escapeHtml(q.symbol)}</code>`);
  lines.push([assetLabel(q), "⛓ BNB Chain"].join("  ·  "));

  lines.push("");
  if (q.address) {
    lines.push(`<code>${escapeHtml(q.address)}</code>`);
    lines.push(
      `🔭 <a href="${bscExplorerTokenUrl(q.address)}">BscScan</a>` +
        `  ·  🚀 <a href="${escapeHtml(PLATFORM_URL[q.platform])}">Launch on ${escapeHtml(platform)}</a>`
    );
  } else {
    lines.push(`<i>Contract not deployed yet.</i>`);
    lines.push(`🚀 <a href="${escapeHtml(PLATFORM_URL[q.platform])}">${escapeHtml(platform)}</a>`);
  }
  return lines.join("\n");
}

export interface LaunchAlertData {
  launch: BscLaunch;
  priceUsd: number | null;
  liquidityUsd: number | null;
  marketCap: number | null;
  pairUrl: string | null;
  imageUrl: string | null;
}

export function formatBscFirstTokenAlert(w: FirstTokenWatch, d: LaunchAlertData): string {
  const platform = PLATFORM_LABEL[w.platform];
  const t = d.launch;
  const lines: string[] = [];

  lines.push(`🥇 <b>First token vs $${escapeHtml(w.symbol)} on ${escapeHtml(platform)}</b>`);
  lines.push(`<i>Inaugural launch against this stock on ${escapeHtml(platform)}.</i>`);
  lines.push(`🚀 <a href="${escapeHtml(PLATFORM_URL[w.platform])}">${escapeHtml(platform)}</a>  ·  🌱 Bonding curve just created`);
  lines.push("");
  lines.push(`<b>${escapeHtml(t.name || t.symbol || "Unknown")}</b>  ·  <code>$${escapeHtml(t.symbol || "?")}</code>`);
  lines.push(`🔗 <b>$${escapeHtml(t.symbol || "?")}</b> ⇄ <b>$${escapeHtml(w.symbol)}</b>`);

  const stat: string[] = [];
  if (d.priceUsd != null) stat.push(`💵 ${escapeHtml(formatPrice(d.priceUsd))}`);
  if (d.liquidityUsd != null) stat.push(`💧 $${escapeHtml(formatCompact(d.liquidityUsd))}`);
  if (d.marketCap != null) stat.push(`📊 $${escapeHtml(formatCompact(d.marketCap))}`);
  lines.push(stat.length ? stat.join("  ·  ") : `<i>Fresh curve — no market data indexed yet.</i>`);

  lines.push("");
  lines.push(`<code>${escapeHtml(t.tokenAddress)}</code>`);
  const links = [`🔭 <a href="${bscExplorerTokenUrl(t.tokenAddress)}">BscScan</a>`];
  if (d.pairUrl) links.push(`📈 <a href="${escapeHtml(d.pairUrl)}">Chart</a>`);
  lines.push(links.join("  ·  "));
  return lines.join("\n");
}

async function sendQuoteAlert(chatId: string, q: StockQuote, event: "listed" | "live"): Promise<void> {
  const bot = await getAlertsBot();
  const text = formatStockQuoteAlert(q, event);
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

async function sendFirstTokenAlert(chatId: string, w: FirstTokenWatch, d: LaunchAlertData): Promise<void> {
  const bot = await getAlertsBot();
  const text = formatBscFirstTokenAlert(w, d);
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

// ── Quote-catalog poller ──────────────────────────────────────────────────────

/**
 * One poll cycle over both launchpads' quote catalogs. Alerts when a stock is
 * newly listed, and again when a previously-announced one goes live. Seeds
 * silently on the first run so the existing catalog never pings.
 */
export async function pollBscStockQuotes(): Promise<void> {
  const quotes = await fetchAllQuotes();
  if (quotes.length === 0) return;

  if (!seeded) {
    for (const q of quotes) seen.set(keyOf(q), { live: q.live });
    seeded = true;
    console.log(`[bsc-stocks] seeded ${seen.size} existing quote assets (no alert on backlog)`);
    return;
  }

  for (const q of quotes) {
    const key = keyOf(q);
    const prev = seen.get(key);

    if (!prev) {
      seen.set(key, { live: q.live });
      if (q.live) startFirstTokenWatch(q);
      try {
        await broadcastAlert((chatId) => sendQuoteAlert(chatId, q, "listed"));
        console.log(`[bsc-stocks] alerted new quote: ${q.symbol} on ${q.platform} (live=${q.live})`);
      } catch (err) {
        console.error("[bsc-stocks] failed to send listing alert:", err);
      }
      continue;
    }

    // Announced earlier, now actually tradable — the moment that matters.
    if (!prev.live && q.live) {
      seen.set(key, { live: true });
      startFirstTokenWatch(q);
      try {
        await broadcastAlert((chatId) => sendQuoteAlert(chatId, q, "live"));
        console.log(`[bsc-stocks] alerted quote went live: ${q.symbol} on ${q.platform}`);
      } catch (err) {
        console.error("[bsc-stocks] failed to send go-live alert:", err);
      }
    }
  }
}

function startFirstTokenWatch(q: StockQuote): void {
  if (!q.address) return;
  const key = watchKey(q.platform, q.address);
  if (awaitingFirstToken.has(key)) return;
  awaitingFirstToken.set(key, {
    platform: q.platform,
    stockAddress: q.address.toLowerCase(),
    symbol: q.symbol,
    name: q.name,
    addedAt: Date.now(),
  });
  console.log(`[bsc-stocks] watching ${q.symbol} on ${q.platform} for its first launch`);
}

// ── On-chain first-token watcher ──────────────────────────────────────────────
// Reads bonding-curve creation events directly, so a launch is caught as the
// curve is deployed rather than whenever an indexer notices a pool. Because we
// only ever scan forward from the block a watch began, a token that launched
// before the stock was added on this platform can never be mistaken for its
// first — no backlog filtering needed.

// Never scan more than this in one pass; after downtime we skip the gap rather
// than hammer the public RPCs (and a stale launch is no longer "first" news).
const MAX_BLOCK_SPAN = 5_000;
let lastScannedBlock: number | null = null;

export async function pollBscOnchainLaunches(): Promise<void> {
  const latest = await getLatestBscBlock();
  if (latest == null) return;

  // Baseline on first run, and keep the cursor current while nothing is watched
  // so enabling a watch never triggers a huge backfill.
  if (lastScannedBlock == null || awaitingFirstToken.size === 0) {
    lastScannedBlock = latest;
    return;
  }
  if (latest <= lastScannedBlock) return;

  const from = Math.max(lastScannedBlock + 1, latest - MAX_BLOCK_SPAN);
  const to = latest;

  // Drop stale watches once per pass.
  const now = Date.now();
  for (const [key, w] of awaitingFirstToken) {
    if (now - w.addedAt > WATCH_TTL_MS) {
      awaitingFirstToken.delete(key);
      console.log(`[bsc-stocks] stopped watching ${w.symbol} on ${w.platform} — no launch in 14 days`);
    }
  }

  const watchingFlap = [...awaitingFirstToken.values()].some((w) => w.platform === "flap");
  const watchingFour = [...awaitingFirstToken.values()].some((w) => w.platform === "fourmeme");

  const launches: BscLaunch[] = [];
  try {
    // A null result means the RPCs failed, not that nothing launched — leave the
    // cursor where it is so the range is retried rather than silently skipped.
    if (watchingFlap) {
      const flap = await getFlapLaunches(from, to);
      if (flap == null) return;
      launches.push(...flap);
    }
    if (watchingFour) {
      const four = await getFourMemeLaunches(from, to);
      if (four == null) return;
      launches.push(...four);
    }
  } catch (err) {
    console.error("[bsc-stocks] launch scan failed:", err);
    return;
  }
  lastScannedBlock = to;
  if (launches.length === 0) return;

  launches.sort((a, b) => a.blockNumber - b.blockNumber);

  for (const launch of launches) {
    try {
      // Four.meme doesn't put the quote in its event; resolve it, but only for
      // launches on a platform we're still watching.
      let quote = launch.quoteAddress;
      if (!quote) {
        const stillWatching = [...awaitingFirstToken.values()].some((w) => w.platform === launch.platform);
        if (!stillWatching) continue;
        quote = (await getFourMemeQuote(launch.tokenAddress)) ?? "";
      }
      if (!quote || quote === ZERO_ADDRESS) continue; // priced in native BNB

      const key = watchKey(launch.platform, quote);
      const w = awaitingFirstToken.get(key);
      if (!w) continue;

      awaitingFirstToken.delete(key); // one ping per stock per platform

      // Flap's event carries no metadata; read it from the token itself.
      if (!launch.symbol && !launch.name) {
        const meta = await getBscTokenMeta(launch.tokenAddress);
        launch.name = meta.name;
        launch.symbol = meta.symbol;
      }

      const stats = await fetchBscTokenStats(launch.tokenAddress);
      await broadcastAlert((chatId) => sendFirstTokenAlert(chatId, w, { launch, ...stats }));
      console.log(
        `[bsc-stocks] alerted first token ${launch.symbol || launch.tokenAddress} vs ${w.symbol} on ${w.platform} (block ${launch.blockNumber})`
      );
    } catch (err) {
      console.error("[bsc-stocks] failed to handle launch:", err);
    }
  }
}

// ── Manual tests ──────────────────────────────────────────────────────────────

/** Send an existing stock quote so the listing format can be verified. */
export async function sendBscStockTestPing(chatId: string, symbol?: string): Promise<boolean> {
  const quotes = await fetchAllQuotes();
  const stocks = quotes.filter((q) => q.kind === "stock");
  if (stocks.length === 0) return false;
  const pick = symbol
    ? stocks.find((q) => q.symbol.toLowerCase() === symbol.toLowerCase())
    : stocks.find((q) => q.live) ?? stocks[0];
  if (!pick) return false;
  await sendQuoteAlert(chatId, pick, pick.live ? "live" : "listed");
  return true;
}

/**
 * Scan a historical block range for the first launch against `symbol` on a given
 * platform and ping it — exercises the real event → quote → alert path.
 */
export async function sendBscFirstTokenTestPing(
  chatId: string,
  platform: Platform,
  symbol: string,
  fromBlock: number,
  toBlock: number
): Promise<boolean> {
  const quotes = await fetchAllQuotes();
  const stock = quotes.find(
    (q) => q.platform === platform && q.symbol.toLowerCase() === symbol.toLowerCase() && q.address
  );
  if (!stock?.address) return false;
  const stockAddr = stock.address.toLowerCase();

  const launches =
    platform === "flap"
      ? await getFlapLaunches(fromBlock, toBlock)
      : await getFourMemeLaunches(fromBlock, toBlock);
  if (launches == null) return false;

  for (const launch of launches) {
    const quote = launch.quoteAddress || (await getFourMemeQuote(launch.tokenAddress)) || "";
    if (quote.toLowerCase() !== stockAddr) continue;

    if (!launch.symbol && !launch.name) {
      const meta = await getBscTokenMeta(launch.tokenAddress);
      launch.name = meta.name;
      launch.symbol = meta.symbol;
    }
    const w: FirstTokenWatch = {
      platform,
      stockAddress: stockAddr,
      symbol: stock.symbol,
      name: stock.name,
      addedAt: Date.now(),
    };
    const stats = await fetchBscTokenStats(launch.tokenAddress);
    await sendFirstTokenAlert(chatId, w, { launch, ...stats });
    return true;
  }
  return false;
}
