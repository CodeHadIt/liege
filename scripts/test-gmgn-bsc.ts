import { chromium } from "playwright-core";

// A known active BSC wallet
const address = "0x3b6f6d1b7fa05e3ad5c97dcd5cf05a82bfd8df9e";
const chain = "bsc";
const pageUrl = `https://gmgn.ai/${chain}/address/${address}`;

function extractParam(url: string, param: string): string | null {
  try {
    return new URL(url).searchParams.get(param);
  } catch {
    return null;
  }
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
  const allUrls: string[] = [];

  page.on("response", (res) => {
    const url = res.url();
    if (url.includes("gmgn.ai")) {
      allUrls.push(url);
      if (!authUrl && url.includes("device_id=")) {
        authUrl = url;
        console.log(`\nAuth URL captured: ${url.slice(0, 120)}...`);
      }
    }
  });

  console.log(`\nNavigating to: ${pageUrl}`);
  await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // Wait up to 8s for auth URL
  const deadline = Date.now() + 8_000;
  while (!authUrl && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\nTotal GMGN requests: ${allUrls.length}`);
  console.log(`Auth URL found: ${!!authUrl}`);

  if (!authUrl) {
    console.log("\nNo auth URL found! First 10 GMGN URLs:");
    allUrls.slice(0, 10).forEach(u => console.log(" ", u.slice(0, 120)));
    await browser.close();
    process.exit(1);
  }

  const device_id = extractParam(authUrl, "device_id") ?? "";
  const client_id = extractParam(authUrl, "client_id") ?? "";
  const fp_did    = extractParam(authUrl, "fp_did") ?? "";
  const app_ver   = extractParam(authUrl, "app_ver") || client_id;

  const apiUrl =
    `https://gmgn.ai/api/v1/wallet_holdings/${chain}/${address}` +
    `?device_id=${device_id}&fp_did=${fp_did}&client_id=${client_id}` +
    `&from_app=gmgn&app_ver=${app_ver}&tz_name=UTC&tz_offset=0&app_lang=en-US&os=web` +
    `&limit=50&orderby=last_active_timestamp&direction=desc&showsmall=true&sellout=false`;

  console.log(`\nCalling API: ${apiUrl.slice(0, 120)}...`);

  const result = await page.evaluate(async (url: string) => {
    const r = await fetch(url, { credentials: "include" });
    return { status: r.status, body: await r.json() };
  }, apiUrl);

  console.log(`\nStatus: ${result.status}`);
  console.log(`\nResponse keys: ${Object.keys(result.body || {}).join(", ")}`);

  const holdings = result.body?.data?.holdings ?? result.body?.data?.list ?? [];
  console.log(`\nHoldings count: ${Array.isArray(holdings) ? holdings.length : "not an array"}`);

  if (Array.isArray(holdings) && holdings.length > 0) {
    console.log("\nFirst holding:", JSON.stringify(holdings[0], null, 2));
  } else {
    console.log("\nFull response:", JSON.stringify(result.body, null, 2));
  }

  await browser.close();
  process.exit(0);
})();
