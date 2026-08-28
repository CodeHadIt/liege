import { fetchRobinhoodStockTokens, rhExplorerTokenUrl } from "@/lib/api/robinhood-stocks";
import { fetchFlapPaymentTokens, FLAP_ROBINHOOD_CHAIN_ID, FLAP_BSC_CHAIN_ID } from "@/lib/api/flap";
import { fetchO1Quotes, o1KeyConfigured, O1_CHAIN } from "@/lib/api/o1";
import { fetchQuoteTokens } from "@/lib/api/stonkfun";
import { fetchSunriseTokens } from "@/lib/api/sunrise";
import { fetchFourMemeQuoteTokens } from "@/lib/api/four-meme";
import { fetchWhitelistedQuoteMints, fetchQuoteMintMeta } from "@/lib/api/pumpfun-quotes";
import { fetchBasestonkLaunches, resolvePairToken } from "@/lib/api/basestonk";
import { isAllowedPairedAsset } from "@/lib/api/pools-fun";
import { getAlertsBot, broadcastAlert, FEATURE } from "./alerts-bot";
import { FEED, resolveSeen, markSeen } from "@/lib/api/feed-seen";
import { pinRhStock } from "./long-alerts";
import { pinStonkFunQuote } from "./stonkfun-alerts";
import { escapeHtml } from "./utils/format";

// ── HOOD watch ───────────────────────────────────────────────────────────────
//
// Standing question, across EVERY launchpad we watch: has Robinhood's own stock
// become something you can launch a token against?
//
// The answer on Robinhood's OWN chain is no: its asset registry lists 194
// tokenized stocks and HOOD is not among them. Robinhood has not tokenized
// itself, so Long — whose picker derives from that registry — cannot offer it,
// and Pons has never paired against the one wrapper that does exist there,
// Ondo's HOODon (`0xfb5b…a79c`).
//
// But the first sweep across ALL platforms found that Robinhood's stock is
// already a live base pair in three places we had never checked:
//
//   HOODB   Flap, BNB Chain      0xa394dcea3fd3847fd793afbfd163e2e3858b7c65
//   HOODX   StonkFun, Solana     XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg
//   HOOD    Sunrise, Solana      HooDYv5RewLRiMLnEVq3VJqdqxhuE6c5eYvqejMC3e9A
//
// Each is a different issuer's wrapper of the same equity, and each was listed
// before this watch existed — their platform watchers seeded them as part of a
// backlog and so never announced them. That is precisely why this sweeps every
// catalog rather than the Robinhood-chain ones: the listing venue is not
// predictable, and assuming it cost us three live pairs.
//
// A hit is announced in ALL CAPS by request, and pinned for permanent, uncapped
// launch watching wherever the platform supports pinning, so the memecoins that
// follow are all reported.

/**
 * Every wrapper spelling of Robinhood's stock we would accept as a match.
 *
 * Deliberately an explicit list rather than a pattern. `^hood[a-z]{0,2}$` would
 * also match "hoodie", and these catalogs do contain memecoins — Flap's BNB list
 * and StonkFun's quote list are not stocks-only. An exact set cannot false-positive.
 */
const HOOD_SYMBOLS = new Set(
  [
    "HOOD", // plain / Robinhood's own registry
    "HOODC", // Coinbase tokenized stock convention (Base)
    "HOODON", // Ondo wrapper
    "WTHOOD", // ST0x wrapped convention
    "WHOOD",
    "XHOOD",
    "HOODB", // Flap/BNB suffix convention
    "HOODX",
    "HOODS",
    "HOODU",
  ].map((s) => s.toUpperCase())
);

/**
 * Assets already known and already covered — not news.
 *
 * HOODon on Flap's Robinhood-chain catalog is pinned and watched (§8). Without
 * this the very first sweep would announce it, because this watcher does not
 * seed silently.
 */
const ALREADY_KNOWN = new Set(["flap (robinhood chain):0xfb5b5778d45ae47f15323fb59b666c655174a79c"]);

/** Robinhood's own listing, however it is spelled or named. */
function isRobinhoodStock(symbol: string | null | undefined, name: string | null | undefined): boolean {
  const sym = (symbol ?? "").trim().toUpperCase();
  if (HOOD_SYMBOLS.has(sym)) return true;
  // Fall back to the company name, ignoring the "• Robinhood Token" suffix every
  // asset on Robinhood Chain carries.
  const company = (name ?? "").split("•")[0].trim().toLowerCase();
  return /\brobinhood\b/.test(company) && /\b(markets|financial|inc|corp)\b/.test(company);
}

interface HoodHit {
  source: string;
  chain: string;
  symbol: string;
  name: string;
  address: string | null;
  url: string | null;
  /** Whether the venue says it is selectable right now. */
  live: boolean;
}

function formatHoodAlert(h: HoodHit, discovered = false): string {
  const lines: string[] = [];
  // A listing that predates this watch is not "just added", and saying so would
  // be wrong. The first sweep reports what is ALREADY available; every later
  // sweep reports a genuine change.
  lines.push(
    discovered
      ? `🚨🚨🚨 <b>ROBINHOOD STOCK IS ALREADY A BASE PAIR</b> 🚨🚨🚨`
      : `🚨🚨🚨 <b>ROBINHOOD STOCK IS NOW A BASE PAIR</b> 🚨🚨🚨`
  );
  if (discovered) lines.push(`<i>Found on first sweep — this listing predates the watch.</i>`);
  lines.push("");
  lines.push(`<b>$${escapeHtml(h.symbol.toUpperCase())} — ${escapeHtml(h.name.toUpperCase())}</b>`);
  lines.push(`<b>PLATFORM: ${escapeHtml(h.source.toUpperCase())}</b>`);
  lines.push(`<b>CHAIN: ${escapeHtml(h.chain.toUpperCase())}</b>`);
  lines.push(`<b>STATUS: ${h.live ? "LIVE — SELECTABLE NOW" : "LISTED, NOT YET SELECTABLE"}</b>`);
  lines.push("");
  if (h.address) lines.push(`<code>${escapeHtml(h.address)}</code>`);
  const links: string[] = [];
  if (h.address && h.chain === "Robinhood Chain") {
    links.push(`🔭 <a href="${rhExplorerTokenUrl(h.address)}">EXPLORER</a>`);
  }
  if (h.url) links.push(`🚀 <a href="${h.url}">LAUNCH</a>`);
  if (links.length) lines.push(links.join("  ·  "));
  lines.push("");
  lines.push(`<b>EVERY LAUNCH AGAINST IT WILL BE REPORTED.</b>`);
  return lines.join("\n");
}

async function sendHoodAlert(chatId: string, h: HoodHit, discovered: boolean): Promise<void> {
  const bot = await getAlertsBot();
  await bot.api.sendMessage(chatId, formatHoodAlert(h, discovered), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

/** In-memory mirror of the durable seen-set. */
const announced = new Set<string>();

/**
 * Pin the asset so every subsequent launch against it is reported, unrestricted.
 *
 * Only two platforms have pin machinery today — the Robinhood-chain watcher and
 * StonkFun. Elsewhere the listing is announced and launches against it follow
 * that platform's normal 36h-window rules, which is a real gap rather than a
 * design choice: Sunrise and Flap/BNB have no equivalent, so a Robinhood pair
 * there is reported like any other new quote.
 */
function pinWherePossible(h: HoodHit): void {
  if (!h.address) return;
  if (h.chain === "Robinhood Chain") {
    pinRhStock(h.address, h.symbol.toUpperCase());
  } else if (h.source === "StonkFun") {
    pinStonkFunQuote(h.address, `${h.symbol} (Robinhood)`);
  }
}

interface SourceResult {
  label: string;
  hits: HoodHit[];
  ok: boolean;
}

/**
 * Run a source, isolating its failure so one dead catalog cannot stop the sweep.
 *
 * The outcome is reported rather than swallowed. "No Robinhood listing anywhere"
 * and "every catalog is unreachable" produce the same empty result, and a watch
 * whose whole value is catching one rare event must not be able to sit silently
 * broken — so a fully failed sweep is logged loudly.
 */
async function source(label: string, fn: () => Promise<HoodHit[]>): Promise<SourceResult> {
  try {
    return { label, hits: await fn(), ok: true };
  } catch (err) {
    console.error(`[hood] ${label} check failed: ${(err as Error).message}`);
    return { label, hits: [], ok: false };
  }
}

/**
 * Every quote catalog in the system, checked for a Robinhood listing.
 *
 * Sources are independent: each is wrapped so a dead one degrades that venue
 * only. The registry matters most — Long's picker derives from it, so a listing
 * there unlocks every registry-driven launchpad at once.
 */
async function collectHits(): Promise<SourceResult[]> {
  return Promise.all([
    // ── Robinhood Chain ────────────────────────────────────────────────────
    source("registry", async () => {
      const stocks = await fetchRobinhoodStockTokens();
      return stocks
        .filter((s) => isRobinhoodStock(s.symbol, s.name))
        .map((s) => ({
          source: "Robinhood asset registry",
          chain: "Robinhood Chain",
          symbol: s.symbol,
          name: s.name.split("•")[0].trim() || s.symbol,
          address: s.contractAddress.toLowerCase(),
          url: "https://app.long.xyz/create",
          live: true,
        }));
    }),

    // Flap runs the same launchpad on Robinhood Chain and BNB Chain against
    // different catalogs, so both are checked. `coming-soon` entries are kept —
    // "listed but not yet selectable" is exactly the early warning worth having.
    source("flap", async () => {
      const all = await fetchFlapPaymentTokens();
      return all
        .filter((t) => isRobinhoodStock(t.symbol, t.name))
        .map((t) => {
          const chain =
            t.chainId === FLAP_ROBINHOOD_CHAIN_ID
              ? "Robinhood Chain"
              : t.chainId === FLAP_BSC_CHAIN_ID
                ? "BNB Chain"
                : `chain ${t.chainId}`;
          return {
            source: `Flap (${chain})`,
            chain,
            symbol: t.symbol,
            name: t.name,
            address: t.address ? t.address.toLowerCase() : null,
            url:
              t.chainId === FLAP_ROBINHOOD_CHAIN_ID
                ? "https://flap.sh/launch?chain=robinhood&lang=en"
                : "https://flap.sh/launch?chain=bsc&lang=en",
            live: t.status === "available",
          };
        });
    }),

    // pools.fun keeps its paired-asset allowlist on-chain, so it is probed by
    // address rather than listed. Only known HOOD addresses can be asked about;
    // a brand-new HOOD token would be caught by the registry source above first,
    // then probed here on the following pass.
    source("pools.fun", async () => {
      const hits: HoodHit[] = [];
      for (const [addr, sym] of [["0xfb5b5778d45ae47f15323fb59b666c655174a79c", "HOODon"]] as const) {
        const allowed = await isAllowedPairedAsset(addr);
        if (allowed !== true) continue;
        hits.push({
          source: "pools.fun",
          chain: "Robinhood Chain",
          symbol: sym,
          name: "Robinhood (Ondo wrapper)",
          address: addr,
          url: "https://pools.fun",
          live: true,
        });
      }
      return hits;
    }),

    // ── Solana ─────────────────────────────────────────────────────────────
    source("stonkfun", async () => {
      const quotes = await fetchQuoteTokens();
      return quotes
        .filter((q) => isRobinhoodStock(q.symbol, q.name))
        .map((q) => ({
          source: "StonkFun",
          chain: "Solana",
          symbol: q.symbol,
          name: q.name,
          address: q.quoteMint,
          url: "https://stonk.fun/launch",
          live: true,
        }));
    }),

    source("sunrise", async () => {
      const tokens = await fetchSunriseTokens();
      return tokens
        .filter((t) => isRobinhoodStock(t.symbol, t.name))
        .map((t) => ({
          source: "Sunrise",
          chain: "Solana",
          symbol: t.symbol,
          name: t.name,
          address: t.address,
          url: "https://sunrise.xyz",
          live: true,
        }));
    }),

    source("pumpfun", async () => {
      const mints = await fetchWhitelistedQuoteMints();
      if (!mints) return [];
      const hits: HoodHit[] = [];
      for (const mint of mints) {
        const meta = await fetchQuoteMintMeta(mint);
        if (!isRobinhoodStock(meta.symbol, meta.name)) continue;
        hits.push({
          source: "Pump.fun",
          chain: "Solana",
          symbol: meta.symbol,
          name: meta.name,
          address: mint,
          url: "https://pump.fun/create",
          live: true,
        });
      }
      return hits;
    }),

    // ── Base ───────────────────────────────────────────────────────────────
    // basestonk publishes no catalog (§8c), so its pair tokens can only be read
    // off actual launches. That makes this the one source that cannot see a
    // listing before first use — a known limitation, not an oversight.
    source("basestonk", async () => {
      const launches = await fetchBasestonkLaunches(100);
      if (!launches) return [];
      const hits: HoodHit[] = [];
      for (const addr of new Set(launches.map((l) => l.pairToken))) {
        const p = await resolvePairToken(addr);
        if (!p || !isRobinhoodStock(p.symbol, p.name)) continue;
        hits.push({
          source: "basestonk",
          chain: "Base",
          symbol: p.symbol,
          name: p.name,
          address: p.address,
          url: "https://basestonk.io/create/",
          live: true,
        });
      }
      return hits;
    }),

    // ── BNB Chain ──────────────────────────────────────────────────────────
    source("four.meme", async () => {
      const quotes = await fetchFourMemeQuoteTokens();
      return quotes
        .filter((q) => isRobinhoodStock(q.symbol, q.symbol))
        .map((q) => ({
          source: "Four.meme",
          chain: "BNB Chain",
          symbol: q.symbol,
          name: q.symbol,
          address: q.address,
          url: "https://four.meme/create",
          live: q.live,
        }));
    }),

    // ── o1, both chains ────────────────────────────────────────────────────
    source("o1", async () => {
      if (!o1KeyConfigured()) return [];
      const hits: HoodHit[] = [];
      for (const [key, id, chain] of [
        ["base", O1_CHAIN.BASE, "Base"],
        ["rh", O1_CHAIN.ROBINHOOD, "Robinhood Chain"],
      ] as const) {
        const quotes = await fetchO1Quotes(id, false);
        for (const q of quotes ?? []) {
          if (!isRobinhoodStock(q.symbol, q.symbol)) continue;
          hits.push({
            source: `o1 (${chain})`,
            chain,
            symbol: q.symbol,
            name: q.symbol,
            address: q.address,
            url: "https://launch.o1.exchange/token/create",
            live: q.selectable,
          });
        }
        void key;
      }
      return hits;
    }),
  ]);
}

/**
 * One sweep of the HOOD watch.
 *
 * Deliberately does NOT seed silently. Every other catalog watcher does, because
 * its job is to report change against a large existing list. The whole point
 * here is that the list is currently EMPTY: if a Robinhood listing is present on
 * the very first pass, that is the news, not a backlog to absorb. Seeding would
 * swallow exactly the event this exists to catch — which is why `ALREADY_KNOWN`
 * exists instead, naming the one asset that is genuinely old news.
 */
export async function pollHoodWatch(): Promise<void> {
  const results = await collectHits();
  const live = results.filter((r) => r.ok);

  // A sweep where nothing answered is a broken watch, not a quiet market. Say so
  // — the whole value here is catching one rare event, and this must not be able
  // to sit dead while looking identical to "no listing yet".
  if (live.length === 0) {
    console.error(`[hood] EVERY source failed this pass (${results.map((r) => r.label).join(", ")}) — watch is blind`);
    return;
  }
  if (live.length < results.length) {
    const dead = results.filter((r) => !r.ok).map((r) => r.label);
    console.warn(`[hood] ${dead.length}/${results.length} sources unreachable this pass: ${dead.join(", ")}`);
  }

  const hits = live.flatMap((r) => r.hits);
  if (hits.length === 0) return;

  const state = await resolveSeen(FEED.HOOD_WATCH, announced);
  for (const k of state.seen) announced.add(k);

  for (const h of hits) {
    // Key on platform + asset: HOOD appearing on a second launchpad is its own
    // event and worth its own ping.
    const key = `${h.source}:${(h.address ?? h.symbol)}`.toLowerCase();
    if (ALREADY_KNOWN.has(key) || state.seen.has(key)) continue;

    announced.add(key);
    if (!state.degraded) await markSeen(FEED.HOOD_WATCH, [key]);

    // Pin before announcing, so a launch seconds later is already covered.
    // Only platforms with pin machinery can be pinned; the rest are announced
    // and then covered by their own watcher's normal rules.
    pinWherePossible(h);

    try {
      await broadcastAlert(FEATURE.LAUNCH, (chatId) => sendHoodAlert(chatId, h, state.firstRun));
      console.log(`[hood] ALERTED: ${h.symbol} on ${h.source} (${h.address ?? "no address"})`);
    } catch (err) {
      console.error("[hood] failed to send alert:", err);
    }
  }
}

/** Manual test: render the alert for a hypothetical listing. */
export function previewHoodAlert(): string {
  return formatHoodAlert({
    source: "Robinhood asset registry",
    chain: "Robinhood Chain",
    symbol: "HOOD",
    name: "Robinhood Markets",
    address: "0x0000000000000000000000000000000000000000",
    url: "https://app.long.xyz/create",
    live: true,
  });
}

/** Diagnostic: which sources answered, and what they hold. Sends nothing. */
export async function hoodWatchStatus(): Promise<SourceResult[]> {
  return collectHits();
}
