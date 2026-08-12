/**
 * Dry-run the BSC bonding-curve launch path. Scans recent blocks for Flap and
 * Four.meme curve creations, resolves each quote asset, and renders the alert
 * that WOULD be sent for any launch against a tokenized stock. Nothing is
 * pushed to Telegram. Run with:
 *   npx tsx scripts/probe-bsc-first-token.ts [blocksBack]
 */
import { fetchFlapPaymentTokens, FLAP_BSC_CHAIN_ID } from "../src/lib/api/flap";
import {
  getLatestBscBlock,
  getFlapLaunches,
  getFourMemeLaunches,
  getFourMemeQuote,
  getBscTokenMeta,
  ZERO_ADDRESS,
  type BscLaunch,
} from "../src/lib/api/bsc-onchain";
import { fetchBscTokenStats } from "../src/lib/api/bsc-launches";
import {
  formatBscFirstTokenAlert,
  type FirstTokenWatch,
  type Platform,
} from "../src/lib/telegram/bsc-stock-alerts";

async function main() {
  const blocksBack = parseInt(process.argv[2] ?? "3000", 10);

  const flapTokens = await fetchFlapPaymentTokens();
  const stocks = new Map<string, { symbol: string; name: string }>();
  for (const t of flapTokens) {
    if (t.chainId === FLAP_BSC_CHAIN_ID && t.category === "rwa" && t.address) {
      stocks.set(t.address.toLowerCase(), { symbol: t.symbol, name: t.name });
    }
  }
  console.log(`known bStock quote assets on BNB Chain: ${stocks.size}`);

  const latest = await getLatestBscBlock();
  if (latest == null) throw new Error("could not read latest BSC block");
  const from = latest - blocksBack;
  console.log(`scanning blocks ${from}..${latest} (~${((blocksBack * 0.45) / 60).toFixed(1)} min)\n`);

  const [flap, four] = await Promise.all([
    getFlapLaunches(from, latest),
    getFourMemeLaunches(from, latest),
  ]);
  if (flap == null || four == null) throw new Error("BSC RPCs failed during the log scan");
  console.log(`flap curve creations:     ${flap.length}`);
  console.log(`four.meme curve creations: ${four.length}\n`);

  const quoteCounts = new Map<string, number>();
  const stockLaunches: BscLaunch[] = [];

  for (const l of [...flap, ...four]) {
    let quote = l.quoteAddress;
    if (!quote) quote = (await getFourMemeQuote(l.tokenAddress)) ?? "";
    l.quoteAddress = quote;
    const label = quote === ZERO_ADDRESS || !quote ? "BNB (native)" : (stocks.get(quote)?.symbol ?? quote);
    quoteCounts.set(`${l.platform}/${label}`, (quoteCounts.get(`${l.platform}/${label}`) ?? 0) + 1);
    if (quote && quote !== ZERO_ADDRESS && stocks.has(quote)) stockLaunches.push(l);
  }

  console.log("quote distribution:");
  for (const [k, v] of [...quoteCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${k.padEnd(28)} x${v}`);
  }

  console.log(`\n=== launches against a tokenized stock: ${stockLaunches.length} ===`);
  for (const l of stockLaunches) {
    if (!l.symbol && !l.name) {
      const meta = await getBscTokenMeta(l.tokenAddress);
      l.name = meta.name;
      l.symbol = meta.symbol;
    }
    const s = stocks.get(l.quoteAddress)!;
    const w: FirstTokenWatch = {
      platform: l.platform as Platform,
      stockAddress: l.quoteAddress,
      symbol: s.symbol,
      name: s.name,
      addedAt: Date.now(),
      launchCount: 1,
    };
    const stats = await fetchBscTokenStats(l.tokenAddress);
    console.log("\n" + formatBscFirstTokenAlert(w, { launch: l, ...stats }) + "\n");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
