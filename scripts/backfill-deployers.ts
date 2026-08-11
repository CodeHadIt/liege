/**
 * Promote alpha deployers and build their full deploy history.
 *
 * The history is the point. A success rate measured only against ath_tokens
 * would always be 100%, because a token only enters that table by clearing $2M
 * — the failures, which are what a rate is for, are missing by construction. So
 * every token a dev has shipped is enumerated from their transactions and
 * scored against the fixed $100k bar.
 *
 *   npx tsx scripts/backfill-deployers.ts            # preview
 *   npx tsx scripts/backfill-deployers.ts --write
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
// Reading dev tokens goes through GMGN, which needs a real browser.
process.env.CHROMIUM_EXECUTABLE_PATH ||= "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

import { supabase } from "../src/lib/supabase";
import {
  refreshAlphaDeployers,
  loadAlphaDeployers,
  tokensByDeployer,
  deployerSuccessRate,
  recentTxs,
  markDeployerChecked,
  syncDeployerTokensFromGmgn,
  athMultiple,
  SUCCESS_MULTIPLE,
} from "../src/lib/api/alpha-deployers";

const CHAIN = "rh";

async function main() {
  const write = process.argv.includes("--write");

  // Promote first so the deployers exist; counts are corrected at the end once
  // their deploy histories are known.
  const promoted = write ? await refreshAlphaDeployers(CHAIN) : await loadAlphaDeployers(CHAIN);
  console.log(`alpha deployers (2+ $2M runners): ${promoted.length}\n`);

  for (const dep of promoted) {
    const winners = await tokensByDeployer(CHAIN, dep.address);
    console.log(`${dep.label ?? dep.address}`);
    console.log(`  ${dep.address}`);
    console.log(`  $2M runners: ${winners.map((w) => w.symbol).join(", ")}`);

    if (!write) {
      console.log("");
      continue;
    }

    // GMGN serves the dev's full token list with each ATH already computed, so
    // it replaces both the runner seeding and the transaction walk.
    const synced = await syncDeployerTokensFromGmgn(CHAIN, dep.id, dep.address);
    if (!synced) {
      console.log("  gmgn returned no deploy list (rate limited?) — skipped\n");
      continue;
    }

    // Start the live watcher at the current head so recorded history is never
    // replayed as new launches.
    const txs = await recentTxs(dep.address);
    if (txs[0]) await markDeployerChecked(dep.id, txs[0].hash);

    const rate = await deployerSuccessRate(CHAIN, dep.address);
    await supabase
      .from("token_deployers")
      .update({ success_20x_count: rate.hits, total_deploys: rate.total })
      .eq("id", dep.id);

    console.log(`  deploys (from GMGN): ${synced.total}  ->  ${rate.hits}/${rate.total} hit ${SUCCESS_MULTIPLE}x+ (${rate.pct.toFixed(0)}%)`);
    for (const w of winners) {
      const x = athMultiple(w.athMcUsd);
      console.log(`    ${(w.symbol ?? "?").padEnd(14)} ATH $${Math.round(w.athMcUsd ?? 0).toLocaleString().padStart(12)}  ${x ? Math.round(x).toLocaleString() + "x" : "?"}`);
    }
    console.log("");
  }

  if (!write) console.log("PREVIEW ONLY — re-run with --write.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
