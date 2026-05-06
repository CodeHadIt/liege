import { chromium } from "playwright-core";

const address = "0x8894e0a0c962cb723c1976a4421c95949be2d4e3";
const chain = "bsc";
const pageUrl = `https://gmgn.ai/${chain}/address/${address}`;

(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const page = await context.newPage();
  let authUrl = "";

  page.on("response", (res) => {
    const url = res.url();
    if (!authUrl && url.includes("gmgn.ai") && url.includes("device_id=")) authUrl = url;
  });

  await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const deadline = Date.now() + 8_000;
  while (!authUrl && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));

  if (!authUrl) { console.log("No auth URL!"); await browser.close(); process.exit(1); }

  const param = (name: string) => new URL(authUrl).searchParams.get(name) ?? "";
  const device_id = param("device_id"), client_id = param("client_id"), fp_did = param("fp_did");

  const apiUrl =
    `https://gmgn.ai/api/v1/wallet_holdings/${chain}/${address}` +
    `?device_id=${device_id}&fp_did=${fp_did}&client_id=${client_id}` +
    `&from_app=gmgn&app_ver=${client_id}&tz_name=UTC&tz_offset=0&app_lang=en-US&os=web` +
    `&limit=50&orderby=last_active_timestamp&direction=desc&showsmall=true&sellout=false`;

  const result = await page.evaluate(async (url: string) => {
    const r = await fetch(url, { credentials: "include" });
    return { status: r.status, body: await r.json() };
  }, apiUrl);

  const holdings = result.body?.data?.holdings ?? result.body?.data?.list ?? [];
  console.log(`Status: ${result.status}, Holdings: ${Array.isArray(holdings) ? holdings.length : 0}`);
  if (Array.isArray(holdings) && holdings.length > 0) {
    console.log("First holding:", JSON.stringify(holdings[0], null, 2));
  } else {
    console.log("Full response:", JSON.stringify(result.body, null, 2));
  }

  await browser.close();
})();
