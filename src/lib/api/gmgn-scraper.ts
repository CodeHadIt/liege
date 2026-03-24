import { chromium, type Browser } from "playwright";
import { serverCache, CACHE_TTL } from "@/lib/cache";

export interface GmgnTopTrader {
  walletAddress: string;
  /** Historical realized PnL in USD (actual, not approximated) */
  realizedProfitUsd: number;
  /** Unrealized PnL in USD at time of scrape */
  unrealizedProfitUsd: number;
  /** Total USD spent buying */
  historyBoughtCostUsd: number;
  /** Total USD received from selling */
  historySoldIncomeUsd: number;
  /** Current token balance */
  balance: number;
  /** Current USD value of balance */
  balanceUsd: number;
  /** Average buy price in USD per token */
  avgCostUsd: number;
  /** Average sell price in USD per token */
  avgSoldUsd: number;
  /** Buy transaction count */
  buyCount: number;
  /** Sell transaction count */
  sellCount: number;
  /** Last activity unix timestamp (seconds) */
  lastActiveTimestamp: number | null;
  /** Native balance in wei as string */
  nativeBalanceWei: string;
}

// ─── Browser singleton ────────────────────────────────────────────────────────

let browserInstance: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserInstance?.isConnected()) return browserInstance;
  if (browserLaunchPromise) return browserLaunchPromise;
  browserLaunchPromise = chromium
    .launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
    })
    .then((b) => {
      browserInstance = b;
      browserLaunchPromise = null;
      return b;
    })
    .catch((err) => {
      browserLaunchPromise = null;
      throw err;
    });
  return browserLaunchPromise;
}

// ─── GMGN chain ID mapping ────────────────────────────────────────────────────

const CHAIN_TO_GMGN: Record<string, string> = {
  base:     "base",
  bsc:      "bsc",
  ethereum: "eth",
  eth:      "eth",
};

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Scrape top traders for an EVM token from GMGN.ai.
 *
 * Uses Playwright to load the token page (establishes session/cookies), then
 * fires a credentialed fetch for the token_holders endpoint sorted by
 * realized_profit — returning all historical traders including fully-exited
 * wallets, with exact PnL data.
 *
 * Cached for 30 minutes per token to minimise GMGN load and avoid rate limits.
 */
export async function scrapeGmgnTopTraders(
  chain: string,
  tokenAddress: string
): Promise<GmgnTopTrader[]> {
  const cacheKey = `gmgn-top-traders:${chain}:${tokenAddress.toLowerCase()}`;
  const cached = serverCache.get<GmgnTopTrader[]>(cacheKey);
  if (cached) return cached;

  const gmgnChain = CHAIN_TO_GMGN[chain.toLowerCase()];
  if (!gmgnChain) {
    console.log(`[gmgn-scraper] Unsupported chain: ${chain}`);
    return [];
  }

  const pageUrl = `https://gmgn.ai/${gmgnChain}/token/${tokenAddress}`;
  const apiUrl =
    `https://gmgn.ai/vas/api/v1/token_holders/${gmgnChain}/${tokenAddress}` +
    `?orderby=realized_profit&direction=desc&limit=100`;

  console.log(`[gmgn-scraper] Fetching ${chain}:${tokenAddress}`);

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const page = await context.newPage();
  let holdersBody: Record<string, unknown> | null = null;

  try {
    // Wait for the page's automatic token_holders call as a "session ready"
    // signal, then add a short fixed delay to let GMGN's auth cookies fully
    // settle before we fire our own credentialed fetch.
    // Cap the waitForResponse at 20s; fall back to a straight 8s wait if it
    // never fires (e.g. GMGN changes the request pattern).
    const sessionReady = page
      .waitForResponse(
        (res) => res.url().includes("/vas/api/v1/token_holders/"),
        { timeout: 20_000 }
      )
      .catch(() => null);

    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const readyAt = Date.now();
    await sessionReady;
    // Ensure at least 6s have elapsed since navigation so auth is stable.
    const elapsed = Date.now() - readyAt;
    if (elapsed < 6_000) await new Promise((r) => setTimeout(r, 6_000 - elapsed));

    // Fire the realized_profit-sorted fetch from within the browser context
    // so it carries the session cookies. Retry up to 3 times on failure.
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) {
        console.log(`[gmgn-scraper] Retry attempt ${attempt}/3 for ${tokenAddress.slice(0, 10)}…`);
        await new Promise((r) => setTimeout(r, 2_000 * (attempt - 1)));
      }

      const result = await page
        .evaluate(async (url: string) => {
          try {
            const r = await fetch(url, { credentials: "include" });
            return { ok: r.ok, status: r.status, body: await r.json() };
          } catch (e) {
            return { ok: false, status: 0, body: null, error: String(e) };
          }
        }, apiUrl)
        .catch(() => ({ ok: false as const, status: 0, body: null }));

      if (result.ok && result.body) {
        holdersBody = result.body as Record<string, unknown>;
        console.log(
          `[gmgn-scraper] OK on attempt ${attempt} — ${JSON.stringify(result.body).length} bytes`
        );
        break;
      }

      console.log(`[gmgn-scraper] Attempt ${attempt} failed: status=${result.status}`);
    }
  } catch (err) {
    console.log(`[gmgn-scraper] Page error: ${err}`);
  } finally {
    await context.close();
  }

  if (!holdersBody) {
    console.log(`[gmgn-scraper] No data captured for ${tokenAddress.slice(0, 10)}…`);
    return [];
  }

  const raw = holdersBody as { code?: number; data?: { list?: unknown[] } };
  const list = raw?.data?.list;
  if (!Array.isArray(list) || list.length === 0) {
    console.log(`[gmgn-scraper] Empty or malformed response for ${tokenAddress.slice(0, 10)}…`);
    return [];
  }

  const traders: GmgnTopTrader[] = list
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      walletAddress:        String(item.address ?? ""),
      realizedProfitUsd:    parseFloat(String(item.realized_profit ?? 0)) || 0,
      unrealizedProfitUsd:  parseFloat(String(item.unrealized_profit ?? 0)) || 0,
      historyBoughtCostUsd: parseFloat(String(item.history_bought_cost ?? 0)) || 0,
      historySoldIncomeUsd: parseFloat(String(item.history_sold_income ?? 0)) || 0,
      balance:              typeof item.balance === "number" ? item.balance : parseFloat(String(item.balance ?? 0)) || 0,
      balanceUsd:           parseFloat(String(item.usd_value ?? 0)) || 0,
      avgCostUsd:           parseFloat(String(item.avg_cost ?? 0)) || 0,
      avgSoldUsd:           parseFloat(String(item.avg_sold ?? 0)) || 0,
      buyCount:             typeof item.buy_tx_count_cur === "number" ? item.buy_tx_count_cur : parseInt(String(item.buy_tx_count_cur ?? 0)) || 0,
      sellCount:            typeof item.sell_tx_count_cur === "number" ? item.sell_tx_count_cur : parseInt(String(item.sell_tx_count_cur ?? 0)) || 0,
      lastActiveTimestamp:  typeof item.last_active_timestamp === "number" ? item.last_active_timestamp : null,
      nativeBalanceWei:     String(item.native_balance ?? "0"),
    }))
    .filter((t) => t.walletAddress.startsWith("0x"))
    .sort((a, b) => b.realizedProfitUsd - a.realizedProfitUsd);

  console.log(
    `[gmgn-scraper] Parsed ${traders.length} traders for ${chain}:${tokenAddress.slice(0, 10)}… ` +
    `— top PnL: $${traders[0]?.realizedProfitUsd?.toFixed(0)}`
  );

  if (traders.length > 0) {
    serverCache.set(cacheKey, traders, CACHE_TTL.GMGN_TRADERS);
  }

  return traders;
}
