import { chromium, type Browser } from "playwright";
import { serverCache, CACHE_TTL } from "@/lib/cache";
import { searchPairs, type DexScreenerPair } from "./dexscreener";

export interface DexScreenerTopTrader {
  wallet: string;
  tokensBought: number;
  tokensSold: number;
}

// Singleton browser instance
let browserInstance: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserInstance?.isConnected()) return browserInstance;
  if (browserLaunchPromise) return browserLaunchPromise;
  browserLaunchPromise = chromium
    .launch({
      headless: false,
      args: ["--disable-blink-features=AutomationControlled"],
    })
    .then((b) => {
      browserInstance = b;
      browserLaunchPromise = null;
      return b;
    });
  return browserLaunchPromise;
}

/**
 * Parse the DexScreener top traders binary response.
 * Format: entries prefixed with T0x{40 hex chars}, followed by
 * text-encoded decimal numbers tagged with 0x18 (bought) or 0x1a (sold).
 */
function parseTopTradersBinary(buf: Buffer): DexScreenerTopTrader[] {
  const PREFIX = Buffer.from("T0x");
  const walletOffsets: { wallet: string; offset: number }[] = [];
  let pos = 0;

  while (true) {
    const idx = buf.indexOf(PREFIX, pos);
    if (idx === -1) break;
    const wallet = buf.slice(idx + 1, idx + 43).toString("ascii");
    walletOffsets.push({ wallet, offset: idx });
    pos = idx + 43;
  }

  const traders: DexScreenerTopTrader[] = [];

  for (let i = 0; i < walletOffsets.length; i++) {
    const start = walletOffsets[i].offset + 43;
    const end =
      i + 1 < walletOffsets.length ? walletOffsets[i + 1].offset : buf.length;
    const data = buf.slice(start, end);

    // Extract text-encoded decimal numbers from the data chunk
    const numbers: { value: number; tag: number }[] = [];
    let j = 0;
    while (j < data.length) {
      if (
        (data[j] >= 0x30 && data[j] <= 0x39) /* 0-9 */ ||
        data[j] === 0x2d /* - */
      ) {
        let numStr = "";
        let k = j;
        while (
          k < data.length &&
          (data[k] >= 0x30 && data[k] <= 0x39) /* 0-9 */ ||
          (k < data.length && data[k] === 0x2e) /* . */ ||
          (k < data.length && data[k] === 0x2d) /* - */
        ) {
          numStr += String.fromCharCode(data[k]);
          k++;
        }
        if (numStr.includes(".") && numStr.length > 3) {
          const tagByte = j > 0 ? data[j - 1] : 0;
          numbers.push({ value: parseFloat(numStr), tag: tagByte });
        }
        j = k;
      } else {
        j++;
      }
    }

    let tokensBought = 0;
    let tokensSold = 0;

    if (numbers.length >= 2) {
      // Two numbers: first = bought tokens, second = sold tokens
      tokensBought = numbers[0].value;
      tokensSold = numbers[1].value;
    } else if (numbers.length === 1) {
      // One number: tag 0x18 = bought, tag 0x1a = sold
      if (numbers[0].tag === 0x1a) {
        tokensSold = numbers[0].value;
      } else {
        tokensBought = numbers[0].value;
      }
    }

    traders.push({
      wallet: walletOffsets[i].wallet,
      tokensBought,
      tokensSold,
    });
  }

  return traders;
}

/**
 * Scrape top traders for a token from DexScreener.
 * Uses Playwright to bypass Cloudflare and intercept the binary API response.
 */
export async function scrapeTopTraders(
  chain: string,
  tokenAddress: string
): Promise<DexScreenerTopTrader[]> {
  const cacheKey = `dex-top-traders:${chain}:${tokenAddress}`;
  const cached = serverCache.get<DexScreenerTopTrader[]>(cacheKey);
  if (cached) return cached;

  // Search for pairs — /latest/dex/search returns all pairs including V4 pools
  const allPairs = await searchPairs(tokenAddress);
  const pairs = allPairs.filter(
    (p) =>
      p.chainId === chain &&
      p.baseToken.address.toLowerCase() === tokenAddress.toLowerCase()
  );
  if (pairs.length === 0) return [];

  // Use the highest liquidity pair
  const pair = pairs.sort(
    (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
  )[0];

  const pageUrl = pair.url;
  if (!pageUrl) return [];

  console.log(`[scraper] ${tokenAddress} → navigating to ${pageUrl}`);

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const page = await context.newPage();
  let topTradersBuffer: Buffer | null = null;
  const interceptedUrls: string[] = [];

  page.on("response", async (response) => {
    const url = response.url();
    if (url.includes("io.dexscreener")) {
      interceptedUrls.push(url);
    }
    if (url.includes("/top/") && url.includes("io.dexscreener")) {
      try {
        topTradersBuffer = (await response.body()) as Buffer;
        console.log(
          `[scraper] ${tokenAddress} → intercepted top traders response: ${(topTradersBuffer as Buffer).length} bytes`
        );
      } catch {}
    }
  });

  try {
    await page.goto(pageUrl, { waitUntil: "load", timeout: 60000 });
    console.log(`[scraper] ${tokenAddress} → page loaded, waiting 12s...`);
    await page.waitForTimeout(12000);

    // Click "Top Traders" tab
    const topTradersBtn = page.getByText("Top Traders").first();
    const btnVisible = await topTradersBtn.isVisible().catch(() => false);
    console.log(`[scraper] ${tokenAddress} → Top Traders button visible: ${btnVisible}`);

    if (btnVisible) {
      await topTradersBtn.click({ timeout: 5000 });
      console.log(`[scraper] ${tokenAddress} → clicked Top Traders, waiting 8s...`);
      await page.waitForTimeout(8000);
    }
  } catch (err) {
    console.log(`[scraper] ${tokenAddress} → scrape failed: ${err}`);
  } finally {
    console.log(
      `[scraper] ${tokenAddress} → intercepted ${interceptedUrls.length} io.dexscreener URLs`
    );
    for (const u of interceptedUrls.slice(0, 5)) {
      console.log(`  ${u.substring(0, 120)}`);
    }
    await context.close();
  }

  // Cast needed: TS can't track assignments in async callbacks
  const buf = topTradersBuffer as Buffer | null;
  if (!buf || buf.length < 50) {
    console.log(
      `[scraper] ${tokenAddress} → no valid top traders buffer (${buf ? buf.length : 0} bytes)`
    );
    return [];
  }

  const traders = parseTopTradersBinary(buf);
  console.log(`[scraper] ${tokenAddress} → parsed ${traders.length} traders`);
  if (traders.length > 0) {
    serverCache.set(cacheKey, traders, CACHE_TTL.TOP_TRADERS);
  }

  return traders;
}
