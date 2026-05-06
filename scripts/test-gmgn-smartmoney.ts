import { chromium } from "playwright-core";

const address = "0x8d73a36d78e2ae4a437053c9ce3be70d483ab74d";
const chain = "bsc";
const pageUrl = `https://gmgn.ai/${chain}/address/${address}`;
const targets = [
  "0xf74548802f4c700315f019fde17178b392ee4444",
  "0xbc5dac3eb8e4c82523c84fa8589f91cbe6cc4444",
];

(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
  });
  await context.addInitScript(() => { Object.defineProperty(navigator, "webdriver", { get: () => false }); });

  const page = await context.newPage();
  let authUrl = "";
  page.on("response", (res) => {
    const url = res.url();
    if (!authUrl && url.includes("gmgn.ai") && url.includes("device_id=")) authUrl = url;
  });

  await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const deadline = Date.now() + 8_000;
  while (!authUrl && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));

  const param = (name: string) => new URL(authUrl).searchParams.get(name) ?? "";
  const device_id = param("device_id"), client_id = param("client_id"), fp_did = param("fp_did");
  const baseParams = `device_id=${device_id}&fp_did=${fp_did}&client_id=${client_id}&from_app=gmgn&app_ver=${client_id}&tz_name=UTC&tz_offset=0&app_lang=en-US&os=web`;

  const smartBase = `https://gmgn.ai/defi/quotation/v1/smartmoney/${chain}/walletNew`;

  const endpoints = [
    `${smartBase}/${address}/holdings?${baseParams}&limit=50&orderby=realized_profit&direction=desc`,
    `${smartBase}/${address}/trades?${baseParams}&limit=50&orderby=realized_profit&direction=desc`,
    `${smartBase}/${address}/token_list?${baseParams}&limit=50&orderby=realized_profit&direction=desc`,
    `${smartBase}/${address}/trade_history?${baseParams}&limit=50`,
    `${smartBase}/${address}/profitability?${baseParams}&limit=50`,
    `${smartBase}/${address}/top_trades?${baseParams}&limit=50`,
    `https://gmgn.ai/defi/quotation/v1/smartmoney/${chain}/wallet/${address}?${baseParams}`,
    // Try the wallet holdings sorted by realized_profit with all variants
    `https://gmgn.ai/api/v1/wallet_holdings/${chain}/${address}?${baseParams}&limit=50&orderby=realized_profit&direction=desc&showsmall=true&sellout=true&history=true`,
    `https://gmgn.ai/api/v1/wallet_holdings/${chain}/${address}?${baseParams}&limit=100&orderby=realized_profit&direction=desc&showsmall=true&sellout=true`,
  ];

  for (const url of endpoints) {
    const result = await page.evaluate(async (u: string) => {
      try {
        const r = await fetch(u, { credentials: "include" });
        const body = await r.json();
        const dataKeys = Object.keys(body?.data || {}).join(",");
        const listLen = body?.data?.list?.length ?? body?.data?.holdings?.length ?? body?.data?.trades?.length ?? "?";
        return { status: r.status, code: body?.code ?? body?.status, dataKeys, listLen, snippet: JSON.stringify(body).slice(0, 300) };
      } catch (e) { return { status: 0, code: -1, dataKeys: "", listLen: 0, snippet: String(e) }; }
    }, url);

    const label = url.replace(/https:\/\/gmgn\.ai/, "").replace(/\?.*/, "").slice(0, 70);
    console.log(`[${result.status}] ${label}: code=${result.code} list=${result.listLen} keys=${result.dataKeys.slice(0,60)}`);

    if (result.status === 200 && (result.code === 0 || result.code === 200)) {
      // Check if target tokens appear
      const found = targets.filter(t => result.snippet.toLowerCase().includes(t.toLowerCase()));
      if (found.length > 0) console.log(`  *** TARGET TOKENS FOUND: ${found}`);
      if (typeof result.listLen === "number" && result.listLen > 0) {
        console.log(`  -> ${result.snippet.slice(0, 200)}`);
      }
    }
  }

  await browser.close();
})();
