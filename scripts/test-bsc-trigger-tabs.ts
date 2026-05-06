import { chromium } from "playwright-core";

const address = "0x8d73a36d78e2ae4a437053c9ce3be70d483ab74d";
const chain = "bsc";
const pageUrl = `https://gmgn.ai/${chain}/address/${address}`;

(async () => {
  const browser = await chromium.launch({ headless: false, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
  });
  await context.addInitScript(() => { Object.defineProperty(navigator, "webdriver", { get: () => false }); });

  const page = await context.newPage();
  const interesting: { url: string; status: number }[] = [];

  page.on("response", async (res) => {
    const url = res.url();
    if ((url.includes("gmgn.ai/api/") || url.includes("gmgn.ai/defi/") || url.includes("gmgn.ai/vas/")) &&
        !url.includes("major_coin_prices") && !url.includes("gas_price") && !url.includes("dex_trades_polling") && !url.includes("my_rank") && !url.includes("twitch")) {
      interesting.push({ url: url.slice(0, 200), status: res.status() });
    }
  });

  await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await new Promise(r => setTimeout(r, 5_000));

  // Try clicking on Holdings/PnL buttons
  console.log("Trying to click PnL/Holdings tabs...");
  const buttons = await page.$$("button");
  for (const btn of buttons) {
    const text = await btn.textContent();
    console.log(`  Button: "${text?.trim()}"`);
  }

  // Try clicking links/tabs
  const links = await page.$$("a, [role='tab'], .tab");
  for (const link of links.slice(0, 20)) {
    const text = await link.textContent();
    if (text) console.log(`  Link/tab: "${text.trim().slice(0, 50)}"`);
  }

  await new Promise(r => setTimeout(r, 8_000));

  console.log(`\nInteresting API calls captured:`);
  interesting.forEach(({ url, status }) => console.log(`  [${status}] ${url}`));

  await browser.close();
})();
