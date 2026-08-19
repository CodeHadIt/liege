import {
  fetchStonkFunInternalLaunches,
  fetchStonkFunAirdrop,
  type StonkFunAirdropLaunch,
  type StonkFunAirdropDetail,
} from "@/lib/api/stonkfun";
import { getAlertsBot, broadcastAlert, FEATURE } from "./alerts-bot";
import { escapeHtml, formatCompact, formatTimeAgo, jupiterBuyUrl } from "./utils/format";

// ── StonkFun Airdrop Mode watcher ────────────────────────────────────────────
//
// Airdrop Mode holds a share of supply OUT of the pool and distributes it to
// holders of the quote token being paired against. Reward-mode launches only,
// capped at 50% of supply, recipient set snapshotted and frozen at quote time.
//
// This is a different question from the existing launch watcher, which asks
// "was this launched against an asset we are watching". Here the launch OPTION
// is the signal, whatever it paired against — so it runs as its own pass rather
// than as a filter inside the other one.
//
// Detection uses the INTERNAL feed. The public ledger exposes no airdrop flag
// and no airdrop filter, so the only alternative is one request per launch:
// establishing the feature's start date cost 1,593 of them. The internal feed
// carries `airdropBps` inline, which makes this one request per pass.

const CHAIN_LABEL = "Solana";

/**
 * When this watcher stops.
 *
 * The feature was requested as a 24h watch, so it expires rather than running
 * forever. A fixed timestamp, not "24h from process start": the latter would
 * silently extend the window on every redeploy, so a watch meant to end tonight
 * could still be running next week.
 *
 * Override with STONKFUN_AIRDROP_WATCH_UNTIL (ISO). Past it, the poller
 * no-ops — it is not an error, so it says so once and goes quiet.
 */
const DEFAULT_WATCH_UNTIL = "2026-08-19T14:00:00Z";

export function airdropWatchUntil(): number {
  const raw = process.env.STONKFUN_AIRDROP_WATCH_UNTIL || DEFAULT_WATCH_UNTIL;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : Date.parse(DEFAULT_WATCH_UNTIL);
}

/** Mints already reported, so each is announced exactly once. */
const seen = new Set<string>();
let seeded = false;
let announcedExpiry = false;

/**
 * Never announce a launch older than this, even if dedupe is reset by a
 * restart. An airdrop from hours ago is not news.
 */
const MAX_ALERT_AGE_MS = 30 * 60 * 1000;

function solscanToken(mint: string): string {
  return `https://solscan.io/token/${mint}`;
}

export function formatAirdropAlert(
  l: StonkFunAirdropLaunch,
  detail: StonkFunAirdropDetail | null
): string {
  const pct = detail?.percentOfSupply ?? l.airdropBps / 100;
  const lines: string[] = [];

  lines.push(`🪂 <b>Airdrop Mode launch on StonkFun</b>  ·  ⛓ ${escapeHtml(CHAIN_LABEL)}`);
  lines.push("");
  lines.push(`<b>${escapeHtml(l.name)}</b>  ·  <code>$${escapeHtml(l.symbol)}</code>`);
  lines.push(
    `🔗 <b>$${escapeHtml(l.symbol)}</b> ⇄ <b>$${escapeHtml(l.quoteSymbol)}</b>` +
      (l.launchpad ? `  ·  🏦 ${escapeHtml(l.launchpad)}` : "")
  );
  lines.push("");

  // The airdrop is the whole point of the alert, so it leads.
  lines.push(`🪂 <b>${escapeHtml(String(pct))}% of supply</b> airdropped to $${escapeHtml(l.quoteSymbol)} holders`);
  if (detail?.supplyTokens != null) {
    lines.push(`📦 ${escapeHtml(formatCompact(detail.supplyTokens))} tokens held out of the pool`);
  }
  if (detail?.recipientCount != null) {
    lines.push(`👥 ${escapeHtml(detail.recipientCount.toLocaleString())} recipients`);
  }
  if (l.startMarketCapUsd != null) {
    lines.push(`📊 Launch MC:  <b>$${escapeHtml(formatCompact(l.startMarketCapUsd))}</b>`);
  }

  lines.push("");
  lines.push(`<code>${escapeHtml(l.mint)}</code>`);
  const footer = [
    `🕐 ${escapeHtml(formatTimeAgo(Date.parse(l.createdAt) / 1000 || 0))}`,
    `🔍 <a href="${solscanToken(l.mint)}">Solscan</a>`,
    `📈 <a href="https://dexscreener.com/solana/${escapeHtml(l.mint)}">Chart</a>`,
  ];
  const jup = jupiterBuyUrl(l.mint);
  if (jup) footer.push(`🪐 <a href="${jup}">Buy on Jup</a>`);
  lines.push(footer.join("  ·  "));
  if (l.creator) lines.push(`👤 Dev: <code>${escapeHtml(l.creator)}</code>`);
  return lines.join("\n");
}

async function sendAirdropAlert(
  chatId: string,
  l: StonkFunAirdropLaunch,
  detail: StonkFunAirdropDetail | null
): Promise<void> {
  const bot = await getAlertsBot();
  const text = formatAirdropAlert(l, detail);
  if (l.logoUrl) {
    await bot.api
      .sendPhoto(chatId, l.logoUrl, { caption: text, parse_mode: "HTML" })
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
 * One poll: report launches that used Airdrop Mode.
 *
 * Seeds silently on the first pass. At the time this shipped there were already
 * 23 airdrop launches in the feed's window, and announcing the backlog would
 * have been 23 pings for tokens up to a day old.
 */
export async function pollStonkFunAirdropLaunches(): Promise<void> {
  if (Date.now() > airdropWatchUntil()) {
    if (!announcedExpiry) {
      console.log(
        `[stonkfun-airdrop] watch window ended (${new Date(airdropWatchUntil()).toISOString()}) — no longer alerting`
      );
      announcedExpiry = true;
    }
    return;
  }

  const launches = await fetchStonkFunInternalLaunches();
  // null is a failed fetch, not an empty feed — hold state rather than seed off
  // nothing and treat the whole backlog as new on the next pass.
  if (launches === null) return;
  if (launches.length === 0) return;

  const airdrops = launches.filter((l) => l.airdropBps > 0);

  if (!seeded) {
    for (const l of airdrops) seen.add(l.mint);
    seeded = true;
    console.log(
      `[stonkfun-airdrop] seeded ${airdrops.length} existing airdrop launches (no alert on backlog)`
    );
    return;
  }

  // Oldest-first so a burst arrives in launch order.
  const fresh = airdrops
    .filter((l) => !seen.has(l.mint))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  for (const l of fresh) {
    seen.add(l.mint);

    const age = Date.now() - (Date.parse(l.createdAt) || Date.now());
    if (age > MAX_ALERT_AGE_MS) {
      console.log(`[stonkfun-airdrop] skipping stale ${l.symbol} (${Math.round(age / 60000)}m old)`);
      continue;
    }

    // Recipient count and source come from a second endpoint. Best-effort only:
    // the alert already has everything that matters from the feed, so a slow or
    // failed lookup must not delay or drop it.
    const detail = await fetchStonkFunAirdrop(l.mint);

    try {
      await broadcastAlert(FEATURE.LAUNCH, (chatId) => sendAirdropAlert(chatId, l, detail));
      console.log(
        `[stonkfun-airdrop] alerted ${l.symbol} — ${l.airdropBps / 100}% to $${l.quoteSymbol} holders`
      );
    } catch (err) {
      console.error("[stonkfun-airdrop] failed to send alert:", err);
    }
  }

  // Keep the dedupe set bounded across a long watch.
  if (seen.size > 2000) {
    seen.clear();
    for (const l of airdrops) seen.add(l.mint);
  }
}

/** Manual test: render the most recent airdrop launch to one chat. */
export async function sendAirdropTestPing(chatId: string): Promise<boolean> {
  const launches = await fetchStonkFunInternalLaunches();
  const hit = launches?.find((l) => l.airdropBps > 0);
  if (!hit) return false;
  const detail = await fetchStonkFunAirdrop(hit.mint);
  await sendAirdropAlert(chatId, hit, detail);
  return true;
}
