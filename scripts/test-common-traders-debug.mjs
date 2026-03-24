/**
 * Diagnose why 0xacaf...354a is missing from common traders results.
 * Checks both tokens individually then simulates the intersection.
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
const CHAIN = "base"; // adjust if tokens are on a different chain

const TOKENS = [
  "0x50d2280441372486beecdd328c1854743ebacb07",
  "0x587cd533f418825521f3a1daa7ccd1e7339a1b07",
];

const results = [];

for (const token of TOKENS) {
  console.log(`\n${"─".repeat(70)}`);
  console.log(`Fetching GMGN traders: ${CHAIN}:${token}`);
  console.log("─".repeat(70));

  const traders = await scrapeGmgnTopTraders(CHAIN, token);
  console.log(`Total traders returned: ${traders.length}`);

  const found = traders.find(
    (t) => t.walletAddress.toLowerCase() === TARGET_WALLET.toLowerCase()
  );

  if (found) {
    const rank = traders.findIndex(
      (t) => t.walletAddress.toLowerCase() === TARGET_WALLET.toLowerCase()
    ) + 1;
    console.log(`\n✅  TARGET WALLET FOUND at rank #${rank}`);
    console.log(JSON.stringify(found, null, 2));
  } else {
    console.log(`\n❌  TARGET WALLET NOT FOUND in top ${traders.length} results`);
  }

  results.push({ token, traders, found: !!found });
}

console.log(`\n${"═".repeat(70)}`);
console.log("INTERSECTION SIMULATION");
console.log("═".repeat(70));

const sets = results.map((r) => new Set(r.traders.map((t) => t.walletAddress.toLowerCase())));

const intersection = [...sets[0]].filter((w) => sets.every((s) => s.has(w)));
console.log(`\nWallets in BOTH token lists: ${intersection.length}`);
console.log(`Target wallet in intersection: ${intersection.includes(TARGET_WALLET.toLowerCase()) ? "✅ YES" : "❌ NO"}`);

// Show which tokens the target is in
for (const r of results) {
  const inSet = sets[results.indexOf(r)].has(TARGET_WALLET.toLowerCase());
  console.log(`  Token ${r.token.slice(0, 10)}...: ${inSet ? "✅ present" : "❌ absent"}`);
}

process.exit(0);
