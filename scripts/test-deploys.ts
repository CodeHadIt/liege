/* eslint-disable no-console */
import { getDeployedTokens, bestLaunch } from "../src/lib/api/deploys";

const cases: Array<{ chain: "solana" | "eth" | "base" | "bsc"; addr: string; note: string }> = [
  { chain: "solana", addr: "B2oCruKe8e4s44n47myzD7TnNaGLqT7brNzforQx2Bjg", note: "VERIFIED recent pump.fun dev" },
  { chain: "solana", addr: "5Drny4ZTPhg98nAL9f9E78dqUBvtDfe16HABKMmUT7f2", note: "user-provided sol address" },
  { chain: "bsc",    addr: "0x40dcba226725b024216c40a2495d858ce3ca188d", note: "user-provided bsc address" },
  { chain: "eth",    addr: "0x40dcba226725b024216c40a2495d858ce3ca188d", note: "same address on ETH" },
  { chain: "base",   addr: "0x40dcba226725b024216c40a2495d858ce3ca188d", note: "same address on Base" },
];

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
