import { chromium, type Browser } from "playwright-core";
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

  const systemChromium = process.env.CHROMIUM_EXECUTABLE_PATH;
  const isServerless = !systemChromium && (
    !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME)
  );

  const commonArgs = [
    "--disable-blink-features=AutomationControlled",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
  ];

  browserLaunchPromise = (async () => {
    if (systemChromium) {
      // Container environment — use system-installed Chromium (Railway, Docker, etc.)
      return chromium.launch({
        executablePath: systemChromium,
        headless: true,
        args: commonArgs,
      });
    }
    if (isServerless) {
      // Serverless (Vercel/Lambda) — use @sparticuz/chromium bundled binary
      const sparticuz = (await import("@sparticuz/chromium")).default;
      return chromium.launch({
        args: [...sparticuz.args, ...commonArgs],
        executablePath: await sparticuz.executablePath(),
        headless: true,
      });
    }
    // Local development
    return chromium.launch({
      headless: true,
      args: commonArgs,
    });
  })()
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
 * Navigate to the GMGN token page, capture the page's auto-fired token_holders
 * response (session signal), then optionally fire a second credentialed fetch
 * to `customApiUrl`.
 *
 * Returns { autoBody, customBody } where autoBody is from the page's natural
 * request (whatever GMGN fires by default) and customBody is from the custom
 * URL (null if no custom URL provided).
 */
async function fetchGmgnWithSession(
  pageUrl: string,
  customApiUrl: string | null,
  label: string
): Promise<{ autoBody: Record<string, unknown> | null; customBody: Record<string, unknown> | null }> {
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
  let autoBody: Record<string, unknown> | null = null;
  let customBody: Record<string, unknown> | null = null;

  try {
    // Capture the page's auto-fired token_holders response AND use it as session signal
    const sessionReady = page
      .waitForResponse(
        async (res) => {
          if (!res.url().includes("/vas/api/v1/token_holders/")) return false;
          try { autoBody = await res.json(); } catch { /* ignore */ }
          return true;
        },
        { timeout: 20_000 }
      )
      .catch(() => null);

    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const readyAt = Date.now();
    await sessionReady;
    const elapsed = Date.now() - readyAt;
    if (elapsed < 6_000) await new Promise((r) => setTimeout(r, 6_000 - elapsed));

    if (customApiUrl) {
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
          }, customApiUrl)
          .catch(() => ({ ok: false as const, status: 0, body: null }));

        if (result.ok && result.body) {
          customBody = result.body as Record<string, unknown>;
          console.log(`[gmgn-scraper] ${label} custom fetch OK on attempt ${attempt}`);
          break;
        }
        console.log(`[gmgn-scraper] ${label} attempt ${attempt} failed: status=${result.status}`);
      }
    }
  } catch (err) {
    console.log(`[gmgn-scraper] ${label} page error: ${err}`);
  } finally {
    await context.close();
  }

  return { autoBody, customBody };
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
  const customApiUrl =
    `https://gmgn.ai/vas/api/v1/token_holders/${gmgnChain}/${tokenLower}` +
    `?orderby=realized_profit&direction=desc&limit=100`;

  console.log(`[gmgn-scraper] top-traders ${chain}:${tokenLower}`);
  const { customBody } = await fetchGmgnWithSession(pageUrl, customApiUrl, `traders:${tokenLower.slice(0, 10)}`);
  if (!customBody) return [];

  const traders = parseGmgnList(customBody).sort((a, b) => b.realizedProfitUsd - a.realizedProfitUsd);
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

  // Fire the realized_profit custom fetch (known working) while also capturing
  // the page's auto-fired request (GMGN's default sort — often balance-based).
  // We'll use whichever returns more balance data.
  const customApiUrl =
    `https://gmgn.ai/vas/api/v1/token_holders/${gmgnChain}/${tokenLower}` +
    `?orderby=realized_profit&direction=desc&limit=100`;

  console.log(`[gmgn-scraper] top-holders ${chain}:${tokenLower}`);
  const { autoBody, customBody } = await fetchGmgnWithSession(
    pageUrl,
    customApiUrl,
    `holders:${tokenLower.slice(0, 10)}`
  );

  // Parse both responses, pick the one with more holders by balance
  const fromAuto = autoBody ? parseGmgnList(autoBody) : [];
  const fromCustom = customBody ? parseGmgnList(customBody) : [];

  // Merge and deduplicate — prefer whichever source has the higher balance per wallet
  const byAddress = new Map<string, GmgnTopTrader>();
  for (const t of [...fromCustom, ...fromAuto]) {
    const existing = byAddress.get(t.walletAddress);
    if (!existing || t.balance > existing.balance) byAddress.set(t.walletAddress, t);
  }

  const holders = [...byAddress.values()].sort((a, b) => b.balance - a.balance);
  console.log(`[gmgn-scraper] ${holders.length} holders (auto:${fromAuto.length} custom:${fromCustom.length}), top balance: ${holders[0]?.balance?.toFixed(0)}`);

  if (holders.length > 0) {
    serverCache.set(cacheKey, holders, CACHE_TTL.GMGN_TRADERS);
    // Also populate the traders cache so top-traders tab reuses this session
    const tradersCacheKey = `gmgn-top-traders:${chain}:${tokenLower}`;
    if (!serverCache.get(tradersCacheKey)) {
      const traders = [...byAddress.values()].sort((a, b) => b.realizedProfitUsd - a.realizedProfitUsd);
      serverCache.set(tradersCacheKey, traders, CACHE_TTL.GMGN_TRADERS);
    }
  }
  return holders;
}
