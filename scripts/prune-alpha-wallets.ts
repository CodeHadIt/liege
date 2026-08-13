/**
 * Remove alpha wallets that don't clear the combined-PnL bar.
 *
 *   npx tsx scripts/prune-alpha-wallets.ts            # preview
 *   npx tsx scripts/prune-alpha-wallets.ts --write
 *
 * The bar (MIN_COMBINED_PNL_USD) was introduced after the table was already
 * populated, so this applies it retroactively. Both live write paths — the daily
 * scan's promotion and the seed script — enforce the same constant, so once this
 * has run the table cannot drift back below it.
 *
 * Deletes rather than deactivates. `is_active` exists, but a wallet under the
 * bar is not "paused pending review", it simply never qualified; leaving rows
 * behind would mean every consumer had to remember to filter, and the export
 * scripts key off the table directly.
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { supabase } from "../src/lib/supabase";
import { MIN_COMBINED_PNL_USD, compactPnl } from "../src/lib/api/alpha-wallets";

const CHAIN = "rh";

async function main() {
  const write = process.argv.includes("--write");

  const { data, error } = await supabase
    .from("alpha_wallets")
    .select("id,label,address,total_pnl_usd,token_count,tokens,source")
    .eq("chain", CHAIN)
    .order("total_pnl_usd", { ascending: true });

  if (error) throw new Error(`alpha_wallets read failed: ${error.message}`);
  const rows = data ?? [];
  if (rows.length === 0) throw new Error("no alpha wallets found — nothing to prune, and that is suspicious");

  // A NULL PnL is not a zero: it means the figure was never captured, and
  // deleting on the strength of a missing number would be guessing. Held back
  // and reported so it can be looked at rather than silently dropped.
  const unknown = rows.filter((r) => r.total_pnl_usd === null || r.total_pnl_usd === undefined);
  const below = rows.filter(
    (r) => r.total_pnl_usd !== null && r.total_pnl_usd !== undefined && Number(r.total_pnl_usd) < MIN_COMBINED_PNL_USD
  );
  const keep = rows.length - below.length - unknown.length;

  console.log(`bar              : ${compactPnl(MIN_COMBINED_PNL_USD)} combined PnL`);
  console.log(`alpha wallets    : ${rows.length}`);
  console.log(`  keeping        : ${keep}`);
  console.log(`  removing       : ${below.length}`);
  console.log(`  unknown PnL    : ${unknown.length}  (kept — needs a look, not a guess)`);

  if (below.length) {
    console.log(`\nremoving (lowest first):`);
    for (const r of below) {
      console.log(`  ${compactPnl(Number(r.total_pnl_usd)).padStart(8)}  ${(r.label ?? "?").padEnd(32)} ${r.address}  [${(r.tokens ?? []).join(",")}]`);
    }
  }
  for (const r of unknown) {
    console.log(`  ⚠️  NULL PnL, kept: ${r.label} ${r.address}`);
  }

  if (!write) {
    console.log(`\nPREVIEW ONLY — re-run with --write to delete.`);
    return;
  }
  if (below.length === 0) {
    console.log(`\nnothing to remove.`);
    return;
  }

  // Delete by primary key in batches — matching on a float column would be
  // fragile, and ids are unambiguous.
  const ids = below.map((r) => r.id);
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const slice = ids.slice(i, i + 50);
    const { error: delErr } = await supabase.from("alpha_wallets").delete().in("id", slice);
    if (delErr) throw new Error(`delete failed at batch ${i}: ${delErr.message}`);
    deleted += slice.length;
  }

  const { count } = await supabase
    .from("alpha_wallets")
    .select("*", { count: "exact", head: true })
    .eq("chain", CHAIN);

  console.log(`\ndeleted ${deleted} wallets`);
  console.log(`alpha_wallets now: ${count ?? "?"}`);
  console.log(`\nNext: npx tsx scripts/update-tracked-wallets.ts --write`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
