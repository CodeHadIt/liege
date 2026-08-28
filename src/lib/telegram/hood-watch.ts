import { fetchRobinhoodStockTokens, rhExplorerTokenUrl } from "@/lib/api/robinhood-stocks";
import { fetchFlapPaymentTokens, FLAP_ROBINHOOD_CHAIN_ID } from "@/lib/api/flap";
import { fetchO1Quotes, o1KeyConfigured, O1_CHAIN } from "@/lib/api/o1";
import { getAlertsBot, broadcastAlert, FEATURE } from "./alerts-bot";
import { FEED, resolveSeen, markSeen } from "@/lib/api/feed-seen";
import { pinRhStock } from "./long-alerts";
import { escapeHtml } from "./utils/format";

// ── HOOD watch ───────────────────────────────────────────────────────────────
//
// Standing question: has Robinhood's OWN stock become something you can launch
// a token against?
//
// As of the last check it had not. Robinhood's asset registry lists 194
// tokenized stocks on its chain and HOOD is not among them — Robinhood has not
// tokenized itself. The only HOOD exposure on that chain is Ondo's HOODon
// (`0xfb5b…a79c`), a third-party wrapper that no launchpad offers as a quote:
// Long's picker is built from the registry, Pons has never paired against it,
// and the launches that do exist are Flap's.
//
// That makes HOOD arriving a discrete, high-value event, and this watcher exists
// to catch it the moment it happens rather than whenever someone notices. It
// checks every place the answer could change first:
//
//   1. Robinhood's official asset registry — the upstream source of truth. Long
//      builds its quote picker from it, so HOOD landing here is the event that
//      unlocks every registry-driven launchpad at once.
//   2. Flap's Robinhood-chain payment tokens — Flap curates its own quote list
//      and already carries HOODon, so it could list HOOD before the registry.
//   3. o1's Robinhood-chain quote catalog — same shape, separate catalog.
//
// Pons is deliberately absent: it publishes no readable catalog (the site
// geo-blocks and has no API), so it cannot be polled. It is covered indirectly —
// the moment HOOD is pinned below, the on-chain launch watcher reports launches
// against it regardless of which launchpad created them, Pons included.
//
// A hit is announced in ALL CAPS by request, and pins the asset for permanent,
// uncapped launch watching so the memecoins that follow are all reported.

/** Robinhood's own listing, however it is spelled. */
function isRobinhoodStock(symbol: string, name: string): boolean {
  const sym = symbol.trim().toUpperCase();
  // HOODon is Ondo's wrapper, already known and already pinned — not the event.
  if (sym === "HOODON") return false;
  if (sym === "HOOD" || sym === "HOODC") return true;
  // Catch a differently-tickered listing of the same company, without matching
  // the "• Robinhood Token" suffix every asset on the chain carries.
  const company = name.split("•")[0].trim().toLowerCase();
  return /\brobinhood\b/.test(company) && /markets|financial|inc/.test(company);
}

interface HoodHit {
  source: string;
  symbol: string;
  name: string;
  address: string | null;
  /** Where a reader can go and act on it. */
  url: string | null;
  /** Whether the venue says it is selectable right now. */
  live: boolean;
}

function formatHoodAlert(h: HoodHit): string {
  const lines: string[] = [];
  lines.push(`🚨🚨🚨 <b>ROBINHOOD STOCK IS NOW A BASE PAIR</b> 🚨🚨🚨`);
  lines.push("");
  lines.push(`<b>$${escapeHtml(h.symbol.toUpperCase())} — ${escapeHtml(h.name.toUpperCase())}</b>`);
  lines.push(`<b>SOURCE: ${escapeHtml(h.source.toUpperCase())}</b>`);
  lines.push(`<b>STATUS: ${h.live ? "LIVE — SELECTABLE NOW" : "LISTED, NOT YET SELECTABLE"}</b>`);
  lines.push("");
  if (h.address) lines.push(`<code>${escapeHtml(h.address)}</code>`);
  const links: string[] = [];
  if (h.address) links.push(`🔭 <a href="${rhExplorerTokenUrl(h.address)}">EXPLORER</a>`);
  if (h.url) links.push(`🚀 <a href="${h.url}">LAUNCH</a>`);
  if (links.length) lines.push(links.join("  ·  "));
  lines.push("");
  lines.push(`<b>THIS ASSET IS NOW PINNED — EVERY LAUNCH AGAINST IT WILL BE REPORTED.</b>`);
  return lines.join("\n");
}

async function sendHoodAlert(chatId: string, h: HoodHit): Promise<void> {
  const bot = await getAlertsBot();
  await bot.api.sendMessage(chatId, formatHoodAlert(h), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

/** In-memory mirror of the durable seen-set. */
const announced = new Set<string>();

/**
 * Collect every place HOOD could currently appear.
 *
 * Each source failing is tolerated independently — a dead Flap fetch must not
 * stop the registry check, because the registry is the one that matters most.
 */
async function collectHits(): Promise<HoodHit[]> {
  const hits: HoodHit[] = [];

  try {
    const stocks = await fetchRobinhoodStockTokens();
    for (const s of stocks) {
      if (!isRobinhoodStock(s.symbol, s.name)) continue;
      hits.push({
        source: "Robinhood asset registry",
        symbol: s.symbol,
        name: s.name.split("•")[0].trim() || s.symbol,
        address: s.contractAddress,
        url: "https://app.long.xyz/create",
        live: true,
      });
    }
  } catch (err) {
    console.error("[hood] registry check failed:", (err as Error).message);
  }

  try {
    const all = await fetchFlapPaymentTokens();
    // Include "coming-soon" as well as "available": a stock Flap has announced
    // but not switched on is exactly the "in the catalog but not yet live" case
    // worth knowing about early. `live` carries the distinction.
    for (const t of all) {
      if (t.chainId !== FLAP_ROBINHOOD_CHAIN_ID) continue;
      if (!isRobinhoodStock(t.symbol, t.name)) continue;
      hits.push({
        source: "Flap (Robinhood Chain)",
        symbol: t.symbol,
        name: t.name,
        address: t.address ? t.address.toLowerCase() : null,
        url: "https://flap.sh/launch?chain=robinhood&lang=en",
        live: t.status === "available",
      });
    }
  } catch (err) {
    console.error("[hood] flap check failed:", (err as Error).message);
  }

  if (o1KeyConfigured()) {
    try {
      const quotes = await fetchO1Quotes(O1_CHAIN.ROBINHOOD, false);
      for (const q of quotes ?? []) {
        if (!isRobinhoodStock(q.symbol, q.symbol)) continue;
        hits.push({
          source: "o1 (Robinhood Chain)",
          symbol: q.symbol,
          name: q.symbol,
          address: q.address,
          url: "https://launch.o1.exchange/token/create",
          live: q.selectable,
        });
      }
    } catch (err) {
      console.error("[hood] o1 check failed:", (err as Error).message);
    }
  }

  return hits;
}

/**
 * One pass of the HOOD watch.
 *
 * Deliberately does NOT seed silently on first run. Every other catalog watcher
 * does, because their job is to report change against a large existing list. The
 * whole point here is that the list is currently EMPTY: if HOOD is present on
 * the very first pass, that is the news, not a backlog to absorb. Seeding would
 * swallow exactly the event this exists to catch.
 */
export async function pollHoodWatch(): Promise<void> {
  const hits = await collectHits();
  if (hits.length === 0) return;

  const state = await resolveSeen(FEED.HOOD_WATCH, announced);
  for (const k of state.seen) announced.add(k);

  for (const h of hits) {
    // Key on source+asset: HOOD appearing on Flap after the registry is its own
    // event, and worth its own ping.
    const key = `${h.source}:${(h.address ?? h.symbol).toLowerCase()}`;
    if (state.seen.has(key)) continue;

    announced.add(key);
    if (!state.degraded) await markSeen(FEED.HOOD_WATCH, [key]);

    // Pin before announcing, so a launch seconds later is already covered.
    if (h.address) pinRhStock(h.address, h.symbol.toUpperCase());

    try {
      await broadcastAlert(FEATURE.LAUNCH, (chatId) => sendHoodAlert(chatId, h));
      console.log(`[hood] ALERTED: ${h.symbol} via ${h.source} (${h.address ?? "no address"})`);
    } catch (err) {
      console.error("[hood] failed to send alert:", err);
    }
  }
}

/** Manual test: render the alert for a hypothetical listing. */
export function previewHoodAlert(): string {
  return formatHoodAlert({
    source: "Robinhood asset registry",
    symbol: "HOOD",
    name: "Robinhood Markets",
    address: "0x0000000000000000000000000000000000000000",
    url: "https://app.long.xyz/create",
    live: true,
  });
}
