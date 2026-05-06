import { chromium } from "playwright-core";

const address = "0x8d73a36d78e2ae4a437053c9ce3be70d483ab74d";
const chain = "bsc";
const pageUrl = `https://gmgn.ai/${chain}/address/${address}`;

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

  // Try different endpoint patterns
  const endpoints = [
    // Various patterns for all-time trade summary
    `https://gmgn.ai/api/v1/wallet_token_list/${chain}/${address}?${baseParams}&limit=50&orderby=realized_profit&direction=desc`,
    `https://gmgn.ai/api/v1/wallet_trade_history/${chain}/${address}?${baseParams}&limit=20`,
    `https://gmgn.ai/api/v1/wallet_token_info/${chain}/${address}?${baseParams}`,
    `https://gmgn.ai/api/v1/wallet_top_pnl/${chain}/${address}?${baseParams}`,
    `https://gmgn.ai/defi/quotation/v1/smartmoney/${chain}/walletNew/${address}?${baseParams}`,
    `https://gmgn.ai/api/v1/wallet_activity/${chain}/${address}?${baseParams}&limit=20`,
    `https://gmgn.ai/api/v1/wallet_activities/${chain}/${address}?${baseParams}&limit=20`,
    // The holdings endpoint sorted differently 
    `https://gmgn.ai/api/v1/wallet_holdings/${chain}/${address}?${baseParams}&limit=50&orderby=realized_profit&direction=desc&showsmall=true&sellout=true`,
  ];

  for (const url of endpoints) {
    const result = await page.evaluate(async (u: string) => {
      try {
        const r = await fetch(u, { credentials: "include" });
        const body = await r.json();
        return { status: r.status, code: body?.code, keys: Object.keys(body?.data || {}).join(","), bodySnippet: JSON.stringify(body).slice(0, 200) };
      } catch (e) { return { status: 0, code: -1, keys: "", bodySnippet: String(e) }; }
    }, url);

    const label = url.replace(/https:\/\/gmgn\.ai/, "").replace(/\?.*/, "").slice(0, 60);
    console.log(`[${result.status}] ${label}: code=${result.code} keys=${result.keys}`);
    if (result.status === 200 && result.code === 0) {
      console.log(`  -> ${result.bodySnippet.slice(0, 150)}`);
    }
  }

  await browser.close();
})();
