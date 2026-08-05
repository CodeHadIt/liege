/**
 * Integration test for the Robinhood (RH) /tt feature via the GMGN scraper.
 * Exercises the real path: detectEvmChain routing + scrapeGmgnTopTraders.
 *
 * Run: CHROMIUM_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *        npx tsx scripts/test-rh-tt.ts
 */
import { detectEvmChain } from "@/lib/telegram/commands/token";
import { scrapeGmgnTopTraders } from "@/lib/api/gmgn-scraper";

const TOKENS = [
  "0x45242320dbb855eea8fd36804c6487e10e97fcf9",
  "0x020bfc650a365f8bb26819deaabf3e21291018b4",
];

async function main() {
  for (const addr of TOKENS) {
    console.log(`\n=== token ${addr} ===`);

    // 1. Routing decision (what the /tt command handler does)
    const chain = await detectEvmChain(addr);
    console.log(`detectEvmChain -> ${chain}  ${chain === "rh" ? "✅" : "❌ expected rh"}`);

    // 2. GMGN scrape (what handleTopTraders does for non-TON chains)
    const traders = await scrapeGmgnTopTraders(chain, addr).catch((e) => { console.log("scrape err:", e); return []; });
    console.log(`traders: ${traders.length}  ${traders.length > 0 ? "✅" : "❌"}`);
    traders.slice(0, 8).forEach((t, i) =>
      console.log(
        `  ${i + 1}. ${t.walletAddress}  ` +
        `bought $${t.historyBoughtCostUsd.toFixed(0)}  sold $${t.historySoldIncomeUsd.toFixed(0)}  ` +
        `realizedPnl $${t.realizedProfitUsd.toFixed(0)}  bal $${t.balanceUsd.toFixed(0)}`
      )
    );
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
