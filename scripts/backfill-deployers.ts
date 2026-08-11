/**
 * Backfill launch market caps and promote alpha deployers.
 *
 * deploy_mc_usd is what makes a "20x success rate" meaningful — without it a
 * token's ATH says nothing about whether the dev delivered.
 *
 *   npx tsx scripts/backfill-deployers.ts
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { supabase } from "../src/lib/supabase";
import { fetchDeployMc, refreshAlphaDeployers, tokensByDeployer, successRate } from "../src/lib/api/alpha-deployers";

const CHAIN = "rh";

async function main() {
  const { data: tokens } = await supabase
    .from("ath_tokens")
    .select("id, token_address, symbol, ath_mc_usd, total_supply, deploy_mc_usd")
    .eq("chain", CHAIN);

  const todo = (tokens ?? []).filter((t) => t.deploy_mc_usd == null);
  console.log(`tokens needing a launch market cap: ${todo.length}/${tokens?.length ?? 0}`);

  let done = 0;
  for (const t of todo) {
    const supply = Number(t.total_supply) || 1_000_000_000;
    const deployMc = await fetchDeployMc(t.token_address, supply);
    if (deployMc == null || deployMc <= 0) continue;
    const multiple = t.ath_mc_usd ? t.ath_mc_usd / deployMc : null;
    await supabase
      .from("ath_tokens")
      .update({ deploy_mc_usd: deployMc, ath_multiple: multiple })
      .eq("id", t.id);
    done++;
    console.log(`  ${(t.symbol ?? "?").padEnd(14)} launch $${Math.round(deployMc).toLocaleString().padStart(12)}  ->  ${multiple ? multiple.toFixed(1) + "x" : "?"}`);
  }
  console.log(`\nlaunch market caps written: ${done}`);

  const promoted = await refreshAlphaDeployers(CHAIN);
  console.log(`\nalpha deployers (2+ ATH tokens): ${promoted.length}`);
  for (const d of promoted) {
    const hist = await tokensByDeployer(CHAIN, d.address);
    const { hits, total, pct } = successRate(hist);
    console.log(`  ${(d.label ?? "?").padEnd(30)} ${d.address}  ${d.tokenCount} tokens  ${hits}/${total} 20x+ (${pct.toFixed(0)}%)`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
