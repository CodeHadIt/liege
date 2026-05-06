// Test metadata resolution for old Solana tokens
const tokens = [
  { addr: "sF6smhq2QiBzQLB8krsAe3CLZ6yBzNfKUD8jPYm79kw", name: "Carl Johnson / CJ" },
  { addr: "Ec6T3Q7JcfXr4FxNZgEQtSYfmRPNCt21JwbEkF6Lpump", name: "Lester / LSTR" },
];

const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY;
const HELIUS_KEY  = process.env.HELIUS_API_KEY;

async function testBirdeye(addr: string) {
  const res = await fetch(`https://public-api.birdeye.so/defi/token_overview?address=${addr}`, {
    headers: { "X-API-KEY": BIRDEYE_KEY!, "x-chain": "solana" }
  });
  const j = await res.json();
  return { status: res.status, success: j?.success, symbol: j?.data?.symbol, name: j?.data?.name };
}

async function testDexScreener(addr: string) {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`);
  const j = await res.json();
  const pair = j?.pairs?.[0];
  return { pairCount: j?.pairs?.length ?? 0, symbol: pair?.baseToken?.symbol, name: pair?.baseToken?.name };
}

async function testHelius(addr: string) {
  const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAsset", params: { id: addr } }),
  });
  const j = await res.json();
  const content = j?.result?.content;
  return {
    symbol: content?.metadata?.symbol,
    name: content?.metadata?.name,
    jsonUri: content?.json_uri,
    interface: j?.result?.interface,
  };
}

async function testSolscan(addr: string) {
  const res = await fetch(`https://pro-api.solscan.io/v2.0/token/meta?address=${addr}`, {
    headers: { token: process.env.SOLSCAN_API_KEY! }
  });
  const j = await res.json();
  return { status: res.status, symbol: j?.data?.symbol, name: j?.data?.name, success: j?.success };
}

(async () => {
  for (const { addr, name } of tokens) {
    console.log(`\n=== ${name} ===`);
    console.log(`Address: ${addr}`);

    const [birdeye, dex, helius, solscan] = await Promise.all([
      testBirdeye(addr).catch(e => ({ error: String(e) })),
      testDexScreener(addr).catch(e => ({ error: String(e) })),
      testHelius(addr).catch(e => ({ error: String(e) })),
      testSolscan(addr).catch(e => ({ error: String(e) })),
    ]);

    console.log("Birdeye:", birdeye);
    console.log("DexScreener:", dex);
    console.log("Helius DAS:", helius);
    console.log("Solscan:", solscan);
  }
})();
