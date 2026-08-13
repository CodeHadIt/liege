/**
 * Seed the alpha_wallets table from the ATH research dataset.
 *
 * Reads data/rh-ath-2m-60d.json (repeatTraders — bots already excluded) and
 * upserts each wallet with a label following the convention
 * <CHAIN>_<coin1>_<coin2>_<pnl>, e.g. RH_cashcat_tendies_1.7M.
 *
 *   npx tsx scripts/seed-alpha-wallets.ts            # preview only
 *   npx tsx scripts/seed-alpha-wallets.ts --write    # write to Supabase
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { readFileSync } from "fs";
import {
  buildLabel,
  dedupeLabels,
  upsertAlphaWallets,
  MIN_COMBINED_PNL_USD,
  type AlphaWallet,
} from "../src/lib/api/alpha-wallets";

const SOURCE = "rh-ath-2m-60d";
const CHAIN = "rh";

async function main() {
  const write = process.argv.includes("--write");
  const report = JSON.parse(readFileSync("data/rh-ath-2m-60d.json", "utf8"));
  const repeats: any[] = report.repeatTraders ?? [];
  if (repeats.length === 0) throw new Error("no repeatTraders in dataset");

  // `appearances` are already sorted by PnL contribution, so the first two are
  // the wallet's biggest winners — which is what the label should name.
  const draft = repeats.map((r) => ({
    r,
    tokens: (r.appearances ?? []).map((a: any) => a.symbol as string),
  }));
  const labels = dedupeLabels(draft.map((d) => buildLabel(CHAIN, d.tokens, d.r.totalPnlUsd)));

  const wallets: AlphaWallet[] = draft.map((d, i) => ({
    label: labels[i],
    address: d.r.walletAddress,
    chain: CHAIN,
    tokenCount: d.r.tokenCount,
    tokens: d.tokens,
    totalPnlUsd: d.r.totalPnlUsd ?? null,
    totalInvestedUsd: d.r.totalInvestedUsd ?? null,
    aggregateRoiPct: d.r.aggregateRoiPct ?? null,
    bestRank: d.r.bestRank ?? null,
    maxTxOnAToken: d.r.maxTxOnAToken ?? null,
    source: SOURCE,
    isActive: true,
  }));

  // Same bar as the live promotion path — the seed must not be able to
  // introduce wallets the daily scan would reject.
  const belowBar = wallets.filter((w) => (w.totalPnlUsd ?? 0) < MIN_COMBINED_PNL_USD);
  const qualified = wallets.filter((w) => (w.totalPnlUsd ?? 0) >= MIN_COMBINED_PNL_USD);
  console.log(`below $${MIN_COMBINED_PNL_USD.toLocaleString()} combined PnL, skipped: ${belowBar.length}`);
  console.log(`alpha wallets from ${SOURCE}: ${qualified.length}\n`);
  for (const w of qualified.slice(0, 15)) {
    console.log(`  ${w.label.padEnd(34)} ${w.address}  ${w.tokenCount}x  ${w.tokens.slice(0, 4).join(",")}`);
  }
  if (qualified.length > 15) console.log(`  … ${qualified.length - 15} more`);

  const dupes = labels.filter((l, i) => labels.indexOf(l) !== i);
  console.log(`\nlabel collisions resolved: ${dupes.length}`);

  if (!write) {
    console.log(`\nPREVIEW ONLY — re-run with --write to upsert into Supabase.`);
    return;
  }
  const n = await upsertAlphaWallets(qualified);
  console.log(`\nupserted ${n} wallets into alpha_wallets`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
