import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const API_KEY = process.env.HELIUS_API_KEY;
const MINT_AUTH = "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM";
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

// --- Step 1: Fetch all pump.fun CREATE transactions from Helius ---
async function fetchAllDeploys() {
  const cutoffSec = Math.floor((Date.now() - EIGHT_HOURS_MS) / 1000);
  const deploys = [];
  const seen = new Set();
  let beforeSig = "";
  let pageCount = 0;
  const baseUrl = `https://api.helius.xyz/v0/addresses/${MINT_AUTH}/transactions?api-key=${API_KEY}&type=CREATE&limit=100`;

  console.log(`[helius] Fetching pump.fun deploys from last 8 hours...\n`);

  while (true) {
    pageCount++;
    const url = beforeSig ? `${baseUrl}&before=${beforeSig}` : baseUrl;
    const res = await fetch(url);
    if (!res.ok) { console.error(`Helius API failed: ${res.status}`); break; }
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;

    let reachedCutoff = false;
    for (const tx of data) {
      if (tx.timestamp < cutoffSec) { reachedCutoff = true; break; }
      const mint = tx.tokenTransfers?.[0]?.mint;
      if (mint && !seen.has(mint)) {
        seen.add(mint);
        deploys.push({ address: mint, createdAt: tx.timestamp * 1000 });
      }
    }

    process.stdout.write(`\r[helius] Page ${pageCount}: ${deploys.length} tokens so far`);
    if (reachedCutoff) break;
    beforeSig = data[data.length - 1].signature;
    if (pageCount >= 200) break;
  }

  deploys.sort((a, b) => b.createdAt - a.createdAt);
  const newest = deploys[0];
  const oldest = deploys[deploys.length - 1];
  console.log(`\n[helius] ═══ Total coins deployed: ${deploys.length} ═══`);
  if (newest) {
    const age = Math.round((Date.now() - newest.createdAt) / 60000);
    console.log(`[helius] Newest: ${newest.address} — ${new Date(newest.createdAt).toISOString()} (${age} min ago)`);
  }
  if (oldest) {
    const age = Math.round((Date.now() - oldest.createdAt) / 60000);
    console.log(`[helius] Oldest: ${oldest.address} — ${new Date(oldest.createdAt).toISOString()} (${age} min ago)`);
  }
  return deploys;
}

// --- Step 2: Check DexScreener orders with concurrency ---
async function checkDexOrders(deploys) {
  const found = [];
  const CONCURRENCY = 5; // 5 parallel requests
  let checked = 0;

  console.log(`\n[dexscreener] Checking ${deploys.length} tokens for orders (concurrency=${CONCURRENCY})...\n`);

  for (let i = 0; i < deploys.length; i += CONCURRENCY) {
    const batch = deploys.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (deploy) => {
        try {
          const res = await fetch(`https://api.dexscreener.com/orders/v1/solana/${deploy.address}`);
          if (!res.ok) return null;
          const data = await res.json();
          if (!data?.orders) return null;

          const tags = [];
          for (const order of data.orders) {
            if (order.status !== "approved") continue;
            if (order.type === "tokenProfile" && !tags.includes("dexPaid")) tags.push("dexPaid");
            if (order.type === "communityTakeover" && !tags.includes("cto")) tags.push("cto");
          }
          if (tags.length > 0) {
            return { ...deploy, tags };
          }
        } catch {
          // skip failures
        }
        return null;
      })
    );

    for (const r of results) {
      if (r) {
        found.push(r);
        console.log(`[FOUND] ${r.address} [${r.tags.join(", ")}] — created ${new Date(r.createdAt).toISOString()}`);
      }
    }

    checked += batch.length;
    process.stdout.write(`\r[dexscreener] Checked ${checked}/${deploys.length} | found: ${found.length}`);
    if (found.length > 0 && results.some((r) => r)) process.stdout.write("\n");

    // Small delay to avoid rate limits
    await new Promise((r) => setTimeout(r, 200));
  }

  return found;
}

// --- Main ---
const deploys = await fetchAllDeploys();
const found = await checkDexOrders(deploys);

console.log(`\n\n═══ SCAN COMPLETE ═══`);
console.log(`Total tokens scanned: ${deploys.length}`);
console.log(`Total with DexScreener orders: ${found.length}`);
if (found.length > 0) {
  console.log(`\nAll found tokens:`);
  for (const t of found) {
    const age = Math.round((Date.now() - t.createdAt) / 60000);
    console.log(`  [${t.tags.join(", ")}] ${t.address} — created ${new Date(t.createdAt).toISOString()} (${age} min ago)`);
  }
}
