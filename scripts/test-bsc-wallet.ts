import { scrapeGmgnWalletHoldings } from "../src/lib/api/gmgn-scraper";

const address = "0x8d73a36d78e2ae4a437053c9ce3be70d483ab74d";
const chain = "bsc";

scrapeGmgnWalletHoldings(chain, address).then((holdings) => {
  console.log(`Total holdings: ${holdings.length}`);

  // Look for specific tokens
  const targets = [
    "0xf74548802f4c700315f019fde17178b392ee4444",
    "0xbc5dac3eb8e4c82523c84fa8589f91cbe6cc4444",
  ];

  for (const t of targets) {
    const h = holdings.find(h => h.tokenAddress.toLowerCase() === t.toLowerCase());
    console.log(`\n${t}: ${h ? "FOUND" : "NOT FOUND"}`);
    if (h) console.log(JSON.stringify(h, null, 2));
  }

  // Show top 5 by realizedPnlUsd
  const byPnl = [...holdings].sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd);
  console.log("\nTop 5 by realizedPnl:");
  byPnl.slice(0, 5).forEach(h => console.log(`  ${h.symbol} (${h.tokenAddress.slice(0,10)}...) realized=$${h.realizedPnlUsd.toFixed(0)} balance=$${h.balanceUsd.toFixed(0)} invested=$${h.investedUsd.toFixed(0)}`));

  // Show all with realizedPnl > 0
  const withPnl = holdings.filter(h => h.realizedPnlUsd > 0);
  console.log(`\nHoldings with realized PnL > 0: ${withPnl.length}`);

  process.exit(0);
}).catch(err => { console.error(err); process.exit(1); });
