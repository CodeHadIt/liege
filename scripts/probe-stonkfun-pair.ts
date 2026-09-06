/**
 * Does a StonkFun creation transaction reveal the quote token on-chain?
 * If the launch tx seeds the pool in the same transaction, the quote mint shows
 * up in its token transfers — which would let the first-token watcher identify
 * the pair at mint time instead of waiting for an indexer.
 *
 *   npx tsx scripts/probe-stonkfun-pair.ts
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { fetchRecentCreations, fetchQuoteTokens, STONKFUN_DEPLOYER } from "../src/lib/api/stonkfun";

async function main() {
  const quotes = await fetchQuoteTokens();
  if (!quotes) throw new Error('stonkfun quote catalog unavailable');
  const quoteByMint = new Map(quotes.map((q) => [q.quoteMint, q]));
  console.log(`known quote tokens: ${quotes.length}`);

  const creations = await fetchRecentCreations(5);
  console.log(`recent creations: ${creations.length}\n`);

  const key = process.env.HELIUS_API_KEY;
  for (const c of creations) {
    console.log(`── ${c.symbol}  mint=${c.mint}`);
    console.log(`   sig=${c.signature}  ts=${new Date(c.timestamp * 1000).toISOString()}`);

    const res = await fetch(`https://api.helius.xyz/v0/transactions?api-key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactions: [c.signature] }),
    });
    if (!res.ok) {
      console.log(`   tx fetch failed: ${res.status}\n`);
      continue;
    }
    const [tx] = await res.json();
    if (!tx) {
      console.log("   no tx returned\n");
      continue;
    }
    console.log(`   type=${tx.type} source=${tx.source}`);
    console.log(`   desc="${(tx.description ?? "").slice(0, 120)}"`);

    const mints = new Map<string, number>();
    for (const t of tx.tokenTransfers ?? []) {
      if (!t.mint) continue;
      mints.set(t.mint, (mints.get(t.mint) ?? 0) + 1);
    }
    console.log(`   distinct mints in tx: ${mints.size}`);
    for (const [m, n] of mints) {
      const q = quoteByMint.get(m);
      const tag = m === c.mint ? "<< the new token" : q ? `<< QUOTE TOKEN: ${q.symbol} (${q.category})` : "";
      console.log(`      ${m}  x${n}  ${tag}`);
    }
    const nativeIn = (tx.nativeTransfers ?? []).length;
    console.log(`   nativeTransfers: ${nativeIn}`);
    console.log(`   accountData entries: ${(tx.accountData ?? []).length}`);

    // Does any account in the tx hold a balance change in a known quote mint?
    const quoteHits = new Set<string>();
    for (const ad of tx.accountData ?? []) {
      for (const tb of ad.tokenBalanceChanges ?? []) {
        if (tb.mint && quoteByMint.has(tb.mint)) quoteHits.add(tb.mint);
      }
    }
    console.log(
      `   quote mints via balance changes: ${
        quoteHits.size ? [...quoteHits].map((m) => quoteByMint.get(m)!.symbol).join(", ") : "(none)"
      }`
    );
    console.log("");
  }
  console.log(`deployer: ${STONKFUN_DEPLOYER}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
