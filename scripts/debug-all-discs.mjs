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

// Check each unique discriminator from before
const candidates = [
  "d6904cec5f8b31b4",
  "38fc74089edfcd5f",
  "1416567bc61cdb84",
  "ea66c2cb96483ee5",
  "f945a4da9667548a",
  "5e06ca73ff60e8b7",
  "a572670079cef751",
];

// Fetch a larger sample to find these rare discriminators
const sigs = await rpc("getSignaturesForAddress", [PUMP, { limit: 1000 }]);
const successful = sigs.filter((s) => !s.err);
console.log(`Checking ${successful.length} transactions for rare discriminators...\n`);

for (const s of successful) {
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

  if (!candidates.includes(disc)) continue;

  // Found a rare discriminator - check if it's a create
  const logs = tx.meta?.logMessages || [];
  const instructionLogs = logs.filter((l) => l.includes("Instruction:"));
  const hasCreateMetadata = logs.some((l) => l.includes("CreateMetadataAccountV3") || l.includes("Create "));
  const hasInitMint = logs.some((l) => l.includes("InitializeMint"));

  console.log(`Disc: ${disc} | Accounts: ${ix.accounts.length}`);
  console.log(`  Instructions: ${instructionLogs.map((l) => l.replace("Program log: Instruction: ", "")).join(", ")}`);
  console.log(`  Has CreateMetadata: ${hasCreateMetadata} | Has InitMint: ${hasInitMint}`);
  console.log(`  Sig: ${s.signature.slice(0, 40)}...`);

  if (hasInitMint || hasCreateMetadata) {
    console.log("\n  *** THIS IS THE CREATE DISCRIMINATOR ***\n");
    console.log("  Accounts:");
    ix.accounts.forEach((a, i) => console.log(`    [${i}]`, a));
    process.exit(0);
  }

  console.log("");
}

console.log("No create instruction found in this batch. Might need more samples.");
