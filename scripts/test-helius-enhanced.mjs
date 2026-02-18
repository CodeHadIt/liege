import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const API_KEY = process.env.HELIUS_API_KEY;
const MINT_AUTH = "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM";

// Try different Enhanced Transaction API endpoint formats
const endpoints = [
  // Format 1: v0 with query param
  `https://api.helius.xyz/v0/addresses/${MINT_AUTH}/transactions?api-key=${API_KEY}&limit=5`,
  // Format 2: v0 with type filter
  `https://api.helius.xyz/v0/addresses/${MINT_AUTH}/transactions?api-key=${API_KEY}&limit=5&type=CREATE`,
  // Format 3: v1
  `https://api.helius.xyz/v1/addresses/${MINT_AUTH}/transactions?api-key=${API_KEY}&limit=5`,
  // Format 4: parsed transaction history
  `https://api.helius.xyz/v0/addresses/${MINT_AUTH}/transactions?api-key=${API_KEY}&limit=5&source=PUMP_FUN`,
];

for (const url of endpoints) {
  const label = url.replace(API_KEY, "***").replace(MINT_AUTH, "MINT_AUTH");
  console.log(`\n--- Testing: ${label} ---`);
  try {
    const res = await fetch(url);
    console.log(`Status: ${res.status} ${res.statusText}`);
    const text = await res.text();
    if (res.ok) {
      const data = JSON.parse(text);
      console.log(`Response: ${Array.isArray(data) ? data.length + " items" : typeof data}`);
      if (Array.isArray(data) && data.length > 0) {
        const first = data[0];
        console.log(`First item keys: ${Object.keys(first).join(", ")}`);
        console.log(`Type: ${first.type}, Source: ${first.source}`);
        console.log(`Timestamp: ${first.timestamp ? new Date(first.timestamp * 1000).toISOString() : "N/A"}`);
        if (first.tokenTransfers?.length > 0) {
          console.log(`Token transfers: ${first.tokenTransfers.length}`);
          console.log(`  First: mint=${first.tokenTransfers[0].mint}`);
        }
        if (first.accountData?.length > 0) {
          console.log(`Account data entries: ${first.accountData.length}`);
        }
        // Log the full first item for inspection
        console.log(`\nFull first item:\n${JSON.stringify(first, null, 2).slice(0, 2000)}`);
      }
    } else {
      console.log(`Error body: ${text.slice(0, 300)}`);
    }
  } catch (err) {
    console.log(`Exception: ${err.message}`);
  }
}
