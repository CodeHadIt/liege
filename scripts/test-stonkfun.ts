import { fetchRecentCreations, enrichCreation } from "@/lib/api/stonkfun";
import { formatStonkFunAlert } from "@/lib/telegram/stonkfun-alerts";

async function main() {
  const creations = await fetchRecentCreations(5);
  console.log(`fetchRecentCreations -> ${creations.length} creations`);
  creations.forEach((c) => console.log(`  ${c.symbol.padEnd(12)} ${c.mint}  t=${c.timestamp}`));
  if (!creations.length) { console.log("no creations found"); return; }

  console.log("\n=== enrich + render the 2 most recent ===");
  for (const c of creations.slice(0, 2)) {
    const d = await enrichCreation(c);
    console.log("\n--- RAW ---");
    console.log(JSON.stringify({ name: d.name, symbol: d.symbol, paired: d.pairedSymbol, liq: d.liquidityUsd, mc: d.marketCap, price: d.priceUsd, dex: d.dex, website: d.website, twitter: d.twitter, telegram: d.telegram, image: d.imageUrl?.slice(0,50) }, null, 0));
    console.log("--- RENDERED TELEGRAM MESSAGE ---");
    console.log(formatStonkFunAlert(d));
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
