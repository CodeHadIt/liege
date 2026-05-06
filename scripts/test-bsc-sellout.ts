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

  if (!authUrl) { console.log("No auth URL"); await browser.close(); process.exit(1); }

  const param = (name: string) => new URL(authUrl).searchParams.get(name) ?? "";
  const device_id = param("device_id"), client_id = param("client_id"), fp_did = param("fp_did");

  // Test with sellout=true to include fully-sold positions
  for (const sellout of ["false", "true"]) {
    const apiUrl =
      `https://gmgn.ai/api/v1/wallet_holdings/${chain}/${address}` +
      `?device_id=${device_id}&fp_did=${fp_did}&client_id=${client_id}` +
      `&from_app=gmgn&app_ver=${client_id}&tz_name=UTC&tz_offset=0&app_lang=en-US&os=web` +
      `&limit=50&orderby=realized_profit&direction=desc&showsmall=true&sellout=${sellout}`;

    const result = await page.evaluate(async (url: string) => {
      const r = await fetch(url, { credentials: "include" });
      return { status: r.status, body: await r.json() };
    }, apiUrl);

    const holdings: any[] = result.body?.data?.holdings ?? result.body?.data?.list ?? [];
    console.log(`\nsellout=${sellout}: ${holdings.length} holdings`);

    for (const t of targets) {
      const h = holdings.find((h: any) => {
        const addr = h.token?.token_address || h.token?.address || h.address || "";
        return addr.toLowerCase() === t.toLowerCase();
      });
      console.log(`  ${t.slice(0, 12)}... : ${h ? `FOUND — realized=$${parseFloat(h.realized_profit||"0").toFixed(0)}, balance=${h.balance}` : "NOT FOUND"}`);
    }

    if (holdings.length > 0) {
      const sorted = holdings.sort((a: any, b: any) => parseFloat(b.realized_profit||"0") - parseFloat(a.realized_profit||"0"));
      console.log("  Top 3 by realized_profit:");
      sorted.slice(0, 3).forEach((h: any) => {
        const addr = h.token?.token_address || h.token?.address || "";
        console.log(`    ${h.token?.symbol} (${addr.slice(0,12)}...) realized=$${parseFloat(h.realized_profit||"0").toFixed(0)} balance=${h.balance}`);
      });
    }
  }

  // Also try with limit=100
  const apiUrl100 =
    `https://gmgn.ai/api/v1/wallet_holdings/${chain}/${address}` +
    `?device_id=${device_id}&fp_did=${fp_did}&client_id=${client_id}` +
    `&from_app=gmgn&app_ver=${client_id}&tz_name=UTC&tz_offset=0&app_lang=en-US&os=web` +
    `&limit=100&orderby=realized_profit&direction=desc&showsmall=true&sellout=true`;

  const result100 = await page.evaluate(async (url: string) => {
    const r = await fetch(url, { credentials: "include" });
    return { status: r.status, body: await r.json() };
  }, apiUrl100);

  const h100: any[] = result100.body?.data?.holdings ?? result100.body?.data?.list ?? [];
  console.log(`\nlimit=100 + sellout=true: ${h100.length} holdings`);
  for (const t of targets) {
    const h = h100.find((h: any) => {
      const addr = h.token?.token_address || h.token?.address || h.address || "";
      return addr.toLowerCase() === t.toLowerCase();
    });
    console.log(`  ${t.slice(0, 12)}... : ${h ? `FOUND — realized=$${parseFloat(h.realized_profit||"0").toFixed(0)}` : "NOT FOUND"}`);
  }

  await browser.close();
})();
