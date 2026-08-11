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

import { supabase } from "../src/lib/supabase";
import {
  refreshAlphaDeployers,
  loadAlphaDeployers,
  tokensByDeployer,
  deployerSuccessRate,
  recentTxs,
  mintedTokensInTx,
  markDeployerChecked,
  fetchAthMc,
  athMultiple,
  SUCCESS_ATH_MC_USD,
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

    // Walk their transactions and record every token they minted.
    const txs = await recentTxs(dep.address);
    let found = 0;
    for (const tx of txs) {
      for (const token of await mintedTokensInTx(tx.hash)) {
        const { data: seen } = await supabase
          .from("deployer_launches")
          .select("id")
          .eq("chain", CHAIN)
          .eq("token_address", token.address)
          .maybeSingle();
        if (seen?.id) continue;

        const ath = await fetchAthMc(token.address);
        await supabase.from("deployer_launches").insert({
          deployer_id: dep.id,
          chain: CHAIN,
          deployer_address: dep.address,
          token_address: token.address,
          token_name: token.name,
          token_symbol: token.symbol,
          tx_hash: tx.hash,
          launched_at: tx.timestamp,
          ath_mc_usd: ath,
          is_success: (ath ?? 0) >= SUCCESS_ATH_MC_USD,
          // Historical rows are backfilled, never announced.
          alerted_at: new Date().toISOString(),
        });
        found++;
      }
    }
    // Start the live watcher from the current head, so the backfilled history
    // isn't replayed as new launches.
    if (txs[0]) await markDeployerChecked(dep.id, txs[0].hash);

    const rate = await deployerSuccessRate(CHAIN, dep.address);
    await supabase
      .from("token_deployers")
      .update({ success_20x_count: rate.hits, total_deploys: rate.total })
      .eq("id", dep.id);

    console.log(`  deploys recorded: ${found}  ->  ${rate.hits}/${rate.total} hit ${SUCCESS_MULTIPLE}x+ (${rate.pct.toFixed(0)}%)`);
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
