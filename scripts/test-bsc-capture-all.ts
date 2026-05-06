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
  const intercepted: { url: string; status: number }[] = [];

  page.on("response", (res) => {
    const url = res.url();
    // Only log GMGN API calls
    if (url.includes("gmgn.ai/api/") || url.includes("gmgn.ai/defi/") || url.includes("gmgn.ai/vas/")) {
      intercepted.push({ url: url.slice(0, 180), status: res.status() });
    }
  });

  await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await new Promise(r => setTimeout(r, 10_000)); // wait 10s for lazy-loaded requests

  console.log(`\nAll GMGN API calls (${intercepted.length}):`);
  for (const { url, status } of intercepted) {
    console.log(`  [${status}] ${url}`);
  }

  await browser.close();
})();
