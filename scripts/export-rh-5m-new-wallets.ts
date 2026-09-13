/**
 * Export the alpha-wallet candidates found in the $5M Robinhood study that we do
 * NOT already track — named with the project's own convention and shaped like an
 * `alpha_wallets` row, so the file can be imported into a trading platform or
 * replayed into the table.
 *
 * Thresholds are taken from the live promotion path rather than invented here
 * (see promoteRepeatTraders): a wallet must appear in 2+ distinct tokens, clear
 * MIN_COMBINED_PNL_USD, not be a contract, and not look like a bot. Using a
 * softer bar would produce a list that the system itself would refuse to store.
 *
 *   npx tsx scripts/export-rh-5m-new-wallets.ts            # writes JSON
 *   npx tsx scripts/export-rh-5m-new-wallets.ts --limit 10 # quick sample
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
import { readFileSync, writeFileSync } from "fs";

import { scrapeGmgnTopTraders, type GmgnTopTrader } from "../src/lib/api/gmgn-scraper";
import { isContractAddress, KNOWN_INFRA } from "../src/lib/api/ath-tokens";
import { loadAlphaWallets, buildLabel, dedupeLabels, MIN_COMBINED_PNL_USD } from "../src/lib/api/alpha-wallets";

const CHAIN = "robinhood";
const DB_CHAIN = "rh";
const REPORT = "/Users/mac/Desktop/dev/mac_mini/liege/docs/research/rh-5m-coins-two-weeks.md";
const OUT = "/Users/mac/Desktop/dev/mac_mini/liege/docs/research/rh-5m-new-alpha-wallets.json";

/** A wallet trading this much on one token is running a bot, not a thesis. */
const BOT_MAX_TX_ON_A_TOKEN = 1_000;

interface Agg {
  address: string;
  tokens: string[];
  pnl: number;
  invested: number;
  bestRank: number;
  maxTx: number;
}

function coinsFromReport(): { symbol: string; address: string }[] {
  const md = readFileSync(REPORT, "utf8");
  const block = md.split("```")[1] ?? "";
  return block
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length === 2 && /^0x[0-9a-f]{40}$/i.test(p[1]))
    .map(([symbol, address]) => ({ symbol, address: address.toLowerCase() }));
}

async function main() {
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;

  const coins = coinsFromReport().slice(0, limit);
  console.log(`coins from report: ${coins.length}`);

  const agg = new Map<string, Agg>();
  let failures = 0;

  for (const [i, c] of coins.entries()) {
    let traders: GmgnTopTrader[] = [];
    try {
      traders = (await scrapeGmgnTopTraders(CHAIN, c.address)) ?? [];
    } catch (e) {
      failures++;
      console.log(`  ${c.symbol.padEnd(14)} FAILED: ${(e as Error).message.slice(0, 50)}`);
      continue;
    }
    for (const [rank, t] of traders.entries()) {
      const w = t.walletAddress.toLowerCase();
      if (KNOWN_INFRA.has(w)) continue;
      let a = agg.get(w);
      if (!a) { a = { address: w, tokens: [], pnl: 0, invested: 0, bestRank: 999, maxTx: 0 }; agg.set(w, a); }
      if (!a.tokens.includes(c.symbol)) a.tokens.push(c.symbol);
      a.pnl += (Number(t.realizedProfitUsd) || 0) + (Number(t.unrealizedProfitUsd) || 0);
      a.invested += Number(t.historyBoughtCostUsd) || 0;
      a.bestRank = Math.min(a.bestRank, rank + 1);
      a.maxTx = Math.max(a.maxTx, (Number(t.buyCount) || 0) + (Number(t.sellCount) || 0));
    }
    console.log(`  ${String(i + 1).padStart(2)}/${coins.length} ${c.symbol.padEnd(14)} ${traders.length} traders`);
  }

  console.log(`\nscrape failures: ${failures}`);
  console.log(`distinct addresses seen: ${agg.size}`);

  const existing = await loadAlphaWallets(DB_CHAIN);
  console.log(`already tracked on ${DB_CHAIN}: ${existing.size}`);

  // Apply the live promotion bar, reporting each rejection reason.
  const reasons = { oneToken: 0, lowPnl: 0, bot: 0, known: 0, contract: 0 };
  const shortlist: Agg[] = [];
  for (const a of agg.values()) {
    if (a.tokens.length < 2) { reasons.oneToken++; continue; }
    if (a.pnl < MIN_COMBINED_PNL_USD) { reasons.lowPnl++; continue; }
    if (a.maxTx >= BOT_MAX_TX_ON_A_TOKEN) { reasons.bot++; continue; }
    if (existing.has(a.address)) { reasons.known++; continue; }
    shortlist.push(a);
  }

  // Contract check last — it is the only one that costs a network call.
  const candidates: Agg[] = [];
  for (const a of shortlist) {
    if (await isContractAddress(a.address)) { reasons.contract++; continue; }
    candidates.push(a);
  }

  console.log(
    `\nrejected — single token: ${reasons.oneToken}, PnL < $${MIN_COMBINED_PNL_USD.toLocaleString()}: ${reasons.lowPnl}, ` +
      `bot-like: ${reasons.bot}, already tracked: ${reasons.known}, contracts: ${reasons.contract}`
  );
  console.log(`NEW wallets to export: ${candidates.length}`);

  // Name them: highest-PnL tokens first, so the label reflects what the wallet is
  // actually known for. dedupeLabels suffixes collisions.
  candidates.sort((a, b) => b.pnl - a.pnl);
  const labels = dedupeLabels(candidates.map((a) => buildLabel(DB_CHAIN, a.tokens, a.pnl)));

  const rows = candidates.map((a, i) => ({
    label: labels[i],
    address: a.address,
    chain: DB_CHAIN,
    token_count: a.tokens.length,
    tokens: a.tokens,
    total_pnl_usd: Math.round(a.pnl * 100) / 100,
    total_invested_usd: Math.round(a.invested * 100) / 100,
    aggregate_roi_pct: a.invested > 0 ? Math.round((a.pnl / a.invested) * 10000) / 100 : null,
    best_rank: a.bestRank === 999 ? null : a.bestRank,
    max_tx_on_a_token: a.maxTx,
    source: "rh-5m-2w-study",
    notes: `Found in the $5M/14d Robinhood study; appears in ${a.tokens.length} of ${coins.length} coins`,
    is_active: true,
  }));

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        chain: DB_CHAIN,
        source: "rh-5m-2w-study",
        criteria: {
          min_distinct_tokens: 2,
          min_combined_pnl_usd: MIN_COMBINED_PNL_USD,
          max_tx_on_a_token: BOT_MAX_TX_ON_A_TOKEN,
          excludes: "contracts, known infrastructure, wallets already in alpha_wallets",
        },
        coins_scanned: coins.length,
        scrape_failures: failures,
        wallet_count: rows.length,
        wallets: rows,
      },
      null,
      2
    )
  );

  console.log(`\nwrote ${OUT}`);
  console.log(`\n${"LABEL".padEnd(34)}${"COINS".padEnd(7)}${"PnL".padStart(13)}  ADDRESS`);
  for (const r of rows.slice(0, 25)) {
    console.log(`${r.label.padEnd(34)}${String(r.token_count).padEnd(7)}${("$" + Math.round(r.total_pnl_usd).toLocaleString()).padStart(13)}  ${r.address}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
