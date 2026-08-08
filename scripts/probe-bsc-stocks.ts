/**
 * Probe the BSC stock-quote sources: Four.meme's counter-asset catalog and
 * Flap's payment-token catalog (live + upcoming). Run with:
 *   npx tsx --tsconfig tsconfig.json scripts/probe-bsc-stocks.ts
 */
import { fetchFourMemeQuoteTokens } from "../src/lib/api/four-meme";
import { fetchFlapPaymentTokens } from "../src/lib/api/flap";

async function main() {
  const four = await fetchFourMemeQuoteTokens();
  console.log(`\n=== four.meme counter assets: ${four.length} ===`);
  for (const t of four) {
    console.log(`  ${t.symbol.padEnd(12)} ${t.status.padEnd(8)} ${t.live ? "LIVE" : "    "}  ${t.address}`);
  }

  const flap = await fetchFlapPaymentTokens();
  console.log(`\n=== flap payment tokens: ${flap.length} ===`);
  const byChain = new Map<number, typeof flap>();
  for (const t of flap) {
    if (!byChain.has(t.chainId)) byChain.set(t.chainId, []);
    byChain.get(t.chainId)!.push(t);
  }
  for (const [chainId, tokens] of byChain) {
    const rwa = tokens.filter((t) => t.category === "rwa");
    console.log(
      `\n  -- chainId ${chainId}: ${tokens.length} total, ${rwa.length} rwa ` +
        `(${rwa.filter((t) => t.status === "available").length} live, ` +
        `${rwa.filter((t) => t.status === "coming-soon").length} upcoming)`
    );
    for (const t of tokens) {
      console.log(
        `     ${t.symbol.padEnd(10)} ${t.category.padEnd(6)} ${t.status.padEnd(12)} ${t.address ?? "(not deployed)"}  ${t.name}`
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
