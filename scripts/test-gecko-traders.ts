/**
 * Debug script: navigate to GeckoTerminal pool page, log ALL API calls,
 * click the Traders tab, capture the response, and print the trader table.
 *
 * Run: npx tsx scripts/test-gecko-traders.ts
 */
import { chromium } from "playwright-core";

const POOL = "EQCO9NDT4Il25_4ZpHIOgMAUbRJvpsI9pLzqhD8X7eTVB7X_";
const PAGE_URL = `https://www.geckoterminal.com/ton/pools/${POOL}`;

function fmt(n: number) {
  const abs = Math.abs(n);
  const s = n < 0 ? "-" : "+";
  if (abs >= 1e6) return `${s}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${s}$${(abs / 1e3).toFixed(1)}K`;
  return `${s}$${abs.toFixed(2)}`;
}

async function main() {
  console.log("Launching browser…");
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const page = await context.newPage();

  // ── Log every API request (skip assets) ────────────────────────────────────
  const capturedResponses: { url: string; status: number; body: unknown }[] = [];

  page.on("response", async (res) => {
    const url = res.url();
    if (
      url.includes(".js") ||
      url.includes(".css") ||
      url.includes(".png") ||
      url.includes(".svg") ||
      url.includes(".woff") ||
      url.includes("analytics") ||
      url.includes("sentry") ||
      url.includes("intercom") ||
      url.includes("cloudflare")
    ) return;

    const ct = res.headers()["content-type"] ?? "";
    if (!ct.includes("json")) return;

    let body: unknown = null;
    try { body = await res.json(); } catch { return; }

    console.log(`  [NET] ${res.status()} ${url.slice(0, 120)}`);
    capturedResponses.push({ url, status: res.status(), body });
  });

  // ── Navigate ────────────────────────────────────────────────────────────────
  console.log(`\nNavigating to ${PAGE_URL}`);
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  console.log("Page loaded. Waiting 4s for initial API calls…");
  await new Promise((r) => setTimeout(r, 4_000));

  // ── List all clickable tabs ─────────────────────────────────────────────────
  console.log("\nLooking for tabs on page…");
  const tabTexts = await page.evaluate(() => {
    const candidates = [
      ...document.querySelectorAll('button, [role="tab"], a'),
    ];
    return candidates
      .map((el) => ({ text: el.textContent?.trim(), tag: el.tagName, role: el.getAttribute("role") }))
      .filter((t) => t.text && t.text.length < 40)
      .slice(0, 30);
  });
  console.log("  Tabs/buttons found:", JSON.stringify(tabTexts, null, 2));

  // ── Click "Traders" tab ─────────────────────────────────────────────────────
  const before = capturedResponses.length;
  console.log("\nAttempting to click Traders tab…");

  const selectors = [
    'button:has-text("Traders")',
    '[role="tab"]:has-text("Traders")',
    'a:has-text("Traders")',
    'li:has-text("Traders")',
    'span:has-text("Traders")',
  ];

  let clicked = false;
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      const visible = await el.isVisible({ timeout: 2_000 });
      if (visible) {
        await el.click();
        console.log(`  ✓ Clicked with selector: ${sel}`);
        clicked = true;
        break;
      }
    } catch { /* try next */ }
  }

  if (!clicked) {
    console.log("  ✗ Could not find/click Traders tab — dumping page HTML excerpt:");
    const html = await page.content();
    // Print first 3000 chars to find the tab structure
    console.log(html.slice(0, 3000));
  }

  console.log("Waiting 8s for trader API response…");
  await new Promise((r) => setTimeout(r, 8_000));

  // ── Report new responses captured after tab click ───────────────────────────
  const newResponses = capturedResponses.slice(before);
  console.log(`\n${newResponses.length} new JSON responses after tab click:`);
  for (const r of newResponses) {
    const bodyStr = JSON.stringify(r.body).slice(0, 200);
    console.log(`  [${r.status}] ${r.url.slice(0, 100)}`);
    console.log(`         body: ${bodyStr}`);
  }

  // ── Find wallet_tokens response and render table ─────────────────────────────
  const traderResponse = capturedResponses.find((r) =>
    r.url.includes("wallet_tokens") && r.url.includes("token_id")
  );

  if (!traderResponse) {
    console.log("\n✗ No wallet_tokens response captured — traders tab may not have loaded.");
    console.log("  All captured URLs:");
    capturedResponses.forEach((r) => console.log(`    ${r.url.slice(0, 100)}`));
  } else {
    const body = traderResponse.body as Record<string, unknown>;
    const list = Array.isArray(body.data) ? body.data as Record<string, unknown>[] : [];
    console.log(`\n✓ Captured ${list.length} traders from: ${traderResponse.url.slice(0, 80)}`);
    console.log(`\n─── Top Traders (first 10) ───────────────────────────────────────────────────`);
    console.log(`${"#".padEnd(3)} ${"Wallet".padEnd(50)} ${"Buy Vol".padEnd(12)} ${"Sell Vol".padEnd(12)} ${"PnL".padEnd(12)} Txns`);
    console.log(`${"─".repeat(100)}`);
    list.slice(0, 10).forEach((item, i) => {
      const attrs = (item.attributes as Record<string, unknown>) ?? item;
      const wallet = String(attrs.wallet_address ?? attrs.address ?? "?");
      const buyVol  = parseFloat(String(attrs.total_buy_in_usd   ?? 0)) || 0;
      const sellVol = parseFloat(String(attrs.total_sell_in_usd  ?? 0)) || 0;
      const pnl     = parseFloat(String(attrs.realized_pnl       ?? 0)) || 0;
      const buys    = parseInt(String(attrs.total_buy_count  ?? attrs.total_buys  ?? 0)) || 0;
      const sells   = parseInt(String(attrs.total_sell_count ?? attrs.total_sells ?? 0)) || 0;
      console.log(
        `${String(i + 1).padEnd(3)} ${wallet.padEnd(50)} ${fmt(buyVol).padEnd(12)} ${fmt(sellVol).padEnd(12)} ${fmt(pnl).padEnd(12)} ${buys}b/${sells}s`
      );
    });
    console.log(`${"─".repeat(100)}`);
  }

  await browser.close();
  console.log("\nDone.");
}

main().catch(console.error);
