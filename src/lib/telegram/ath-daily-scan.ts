import { supabase } from "@/lib/supabase";
import { rateLimit } from "@/lib/rate-limiter";
import { scrapeGmgnTopTraders, type GmgnTopTrader } from "@/lib/api/gmgn-scraper";
import {
  upsertAthToken,
  upsertDeployer,
  saveTokenTraders,
  appearancesForWallets,
  knownAthTokens,
  fetchDeployer,
  fetchHolders,
  launchpadFromFactory,
  isContractAddress,
  KNOWN_INFRA,
  RH_EXPLORER,
} from "@/lib/api/ath-tokens";
import {
  buildLabel,
  upsertAlphaWallets,
  loadAlphaWallets,
  compactPnl,
  type AlphaWallet,
} from "@/lib/api/alpha-wallets";
import { getAlertsBot, broadcastAlert } from "./alerts-bot";
import { escapeHtml } from "./utils/format";
import { mc } from "./alpha-alerts";

// ── Daily ATH scan ────────────────────────────────────────────────────────────
// Runs once a day. Finds Robinhood Chain tokens that reached a $2M ATH market
// cap in the last 24h, records them with their top 30 traders, then cross-
// references those traders against every ATH token we have ever recorded.
//
// A wallet that was a top trader on two or more separate runners has repeated
// across independent winners — that is what an alpha wallet is here — so it is
// promoted automatically and announced.

export const CHAIN = "rh";
export const ATH_THRESHOLD_USD = 2_000_000;
export const TOP_N = 30;
/** Hour (UTC) the scan runs. */
export const SCAN_HOUR_UTC = 23;
/** Tokens must have peaked within this window to count as "today's" runners. */
const WINDOW_HOURS = 24;
/**
 * Don't resolve ATH for candidates far below the threshold. A token that peaked
 * at $2M within the last day has not usually collapsed below this since, and
 * without a floor the scan would price thousands of dust pools nightly.
 */
const MIN_CURRENT_FDV_USD = 100_000;

/**
 * Ceiling on a believable ATH for a launchpad token on this chain.
 *
 * Thin pools print bad daily highs, and the resulting figures are absurd rather
 * than merely high — a dry run produced "Cashcow, ATH $1,876,560,000,000" and
 * "UP, ATH $537M". Publishing those in a daily digest would discredit the whole
 * feed, so anything above this is held back and logged rather than reported.
 */
const PLAUSIBLE_MAX_ATH_USD = 500_000_000;

/**
 * Assets that trade here but were not launched here. They clear $2M comfortably
 * and would otherwise appear as "runners" every single day.
 */
const NOT_LAUNCHES = new Set([
  "weth", "eth", "usdg", "usde", "usdc", "usdt", "dai", "wbtc", "btc", "index", "wrh",
]);

// Bot threshold, matching the research pipeline that seeded the original list:
// the median top-30 trader makes ~23 trades on a token, so 1,000 is unambiguous
// automation. The research pipeline also used a median-across-tokens rule, which
// has no meaning here — a daily scan classifies each token in isolation, and the
// cross-token view only exists at promotion time.
const BOT_MAX_TX_ON_ANY_TOKEN = 1_000;

const GT = "https://api.geckoterminal.com/api/v2";
const GT_SPACING_MS = 3_500;
let lastGt = 0;

async function gt<T = unknown>(path: string, tries = 3): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    const wait = Math.max(0, GT_SPACING_MS - (Date.now() - lastGt));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastGt = Date.now();
    try {
      const res = await fetch(GT + path, {
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 8_000 * (i + 1)));
        continue;
      }
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      /* retry */
    }
  }
  return null;
}

interface GtPoolAttrs {
  address?: string;
  fdv_usd?: string;
  pool_created_at?: string;
}
interface GtTokenAttrs {
  address?: string;
  symbol?: string;
  name?: string;
}
interface GtPoolRow {
  attributes: GtPoolAttrs;
  relationships?: { base_token?: { data?: { id?: string } } };
}
interface GtIncluded {
  id: string;
  attributes: GtTokenAttrs;
}

interface Candidate {
  tokenAddress: string;
  symbol: string;
  name: string;
  poolAddress: string | null;
  currentFdvUsd: number | null;
  createdAt: string | null;
}

/**
 * Candidate universe for a daily run. Robinhood Chain sees thousands of
 * launches a day and nothing lets you filter by peak market cap, so we take
 * every ranked list we can reach and price them individually.
 */
async function collectCandidates(): Promise<Candidate[]> {
  const byAddr = new Map<string, Candidate>();

  const add = (c: Candidate) => {
    const k = c.tokenAddress.toLowerCase();
    const ex = byAddr.get(k);
    if (ex) {
      ex.poolAddress ??= c.poolAddress;
      ex.currentFdvUsd ??= c.currentFdvUsd;
      return;
    }
    byAddr.set(k, { ...c, tokenAddress: k });
  };

  for (const sort of ["h24_volume_usd_desc", "h24_tx_count_desc"]) {
    for (let page = 1; page <= 10; page++) {
      const d = await gt<{ data?: unknown[]; included?: unknown[] }>(
        `/networks/robinhood/pools?page=${page}&sort=${sort}&include=base_token`
      );
      const rows = (d?.data ?? []) as GtPoolRow[];
      if (rows.length === 0) break;
      const tokens = new Map<string, GtTokenAttrs>();
      for (const inc of (d?.included ?? []) as GtIncluded[]) tokens.set(inc.id, inc.attributes);
      for (const p of rows) {
        const a = p.attributes;
        const baseId = p.relationships?.base_token?.data?.id ?? "";
        const t = tokens.get(baseId);
        const addr = (t?.address ?? baseId.split("_")[1] ?? "").toLowerCase();
        if (!addr) continue;
        add({
          tokenAddress: addr,
          symbol: t?.symbol ?? "",
          name: t?.name ?? "",
          poolAddress: a.address ?? null,
          currentFdvUsd: a.fdv_usd ? parseFloat(a.fdv_usd) : null,
          createdAt: a.pool_created_at ?? null,
        });
      }
    }
  }

  for (let page = 1; page <= 10; page++) {
    const d = await gt<{ data?: unknown[]; included?: unknown[] }>(
      `/networks/robinhood/new_pools?page=${page}&include=base_token`
    );
    const rows = (d?.data ?? []) as GtPoolRow[];
    if (rows.length === 0) break;
    const tokens = new Map<string, GtTokenAttrs>();
    for (const inc of (d?.included ?? []) as GtIncluded[]) tokens.set(inc.id, inc.attributes);
    for (const p of rows) {
      const a = p.attributes;
      const baseId = p.relationships?.base_token?.data?.id ?? "";
      const t = tokens.get(baseId);
      const addr = (t?.address ?? baseId.split("_")[1] ?? "").toLowerCase();
      if (!addr) continue;
      add({
        tokenAddress: addr,
        symbol: t?.symbol ?? "",
        name: t?.name ?? "",
        poolAddress: a.address ?? null,
        currentFdvUsd: a.fdv_usd ? parseFloat(a.fdv_usd) : null,
        createdAt: a.pool_created_at ?? null,
      });
    }
  }

  return [...byAddr.values()];
}

/** Supply on this chain is 1e9 for essentially every launchpad token. */
const ASSUMED_SUPPLY = 1_000_000_000;

interface Peak {
  athMcUsd: number;
  athAt: string;
  supply: number;
  launchedAt: string | null;
}

/** Peak market cap from the pool's daily candles. */
async function resolvePeak(c: Candidate): Promise<Peak | null> {
  if (!c.poolAddress) return null;
  const o = await gt<{ data?: { attributes?: { ohlcv_list?: number[][] } } }>(
    `/networks/robinhood/pools/${c.poolAddress}/ohlcv/day?limit=1000&currency=usd`
  );
  const list = o?.data?.attributes?.ohlcv_list ?? [];
  if (list.length === 0) return null;

  let best = { ts: 0, high: 0 };
  for (const [ts, , high] of list) if (high > best.high) best = { ts, high };
  if (best.high <= 0) return null;

  return {
    athMcUsd: best.high * ASSUMED_SUPPLY,
    athAt: new Date(best.ts * 1000).toISOString(),
    supply: ASSUMED_SUPPLY,
    launchedAt: c.createdAt ?? new Date(list[list.length - 1][0] * 1000).toISOString(),
  };
}

function classifyBots(traders: GmgnTopTrader[]): Map<string, { bot: boolean; reason: string | null }> {
  const out = new Map<string, { bot: boolean; reason: string | null }>();
  for (const t of traders) {
    const tx = t.buyCount + t.sellCount;
    let reason: string | null = null;
    if (tx >= BOT_MAX_TX_ON_ANY_TOKEN) reason = `${tx.toLocaleString()} trades on this token`;
    out.set(t.walletAddress.toLowerCase(), { bot: reason !== null, reason });
  }
  return out;
}

// ── Alerts ───────────────────────────────────────────────────────────────────

/**
 * New alpha wallet. Deliberately in caps — this is the rarest and highest-value
 * message the bot sends, and it must not read like the routine feed.
 */
export function formatNewAlphaAlert(
  label: string,
  address: string,
  appearances: Array<{ tokenSymbol: string | null; totalPnlUsd: number | null }>,
  totalPnl: number
): string {
  const toks = appearances.map((a) => (a.tokenSymbol ?? "?").toUpperCase()).join(", ");
  const lines: string[] = [];
  lines.push(`🚨🚨 <b>NEW ALPHA WALLET ADDED</b> 🚨🚨`);
  lines.push("");
  lines.push(`<b>${escapeHtml(label.toUpperCase())}</b>`);
  lines.push(`<code>${escapeHtml(address)}</code>`);
  lines.push("");
  lines.push(`<b>TOP TRADER ON ${appearances.length} $2M+ RUNNERS:</b>`);
  lines.push(`<b>${escapeHtml(toks)}</b>`);
  lines.push(`<b>COMBINED PNL: ${mc(totalPnl).toUpperCase()}</b>`);
  lines.push("");
  lines.push(
    `🔭 <a href="${RH_EXPLORER}/address/${address}">BLOCKSCOUT</a>  ·  ` +
      `📈 <a href="https://gmgn.ai/robinhood/address/${address}">GMGN</a>`
  );
  return lines.join("\n");
}

export interface ScanTokenSummary {
  symbol: string;
  name: string;
  tokenAddress: string;
  athMcUsd: number | null;
  currentMcUsd: number | null;
  launchpad: string | null;
  holders: number | null;
}

/** Daily digest of what reached the threshold. Normal case, normal tone. */
export function formatDailySummary(tokens: ScanTokenSummary[], newAlphaCount: number, dateUtc: string): string {
  const lines: string[] = [];
  lines.push(`📊 <b>Daily ATH Scan</b>  ·  ${escapeHtml(dateUtc)} 23:00 UTC`);
  lines.push(`<i>Robinhood Chain — tokens that hit $2M+ market cap in the last 24h.</i>`);
  lines.push("");

  if (tokens.length === 0) {
    lines.push(`No tokens reached $2M today.`);
  } else {
    lines.push(`<b>${tokens.length} token${tokens.length === 1 ? "" : "s"} hit $2M+:</b>`);
    lines.push("");
    for (const t of tokens) {
      const bits = [`ATH ${mc(t.athMcUsd)}`];
      if (t.currentMcUsd != null) bits.push(`now ${mc(t.currentMcUsd)}`);
      if (t.holders != null) bits.push(`${t.holders.toLocaleString()} holders`);
      if (t.launchpad) bits.push(escapeHtml(t.launchpad));
      lines.push(`• <b>$${escapeHtml(t.symbol || "?")}</b> — ${bits.join("  ·  ")}`);
      lines.push(`  <code>${escapeHtml(t.tokenAddress)}</code>`);
    }
  }

  lines.push("");
  lines.push(
    newAlphaCount > 0
      ? `🚨 <b>${newAlphaCount} new alpha wallet${newAlphaCount === 1 ? "" : "s"} added.</b>`
      : `No new alpha wallets today.`
  );
  return lines.join("\n");
}

async function send(chatId: string, text: string): Promise<void> {
  const bot = await getAlertsBot();
  await bot.api.sendMessage(chatId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
}

// ── The scan ─────────────────────────────────────────────────────────────────

export interface ScanResult {
  tokensFound: number;
  tradersCaptured: number;
  alphaAdded: number;
  candidatesScanned: number;
}

/**
 * One full scan. Safe to call directly for a manual run; the scheduler below
 * calls it once a day.
 */
export async function runAthScan(opts: { windowHours?: number; dryRun?: boolean } = {}): Promise<ScanResult> {
  const windowHours = opts.windowHours ?? WINDOW_HOURS;
  const cutoff = Date.now() - windowHours * 3_600_000;
  const known = await knownAthTokens(CHAIN);

  console.log(`[ath-scan] collecting candidates…`);
  const candidates = await collectCandidates();
  const worth = candidates.filter((c) => (c.currentFdvUsd ?? 0) >= MIN_CURRENT_FDV_USD);
  console.log(`[ath-scan] ${candidates.length} candidates, ${worth.length} above the $100k floor`);

  const found: ScanTokenSummary[] = [];
  let tradersCaptured = 0;
  const todaysWallets = new Set<string>();

  const rejected: string[] = [];

  for (const c of worth) {
    if (NOT_LAUNCHES.has((c.symbol || "").toLowerCase())) continue;

    const peak = await resolvePeak(c);
    if (!peak || peak.athMcUsd < ATH_THRESHOLD_USD) continue;
    if (peak.athMcUsd > PLAUSIBLE_MAX_ATH_USD) {
      rejected.push(`${c.symbol || c.tokenAddress} ($${Math.round(peak.athMcUsd).toLocaleString()})`);
      continue;
    }
    // Only tokens that PEAKED inside the window — an old runner still trading
    // above $2M is not news, and was recorded when it first qualified.
    if (new Date(peak.athAt).getTime() < cutoff && known.has(c.tokenAddress)) continue;
    if (new Date(peak.athAt).getTime() < cutoff) continue;

    const { deployer, factory } = await fetchDeployer(c.tokenAddress);
    const holders = await fetchHolders(c.tokenAddress);

    const tokenId = opts.dryRun
      ? null
      : await upsertAthToken({
          chain: CHAIN,
          tokenAddress: c.tokenAddress,
          name: c.name || c.symbol,
          symbol: c.symbol,
          launchpad: launchpadFromFactory(factory),
          deployerAddress: deployer,
          athMcUsd: peak.athMcUsd,
          athAt: peak.athAt,
          currentMcUsd: c.currentFdvUsd,
          holders,
          totalSupply: peak.supply,
          poolAddress: c.poolAddress,
          launchedAt: peak.launchedAt,
          source: `daily-scan`,
        });
    if (!opts.dryRun) await upsertDeployer(CHAIN, deployer);

    found.push({
      symbol: c.symbol,
      name: c.name,
      tokenAddress: c.tokenAddress,
      athMcUsd: peak.athMcUsd,
      currentMcUsd: c.currentFdvUsd,
      launchpad: launchpadFromFactory(factory),
      holders,
    });
    console.log(`[ath-scan] ${c.symbol} — ATH ${Math.round(peak.athMcUsd).toLocaleString()} on ${peak.athAt.slice(0, 10)}`);

    let traders: GmgnTopTrader[] = [];
    try {
      traders = await scrapeGmgnTopTraders(CHAIN, c.tokenAddress);
    } catch (err) {
      console.error(`[ath-scan] GMGN failed for ${c.symbol}:`, String(err).slice(0, 80));
    }
    if (traders.length === 0) continue;

    const bots = classifyBots(traders);
    for (const t of traders.slice(0, TOP_N)) {
      if (!bots.get(t.walletAddress.toLowerCase())?.bot) todaysWallets.add(t.walletAddress.toLowerCase());
    }
    if (tokenId) {
      tradersCaptured += await saveTokenTraders(
        tokenId,
        CHAIN,
        c.tokenAddress,
        c.symbol,
        traders.slice(0, TOP_N),
        peak.supply,
        (addr) => bots.get(addr) ?? { bot: false, reason: null }
      );
    }
  }

  if (rejected.length) {
    console.log(`[ath-scan] held back ${rejected.length} implausible ATH(s): ${rejected.join(", ")}`);
  }

  // ── Cross-reference against every ATH token ever recorded ────────────────
  const alphaAdded = opts.dryRun ? 0 : await promoteRepeatTraders([...todaysWallets]);

  const dateUtc = new Date().toISOString().slice(0, 10);
  if (!opts.dryRun) {
    const summary = formatDailySummary(found, alphaAdded, dateUtc);
    await broadcastAlert((chatId) => send(chatId, summary));
  }

  return {
    tokensFound: found.length,
    tradersCaptured,
    alphaAdded,
    candidatesScanned: worth.length,
  };
}

/**
 * Promote wallets that appear as top traders on 2+ recorded ATH tokens and
 * aren't already tracked. Each promotion gets its own all-caps ping.
 */
export async function promoteRepeatTraders(wallets: string[]): Promise<number> {
  if (wallets.length === 0) return 0;

  const existing = await loadAlphaWallets(CHAIN);
  let fresh = wallets.filter((w) => !existing.has(w));
  if (fresh.length === 0) return 0;

  // Contracts are not traders. Without this the V4 PoolManager qualifies on
  // nearly every token and gets promoted — it did, with $17.8B of "PnL".
  const checked: string[] = [];
  for (const w of fresh) {
    if (KNOWN_INFRA.has(w)) continue;
    if (await isContractAddress(w)) {
      console.log(`[ath-scan] skipping ${w} — contract, not a trader`);
      continue;
    }
    checked.push(w);
  }
  fresh = checked;
  if (fresh.length === 0) return 0;

  const appearances = await appearancesForWallets(CHAIN, fresh);
  let added = 0;

  for (const [wallet, apps] of appearances) {
    // Distinct tokens, not rows — a wallet can't qualify off one token.
    const byToken = new Map(apps.map((a) => [a.tokenAddress, a]));
    if (byToken.size < 2) continue;

    const list = [...byToken.values()].sort((a, b) => (b.totalPnlUsd ?? 0) - (a.totalPnlUsd ?? 0));
    const totalPnl = list.reduce((s, a) => s + (a.totalPnlUsd ?? 0), 0);
    const invested = list.reduce((s, a) => s + (a.amountInvestedUsd ?? 0), 0);
    const label = buildLabel(
      CHAIN,
      list.map((a) => a.tokenSymbol ?? "tok"),
      totalPnl
    );

    const entry: AlphaWallet = {
      label,
      address: wallet,
      chain: CHAIN,
      tokenCount: byToken.size,
      tokens: list.map((a) => a.tokenSymbol ?? "?"),
      totalPnlUsd: totalPnl,
      totalInvestedUsd: invested,
      aggregateRoiPct: invested > 0 ? (totalPnl / invested) * 100 : null,
      bestRank: Math.min(...list.map((a) => a.rank ?? 999)),
      maxTxOnAToken: Math.max(...list.map((a) => a.txCount ?? 0)),
      source: "daily-scan",
      isActive: true,
    };

    try {
      await upsertAlphaWallets([entry]);
      const text = formatNewAlphaAlert(label, wallet, list, totalPnl);
      await broadcastAlert((chatId) => send(chatId, text));
      added++;
      console.log(`[ath-scan] PROMOTED ${label} (${byToken.size} tokens, PnL ${compactPnl(totalPnl)})`);
    } catch (err) {
      console.error(`[ath-scan] failed to promote ${wallet}:`, String(err).slice(0, 100));
    }
  }
  return added;
}

// ── Scheduling ───────────────────────────────────────────────────────────────
// Checked every minute rather than driven by a timer set once: a long-lived
// setTimeout drifts, and a redeploy at the wrong moment would skip the day
// entirely. The run_date row makes a repeat run a no-op regardless.

let checking = false;

export async function maybeRunDailyScan(): Promise<void> {
  if (checking) return;
  const now = new Date();
  if (now.getUTCHours() !== SCAN_HOUR_UTC) return;

  checking = true;
  try {
    const runDate = now.toISOString().slice(0, 10);
    const { data: existing } = await supabase
      .from("ath_scan_runs")
      .select("id")
      .eq("chain", CHAIN)
      .eq("run_date", runDate)
      .maybeSingle();
    if (existing?.id) return; // already ran today

    const { data: run, error } = await supabase
      .from("ath_scan_runs")
      .insert({ chain: CHAIN, run_date: runDate })
      .select("id")
      .single();
    if (error) {
      // A unique violation here means another instance claimed the run first.
      if (!error.message.includes("duplicate")) console.error("[ath-scan] claim failed:", error.message);
      return;
    }

    console.log(`[ath-scan] starting daily scan for ${runDate}`);
    try {
      const res = await runAthScan();
      await supabase
        .from("ath_scan_runs")
        .update({
          finished_at: new Date().toISOString(),
          candidates_scanned: res.candidatesScanned,
          tokens_found: res.tokensFound,
          traders_captured: res.tradersCaptured,
          alpha_added: res.alphaAdded,
        })
        .eq("id", run.id);
      console.log(
        `[ath-scan] done — ${res.tokensFound} tokens, ${res.tradersCaptured} traders, ${res.alphaAdded} new alpha`
      );
    } catch (err) {
      await supabase
        .from("ath_scan_runs")
        .update({ finished_at: new Date().toISOString(), error: String(err).slice(0, 500) })
        .eq("id", run.id);
      throw err;
    }
  } finally {
    checking = false;
  }
}

/** Refresh current market caps for recorded tokens — cheap, run weekly. */
export async function refreshAthTokenMarketCaps(limit = 200): Promise<number> {
  const { data } = await supabase
    .from("ath_tokens")
    .select("id, token_address")
    .eq("chain", CHAIN)
    .order("current_mc_updated_at", { ascending: true, nullsFirst: true })
    .limit(limit);

  let updated = 0;
  for (const row of data ?? []) {
    await rateLimit("dexscreener");
    try {
      const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/robinhood/${row.token_address}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const d = await res.json();
      const pairs = Array.isArray(d) ? d : (d?.pairs ?? []);
      const pool = pairs.sort(
        (a: { liquidity?: { usd?: number } }, b: { liquidity?: { usd?: number } }) =>
          (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
      )[0];
      const value = pool?.marketCap ?? pool?.fdv ?? null;
      if (value == null) continue;
      await supabase
        .from("ath_tokens")
        .update({ current_mc_usd: value, current_mc_updated_at: new Date().toISOString() })
        .eq("id", row.id);
      updated++;
    } catch {
      /* skip */
    }
  }
  return updated;
}
