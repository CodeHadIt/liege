import bs58 from "bs58";

const RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const TARGET_DISC = "66063d1201daebea";

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await res.json()).result;
}

// Get recent sigs and find one with the target discriminator
const sigs = await rpc("getSignaturesForAddress", [PUMP, { limit: 100 }]);

for (const s of sigs.filter((x) => !x.err)) {
  const tx = await rpc("getTransaction", [
    s.signature,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
  ]);
  if (!tx) continue;

  const ix = tx.transaction.message.instructions.find(
    (i) => i.programId === PUMP && i.data
  );
  if (!ix) continue;

  const dataBytes = Buffer.from(bs58.decode(ix.data));
  const disc = dataBytes.subarray(0, 8).toString("hex");
  if (disc !== TARGET_DISC) continue;

  console.log("Found create candidate!");
  console.log("Signature:", s.signature);
  console.log("Accounts:");
  ix.accounts.forEach((a, i) => console.log(`  [${i}]`, a));

  // Check for Metaplex CPI (proves metadata creation = token create)
  const metaplex = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
  const hasMetaplex = tx.meta?.innerInstructions?.some((inner) =>
    inner.instructions?.some((i) => i.programId === metaplex)
  );
  console.log("\nHas Metaplex CPI:", hasMetaplex);

  const hasMintInit = tx.meta?.innerInstructions?.some((inner) =>
    inner.instructions?.some(
      (i) =>
        i.parsed?.type === "initializeMint2" ||
        i.parsed?.type === "initializeMint"
    )
  );
  console.log("Has InitializeMint:", hasMintInit);

  const logs = tx.meta?.logMessages?.filter(
    (l) => l.includes("Instruction:") || l.includes("reate")
  );
  console.log("\nRelevant logs:");
  logs?.slice(0, 10).forEach((l) => console.log(" ", l));
  break;
}
