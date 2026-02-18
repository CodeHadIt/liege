// Quick test of Helius pump.fun deploy fetching
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";

function getRpcUrl() {
  const url = process.env.HELIUS_RPC_URL;
  if (url && !url.endsWith("api-key=")) return url;
  if (HELIUS_API_KEY) return `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
  return "https://api.mainnet-beta.solana.com";
}
const RPC_URL = getRpcUrl();
const PUMPFUN_MINT_AUTHORITY = "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM";

console.log(`HELIUS_API_KEY set: ${!!HELIUS_API_KEY}`);
console.log(`RPC_URL: ${RPC_URL.slice(0, 50)}...`);

async function rpcCall(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`RPC ${method} failed: ${res.status} — ${body.slice(0, 200)}`);
    return null;
  }
  const json = await res.json();
  if (json.error) {
    console.error(`RPC ${method} error:`, json.error);
    return null;
  }
  return json.result;
}

// Step 1: Get signatures for mint authority
console.log("\n--- Step 1: getSignaturesForAddress ---");
const sigs = await rpcCall("getSignaturesForAddress", [
  PUMPFUN_MINT_AUTHORITY,
  { limit: 5 },
]);

if (!sigs) {
  console.error("Failed to get signatures");
  process.exit(1);
}

console.log(`Got ${sigs.length} signatures`);
for (const s of sigs) {
  const age = s.blockTime ? Math.round((Date.now() / 1000 - s.blockTime) / 60) : "?";
  console.log(`  sig=${s.signature.slice(0, 20)}... blockTime=${s.blockTime} (${age} min ago) err=${s.err}`);
}

// Step 2: Parse first successful transaction
console.log("\n--- Step 2: getTransaction (first successful) ---");
const firstValid = sigs.find((s) => s.blockTime && !s.err);
if (!firstValid) {
  console.error("No valid signatures found");
  process.exit(1);
}

const tx = await rpcCall("getTransaction", [
  firstValid.signature,
  { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
]);

if (!tx) {
  console.error("Failed to get transaction");
  process.exit(1);
}

const acctKeys = tx.transaction.message.accountKeys.map((a) =>
  typeof a === "string" ? a : a.pubkey
);
console.log(`Account keys (${acctKeys.length}):`);
for (const k of acctKeys) {
  const isPump = k.endsWith("pump") ? " <<<< PUMP TOKEN" : "";
  console.log(`  ${k}${isPump}`);
}

const pumpToken = acctKeys.find((a) => a.endsWith("pump"));
if (pumpToken) {
  console.log(`\nFound pump token: ${pumpToken}`);

  // Step 3: Resolve metadata
  console.log("\n--- Step 3: getAssetBatch ---");
  const assetRes = await rpcCall("getAssetBatch", { ids: [pumpToken] });
  if (assetRes) {
    for (const item of assetRes) {
      console.log(`  ${item.id}: symbol=${item.content?.metadata?.symbol}, name=${item.content?.metadata?.name}`);
    }
  } else {
    console.log("  getAssetBatch returned null");
  }
} else {
  console.log("\nNo pump token found in account keys");
}

console.log("\n--- Full 8h window test ---");
const cutoffSec = Math.floor((Date.now() - 8 * 60 * 60 * 1000) / 1000);
let beforeSig;
let totalDeploys = 0;
let pageCount = 0;
let newestBlockTime = 0;
let oldestBlockTime = Infinity;

while (pageCount < 3) { // Only do 3 pages for the test
  pageCount++;
  const params = [
    PUMPFUN_MINT_AUTHORITY,
    { limit: 1000, ...(beforeSig ? { before: beforeSig } : {}) },
  ];

  const pageSigs = await rpcCall("getSignaturesForAddress", params);
  if (!pageSigs || pageSigs.length === 0) break;

  let reachedCutoff = false;
  let validCount = 0;
  for (const s of pageSigs) {
    if (!s.blockTime || s.err) continue;
    if (s.blockTime < cutoffSec) {
      reachedCutoff = true;
      break;
    }
    validCount++;
    if (s.blockTime > newestBlockTime) newestBlockTime = s.blockTime;
    if (s.blockTime < oldestBlockTime) oldestBlockTime = s.blockTime;
  }

  totalDeploys += validCount;
  console.log(`  Page ${pageCount}: ${pageSigs.length} sigs, ${validCount} valid, reachedCutoff=${reachedCutoff}`);

  if (reachedCutoff) break;
  beforeSig = pageSigs[pageSigs.length - 1].signature;
}

console.log(`\nTotal valid sigs in ${pageCount} pages: ${totalDeploys}`);
if (newestBlockTime > 0) {
  const newestAge = Math.round((Date.now() / 1000 - newestBlockTime) / 60);
  console.log(`Newest: ${new Date(newestBlockTime * 1000).toISOString()} (${newestAge} min ago)`);
}
if (oldestBlockTime < Infinity) {
  const oldestAge = Math.round((Date.now() / 1000 - oldestBlockTime) / 60);
  console.log(`Oldest: ${new Date(oldestBlockTime * 1000).toISOString()} (${oldestAge} min ago)`);
}
