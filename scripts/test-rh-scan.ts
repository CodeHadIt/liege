/**
 * Integration test for RH token scanning (/token, /scan) + wallet analysis.
 * Run: set -a; source .env.local; set +a;
 *   CHROMIUM_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *   npx tsx scripts/test-rh-scan.ts
 */
import { aggregateTokenData } from "@/lib/aggregator";
import { scrapeGmgnWalletHoldings } from "@/lib/api/gmgn-scraper";

const TOKENS = [
  "0x45242320dbb855eea8fd36804c6487e10e97fcf9",
  "0x020bfc650a365f8bb26819deaabf3e21291018b4",
];
const WALLETS = [
  "0x5638484ba2d2f1d1d35020572b0aa439a9869192",
  "0xa3e3376b2395d6e598dba44e3609310b0b6f90bc",
  "0x8d73a36d78e2ae4a437053c9ce3be70d483ab74d",
];

async function main() {
  console.log("########## TOKEN SCAN (aggregateTokenData rh) ##########");
  for (const addr of TOKENS) {
    const d = await aggregateTokenData("rh", addr).catch((e) => { console.log("ERR", e); return null; });
    if (!d) { console.log(`\n${addr}\n  ❌ null (would show "Token not found")`); continue; }
    console.log(`\n${addr}`);
    console.log(`  name/sym : ${d.name} (${d.symbol})  ${d.name !== "Unknown" ? "✅" : "❌"}`);
    console.log(`  price    : $${d.priceUsd}`);
    console.log(`  marketCap: $${d.marketCap?.toLocaleString()}`);
    console.log(`  liquidity: $${d.liquidity?.totalUsd?.toLocaleString()}`);
    console.log(`  vol24h   : $${d.volume24h?.toLocaleString()}`);
    console.log(`  ddScore  : ${d.ddScore?.grade ?? "n/a"}  |  safety flags: ${d.safetySignals?.flags?.length ?? 0}`);
  }

  console.log("\n########## WALLET ANALYSIS (GMGN holdings, rh) ##########");
  for (const w of WALLETS) {
    const h = await scrapeGmgnWalletHoldings("rh", w).catch(() => []);
    console.log(`\n${w}`);
    console.log(`  holdings/positions: ${h.length}  ${h.length > 0 ? "✅" : "⚠️ none"}`);
    h.slice(0, 4).forEach((x) =>
      console.log(`   - ${x.symbol.padEnd(10)} bal $${x.balanceUsd.toFixed(0)}  realizedPnl $${x.realizedPnlUsd.toFixed(0)}`)
    );
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
