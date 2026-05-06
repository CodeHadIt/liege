import { scrapeGmgnWalletHoldings } from "../src/lib/api/gmgn-scraper";

const address = "0x7429686b0123d049579c560c03f0e6605f90fe2e";
const chain = "eth";

console.log(`\nScraping GMGN wallet: ${address} on ${chain}\n`);
console.time("scrape");

scrapeGmgnWalletHoldings(chain, address)
  .then((holdings) => {
    console.timeEnd("scrape");
    console.log(`\nTotal holdings returned: ${holdings.length}\n`);
    console.log(JSON.stringify(holdings, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.timeEnd("scrape");
    console.error("Error:", err);
    process.exit(1);
  });
