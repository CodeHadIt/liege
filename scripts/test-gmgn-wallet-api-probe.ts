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

  const candidates = [
    // Trades / activity variants
    `https://gmgn.ai/api/v1/wallet_trades/${chain}/${address}?${baseParams}&limit=20`,
    `https://gmgn.ai/api/v1/wallet_trade_list/${chain}/${address}?${baseParams}&limit=20`,
    `https://gmgn.ai/api/v1/wallet_swap_records/${chain}/${address}?${baseParams}&limit=20`,
    `https://gmgn.ai/api/v1/wallet_swaps/${chain}/${address}?${baseParams}&limit=20`,
    `https://gmgn.ai/api/v1/wallet_activity_list/${chain}/${address}?${baseParams}&limit=20`,
    `https://gmgn.ai/api/v1/wallet_txs/${chain}/${address}?${baseParams}&limit=20`,
    `https://gmgn.ai/api/v1/wallet_transactions/${chain}/${address}?${baseParams}&limit=20`,
    `https://gmgn.ai/api/v1/wallet_orders/${chain}/${address}?${baseParams}&limit=20`,
    // PnL variants
    `https://gmgn.ai/api/v1/wallet_pnl/${chain}/${address}?${baseParams}&limit=20`,
    `https://gmgn.ai/api/v1/wallet_pnl_list/${chain}/${address}?${baseParams}&limit=20`,
    `https://gmgn.ai/api/v1/wallet_profit/${chain}/${address}?${baseParams}&limit=20`,
    `https://gmgn.ai/api/v1/wallet_profit_list/${chain}/${address}?${baseParams}&limit=20`,
    `https://gmgn.ai/api/v1/wallet_token_pnl/${chain}/${address}?${baseParams}&limit=20`,
    `https://gmgn.ai/api/v1/wallet_realized_profit/${chain}/${address}?${baseParams}&limit=20`,
    // defi/ prefix variants
    `https://gmgn.ai/defi/quotation/v1/smartmoney/${chain}/walletNew/${address}/trades?${baseParams}&limit=20`,
    `https://gmgn.ai/defi/quotation/v1/smartmoney/${chain}/walletNew/${address}/pnl?${baseParams}&limit=20`,
    `https://gmgn.ai/defi/quotation/v1/smartmoney/${chain}/walletNew/${address}/token_profit?${baseParams}&limit=20`,
    `https://gmgn.ai/defi/quotation/v1/smartmoney/${chain}/walletNew/${address}/profit?${baseParams}&limit=20`,
  ];

  for (const url of candidates) {
    const result = await page.evaluate(async (u: string) => {
      try {
        const r = await fetch(u, { credentials: "include" });
        const body = await r.json();
        return { status: r.status, code: body?.code, dataKeys: Object.keys(body?.data || {}).join(","), len: body?.data?.list?.length ?? body?.data?.trades?.length ?? body?.data?.pnl?.length ?? "?" };
      } catch { return { status: 0, code: -1, dataKeys: "", len: 0 }; }
    }, url);

    const label = url.replace(`https://gmgn.ai`, "").replace(/\?.*/, "").slice(0, 70);
    if (result.status === 200 && result.code === 0) {
      console.log(`✅ [${result.status}] ${label} — keys: ${result.dataKeys}, len: ${result.len}`);
    } else {
      console.log(`   [${result.status}] ${label} — code: ${result.code}`);
    }
  }

  await browser.close();
})();
