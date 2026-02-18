import bs58 from "bs58";
import { writeFileSync, existsSync, readFileSync } from "fs";

// ─── Config ──────────────────────────────────────────────────────────────────

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_API_KEY) {
  console.error("HELIUS_API_KEY not set");
  process.exit(1);
}

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const PARSE_URL = `https://api.helius.xyz/v0/transactions?api-key=${HELIUS_API_KEY}`;
const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const CREATE_DISCRIMINATOR = Buffer.from("d6904cec5f8b31b4", "hex");
const TWENTY_FOUR_HOURS = 24 * 60 * 60;
const SIGS_PER_PAGE = 1000;
const PARSE_BATCH_SIZE = 100; // Helius parseTransactions limit

// Rate limiter: Helius free = 10 rps, leave headroom
const MIN_INTERVAL_MS = 130; // ~7.7 rps
let lastCallTime = 0;

async function rateLimitedFetch(url, options) {
  const now = Date.now();
  const wait = MIN_INTERVAL_MS - (now - lastCallTime);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallTime = Date.now();

  const res = await fetch(url, options);

  // Handle rate limiting with exponential backoff
  if (res.status === 429) {
    console.warn("  Rate limited, backing off 3s...");
    await new Promise((r) => setTimeout(r, 3000));
    lastCallTime = Date.now();
    return fetch(url, options);
  }

  return res;
}

async function rpcCall(method, params) {
  const res = await rateLimitedFetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result;
}

// ─── Phase 1: Discover signatures via getSignaturesForAddress ───────────────

async function fetchAllSignatures() {
  const cutoff = Math.floor(Date.now() / 1000) - TWENTY_FOUR_HOURS;
  const allSigs = [];
  let before = undefined;
  let page = 0;

  console.log("Phase 1: Fetching signatures from pump.fun program...");
  console.log(`  Cutoff: ${new Date(cutoff * 1000).toISOString()}`);

  while (true) {
    const params = [
      PUMP_PROGRAM,
      { limit: SIGS_PER_PAGE, ...(before ? { before } : {}) },
    ];
    const sigs = await rpcCall("getSignaturesForAddress", params);
    if (!sigs || sigs.length === 0) break;

    const inRange = sigs.filter((s) => s.blockTime && s.blockTime >= cutoff);
    const successful = inRange.filter((s) => s.err === null);
    allSigs.push(...successful);

    page++;
    const oldest = sigs[sigs.length - 1];
    const oldestTime = oldest.blockTime
      ? new Date(oldest.blockTime * 1000).toISOString()
      : "unknown";

    // Log every 100 pages to reduce noise
    if (page % 100 === 0 || page <= 5) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(
        `  Page ${page}: ${allSigs.length} sigs | Oldest: ${oldestTime} | ${elapsed}s`
      );
    }

    if (oldest.blockTime && oldest.blockTime < cutoff) {
      console.log(`  Reached 24h cutoff at page ${page}.`);
      break;
    }

    before = oldest.signature;
  }

  console.log(`  Total signatures in 24h: ${allSigs.length} (${page} pages)`);
  return allSigs;
}

// ─── Phase 2: Batch parse transactions via Enhanced API ─────────────────────

function isCreateDiscriminator(dataStr) {
  try {
    const dataBytes = Buffer.from(bs58.decode(dataStr));
    if (dataBytes.length < 8) return false;
    return dataBytes.subarray(0, 8).equals(CREATE_DISCRIMINATOR);
  } catch {
    return false;
  }
}

function extractCreateFromEnhanced(tx) {
  if (!tx?.instructions) return null;

  // Check top-level instructions
  for (const ix of tx.instructions) {
    if (ix.programId !== PUMP_PROGRAM) continue;
    if (!ix.data) continue;
    if (isCreateDiscriminator(ix.data)) {
      return {
        mint: ix.accounts?.[2],
        bondingCurve: ix.accounts?.[3],
        creator: ix.accounts?.[0],
        blockTime: tx.timestamp,
        signature: tx.signature,
      };
    }

    // Check inner instructions within this instruction
    if (ix.innerInstructions) {
      for (const inner of ix.innerInstructions) {
        if (inner.programId !== PUMP_PROGRAM) continue;
        if (!inner.data) continue;
        if (isCreateDiscriminator(inner.data)) {
          return {
            mint: inner.accounts?.[0],
            bondingCurve: inner.accounts?.[2],
            creator: inner.accounts?.[7],
            blockTime: tx.timestamp,
            signature: tx.signature,
          };
        }
      }
    }
  }

  return null;
}

// Also keep the raw RPC extraction as fallback
function extractCreateFromRawTx(tx) {
  if (!tx?.transaction?.message?.instructions) return null;
  const blockTime = tx.blockTime;

  for (const ix of tx.transaction.message.instructions) {
    if (ix.programId !== PUMP_PROGRAM || !ix.data) continue;
    if (isCreateDiscriminator(ix.data)) {
      return {
        mint: ix.accounts?.[2],
        bondingCurve: ix.accounts?.[3],
        creator: ix.accounts?.[0],
        blockTime,
        signature: tx.transaction.signatures?.[0],
      };
    }
  }

  if (tx.meta?.innerInstructions) {
    for (const inner of tx.meta.innerInstructions) {
      for (const ix of inner.instructions || []) {
        if (ix.programId !== PUMP_PROGRAM || !ix.data) continue;
        if (isCreateDiscriminator(ix.data)) {
          return {
            mint: ix.accounts?.[0],
            bondingCurve: ix.accounts?.[2],
            creator: ix.accounts?.[7],
            blockTime,
            signature: tx.transaction.signatures?.[0],
          };
        }
      }
    }
  }

  return null;
}

async function parseTransactionsBatch(sigStrings) {
  const res = await rateLimitedFetch(PARSE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sigStrings),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Parse API ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

async function findAllCreates(signatures) {
  console.log(
    `\nPhase 2: Batch-parsing ${signatures.length} transactions for creates...`
  );
  console.log(`  Using parseTransactions API (${PARSE_BATCH_SIZE}/batch)...`);

  const creates = [];
  let parseErrors = 0;
  let fallbackCount = 0;

  // First, test if parseTransactions works
  const testBatch = signatures.slice(0, 5).map((s) => s.signature);
  try {
    const testResult = await parseTransactionsBatch(testBatch);
    if (!Array.isArray(testResult)) {
      throw new Error("parseTransactions returned non-array");
    }
    console.log(`  parseTransactions API test: OK (${testResult.length} results)`);
  } catch (err) {
    console.warn(`  parseTransactions API failed: ${err.message}`);
    console.warn(`  Falling back to individual getTransaction calls...`);
    return findAllCreatesFallback(signatures);
  }

  for (let i = 0; i < signatures.length; i += PARSE_BATCH_SIZE) {
    const batch = signatures
      .slice(i, i + PARSE_BATCH_SIZE)
      .map((s) => s.signature);

    try {
      const parsed = await parseTransactionsBatch(batch);
      for (const tx of parsed) {
        const create = extractCreateFromEnhanced(tx);
        if (create) creates.push(create);
      }
    } catch (err) {
      parseErrors++;
      // Fallback: try individual getTransaction for this batch
      for (const sig of batch) {
        try {
          const tx = await rpcCall("getTransaction", [
            sig,
            { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
          ]);
          if (tx) {
            const create = extractCreateFromRawTx(tx);
            if (create) {
              creates.push(create);
              fallbackCount++;
            }
          }
        } catch {}
      }
    }

    const progress = Math.min(i + PARSE_BATCH_SIZE, signatures.length);
    if (progress % 5000 < PARSE_BATCH_SIZE || progress === signatures.length) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = (progress / ((Date.now() - startTime) / 1000)).toFixed(0);
      const eta = (
        ((signatures.length - progress) / parseFloat(rate)) /
        60
      ).toFixed(1);
      console.log(
        `  ${progress}/${signatures.length} | Creates: ${creates.length} | ${rate} tx/s | ETA: ${eta}m | ${elapsed}s`
      );
    }
  }

  if (parseErrors > 0) {
    console.log(
      `  Parse errors: ${parseErrors} batches (${fallbackCount} creates recovered via fallback)`
    );
  }
  console.log(`  Total creates found: ${creates.length}`);
  return creates;
}

// Fallback: individual getTransaction (original slow approach)
async function findAllCreatesFallback(signatures) {
  console.log(`  Using individual getTransaction calls (slower)...`);
  const creates = [];
  const CONCURRENCY = 8;

  for (let i = 0; i < signatures.length; i += CONCURRENCY) {
    const chunk = signatures.slice(i, i + CONCURRENCY);
    const promises = chunk.map(async (sig) => {
      try {
        const tx = await rpcCall("getTransaction", [
          sig.signature,
          { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
        ]);
        return tx ? extractCreateFromRawTx(tx) : null;
      } catch {
        return null;
      }
    });
    const batch = await Promise.all(promises);
    creates.push(...batch.filter(Boolean));

    const progress = Math.min(i + CONCURRENCY, signatures.length);
    if (progress % 500 < CONCURRENCY) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(
        `  ${progress}/${signatures.length} txns | Creates: ${creates.length} | ${elapsed}s`
      );
    }
  }

  console.log(`  Total creates found: ${creates.length}`);
  return creates;
}

// ─── Phase 3: Enrich with metadata (name, symbol, logo) ────────────────────

async function enrichMetadata(creates) {
  console.log(`\nPhase 3: Enriching ${creates.length} tokens with metadata...`);
  const metadataMap = new Map();
  const mints = creates.map((c) => c.mint).filter(Boolean);

  for (let i = 0; i < mints.length; i += 100) {
    const batch = mints.slice(i, i + 100);
    try {
      const res = await rateLimitedFetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getAssetBatch",
          params: { ids: batch },
        }),
      });
      const json = await res.json();
      const items = json.result ?? [];
      for (const item of items) {
        if (item?.id && item?.content?.metadata) {
          metadataMap.set(item.id, {
            symbol: item.content.metadata.symbol || "???",
            name: item.content.metadata.name || "Unknown",
            logoUrl: item.content?.links?.image ?? null,
          });
        }
      }
      console.log(
        `  Metadata batch ${Math.floor(i / 100) + 1}/${Math.ceil(mints.length / 100)}: resolved ${items.length} assets`
      );
    } catch (err) {
      console.error(`  Metadata batch error:`, err.message);
    }
  }

  return metadataMap;
}

// ─── Phase 4: Read bonding curves for price data ────────────────────────────

function parseBondingCurve(data) {
  const buf = Buffer.from(data, "base64");
  if (buf.length < 49) return null;

  const virtualTokenReserves = buf.readBigUInt64LE(8);
  const virtualSolReserves = buf.readBigUInt64LE(16);
  const realTokenReserves = buf.readBigUInt64LE(24);
  const realSolReserves = buf.readBigUInt64LE(32);
  const tokenTotalSupply = buf.readBigUInt64LE(40);
  const complete = buf[48] === 1;

  return {
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    tokenTotalSupply,
    complete,
  };
}

async function enrichBondingCurves(creates, solPriceUsd) {
  console.log(`\nPhase 4: Reading bonding curves for price data...`);
  const priceMap = new Map();
  const bondingCurves = creates
    .filter((c) => c.bondingCurve)
    .map((c) => ({ mint: c.mint, bc: c.bondingCurve }));

  for (let i = 0; i < bondingCurves.length; i += 100) {
    const batch = bondingCurves.slice(i, i + 100);
    const addresses = batch.map((b) => b.bc);

    try {
      const result = await rpcCall("getMultipleAccounts", [
        addresses,
        { encoding: "base64" },
      ]);

      if (result?.value) {
        result.value.forEach((account, idx) => {
          if (!account?.data?.[0]) return;
          const parsed = parseBondingCurve(account.data[0]);
          if (!parsed || parsed.virtualTokenReserves === 0n) return;

          const priceSol =
            Number(parsed.virtualSolReserves) /
            Number(parsed.virtualTokenReserves);
          const priceUsd = priceSol * solPriceUsd;
          const supply = Number(parsed.tokenTotalSupply) / 1e6;
          const marketCap = priceUsd * supply;

          priceMap.set(batch[idx].mint, {
            priceUsd,
            marketCap,
            liquiditySol: Number(parsed.realSolReserves) / 1e9,
            liquidityUsd: (Number(parsed.realSolReserves) / 1e9) * solPriceUsd,
            graduated: parsed.complete,
          });
        });
      }

      console.log(
        `  Bonding curve batch ${Math.floor(i / 100) + 1}/${Math.ceil(bondingCurves.length / 100)}: read ${batch.length} accounts`
      );
    } catch (err) {
      console.error(`  Bonding curve batch error:`, err.message);
    }
  }

  return priceMap;
}

async function getSolPrice() {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
    );
    const data = await res.json();
    return data.solana.usd;
  } catch {
    console.warn("  Could not fetch SOL price, using $150 as fallback");
    return 150;
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

const startTime = Date.now();

async function main() {
  console.log("=== Helius Pump.fun Token Discovery (Optimized) ===\n");

  // Phase 1: Get all signatures
  const signatures = await fetchAllSignatures();

  if (signatures.length === 0) {
    console.log("No signatures found. Check your Helius API key.");
    process.exit(1);
  }

  // Phase 2: Parse creates using batch API
  const creates = await findAllCreates(signatures);

  if (creates.length === 0) {
    console.log("No create instructions found.");
    writeFileSync(
      "helius-pumpfun-deploys.json",
      JSON.stringify(
        { executed_at: new Date().toISOString(), total_rows: 0, data: [] },
        null,
        2
      )
    );
    process.exit(0);
  }

  // Phase 3: Metadata
  const metadataMap = await enrichMetadata(creates);

  // Phase 4: Bonding curves + pricing
  const solPrice = await getSolPrice();
  console.log(`  SOL price: $${solPrice}`);
  const priceMap = await enrichBondingCurves(creates, solPrice);

  // Assemble final output
  const tokens = creates.map((c) => {
    const meta = metadataMap.get(c.mint) || {
      symbol: "???",
      name: "Unknown",
      logoUrl: null,
    };
    const price = priceMap.get(c.mint) || {
      priceUsd: null,
      marketCap: null,
      liquiditySol: null,
      liquidityUsd: null,
      graduated: null,
    };

    return {
      token_address: c.mint,
      symbol: meta.symbol,
      name: meta.name,
      logo_url: meta.logoUrl,
      created_at: c.blockTime
        ? new Date(c.blockTime * 1000).toISOString()
        : null,
      creator: c.creator,
      price_usd: price.priceUsd,
      market_cap: price.marketCap,
      liquidity_sol: price.liquiditySol,
      liquidity_usd: price.liquidityUsd,
      graduated: price.graduated,
      signature: c.signature,
    };
  });

  // Sort by market cap descending
  tokens.sort((a, b) => (b.market_cap ?? 0) - (a.market_cap ?? 0));

  // Add rank
  tokens.forEach((t, i) => (t.rank = i + 1));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  const output = {
    executed_at: new Date().toISOString(),
    query: "All pump.fun deploys via Helius RPC (batch optimized)",
    sol_price_usd: solPrice,
    elapsed_seconds: parseFloat(elapsed),
    total_rows: tokens.length,
    time_range: {
      newest: tokens[0]?.created_at,
      oldest: tokens[tokens.length - 1]?.created_at,
    },
    data: tokens,
  };

  writeFileSync("helius-pumpfun-deploys.json", JSON.stringify(output, null, 2));
  console.log(`\n=== Done ===`);
  console.log(`  Tokens found: ${tokens.length}`);
  console.log(
    `  Graduated: ${tokens.filter((t) => t.graduated).length}`
  );
  console.log(
    `  Still on bonding curve: ${tokens.filter((t) => t.graduated === false).length}`
  );
  console.log(
    `  Time range: ${output.time_range.oldest} → ${output.time_range.newest}`
  );
  console.log(`  Elapsed: ${elapsed}s`);
  console.log(`  Saved to helius-pumpfun-deploys.json`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
