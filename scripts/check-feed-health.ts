/**
 * Probe every upstream once and print the result. Sends nothing, writes nothing.
 *
 *   npx tsx scripts/check-feed-health.ts
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { healthSnapshot } from "../src/lib/telegram/health-alerts";

async function main() {
  const rows = await healthSnapshot();
  console.log("source".padEnd(24) + "chain".padEnd(18) + "status".padEnd(10) + "detail");
  console.log("-".repeat(84));
  for (const r of rows.sort((a, b) => Number(a.ok) - Number(b.ok))) {
    console.log(
      r.source.padEnd(24) + r.chain.padEnd(18) + (r.ok ? "OK" : "DOWN").padEnd(10) + (r.error ?? "")
    );
  }
  const down = rows.filter((r) => !r.ok);
  console.log(`\n${rows.length - down.length}/${rows.length} sources healthy`);
  if (down.length) console.log(`DOWN: ${down.map((d) => d.source).join(", ")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
