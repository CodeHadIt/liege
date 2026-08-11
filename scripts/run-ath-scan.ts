/**
 * Run the daily ATH scan manually.
 *
 *   npx tsx scripts/run-ath-scan.ts --dry            # no DB writes, no pings
 *   npx tsx scripts/run-ath-scan.ts                  # real run (writes + pings)
 *   npx tsx scripts/run-ath-scan.ts --hours 168      # widen the window
 *   npx tsx scripts/run-ath-scan.ts --refresh-mc     # weekly market-cap refresh
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
process.env.CHROMIUM_EXECUTABLE_PATH ||= "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

import { runAthScan, refreshAthTokenMarketCaps } from "../src/lib/telegram/ath-daily-scan";

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry");
  const hoursIdx = argv.indexOf("--hours");
  const windowHours = hoursIdx >= 0 ? parseInt(argv[hoursIdx + 1], 10) : undefined;

  if (argv.includes("--refresh-mc")) {
    const n = await refreshAthTokenMarketCaps();
    console.log(`refreshed current market cap for ${n} tokens`);
    return;
  }

  console.log(`running ATH scan${dryRun ? " (DRY RUN — no writes, no pings)" : ""}${windowHours ? ` window=${windowHours}h` : ""}\n`);
  const res = await runAthScan({ dryRun, windowHours });
  console.log(`\n════ result ════`);
  console.log(`  candidates scanned : ${res.candidatesScanned}`);
  console.log(`  tokens ≥$2M found  : ${res.tokensFound}`);
  console.log(`  traders captured   : ${res.tradersCaptured}`);
  console.log(`  new alpha wallets  : ${res.alphaAdded}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
