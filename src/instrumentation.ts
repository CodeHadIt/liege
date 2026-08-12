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
    const { pollStonkFunQuoteTokens, pollStonkFunFirstTokens } = await import("@/lib/telegram/stonkfun-alerts");
    const { pollSunriseStocks } = await import("@/lib/telegram/sunrise-alerts");
    const { pollLongStocks, pollLongOnchainCreations, pollFlapRobinhoodStocks } = await import("@/lib/telegram/long-alerts");
    const { pollBscStockQuotes, pollBscOnchainLaunches } = await import("@/lib/telegram/bsc-stock-alerts");
    const { pollAlphaConfluence } = await import("@/lib/telegram/alpha-watcher");
    const { maybeRunDailyScan, maybeRefreshMarketCaps } = await import("@/lib/telegram/ath-daily-scan");
    const { pollDeployerLaunches } = await import("@/lib/telegram/deployer-alerts");

    console.log("[instrumentation] Starting dex-profiles background poller (every 30s)");
    console.log("[instrumentation] Starting MC refresh poller (every 120s)");
    // NOTE: the every-launch StonkFun feed (pollStonkFunCreations) is PAUSED —
    // it pinged on every mint, which drowned out the signal. StonkFun now follows
    // the same shape as the Robinhood Chain and BNB Chain watchers: alert when a
    // pairing asset is added, then alert the first token launched against it.
    // Re-schedule pollStonkFunCreations here to bring the old feed back.
    console.log("[instrumentation] Starting StonkFun quote-token alert poller (every 60s)");

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

    // First token launched against a newly-added StonkFun quote. Runs tighter
    // than the catalog poll so a launch is caught while it's still news, and
    // short-circuits entirely while no quote is being watched.
    console.log("[instrumentation] Starting StonkFun first-token watcher (every 30s)");
    const STONKFUN_FIRST_TOKEN_INTERVAL = 30_000;
    pollStonkFunFirstTokens().catch((err) =>
      console.error("[instrumentation] Initial StonkFun first-token poll error:", err)
    );
    setInterval(() => {
      pollStonkFunFirstTokens().catch((err) =>
        console.error("[instrumentation] StonkFun first-token poll error:", err)
      );
    }, STONKFUN_FIRST_TOKEN_INTERVAL);

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

    // Long / Robinhood Chain: new stocks are added rarely, so poll the asset
    // registry every 60s...
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

    // ...but run the on-chain first-token watcher tighter (30s) so a launch
    // against a newly-added stock is caught fast. Blockscout getLogs is free,
    // so a faster cadence adds no cost.
    console.log("[instrumentation] Starting Long on-chain first-token watcher (every 30s)");
    const LONG_ONCHAIN_INTERVAL = 30_000;
    pollLongOnchainCreations().catch((err) =>
      console.error("[instrumentation] Initial Long on-chain poll error:", err)
    );
    setInterval(() => {
      pollLongOnchainCreations().catch((err) =>
        console.error("[instrumentation] Long on-chain poll error:", err)
      );
    }, LONG_ONCHAIN_INTERVAL);

    // Flap also launches on Robinhood Chain against its own stock catalog, which
    // isn't a subset of Robinhood's registry — poll it alongside the registry.
    console.log("[instrumentation] Starting Flap (Robinhood Chain) stock quote poller (every 120s)");
    const FLAP_RH_INTERVAL = 120_000;
    pollFlapRobinhoodStocks().catch((err) =>
      console.error("[instrumentation] Initial Flap RH poll error:", err)
    );
    setInterval(() => {
      pollFlapRobinhoodStocks().catch((err) =>
        console.error("[instrumentation] Flap RH poll error:", err)
      );
    }, FLAP_RH_INTERVAL);

    // BNB Chain tokenized-stock quotes (Four.meme + Flap). New quote assets are
    // listed on the order of days and both sources are scraped pages rather than
    // APIs, so 120s is ample and keeps us light on their origins.
    console.log("[instrumentation] Starting BSC stock-quote alert poller (every 120s)");
    const BSC_QUOTE_INTERVAL = 120_000;
    pollBscStockQuotes().catch((err) =>
      console.error("[instrumentation] Initial BSC stock-quote poll error:", err)
    );
    setInterval(() => {
      pollBscStockQuotes().catch((err) =>
        console.error("[instrumentation] BSC stock-quote poll error:", err)
      );
    }, BSC_QUOTE_INTERVAL);

    // ...but once a stock IS live, watch the chain itself for the first launch
    // against it. This reads Flap's and Four.meme's bonding-curve creation
    // events, so a launch is caught as the curve is deployed — not whenever an
    // indexer gets round to the pool. Public BSC RPCs are free, and the scan
    // short-circuits entirely while nothing is being watched.
    console.log("[instrumentation] Starting BSC on-chain launch watcher (every 20s)");
    const BSC_LAUNCH_INTERVAL = 20_000;
    pollBscOnchainLaunches().catch((err) =>
      console.error("[instrumentation] Initial BSC launch poll error:", err)
    );
    setInterval(() => {
      pollBscOnchainLaunches().catch((err) =>
        console.error("[instrumentation] BSC launch poll error:", err)
      );
    }, BSC_LAUNCH_INTERVAL);

    // Alpha wallet confluence on Robinhood Chain. A poll is one block number
    // plus one getLogs covering EVERY alpha wallet (OR-filtered on the Transfer
    // recipient), so the cost does not grow with the size of the watchlist —
    // which is what lets this run at 30s.
    console.log("[instrumentation] Starting alpha-wallet confluence watcher (every 30s)");
    const ALPHA_INTERVAL = 30_000;
    pollAlphaConfluence().catch((err) =>
      console.error("[instrumentation] Initial alpha confluence poll error:", err)
    );
    setInterval(() => {
      pollAlphaConfluence().catch((err) =>
        console.error("[instrumentation] Alpha confluence poll error:", err)
      );
    }, ALPHA_INTERVAL);

    // Daily ATH scan at 23:00 UTC. Checked every minute rather than scheduled
    // with a single long timer: a timer set once drifts over days and a redeploy
    // at the wrong moment would skip the day entirely. The run is claimed by UTC
    // date in the database, so repeated checks — and multiple instances — still
    // produce exactly one run.
    console.log("[instrumentation] Starting daily ATH scan scheduler (23:00 UTC)");
    console.log("[instrumentation] Starting weekly market-cap refresh (Sun 23:00 UTC)");
    setInterval(() => {
      maybeRunDailyScan().catch((err) =>
        console.error("[instrumentation] Daily ATH scan error:", err)
      );
      // Shares the same minute tick — both are clock-checked rather than timed,
      // so neither drifts and a redeploy can't skip the slot.
      maybeRefreshMarketCaps().catch((err) =>
        console.error("[instrumentation] Weekly MC refresh error:", err)
      );
    }, 60_000);

    // Alpha deployers — devs with 2+ $2M runners, watched for their next launch.
    // One request per deployer per pass and the list is small, so 2 minutes is
    // frequent enough to catch a deploy while it still matters.
    console.log("[instrumentation] Starting alpha deployer launch watcher (every 120s)");
    const DEPLOYER_INTERVAL = 120_000;
    pollDeployerLaunches().catch((err) =>
      console.error("[instrumentation] Initial deployer poll error:", err)
    );
    setInterval(() => {
      pollDeployerLaunches().catch((err) =>
        console.error("[instrumentation] Deployer poll error:", err)
      );
    }, DEPLOYER_INTERVAL);

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
