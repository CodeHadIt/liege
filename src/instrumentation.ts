export async function register() {
  // Only run polling on the Node.js runtime — never Edge or browser. This guard
  // is critical: the StonkFun poller pulls in the Telegram bot, which
  // transitively imports playwright-core (via the GMGN scraper). Playwright can't
  // be bundled for the Edge runtime, so gating on NEXT_RUNTIME keeps that whole
  // module graph out of the Edge instrumentation bundle.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const POLL_INTERVAL = 30_000;
    const MC_REFRESH_INTERVAL = 120_000;

    // Dynamic import so this only loads server-side
    const { pollAndStoreDexProfiles, refreshCurrentMarketCaps } = await import("@/lib/api/dex-orders-cache");
    const { pollStonkFunCreations, pollStonkFunQuoteTokens } = await import("@/lib/telegram/stonkfun-alerts");
    const { pollSunriseStocks } = await import("@/lib/telegram/sunrise-alerts");
    const { pollLongStocks } = await import("@/lib/telegram/long-alerts");

    console.log("[instrumentation] Starting dex-profiles background poller (every 30s)");
    console.log("[instrumentation] Starting MC refresh poller (every 120s)");
    console.log("[instrumentation] Starting StonkFun new-token alert poller (every 30s)");
    console.log("[instrumentation] Starting StonkFun quote-token alert poller (every 60s)");

    const STONKFUN_INTERVAL = 30_000;
    // Seed silently on boot, then poll for new creations.
    pollStonkFunCreations().catch((err) =>
      console.error("[instrumentation] Initial StonkFun poll error:", err)
    );
    setInterval(() => {
      pollStonkFunCreations().catch((err) =>
        console.error("[instrumentation] StonkFun poll error:", err)
      );
    }, STONKFUN_INTERVAL);

    // New quote-token (pairing asset) poller — added less often, so 60s is plenty.
    const STONKFUN_QUOTE_INTERVAL = 60_000;
    pollStonkFunQuoteTokens().catch((err) =>
      console.error("[instrumentation] Initial StonkFun quote-token poll error:", err)
    );
    setInterval(() => {
      pollStonkFunQuoteTokens().catch((err) =>
        console.error("[instrumentation] StonkFun quote-token poll error:", err)
      );
    }, STONKFUN_QUOTE_INTERVAL);

    // Sunrise new-stock-pair poller (tokenized stocks vs USDC) — 60s.
    console.log("[instrumentation] Starting Sunrise stock-pair alert poller (every 60s)");
    const SUNRISE_INTERVAL = 60_000;
    pollSunriseStocks().catch((err) =>
      console.error("[instrumentation] Initial Sunrise poll error:", err)
    );
    setInterval(() => {
      pollSunriseStocks().catch((err) =>
        console.error("[instrumentation] Sunrise poll error:", err)
      );
    }, SUNRISE_INTERVAL);

    // Long / Robinhood Chain new-stock-token poller — 60s.
    console.log("[instrumentation] Starting Long (Robinhood Chain) stock alert poller (every 60s)");
    const LONG_INTERVAL = 60_000;
    pollLongStocks().catch((err) =>
      console.error("[instrumentation] Initial Long poll error:", err)
    );
    setInterval(() => {
      pollLongStocks().catch((err) =>
        console.error("[instrumentation] Long poll error:", err)
      );
    }, LONG_INTERVAL);

    // Initial poll on startup
    pollAndStoreDexProfiles().catch((err) =>
      console.error("[instrumentation] Initial poll error:", err)
    );

    // Then poll every 30s
    setInterval(() => {
      pollAndStoreDexProfiles().catch((err) =>
        console.error("[instrumentation] Poll error:", err)
      );
    }, POLL_INTERVAL);

    // Initial MC refresh after 10s delay (let first poll populate data)
    setTimeout(() => {
      refreshCurrentMarketCaps().catch((err) =>
        console.error("[instrumentation] Initial MC refresh error:", err)
      );
    }, 10_000);

    // Then refresh MCs every 2 minutes
    setInterval(() => {
      refreshCurrentMarketCaps().catch((err) =>
        console.error("[instrumentation] MC refresh error:", err)
      );
    }, MC_REFRESH_INTERVAL);
  }
}
