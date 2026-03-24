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
 * GMGN's token_holders endpoint fires on page load and contains full
 * historical PnL data (realized_profit, unrealized_profit, avg cost/sell,
 * etc.) — far more accurate than DexScreener's approximated token amounts.
 *
 * Returns traders sorted by realized_profit descending.
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
  console.log(`[gmgn-scraper] Navigating to ${pageUrl}`);

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

  page.on("response", async (res) => {
    const url = res.url();
    // Only capture the realized_profit-sorted holders call, not the default amount_percentage one
    if (!url.includes("/vas/api/v1/token_holders/")) return;
    if (url.includes("orderby=amount_percentage")) return;
    try {
      const body = await res.json().catch(() => null);
      if (body && !holdersBody) {
        holdersBody = body as Record<string, unknown>;
        console.log(`[gmgn-scraper] Intercepted token_holders (${JSON.stringify(body).length} bytes)`);
      }
    } catch {}
  });

  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // Wait for session cookies / fingerprint to be established
    await new Promise((r) => setTimeout(r, 8_000));

    // Fire the token_holders request sorted by realized_profit (includes fully exited wallets)
    // The default page call uses orderby=amount_percentage which misses wallets with balance=0
    const apiUrl =
      `https://gmgn.ai/vas/api/v1/token_holders/${gmgnChain}/${tokenAddress}` +
      `?orderby=realized_profit&direction=desc&limit=100`;

    const result = await page.evaluate(async (url: string) => {
      try {
        const r = await fetch(url, { credentials: "include" });
        return { ok: r.ok, status: r.status, body: await r.json() };
      } catch (e) {
        return { ok: false, status: 0, body: null, error: String(e) };
      }
    }, apiUrl);

    if (result.ok && result.body) {
      holdersBody = result.body as Record<string, unknown>;
      console.log(`[gmgn-scraper] Fetched token_holders (realized_profit order) → ${JSON.stringify(result.body).length} bytes`);
    } else {
      console.log(`[gmgn-scraper] Manual fetch failed: status=${result.status}`);
    }
  } catch (err) {
    console.log(`[gmgn-scraper] Page error: ${err}`);
  } finally {
    await context.close();
  }

  if (!holdersBody) {
    console.log(`[gmgn-scraper] No token_holders data captured`);
    return [];
  }

  // Parse: data.list is the array of holder objects
  const raw = holdersBody as {
    code?: number;
    data?: { list?: unknown[] };
  };
  const list = raw?.data?.list;
  if (!Array.isArray(list) || list.length === 0) {
    console.log(`[gmgn-scraper] Empty or malformed token_holders response`);
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
    // Sort by realized profit descending (GMGN may already sort but ensure it)
    .sort((a, b) => b.realizedProfitUsd - a.realizedProfitUsd);

  console.log(`[gmgn-scraper] Parsed ${traders.length} traders; top realized PnL: $${traders[0]?.realizedProfitUsd?.toFixed(2)}`);

  // ── Log full data structure ─────────────────────────────────────────────────
  console.log(`\n${"─".repeat(80)}`);
  console.log(`GMGN TOP TRADERS — ${chain}:${tokenAddress}`);
  console.log(`${"─".repeat(80)}`);
  console.log(`Total traders: ${traders.length}`);
  console.log(`\nFields in each GmgnTopTrader object:`);
  if (traders[0]) {
    for (const [key, val] of Object.entries(traders[0])) {
      console.log(`  ${key.padEnd(24)} ${typeof val} = ${JSON.stringify(val)}`);
    }
  }
  console.log(`\n${"─".repeat(80)}`);
  console.log(
    `  #   ${"Wallet".padEnd(44)} ${"RealizedPnL".padStart(14)} ${"UnrealizedPnL".padStart(14)} ${"BoughtUSD".padStart(11)} ${"SoldUSD".padStart(11)} ${"Balance".padStart(18)} ${"BalanceUSD".padStart(11)} ${"Trades".padStart(7)} Last Active`
  );
  console.log(`${"─".repeat(80)}`);
  for (let i = 0; i < traders.length; i++) {
    const t = traders[i];
    const lastActive = t.lastActiveTimestamp
      ? new Date(t.lastActiveTimestamp * 1000).toISOString().slice(0, 10)
      : "—";
    console.log(
      `  ${String(i + 1).padStart(2)}  ${t.walletAddress.padEnd(44)} ` +
      `$${t.realizedProfitUsd.toFixed(2).padStart(13)} ` +
      `$${t.unrealizedProfitUsd.toFixed(2).padStart(13)} ` +
      `$${t.historyBoughtCostUsd.toFixed(2).padStart(10)} ` +
      `$${t.historySoldIncomeUsd.toFixed(2).padStart(10)} ` +
      `${t.balance.toFixed(0).padStart(18)} ` +
      `$${t.balanceUsd.toFixed(2).padStart(10)} ` +
      `${(t.buyCount + t.sellCount).toString().padStart(7)}  ${lastActive}`
    );
  }
  console.log(`${"─".repeat(80)}\n`);

  if (traders.length > 0) {
    serverCache.set(cacheKey, traders, CACHE_TTL.TOP_TRADERS);
  }

  return traders;
}
