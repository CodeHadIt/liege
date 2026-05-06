import { chromium } from "playwright-core";

const address = "0x7429686b0123d049579c560c03f0e6605f90fe2e";
const pageUrl = `https://gmgn.ai/eth/address/${address}`;

function extractParam(url: string, param: string): string | null {
  const match = url.match(new RegExp(`[?&]${param}=([^&]+)`));
  return match ? match[1] : null;
}

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
  await new Promise(r => setTimeout(r, 5_000));

  const device_id = extractParam(authUrl, "device_id") ?? "";
  const client_id = extractParam(authUrl, "client_id") ?? "";
  const fp_did    = extractParam(authUrl, "fp_did") ?? "";

  const baseParams = `device_id=${device_id}&fp_did=${fp_did}&client_id=${client_id}&from_app=gmgn&app_ver=${client_id}&tz_name=Africa%2FLagos&tz_offset=3600&app_lang=en-US&os=web`;
  const ep = `https://gmgn.ai/api/v1/wallet_holdings/eth/${address}?${baseParams}&limit=50&orderby=last_active_timestamp&direction=desc&showsmall=true&sellout=false`;

  const result = await page.evaluate(async (url: string) => {
    const r = await fetch(url, { credentials: "include" });
    return { status: r.status, body: await r.json() };
  }, ep);

  console.log(`\nStatus: ${result.status}`);
  console.log(`\nFull response:\n`);
  console.log(JSON.stringify(result.body, null, 2));

  await browser.close();
  process.exit(0);
})();
