import bs58 from "bs58";

const RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await res.json()).result;
}

// Use a known pump.fun token from Dune results to find its creation tx
const knownMint = "kizBMAuD6aX2yT8jATDMKx5GVCTquA7AGftghZ8pump";
console.log("Looking up creation transaction for:", knownMint);

// Get earliest signatures for this token
const sigs = await rpc("getSignaturesForAddress", [knownMint, { limit: 10 }]);
console.log(`Found ${sigs.length} signatures for token`);

// The earliest transaction should be the create
const earliest = sigs[sigs.length - 1];
console.log("Earliest sig:", earliest.signature);

const tx = await rpc("getTransaction", [
  earliest.signature,
  { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
]);

if (!tx) {
  console.log("Transaction not found (might be too old)");
  process.exit(1);
}

// Find pump.fun instruction
for (const ix of tx.transaction.message.instructions) {
  if (ix.programId === PUMP && ix.data) {
    const dataBytes = Buffer.from(bs58.decode(ix.data));
    const disc = dataBytes.subarray(0, 8).toString("hex");
    console.log("\nPump.fun instruction:");
    console.log("  Discriminator:", disc);
    console.log("  Accounts:", ix.accounts.length);
    ix.accounts.forEach((a, i) => console.log(`    [${i}]`, a));
  }
}

// Check logs
console.log("\nLog messages:");
tx.meta?.logMessages
  ?.filter((l) => l.includes("Instruction:") || l.includes("reate") || l.includes("Init"))
  .forEach((l) => console.log(" ", l));

// Also check inner instructions for Metaplex
const metaplex = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
for (const inner of tx.meta?.innerInstructions || []) {
  for (const ix of inner.instructions || []) {
    if (ix.programId === metaplex) {
      console.log("\nMetaplex CPI found:", ix.parsed?.type || "unknown type");
    }
    if (ix.parsed?.type?.includes("initializeMint") || ix.parsed?.type?.includes("InitializeMint")) {
      console.log("InitializeMint found:", ix.parsed.type);
    }
  }
}
