/* eslint-disable no-console */
import { getDeployedTokens, bestLaunch } from "../src/lib/api/deploys";

const cases: Array<{ chain: "solana" | "eth" | "base" | "bsc"; addr: string; note: string }> = [
  // Override via CLI: `npx tsx scripts/test-deploys.ts <chain> <address>`
  { chain: "solana", addr: "5UrNNGfvmGaJ8Uz4FzQPq1NTcbEbnv2ZnBqGU936iBZp", note: "pump.fun NYANCAT dev" },
];

const cliChain = process.argv[2] as "solana" | "eth" | "base" | "bsc" | undefined;
const cliAddr  = process.argv[3];
if (cliChain && cliAddr) cases.length = 0, cases.push({ chain: cliChain, addr: cliAddr, note: "cli-supplied" });

(async () => {
  for (const c of cases) {
    console.log(`\n=== ${c.chain} :: ${c.addr} (${c.note}) ===`);
    const start = Date.now();
    const tokens = await getDeployedTokens(c.chain, c.addr);
    const elapsed = Date.now() - start;
    console.log(`  → ${tokens.length} tokens in ${elapsed}ms`);
    for (const t of tokens.slice(0, 10)) {
      const mc = t.currentMcUsd > 1 ? `$${t.currentMcUsd.toLocaleString()}` : "—";
      console.log(`    ${t.symbol.padEnd(10)} ${t.address}  mc=${mc}`);
    }
    const best = bestLaunch(tokens);
    if (best) console.log(`  🏆 Best: ${best.symbol} — MC: $${(best.highestMcUsd ?? best.currentMcUsd).toLocaleString()}`);
  }
})();
