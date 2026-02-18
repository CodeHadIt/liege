import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const API_KEY = process.env.HELIUS_API_KEY;
const MINT_AUTH = "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM";
const BASE = `https://api.helius.xyz/v0/addresses/${MINT_AUTH}/transactions?api-key=${API_KEY}&type=CREATE`;

const cutoffSec = Math.floor((Date.now() - 60 * 60 * 1000) / 1000); // 1h ago
let before = "";
let totalTokens = 0;
let pageCount = 0;
let newestTs = 0;
let oldestTs = Infinity;

console.log(`Fetching CREATE transactions for last 1h (cutoff: ${new Date(cutoffSec * 1000).toISOString()})...\n`);

while (pageCount < 20) {
  pageCount++;
  const url = `${BASE}&limit=100${before ? `&before=${before}` : ""}`;

  const res = await fetch(url);
  if (!res.ok) {
    console.log(`Page ${pageCount}: HTTP ${res.status}`);
    break;
  }

  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) {
    console.log(`Page ${pageCount}: empty, done`);
    break;
  }

  let reachedCutoff = false;
  let pageTokens = 0;

  for (const tx of data) {
    if (tx.timestamp < cutoffSec) {
      reachedCutoff = true;
      break;
    }
    if (tx.tokenTransfers?.length > 0) {
      const mint = tx.tokenTransfers[0].mint;
      if (mint) {
        pageTokens++;
        if (tx.timestamp > newestTs) newestTs = tx.timestamp;
        if (tx.timestamp < oldestTs) oldestTs = tx.timestamp;
      }
    }
  }

  totalTokens += pageTokens;
  const oldestInPage = data[data.length - 1];
  before = oldestInPage.signature;

  console.log(`Page ${pageCount}: ${data.length} txs, ${pageTokens} tokens, oldest=${new Date(oldestInPage.timestamp * 1000).toISOString()}`);

  if (reachedCutoff) {
    console.log("Reached cutoff, stopping.");
    break;
  }
}

console.log(`\n═══ Summary ═══`);
console.log(`Total tokens found: ${totalTokens}`);
console.log(`Pages fetched: ${pageCount}`);
if (newestTs > 0) {
  const age = Math.round((Date.now() / 1000 - newestTs) / 60);
  console.log(`Newest: ${new Date(newestTs * 1000).toISOString()} (${age} min ago)`);
}
if (oldestTs < Infinity) {
  const age = Math.round((Date.now() / 1000 - oldestTs) / 60);
  console.log(`Oldest: ${new Date(oldestTs * 1000).toISOString()} (${age} min ago)`);
}
