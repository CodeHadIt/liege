import { chromium } from "playwright-core";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  });
  const page = await ctx.newPage();
  const hits: { url: string; status: number; sample: string }[] = [];

  page.on("response", async (res) => {
    const url = res.url();
    if (/\.(js|css|png|jpg|jpeg|svg|woff2?|ico|map)(\?|$)/i.test(url)) return;
    const ct = res.headers()["content-type"] || "";
    let sample = "";
    if (ct.includes("json")) { try { sample = JSON.stringify(await res.json()).slice(0, 400); } catch {} }
    if (ct.includes("json") || /api|labsapis|tokens|graphql/i.test(url)) hits.push({ url, status: res.status(), sample });
  });

  console.log("Loading sunrise.xyz/tokens …");
  await page.goto("https://sunrise.xyz/tokens", { waitUntil: "networkidle", timeout: 60_000 }).catch((e) => console.log("goto:", String(e).slice(0,120)));
  await new Promise((r) => setTimeout(r, 4000));

  console.log(`\n=== ${hits.length} api/json responses ===`);
  for (const h of hits) {
    const flag = /ttwo|ticker|symbol|token|pair|usdc|stock/i.test(h.sample) ? " <<< TOKEN DATA" : "";
    console.log(`\n[${h.status}] ${h.url}${flag}`);
    if (h.sample) console.log(`   ${h.sample}`);
  }
  await ctx.close(); await browser.close();
}
main().then(() => process.exit(0));
