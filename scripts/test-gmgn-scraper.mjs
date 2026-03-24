/**
 * Run the GMGN scraper directly and log the returned data structure.
 * Uses jiti to execute the TypeScript source without a build step.
 */

import { createJiti } from "jiti";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": resolve(root, "src"),
  },
});

const TOKEN = "0x50d2280441372486beecdd328c1854743ebacb07";
const CHAIN = "base";

console.log(`\nRunning GMGN scraper for ${CHAIN}:${TOKEN}\n`);

const { scrapeGmgnTopTraders } = await jiti.import(
  resolve(root, "src/lib/api/gmgn-scraper.ts")
);

const traders = await scrapeGmgnTopTraders(CHAIN, TOKEN);

console.log(`\nReturned ${traders.length} GmgnTopTrader objects.`);
console.log("First trader (raw JS object):");
console.log(JSON.stringify(traders[0], null, 2));

process.exit(0);
