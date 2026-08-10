/**
 * Stage 2 — for every Robinhood Chain token that hit >= $2M ATH market cap in
 * the last 60 days, pull its top 30 traders from GMGN, then cross-reference all
 * of them to find addresses that appear across multiple tokens.
 *
 * Reads   data/rh-candidates.json   (produced by rh-ath-harvest.ts)
 * Writes  data/rh-ath-2m-60d.json   (programmable)
 *         docs/research/rh-ath-2m-60d.md (readable)
 *
 *   npx tsx scripts/rh-ath-traders.ts
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
// The scraper picks a bundled/serverless Chromium otherwise; locally we want the
// system browser, which playwright-core can drive directly.
process.env.CHROMIUM_EXECUTABLE_PATH ||= "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { scrapeGmgnTopTraders, type GmgnTopTrader } from "../src/lib/api/gmgn-scraper";

const CANDIDATES = "data/rh-candidates.json";
const OUT_JSON = "data/rh-ath-2m-60d.json";
const OUT_MD = "docs/research/rh-ath-2m-60d.md";
const TRADER_CACHE = "data/rh-traders-cache.json";
const OUT_WATCHLIST = "data/rh-repeat-traders.txt";

const DAYS = 60;
const ATH_THRESHOLD_USD = 2_000_000;
const TOP_N = 30;
const RH_EXPLORER = "https://robinhoodchain.blockscout.com";
const CONTRACT_CACHE = "data/rh-contract-flags.json";

// ── Filtering out infrastructure ──────────────────────────────────────────────
// GMGN's "top traders" list is derived from token flow, so it includes contracts
// that hold or route the token — the V4 PoolManager shows up in EVERY token and
// would otherwise look like the most prolific repeat trader on the chain. Since
// repeat addresses are the whole point of this dataset, a contract slipping
// through would poison the alert system downstream.
//
// Two filters: a denylist of addresses we already know, and an is_contract check
// against Blockscout for everything else (the general case — routers,
// aggregators and pools we haven't catalogued).
const KNOWN_INFRA = new Set(
  [
    "0x0000000000000000000000000000000000000000", // zero
    "0x000000000000000000000000000000000000dead", // burn
    "0x8366a39cc670b4001a1121b8f6a443a643e40951", // Uniswap V4 PoolManager
    "0x000000e200088d55c39a11f609e5f667729ad49b", // UERC20Factory (pools.trade)
    "0x22e99278308b393ea1260859b181ad7e78f5eeed", // LongLauncher
    "0x26605f322f7ff986f381bb9a6e3f5dab0beaeb09", // Flap portal (Robinhood)
    "0x3711cea4feade896c913c68f01eda97cb06d1a42", // Pons factory
  ].map((a) => a.toLowerCase())
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Blockscout is_contract, disk-cached. Unknown on failure → treated as a wallet. */
async function loadContractFlags(addresses: string[]): Promise<Record<string, boolean>> {
  const cache = loadJson<Record<string, boolean>>(CONTRACT_CACHE, {});
  const todo = addresses.filter((a) => !(a in cache) && !KNOWN_INFRA.has(a));
  if (todo.length === 0) return cache;

  console.log(`\nchecking is_contract for ${todo.length} addresses …`);
  const CONCURRENCY = 5;
  let done = 0;
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    await Promise.all(
      todo.slice(i, i + CONCURRENCY).map(async (addr) => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const res = await fetch(`${RH_EXPLORER}/api/v2/addresses/${addr}`, {
              headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
              signal: AbortSignal.timeout(15_000),
            });
            if (res.status === 429) {
              await sleep(2_000 * (attempt + 1));
              continue;
            }
            if (!res.ok) break;
            const d = await res.json();
            cache[addr] = d?.is_contract === true;
            return;
          } catch {
            await sleep(800);
          }
        }
        cache[addr] = false; // unknown → assume wallet, and say so in the report
      })
    );
    done += Math.min(CONCURRENCY, todo.length - i);
    if (done % 100 < CONCURRENCY) {
      writeFileSync(CONTRACT_CACHE, JSON.stringify(cache));
      console.log(`  ${done}/${todo.length}`);
    }
    await sleep(120);
  }
  writeFileSync(CONTRACT_CACHE, JSON.stringify(cache));
  return cache;
}

interface Candidate {
  tokenAddress: string;
  symbol: string;
  name: string;
  poolAddress: string | null;
  createdAt: string | null;
  launchpadId: string | null;
  currentFdvUsd: number | null;
  currentMcUsd: number | null;
  totalSupply: number | null;
  athMcUsd?: number | null;
  athDate?: string | null;
  sources: string[];
}

interface TraderRow {
  rank: number;
  walletAddress: string;
  amountInvestedUsd: number;
  avgEntryPriceUsd: number;
  entryMcUsd: number | null;
  amountSoldUsd: number;
  avgExitPriceUsd: number;
  exitMcUsd: number | null;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalPnlUsd: number;
  roiPct: number | null;
  currentBalance: number;
  currentBalanceUsd: number;
  supplyPct: number;
  buyCount: number;
  sellCount: number;
  firstBuyAt: string | null;
  lastActiveAt: string | null;
}

const iso = (s: number | null) => (s && s > 0 ? new Date(s * 1000).toISOString() : null);

// ── Bot detection ─────────────────────────────────────────────────────────────
// Trade count per token separates automation from people cleanly. Measured over
// all 1,230 top-30 rows in this dataset:
//
//   median  23     p90  246     p95  859     p99  5,979     max  35,696
//
// A second signal agrees: median average buy size is $757 for wallets under 50
// trades, but collapses to ~$160-290 once a wallet passes 500 — the signature of
// many small automated fills rather than position-taking.
//
// Thresholds are set where the two signals agree, and deliberately conservative:
// a human who traded actively is worth keeping, a bot is not worth alerting on.
const BOT_MAX_TX_ON_ANY_TOKEN = 1_000; // ~43x the median — no human does this on one token
const BOT_MEDIAN_TX = 250; // consistently automated across its tokens, even if no single one is extreme
const BOT_SMALL_FILL_USD = 250; // tiny average fill …
const BOT_SMALL_FILL_MIN_TX = 500; // … combined with high frequency

function classifyBot(appearances: any[]): { isBot: boolean; botReason: string | null; maxTxOnAToken: number; medianTxPerToken: number } {
  const counts = appearances.map((a) => a.txCount ?? 0).sort((x, y) => x - y);
  const maxTx = counts[counts.length - 1] ?? 0;
  const medianTx = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
  const fills = appearances.map((a) => a.avgBuyUsd).filter((v): v is number => v != null && v > 0);
  const avgFill = fills.length ? fills.reduce((s, v) => s + v, 0) / fills.length : null;

  let botReason: string | null = null;
  if (maxTx >= BOT_MAX_TX_ON_ANY_TOKEN) {
    botReason = `${maxTx.toLocaleString()} trades on a single token`;
  } else if (medianTx >= BOT_MEDIAN_TX) {
    botReason = `median ${medianTx.toLocaleString()} trades per token across ${counts.length}`;
  } else if (avgFill != null && avgFill < BOT_SMALL_FILL_USD && maxTx >= BOT_SMALL_FILL_MIN_TX) {
    botReason = `avg fill $${avgFill.toFixed(0)} over ${maxTx.toLocaleString()} trades`;
  }
  return { isBot: botReason !== null, botReason, maxTxOnAToken: maxTx, medianTxPerToken: medianTx };
}

function toRow(t: GmgnTopTrader, rank: number, supply: number | null): TraderRow {
  const invested = t.historyBoughtCostUsd;
  const total = t.realizedProfitUsd + t.unrealizedProfitUsd;
  return {
    rank,
    walletAddress: t.walletAddress.toLowerCase(),
    amountInvestedUsd: invested,
    avgEntryPriceUsd: t.avgCostUsd,
    // Market cap implied by the trader's average fill — the number that says
    // "they were buying at a $X valuation".
    entryMcUsd: supply && t.avgCostUsd ? t.avgCostUsd * supply : null,
    amountSoldUsd: t.historySoldIncomeUsd,
    avgExitPriceUsd: t.avgSoldUsd,
    exitMcUsd: supply && t.avgSoldUsd ? t.avgSoldUsd * supply : null,
    realizedPnlUsd: t.realizedProfitUsd,
    unrealizedPnlUsd: t.unrealizedProfitUsd,
    totalPnlUsd: total,
    roiPct: invested > 0 ? (total / invested) * 100 : null,
    currentBalance: t.balance,
    currentBalanceUsd: t.balanceUsd,
    supplyPct: t.supplyPercent,
    buyCount: t.buyCount,
    sellCount: t.sellCount,
    firstBuyAt: iso(t.openTimestamp),
    lastActiveAt: iso(t.lastActiveTimestamp),
  };
}

/**
 * Compact USD for display: $2.5B / $10M / $200K / $850. Raw numbers stay in the
 * JSON — this is only for the report and watchlist, where full figures are
 * unreadable in a table.
 */
const usd = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  const trim = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)).replace(/\.0+$/, "");
  if (a >= 1e9) return `${sign}$${trim(a / 1e9)}B`;
  if (a >= 1e6) return `${sign}$${trim(a / 1e6)}M`;
  if (a >= 1e3) return `${sign}$${trim(a / 1e3)}K`;
  return `${sign}$${a.toFixed(0)}`;
};

function loadJson<T>(p: string, fallback: T): T {
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function main() {
  const all = Object.values(loadJson<Record<string, Candidate>>(CANDIDATES, {}));
  if (all.length === 0) throw new Error(`no candidates — run rh-ath-harvest.ts first`);

  const cutoff = Date.now() - DAYS * 86_400_000;

  // The brief is coins LAUNCHED on Robinhood Chain. Bridged/wrapped/stable and
  // index assets trade here but weren't launched here, so they don't belong in
  // the dataset even though they clear the market-cap bar comfortably.
  const NOT_LAUNCHES = new Set(
    ["weth", "eth", "usdg", "usde", "usdc", "usdt", "dai", "wbtc", "btc", "index"].map((s) => s)
  );
  // A launchpad coin at $500M+ on this chain is not credible — it's a thin pool
  // printing a bad daily high. Held back and reported separately rather than
  // silently dropped or silently trusted.
  const PLAUSIBLE_MAX = 500_000_000;

  const overThreshold = all
    .filter((c) => (c.athMcUsd ?? 0) >= ATH_THRESHOLD_USD)
    .filter((c) => c.createdAt && new Date(c.createdAt).getTime() >= cutoff);

  const notLaunches = overThreshold.filter((c) => NOT_LAUNCHES.has((c.symbol || "").toLowerCase()));
  const implausible = overThreshold.filter(
    (c) => !NOT_LAUNCHES.has((c.symbol || "").toLowerCase()) && (c.athMcUsd ?? 0) > PLAUSIBLE_MAX
  );
  const qualifying = overThreshold
    .filter((c) => !NOT_LAUNCHES.has((c.symbol || "").toLowerCase()))
    .filter((c) => (c.athMcUsd ?? 0) <= PLAUSIBLE_MAX)
    .sort((a, b) => (b.athMcUsd ?? 0) - (a.athMcUsd ?? 0));

  console.log(`over threshold: ${overThreshold.length}`);
  console.log(`  excluded — not launched here: ${notLaunches.map((c) => c.symbol).join(", ") || "none"}`);
  console.log(`  excluded — implausible ATH   : ${implausible.map((c) => `${c.symbol} ($${((c.athMcUsd ?? 0) / 1e9).toFixed(1)}B)`).join(", ") || "none"}`);

  console.log(`candidates: ${all.length}`);
  console.log(`qualifying (>= $${(ATH_THRESHOLD_USD / 1e6).toFixed(0)}M ATH, <= ${DAYS}d old): ${qualifying.length}\n`);

  const cache = loadJson<Record<string, GmgnTopTrader[]>>(TRADER_CACHE, {});
  const raw = new Map<string, GmgnTopTrader[]>();

  for (const [i, c] of qualifying.entries()) {
    let traders = cache[c.tokenAddress];
    if (!traders) {
      process.stdout.write(`  [${i + 1}/${qualifying.length}] ${c.symbol || c.tokenAddress} … `);
      try {
        traders = await scrapeGmgnTopTraders("rh", c.tokenAddress);
      } catch (err) {
        console.log(`FAILED (${String(err).slice(0, 60)})`);
        traders = [];
      }
      cache[c.tokenAddress] = traders;
      if (!existsSync("data")) mkdirSync("data", { recursive: true });
      writeFileSync(TRADER_CACHE, JSON.stringify(cache));
      console.log(`${traders.length} traders`);
    } else {
      console.log(`  [${i + 1}/${qualifying.length}] ${c.symbol || c.tokenAddress} … ${traders.length} (cached)`);
    }

    raw.set(c.tokenAddress, traders);
  }

  // Only addresses that show up across MULTIPLE tokens need a contract check.
  // Checking all ~3,400 addresses GMGN returned meant thousands of Blockscout
  // calls, which rate-limited into a stall; the ones that matter number ~210.
  // The reasoning: infrastructure (pools, routers) is shared, so it recurs by
  // definition — the PoolManager appeared in every token. A contract that shows
  // up in exactly one token can't manufacture a false "repeat trader", which is
  // the output this dataset exists to produce.
  const freq = new Map<string, number>();
  for (const rows of raw.values()) {
    for (const t of rows) {
      const a = t.walletAddress.toLowerCase();
      freq.set(a, (freq.get(a) ?? 0) + 1);
    }
  }
  const allAddrs = [...freq.keys()];
  const repeatAddrs = allAddrs.filter((a) => (freq.get(a) ?? 0) >= 2);
  console.log(`\n${allAddrs.length} unique addresses; ${repeatAddrs.length} appear in 2+ tokens`);
  const isContract = await loadContractFlags(repeatAddrs);
  const excluded = (a: string) => KNOWN_INFRA.has(a) || isContract[a] === true;
  const filteredOut = allAddrs.filter(excluded);
  console.log(`\nfiltered ${filteredOut.length}/${allAddrs.length} addresses as contracts/infrastructure`);

  const tokens: any[] = [];
  for (const c of qualifying) {
    const traders = raw.get(c.tokenAddress) ?? [];
    const wallets = traders.filter((t) => !excluded(t.walletAddress.toLowerCase()));
    tokens.push({
      tokenAddress: c.tokenAddress,
      name: c.name || c.symbol,
      symbol: c.symbol,
      launchDate: c.createdAt,
      launchpadId: c.launchpadId,
      athMcUsd: c.athMcUsd ?? null,
      athDate: c.athDate ?? null,
      currentMcUsd: c.currentMcUsd ?? c.currentFdvUsd ?? null,
      drawdownFromAthPct:
        c.athMcUsd && (c.currentMcUsd ?? c.currentFdvUsd)
          ? (1 - (c.currentMcUsd ?? c.currentFdvUsd)! / c.athMcUsd) * 100
          : null,
      totalSupply: c.totalSupply,
      poolAddress: c.poolAddress,
      explorerUrl: `${RH_EXPLORER}/token/${c.tokenAddress}`,
      gmgnUrl: `https://gmgn.ai/robinhood/token/${c.tokenAddress}`,
      discoveredVia: c.sources,
      tradersReturnedByGmgn: traders.length,
      contractsFiltered: traders.length - wallets.length,
      topTraders: wallets.slice(0, TOP_N).map((t, idx) => toRow(t, idx + 1, c.totalSupply)),
    });
  }

  // ── cross-reference: addresses appearing across 2+ tokens ──────────────────
  const byWallet = new Map<string, any[]>();
  for (const tok of tokens) {
    for (const tr of tok.topTraders) {
      if (!byWallet.has(tr.walletAddress)) byWallet.set(tr.walletAddress, []);
      byWallet.get(tr.walletAddress)!.push({
        symbol: tok.symbol,
        tokenAddress: tok.tokenAddress,
        rank: tr.rank,
        realizedPnlUsd: tr.realizedPnlUsd,
        totalPnlUsd: tr.totalPnlUsd,
        amountInvestedUsd: tr.amountInvestedUsd,
        entryMcUsd: tr.entryMcUsd,
        exitMcUsd: tr.exitMcUsd,
        roiPct: tr.roiPct,
        firstBuyAt: tr.firstBuyAt,
        txCount: tr.buyCount + tr.sellCount,
        buyCount: tr.buyCount,
        sellCount: tr.sellCount,
        avgBuyUsd: tr.buyCount > 0 ? tr.amountInvestedUsd / tr.buyCount : null,
      });
    }
  }

  const scored = [...byWallet.entries()]
    .filter(([, appearances]) => appearances.length >= 2)
    .map(([walletAddress, appearances]) => {
      const invested = appearances.reduce((s, a) => s + (a.amountInvestedUsd || 0), 0);
      const pnl = appearances.reduce((s, a) => s + (a.totalPnlUsd || 0), 0);
      return {
        walletAddress,
        tokenCount: appearances.length,
        totalInvestedUsd: invested,
        totalPnlUsd: pnl,
        aggregateRoiPct: invested > 0 ? (pnl / invested) * 100 : null,
        bestRank: Math.min(...appearances.map((a) => a.rank)),
        explorerUrl: `${RH_EXPLORER}/address/${walletAddress}`,
        gmgnUrl: `https://gmgn.ai/robinhood/address/${walletAddress}`,
        appearances: appearances.sort((a: any, b: any) => b.totalPnlUsd - a.totalPnlUsd),
        ...classifyBot(appearances),
      };
    })
    .sort((a, b) => b.tokenCount - a.tokenCount || b.totalPnlUsd - a.totalPnlUsd);

  const repeatTraders = scored.filter((r) => !r.isBot);
  const excludedBots = scored.filter((r) => r.isBot);
  console.log(`\nrepeat wallets: ${scored.length} -> ${repeatTraders.length} traders, ${excludedBots.length} excluded as bots`);

  const report = {
    generatedAt: new Date().toISOString(),
    criteria: {
      chain: "Robinhood Chain",
      chainId: 4663,
      windowDays: DAYS,
      athThresholdUsd: ATH_THRESHOLD_USD,
      topTradersPerToken: TOP_N,
      repeatThreshold: 2,
    },
    excluded: {
      notLaunchedHere: notLaunches.map((c) => ({ symbol: c.symbol, athMcUsd: c.athMcUsd })),
      implausibleAth: implausible.map((c) => ({ symbol: c.symbol, athMcUsd: c.athMcUsd, tokenAddress: c.tokenAddress })),
    },
    coverage: {
      candidateUniverse: all.length,
      candidatesResolved: all.filter((c) => c.athMcUsd !== undefined && c.athMcUsd !== null).length,
      qualifyingTokens: tokens.length,
      note:
        "Robinhood Chain sees ~3,700 launches/day on the bonding-curve launchpad alone (~225k over 60 days). " +
        "No public source enumerates that or filters by peak market cap, and GeckoTerminal caps pagination at " +
        "10 pages x 20 per sort order. The universe is therefore assembled from every reachable ranked list " +
        "(pools.trade curve+auction feeds across 4 sort orders, GeckoTerminal top pools by volume and tx count, " +
        "and new pools) and each candidate's ATH computed from its own daily OHLCV. A token that hit $2M and " +
        "then went fully illiquid without appearing in any ranked list could be missed.",
      contractFiltering:
        "GMGN's top-trader list is flow-derived and includes contracts that hold or route the token " +
        "(the Uniswap V4 PoolManager appears in essentially every token). Addresses are checked against " +
        "Blockscout is_contract plus a denylist of known infrastructure, and contracts are removed BEFORE " +
        "taking the top 30, so every listed address is an actual wallet. The is_contract check is applied to " +
        "addresses appearing in 2+ tokens (infrastructure is shared, so it recurs by definition; a contract " +
        "confined to a single token cannot create a false repeat trader). Addresses whose status could not be " +
        "resolved are treated as wallets.",
      sources: [
        "pools.trade tRPC curve.listLaunches (volume|trending|recency|linked-x)",
        "pools.trade tRPC cca.listAllAuctions",
        "GeckoTerminal /networks/robinhood/pools (h24_volume_usd_desc, h24_tx_count_desc)",
        "GeckoTerminal /networks/robinhood/new_pools",
        "GeckoTerminal daily OHLCV per pool for ATH",
        "GMGN robinhood top traders per token",
      ],
    },
    summary: {
      tokens: tokens.length,
      addressesSeen: allAddrs.length,
      contractsFiltered: filteredOut.length,
      uniqueTopTraders: byWallet.size,
      repeatWallets: scored.length,
      repeatTraders: repeatTraders.length,
      excludedBots: excludedBots.length,
      repeatTraderShare: byWallet.size ? +((repeatTraders.length / byWallet.size) * 100).toFixed(2) : 0,
      botDetection: {
        maxTxOnAnyToken: BOT_MAX_TX_ON_ANY_TOKEN,
        medianTxPerToken: BOT_MEDIAN_TX,
        smallFillUsd: BOT_SMALL_FILL_USD,
        smallFillMinTx: BOT_SMALL_FILL_MIN_TX,
      },
      maxTokensBySingleWallet: repeatTraders[0]?.tokenCount ?? 0,
    },
    tokens,
    repeatTraders,
    excludedBots,
  };

  if (!existsSync("data")) mkdirSync("data", { recursive: true });
  writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));

  // ── markdown ──────────────────────────────────────────────────────────────
  const md: string[] = [];
  md.push(`# Robinhood Chain — tokens that hit $2M+ ATH market cap (last ${DAYS} days)`);
  md.push("");
  md.push(`Generated ${report.generatedAt} · chain 4663 · ATH threshold $${(ATH_THRESHOLD_USD / 1e6).toFixed(0)}M · top ${TOP_N} traders per token`);
  md.push("");
  md.push(`Machine-readable copy: [\`data/rh-ath-2m-60d.json\`](../../data/rh-ath-2m-60d.json)`);
  md.push("");
  md.push(`## Summary`);
  md.push("");
  md.push(`| | |`);
  md.push(`|---|---|`);
  md.push(`| Candidate universe scanned | ${report.coverage.candidateUniverse} |`);
  md.push(`| Tokens ≥ $2M ATH in window | **${tokens.length}** |`);
  md.push(`| Unique top-30 traders | ${byWallet.size} |`);
  md.push(`| Traders in 2+ tokens | **${repeatTraders.length}** (${report.summary.repeatTraderShare}%) |`);
  md.push(`| Most tokens by one wallet | ${report.summary.maxTokensBySingleWallet} |`);
  md.push("");
  md.push(`> **Coverage:** ${report.coverage.note}`);
  md.push("");

  md.push(`## Tokens`);
  md.push("");
  md.push(`| # | Token | Ticker | Launched | ATH MC | Current MC | Drawdown | Launchpad |`);
  md.push(`|---|---|---|---|---|---|---|---|`);
  tokens.forEach((t, i) => {
    md.push(
      `| ${i + 1} | ${t.name || "—"} | \`${t.symbol}\` | ${(t.launchDate ?? "—").slice(0, 10)} | ${usd(t.athMcUsd)} | ${usd(t.currentMcUsd)} | ${t.drawdownFromAthPct != null ? t.drawdownFromAthPct.toFixed(1) + "%" : "—"} | ${t.launchpadId ?? "—"} |`
    );
  });
  md.push("");

  md.push(`## Repeat traders (appear in 2+ tokens)`);
  md.push("");
  if (repeatTraders.length === 0) {
    md.push(`_None found._`);
  } else {
    md.push(`| Wallet | Tokens | Total invested | Total PnL | ROI | Max tx/token | Appears in |`);
    md.push(`|---|---|---|---|---|---|---|`);
    for (const r of repeatTraders) {
      md.push(
        `| [\`${r.walletAddress}\`](${r.gmgnUrl}) | **${r.tokenCount}** | ${usd(r.totalInvestedUsd)} | ${usd(r.totalPnlUsd)} | ${r.aggregateRoiPct != null ? r.aggregateRoiPct.toFixed(0) + "%" : "—"} | ${r.maxTxOnAToken.toLocaleString()} | ${r.appearances.map((a: any) => `\`${a.symbol}\``).join(", ")} |`
      );
    }
  }
  md.push("");
  md.push(`## Excluded as bots (${excludedBots.length})`);
  md.push("");
  md.push(
    `Automated wallets, removed from the list above. Trade count per token separates them cleanly: ` +
      `the median top-30 trader makes **23** trades on a token, while these run into the thousands.`
  );
  md.push("");
  if (excludedBots.length === 0) {
    md.push(`_None._`);
  } else {
    md.push(`| Wallet | Tokens | Total PnL | Why excluded | Appears in |`);
    md.push(`|---|---|---|---|---|`);
    for (const r of excludedBots) {
      md.push(
        `| [\`${r.walletAddress}\`](${r.gmgnUrl}) | ${r.tokenCount} | ${usd(r.totalPnlUsd)} | ${r.botReason} | ${r.appearances.map((a: any) => `\`${a.symbol}\``).join(", ")} |`
      );
    }
  }
  md.push("");

  md.push(`## Per-token top ${TOP_N} traders`);
  md.push("");
  for (const t of tokens) {
    md.push(`### ${t.name || t.symbol} · \`${t.symbol}\``);
    md.push("");
    md.push(
      `ATH **${usd(t.athMcUsd)}**${t.athDate ? ` on ${t.athDate.slice(0, 10)}` : ""} · current ${usd(t.currentMcUsd)} · launched ${(t.launchDate ?? "—").slice(0, 10)} · [\`${t.tokenAddress}\`](${t.explorerUrl}) · [GMGN](${t.gmgnUrl})`
    );
    md.push("");
    if (t.topTraders.length === 0) {
      md.push(`_No trader data returned by GMGN._`);
      md.push("");
      continue;
    }
    md.push(`| # | Wallet | Invested | Avg entry MC | Sold | Avg exit MC | Realized PnL | Total PnL | ROI | Buys/Sells |`);
    md.push(`|---|---|---|---|---|---|---|---|---|---|`);
    for (const tr of t.topTraders) {
      const repeat = (byWallet.get(tr.walletAddress)?.length ?? 0) >= 2 ? " 🔁" : "";
      md.push(
        `| ${tr.rank} | \`${tr.walletAddress}\`${repeat} | ${usd(tr.amountInvestedUsd)} | ${usd(tr.entryMcUsd)} | ${usd(tr.amountSoldUsd)} | ${usd(tr.exitMcUsd)} | ${usd(tr.realizedPnlUsd)} | ${usd(tr.totalPnlUsd)} | ${tr.roiPct != null ? tr.roiPct.toFixed(0) + "%" : "—"} | ${tr.buyCount}/${tr.sellCount} |`
      );
    }
    md.push("");
  }

  if (!existsSync("docs/research")) mkdirSync("docs/research", { recursive: true });
  writeFileSync(OUT_MD, md.join("\n"));

  // Flat watchlist — one full address per line, ready to seed the wallet alert
  // system without parsing anything.
  writeFileSync(
    OUT_WATCHLIST,
    repeatTraders
      .map(
        (r) =>
          `${r.walletAddress}  # ${r.tokenCount} tokens | PnL ${usd(r.totalPnlUsd)} | ` +
          r.appearances.map((a: any) => a.symbol).join(", ")
      )
      .join("\n") + "\n"
  );

  console.log(`\n════ done ════`);
  console.log(`  tokens ≥$2M ATH : ${tokens.length}`);
  console.log(`  unique traders  : ${byWallet.size}`);
  console.log(`  repeat traders  : ${repeatTraders.length}`);
  console.log(`  -> ${OUT_JSON}`);
  console.log(`  -> ${OUT_MD}`);
  console.log(`  -> ${OUT_WATCHLIST}`);
}

main()
  .then(() => {
    // The GMGN scraper keeps a Playwright browser singleton alive for reuse and
    // exposes no close helper, so the event loop never drains on its own. Exit
    // explicitly rather than leaving a headless Chrome running after the report
    // has been written.
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
