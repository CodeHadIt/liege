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
  /** % of total supply held (as reported by GMGN, 0 if not available) */
  supplyPercent: number;
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

// ─── Shared Playwright fetch helper ──────────────────────────────────────────

/**
 * Navigate to the GMGN token page (establishes session cookies) then fire a
 * credentialed fetch to `apiUrl` from within the browser context.
 * Returns the raw parsed JSON body, or null on failure.
 */
async function fetchGmgnWithSession(
  pageUrl: string,
  apiUrl: string,
  label: string
): Promise<Record<string, unknown> | null> {
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
  let body: Record<string, unknown> | null = null;

  try {
    const sessionReady = page
      .waitForResponse(
        (res) => res.url().includes("/vas/api/v1/token_holders/"),
        { timeout: 20_000 }
      )
      .catch(() => null);

    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const readyAt = Date.now();
    await sessionReady;
    const elapsed = Date.now() - readyAt;
    if (elapsed < 6_000) await new Promise((r) => setTimeout(r, 6_000 - elapsed));

    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) {
        console.log(`[gmgn-scraper] ${label} retry ${attempt}/3`);
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
        body = result.body as Record<string, unknown>;
        console.log(`[gmgn-scraper] ${label} OK on attempt ${attempt}`);
        break;
      }
      console.log(`[gmgn-scraper] ${label} attempt ${attempt} failed: status=${result.status}`);
    }
  } catch (err) {
    console.log(`[gmgn-scraper] ${label} page error: ${err}`);
  } finally {
    await context.close();
  }

  return body;
}

function parseGmgnList(body: Record<string, unknown>): GmgnTopTrader[] {
  const raw = body as { code?: number; data?: { list?: unknown[] } };
  const list = raw?.data?.list;
  if (!Array.isArray(list) || list.length === 0) return [];

  return list
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
      // Supply percentage as reported directly by GMGN
      supplyPercent:        parseFloat(String(item.percent ?? item.supply_percent ?? 0)) || 0,
    }))
    .filter((t) => t.walletAddress.startsWith("0x"));
}

// ─── Top Traders ──────────────────────────────────────────────────────────────

export async function scrapeGmgnTopTraders(
  chain: string,
  tokenAddress: string
): Promise<GmgnTopTrader[]> {
  const cacheKey = `gmgn-top-traders:${chain}:${tokenAddress.toLowerCase()}`;
  const cached = serverCache.get<GmgnTopTrader[]>(cacheKey);
  if (cached) return cached;

  const gmgnChain = CHAIN_TO_GMGN[chain.toLowerCase()];
  if (!gmgnChain) return [];

  const tokenLower = tokenAddress.toLowerCase();
  const pageUrl = `https://gmgn.ai/${gmgnChain}/token/${tokenLower}`;
  const apiUrl =
    `https://gmgn.ai/vas/api/v1/token_holders/${gmgnChain}/${tokenLower}` +
    `?orderby=realized_profit&direction=desc&limit=100`;

  console.log(`[gmgn-scraper] top-traders ${chain}:${tokenLower}`);
  const body = await fetchGmgnWithSession(pageUrl, apiUrl, `traders:${tokenLower.slice(0, 10)}`);
  if (!body) return [];

  const traders = parseGmgnList(body).sort((a, b) => b.realizedProfitUsd - a.realizedProfitUsd);
  console.log(`[gmgn-scraper] ${traders.length} traders, top PnL: $${traders[0]?.realizedProfitUsd?.toFixed(0)}`);

  if (traders.length > 0) serverCache.set(cacheKey, traders, CACHE_TTL.GMGN_TRADERS);
  return traders;
}

// ─── Top Holders (sorted by current balance) ─────────────────────────────────

export async function scrapeGmgnTopHolders(
  chain: string,
  tokenAddress: string
): Promise<GmgnTopTrader[]> {
  const cacheKey = `gmgn-top-holders:${chain}:${tokenAddress.toLowerCase()}`;
  const cached = serverCache.get<GmgnTopTrader[]>(cacheKey);
  if (cached) return cached;

  const gmgnChain = CHAIN_TO_GMGN[chain.toLowerCase()];
  if (!gmgnChain) return [];

  const tokenLower = tokenAddress.toLowerCase();
  const pageUrl = `https://gmgn.ai/${gmgnChain}/token/${tokenLower}`;
  const apiUrl =
    `https://gmgn.ai/vas/api/v1/token_holders/${gmgnChain}/${tokenLower}` +
    `?orderby=balance&direction=desc&limit=100`;

  console.log(`[gmgn-scraper] top-holders ${chain}:${tokenLower}`);
  const body = await fetchGmgnWithSession(pageUrl, apiUrl, `holders:${tokenLower.slice(0, 10)}`);
  if (!body) return [];

  const holders = parseGmgnList(body).sort((a, b) => b.balance - a.balance);
  console.log(`[gmgn-scraper] ${holders.length} holders, top balance: ${holders[0]?.balance?.toFixed(0)}`);

  if (holders.length > 0) serverCache.set(cacheKey, holders, CACHE_TTL.GMGN_TRADERS);
  return holders;
}
