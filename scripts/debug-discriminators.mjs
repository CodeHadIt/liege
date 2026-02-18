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

const sigs = await rpc("getSignaturesForAddress", [PUMP, { limit: 1000 }]);
const successful = sigs.filter((s) => s.err === null);
console.log(`Fetched ${successful.length} successful signatures\n`);

const discMap = new Map();
let checked = 0;

for (const s of successful.slice(0, 150)) {
  try {
    const tx = await rpc("getTransaction", [
      s.signature,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
    ]);
    if (!tx) continue;

    for (const ix of tx.transaction.message.instructions) {
      if (ix.programId === PUMP && ix.data) {
        const dataBytes = Buffer.from(bs58.decode(ix.data));
        const disc = dataBytes.subarray(0, 8).toString("hex");
        if (!discMap.has(disc)) {
          discMap.set(disc, { count: 0, accounts: ix.accounts?.length, sig: s.signature });
        }
        discMap.get(disc).count++;
      }
    }
    checked++;
    if (checked % 50 === 0)
      console.log(`Checked ${checked} txns, unique discriminators: ${discMap.size}`);
  } catch (e) {
    // skip
  }
}

console.log(`\nChecked ${checked} transactions total`);
console.log("Unique discriminators:\n");
for (const [disc, info] of discMap) {
  console.log(
    `  ${disc} | count: ${info.count} | accounts: ${info.accounts} | example: ${info.sig.slice(0, 40)}...`
  );
}
