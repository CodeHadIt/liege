/**
 * Render every alert format against live data, without sending anything.
 * Verifies the chain labelling (Flap ships on both BNB Chain and Robinhood
 * Chain) and the reshaped StonkFun feed.
 *
 *   npx tsx scripts/probe-alert-formats.ts
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { fetchQuoteTokens, fetchRecentCreations, enrichCreation } from "../src/lib/api/stonkfun";
import { formatQuoteTokenAlert, formatStonkFunLaunchAlert } from "../src/lib/telegram/stonkfun-alerts";
import { fetchFlapPaymentTokens, FLAP_BSC_CHAIN_ID, FLAP_ROBINHOOD_CHAIN_ID } from "../src/lib/api/flap";
import { formatStockQuoteAlert, type StockQuote } from "../src/lib/telegram/bsc-stock-alerts";
import { formatFlapRhStockAlert } from "../src/lib/telegram/long-alerts";

function hr(title: string) {
  console.log(`\n${"═".repeat(64)}\n${title}\n${"═".repeat(64)}`);
}

async function main() {
  const flap = await fetchFlapPaymentTokens();

  hr("FLAP · BNB Chain — new stock quote live");
  const bsc = flap.find((t) => t.chainId === FLAP_BSC_CHAIN_ID && t.category === "rwa" && t.address)!;
  const q: StockQuote = {
    platform: "flap",
    symbol: bsc.symbol,
    name: bsc.name,
    address: bsc.address,
    logoUrl: null,
    live: true,
    kind: "stock",
  };
  console.log(formatStockQuoteAlert(q, "live"));

  hr("FLAP · Robinhood Chain — new stock quote");
  const rh = flap.find((t) => t.chainId === FLAP_ROBINHOOD_CHAIN_ID && t.category === "rwa" && t.address)!;
  console.log(formatFlapRhStockAlert(rh));

  hr("FOUR.MEME · BNB Chain — upcoming stock quote");
  const upcoming = flap.find(
    (t) => t.chainId === FLAP_BSC_CHAIN_ID && t.status === "coming-soon" && t.category === "rwa"
  )!;
  console.log(
    formatStockQuoteAlert(
      { platform: "fourmeme", symbol: upcoming.symbol, name: upcoming.name, address: null, logoUrl: null, live: false, kind: "stock" },
      "listed"
    )
  );

  const quotes = await fetchQuoteTokens();
  if (!quotes) throw new Error('stonkfun quote catalog unavailable');
  hr("STONKFUN · Solana — new quote token (stock)");
  const stockQuote = quotes.find((x) => x.category === "xstock") ?? quotes[0];
  console.log(formatQuoteTokenAlert(stockQuote));

  hr("STONKFUN · Solana — custom on-chain assets are NOT alerted");
  const customQuote = quotes.find((x) => x.category === "custom");
  console.log(
    customQuote
      ? `Would be skipped: ${customQuote.symbol} (category "custom") — a memecoin paired against another memecoin is not the signal this feed is for.`
      : "(no custom-category quote listed right now)"
  );

  hr("STONKFUN · Solana — launch against a newly-added quote");
  const creations = await fetchRecentCreations(10);
  let rendered = false;
  for (const c of creations) {
    const d = await enrichCreation(c);
    if (!d.pairedAddress) continue;
    const quote = quotes.find((x) => x.quoteMint === d.pairedAddress);
    if (!quote) continue;
    console.log(formatStonkFunLaunchAlert(quote, d, 1));
    rendered = true;
    break;
  }
  if (!rendered) console.log("(no recent creation with a resolvable known quote pair)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
