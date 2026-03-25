/**
 * Final test: use CDP Network.enable to capture EVERY network request
 * (including from service workers / blob workers) that the GMGN address page fires.
 * This is the lowest-level intercept possible in Playwright.
 */

import { chromium } from "playwright";

const WALLET = "0xacaf65505d9a48cd7a9be7eba5f25d886792354a";
const CHAIN  = "base";
const PAGE_URL = `https://gmgn.ai/${CHAIN}/address/${WALLET}`;

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const page = await context.newPage();

  // Use CDP session to intercept ALL network activity at the lowest level
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");

  const cdpRequests = new Map();
  const cdpResponses = [];

  cdp.on("Network.requestWillBeSent", (params) => {
    const url = params.request.url;
    if (url.includes("gmgn") || url.includes("vas/api") || url.includes("defi/quotation")) {
      cdpRequests.set(params.requestId, {
        url: url.replace("https://gmgn.ai", ""),
        method: params.request.method,
        initiator: params.initiator?.type ?? "?",
      });
    }
  });

  cdp.on("Network.responseReceived", async (params) => {
    const req = cdpRequests.get(params.requestId);
    if (!req) return;
    cdpResponses.push({
      ...req,
      status: params.response.status,
      mimeType: params.response.mimeType,
      requestId: params.requestId,
    });
  });

  console.log(`\nLoading: ${PAGE_URL}\n`);
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await new Promise((r) => setTimeout(r, 20_000));

  // Print all captured requests
  console.log(`Captured ${cdpResponses.length} gmgn.ai requests:\n`);
  for (const r of cdpResponses) {
    const short = r.url.replace(/\?.*$/, "");
    console.log(`  [${r.status}] [${r.initiator}] ${short}`);
  }

  // Get response bodies for any API calls
  console.log("\n=== API response bodies ===");
  for (const r of cdpResponses) {
    if (!r.mimeType?.includes("json")) continue;
    try {
      const body = await cdp.send("Network.getResponseBody", { requestId: r.requestId });
      const short = r.url.replace(/\?.*$/, "");
      console.log(`\n[${r.status}] ${short}:`);
      console.log(body.body.slice(0, 2000));
    } catch { /* ignore — body may be gone */ }
  }

  // Final probe: try the wallet_holdings endpoint with extra realistic headers
  console.log("\n=== Final probe with realistic headers ===");
  const result = await page.evaluate(async ({ url, wallet, chain }) => {
    try {
      const r = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": `https://gmgn.ai/${chain}/address/${wallet}`,
          "Origin": "https://gmgn.ai",
          "sec-ch-ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"macOS"',
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
        },
      });
      const text = await r.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* noop */ }
      return { ok: r.ok, status: r.status, len: text.length, body };
    } catch (e) {
      return { ok: false, status: 0, len: 0, body: null, error: String(e) };
    }
  }, {
    url: `https://gmgn.ai/vas/api/v1/wallet_holdings/${CHAIN}/${WALLET}?limit=50&orderby=usd_value&direction=desc`,
    wallet: WALLET,
    chain: CHAIN,
  });

  if (result.ok && result.body && result.len > 100) {
    console.log(`✅ [${result.status}] ${result.len}b`);
    console.log(JSON.stringify(result.body, null, 2).slice(0, 5000));
  } else {
    console.log(`❌ [${result.status}] ${result.len}b`);
    if (result.body) console.log(JSON.stringify(result.body).slice(0, 200));
  }

  await context.close();
  await browser.close();
})();
