// Test which Moralis endpoint is best for the Activity tab
// We'll check response structure from both swaps and history endpoints

const API_KEY = process.env.MORALIS_API_KEY;
const address = "0x8d73a36d78e2ae4a437053c9ce3be70d483ab74d";
const chain = "0x38"; // BSC

if (!API_KEY) {
  console.error("MORALIS_API_KEY not set");
  process.exit(1);
}

async function moralis(path: string) {
  const res = await fetch(`https://deep-index.moralis.io/api/v2.2${path}`, {
    headers: { "X-API-Key": API_KEY!, Accept: "application/json" },
  });
  return { status: res.status, data: await res.json() };
}

(async () => {
  console.log("=== /wallets/{addr}/swaps?limit=10 ===");
  const swaps = await moralis(`/wallets/${address}/swaps?chain=${chain}&limit=10&order=DESC`);
  console.log(`Status: ${swaps.status}`);
  if (swaps.data?.result?.length > 0) {
    const s = swaps.data.result[0];
    console.log("First swap keys:", Object.keys(s).join(", "));
    console.log("Sample:", JSON.stringify(s, null, 2).slice(0, 800));
  } else {
    console.log("Response:", JSON.stringify(swaps.data, null, 2).slice(0, 400));
  }

  console.log("\n=== /wallets/{addr}/history?limit=10 ===");
  const hist = await moralis(`/wallets/${address}/history?chain=${chain}&limit=10&order=DESC`);
  console.log(`Status: ${hist.status}`);
  if (hist.data?.result?.length > 0) {
    const h = hist.data.result[0];
    console.log("First item keys:", Object.keys(h).join(", "));
    console.log("Category:", h.category);
    console.log("Sample:", JSON.stringify(h, null, 2).slice(0, 800));
  } else {
    console.log("Response:", JSON.stringify(hist.data, null, 2).slice(0, 400));
  }

  console.log("\n=== /wallets/{addr}/profitability (all-time, BSC) ===");
  const prof = await moralis(`/wallets/${address}/profitability?chain=${chain}`);
  console.log(`Status: ${prof.status}`);
  if (prof.data?.result?.length > 0) {
    console.log(`Profitability count: ${prof.data.result.length}`);
    const p = prof.data.result[0];
    console.log("Keys:", Object.keys(p).join(", "));
    console.log("Sample:", JSON.stringify(p, null, 2).slice(0, 400));
    // Check for our target tokens
    const targets = [
      "0xf74548802f4c700315f019fde17178b392ee4444",
      "0xbc5dac3eb8e4c82523c84fa8589f91cbe6cc4444",
    ];
    for (const t of targets) {
      const found = prof.data.result.find((r: any) => r.token_address?.toLowerCase() === t.toLowerCase());
      console.log(`Target ${t.slice(0,12)}: ${found ? `FOUND — realized=$${found.realized_profit_usd}` : "NOT FOUND"}`);
    }
    // Top 5 by realized profit
    const sorted = [...prof.data.result].sort((a: any, b: any) => parseFloat(b.realized_profit_usd||0) - parseFloat(a.realized_profit_usd||0));
    console.log("\nTop 5 by realized_profit:");
    sorted.slice(0, 5).forEach((r: any) => console.log(`  ${r.token_symbol} realized=$${r.realized_profit_usd} invested=$${r.total_usd_invested}`));
  } else {
    console.log("Response:", JSON.stringify(prof.data, null, 2).slice(0, 400));
  }
})();
