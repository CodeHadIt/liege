/**
 * Simulates the full common/route.ts logic end-to-end for the two given tokens,
 * to confirm whether 0xacaf... appears in the intersection.
 */

import { createJiti } from "jiti";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const jiti = createJiti(import.meta.url, {
  alias: { "@": resolve(root, "src") },
});

const { scrapeGmgnTopTraders } = await jiti.import(
  resolve(root, "src/lib/api/gmgn-scraper.ts")
);

const TARGET_WALLET = "0xacaf65505d9a48cd7a9be7eba5f25d886792354a";
const ZERO_ADDRESSES = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
  "11111111111111111111111111111111",
]);

const TOKENS = [
  { chain: "base", address: "0x50d2280441372486beecdd328c1854743ebacb07" },
  { chain: "base", address: "0x587cd533f418825521f3a1daa7ccd1e7339a1b07" },
];

// ── Phase 1: fetch GMGN for each token, build walletPnls ──────────────────────
const tokenResults = [];

for (const { chain, address } of TOKENS) {
  console.log(`\nFetching GMGN: ${chain}:${address}`);
  const gmgnTraders = await scrapeGmgnTopTraders(chain, address).catch(() => []);
  console.log(`  → ${gmgnTraders.length} GMGN traders returned`);

  // Replicate route walletStats build
  const walletStats = new Map();

  for (const t of gmgnTraders) {
    const addr = t.walletAddress.toLowerCase();
    if (ZERO_ADDRESSES.has(addr)) continue;

    walletStats.set(addr, {
      totalBought: t.avgCostUsd > 0 ? t.historyBoughtCostUsd / t.avgCostUsd : t.balance,
      totalSold:   t.avgSoldUsd  > 0 ? t.historySoldIncomeUsd  / t.avgSoldUsd  : 0,
      boughtUsd:   t.historyBoughtCostUsd,
      soldUsd:     t.historySoldIncomeUsd,
      avgBuyPrice: t.avgCostUsd,
      avgSellPrice: t.avgSoldUsd,
      buyCount:    t.buyCount,
      sellCount:   t.sellCount,
      realizedPnlUsd:   t.realizedProfitUsd,
      unrealizedPnlUsd: t.unrealizedProfitUsd,
    });
  }

  // Check target wallet in walletStats
  const targetStats = walletStats.get(TARGET_WALLET);
  console.log(`  → Target wallet in walletStats: ${targetStats ? "✅ YES" : "❌ NO"}`);
  if (targetStats) {
    console.log(`     realizedPnlUsd=$${targetStats.realizedPnlUsd?.toFixed(2)}`);
  }

  // Replicate walletPnls build
  const walletPnls = [];
  for (const [walletAddress, stats] of walletStats) {
    const pnl = stats.totalSold - stats.totalBought;
    const pnlUsd = stats.realizedPnlUsd ?? (pnl * 0); // priceUsd not needed here
    walletPnls.push({
      walletAddress,
      totalBought: stats.totalBought,
      totalSold: stats.totalSold,
      pnl,
      pnlUsd,
      boughtUsd: stats.boughtUsd,
      soldUsd: stats.soldUsd,
      avgBuyPrice: stats.avgBuyPrice,
      avgSellPrice: stats.avgSellPrice,
      buyCount: stats.buyCount,
      sellCount: stats.sellCount,
      unrealizedPnlUsd: stats.unrealizedPnlUsd,
    });
  }

  const targetPnl = walletPnls.find(w => w.walletAddress === TARGET_WALLET);
  console.log(`  → Target wallet in walletPnls: ${targetPnl ? "✅ YES" : "❌ NO"}`);

  tokenResults.push({ chain, address, walletPnls, symbol: "?", priceUsd: null });
}

// ── Phase 2: intersection (replicating route logic exactly) ──────────────────
console.log("\n── Phase 2: Intersection ──────────────────────────────────────────────");
const walletMap = new Map();

for (const tr of tokenResults) {
  const tokenKey = `${tr.chain}:${tr.address}`;
  for (const wp of tr.walletPnls) {
    const key = tr.chain === "solana" ? wp.walletAddress : wp.walletAddress.toLowerCase();
    if (!walletMap.has(key)) walletMap.set(key, new Map());
    if (!walletMap.get(key).has(tokenKey)) {
      walletMap.get(key).set(tokenKey, { token: { pnlUsd: wp.pnlUsd }, originalAddress: wp.walletAddress });
    }
  }
}

const commonTraders = [];
for (const [walletKey, tokenEntries] of walletMap) {
  if (tokenEntries.size < 2) continue;
  const entries = Array.from(tokenEntries.values());
  const totalPnlUsd = entries.reduce((sum, e) => sum + e.token.pnlUsd, 0);
  commonTraders.push({ walletKey, totalPnlUsd, tokenCount: tokenEntries.size });
}

commonTraders.sort((a, b) => b.totalPnlUsd - a.totalPnlUsd);

console.log(`\nTotal common traders: ${commonTraders.length}`);
const targetInResult = commonTraders.find(t => t.walletKey === TARGET_WALLET);
console.log(`Target wallet in results: ${targetInResult ? "✅ YES" : "❌ NO"}`);
if (targetInResult) {
  const rank = commonTraders.indexOf(targetInResult) + 1;
  console.log(`  Rank #${rank}, totalPnlUsd=$${targetInResult.totalPnlUsd.toFixed(2)}`);
}

console.log("\nTop 15 common traders:");
for (let i = 0; i < Math.min(15, commonTraders.length); i++) {
  const mark = commonTraders[i].walletKey === TARGET_WALLET ? " ← TARGET" : "";
  console.log(`  ${String(i+1).padStart(2)}. ${commonTraders[i].walletKey}  pnl=$${commonTraders[i].totalPnlUsd.toFixed(0)}${mark}`);
}

process.exit(0);
