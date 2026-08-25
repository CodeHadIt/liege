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
    const { pollStonkFunQuoteTokens, pollStonkFunLaunches } = await import("@/lib/telegram/stonkfun-alerts");
    const { pollSunriseStocks } = await import("@/lib/telegram/sunrise-alerts");
    const { pollLongStocks, pollLongOnchainCreations, pollFlapRobinhoodStocks } = await import("@/lib/telegram/long-alerts");
    const { pollBscStockQuotes, pollBscOnchainLaunches } = await import("@/lib/telegram/bsc-stock-alerts");
    const { pollPumpFunQuoteMints, pollPumpFunLaunches } = await import("@/lib/telegram/pumpfun-alerts");
    const { pollPoolsFunQuoteAssets, pollPoolsFunLaunches } = await import("@/lib/telegram/poolsfun-alerts");
    const { pollAlphaConfluence } = await import("@/lib/telegram/alpha-watcher");
    const { maybeRunDailyScan, maybeRefreshMarketCaps } = await import("@/lib/telegram/ath-daily-scan");
    const { pollDeployerLaunches } = await import("@/lib/telegram/deployer-alerts");
    const { pollSolanaAlphaWallets } = await import("@/lib/telegram/solana-alpha-alerts");
    const { pollO1Quotes, pollO1Launches } = await import("@/lib/telegram/o1-alerts");
    const { pollBasestonk } = await import("@/lib/telegram/basestonk-alerts");

    // Tier configuration, reported once at boot.
    //
    // Every tier rule is env-driven, so a missing variable does not fail — it
    // quietly changes who receives what. Gold confluence was dark in production
    // for a day because ALERTS_GOLD_IDS / ALPHA_LIBRARY_CUTOFF were incomplete
    // there and nothing said so. This makes the resolved configuration the first
    // thing in the log.
    const { subscriberTiers, recipientsFor, FEATURE } = await import("@/lib/telegram/alerts-bot");
    {
      const tiers = subscriberTiers();
      const counts: Record<string, number> = {};
      for (const t of tiers.values()) counts[t] = (counts[t] ?? 0) + 1;
      const goldIds = recipientsFor(FEATURE.ALPHA_CONFLUENCE_GOLD).length;
      const raw = process.env.ALPHA_LIBRARY_CUTOFF;
      const cutoffOk = !!raw && Number.isFinite(Date.parse(raw));

      console.log(
        `[instrumentation] alert tiers: ${tiers.size} recipient(s) — ` +
          `platinum=${counts.platinum ?? 0} gold=${counts.gold ?? 0}` +
          (process.env.ALERTS_PLATINUM_IDS || process.env.ALERTS_GOLD_IDS
            ? ""
            : " (LEGACY MODE: no tier vars set, everyone treated as platinum)")
      );
      console.log(
        `[instrumentation] ALPHA_LIBRARY_CUTOFF=${raw ?? "(unset)"}${cutoffOk ? "" : " ← INVALID/UNSET"}`
      );
      if (goldIds > 0 && !cutoffOk) {
        console.error(
          "[instrumentation] ⚠ gold subscribers exist but ALPHA_LIBRARY_CUTOFF is unset/invalid — " +
            "GOLD CONFLUENCE IS DISABLED. Set it to enable gold alpha alerts."
        );
      } else if (goldIds === 0 && (counts.gold ?? 0) > 0) {
        console.error("[instrumentation] ⚠ gold tier has members but no gold features resolve — check FEATURE_TIERS");
      } else {
        console.log(
          `[instrumentation] gold confluence: ${goldIds > 0 ? "ENABLED" : "no gold recipients"}`
        );
      }
    }

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

    // Launches against a watched or pinned StonkFun quote. One read of
    // StonkFun's own launches feed serves both, and the feed names the quote
    // mint per launch — so there is no pair to infer and no retry queue.
    console.log("[instrumentation] Starting StonkFun launch watcher (every 30s)");
    const STONKFUN_LAUNCH_INTERVAL = 30_000;
    pollStonkFunLaunches().catch((err) =>
      console.error("[instrumentation] Initial StonkFun launch poll error:", err)
    );
    setInterval(() => {
      pollStonkFunLaunches().catch((err) =>
        console.error("[instrumentation] StonkFun launch poll error:", err)
      );
    }, STONKFUN_LAUNCH_INTERVAL);

    // NOTE: the StonkFun Airdrop Mode watcher (pollStonkFunAirdropLaunches) is
    // CLOSED and deliberately NOT scheduled. It was a 24h watch, the window is
    // over, and it sends nothing.
    //
    // Unscheduled here rather than left to its own expiry check: at the moment
    // it was closed the deadline had not yet passed, so relying on the timestamp
    // would have kept it pinging. Not scheduling it is the only state that
    // cannot ping.
    //
    // The code is retained and working — see stonkfun-airdrop-alerts.ts. To
    // reopen: schedule pollStonkFunAirdropLaunches on a 30s interval and set
    // STONKFUN_AIRDROP_WATCH_UNTIL to a future ISO timestamp, since its internal
    // guard will otherwise refuse to alert past the old deadline. Nothing else
    // needs changing.

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

    // Pump.fun quote assets. The catalog is a single getAccountInfo against the
    // pump program's Global account, so this is one cheap RPC call per pass and
    // an addition is seen as soon as the chain accepts it.
    console.log("[instrumentation] Starting Pump.fun quote-asset poller (every 60s)");
    const PUMPFUN_QUOTE_INTERVAL = 60_000;
    pollPumpFunQuoteMints().catch((err) =>
      console.error("[instrumentation] Initial Pump.fun quote poll error:", err)
    );
    setInterval(() => {
      pollPumpFunQuoteMints().catch((err) =>
        console.error("[instrumentation] Pump.fun quote poll error:", err)
      );
    }, PUMPFUN_QUOTE_INTERVAL);

    // Launches against a newly-added Pump.fun quote, detected on-chain: one
    // memcmp query against BondingCurve.quote_mint returns every coin launched
    // against a watched quote. This replaced a scan of pump.fun's HTTP creation
    // feed, which sits behind a WAF that blocked us outright after a burst of
    // requests. With no window open the pass makes no request at all.
    console.log("[instrumentation] Starting Pump.fun launch-window watcher (every 60s)");
    const PUMPFUN_LAUNCH_INTERVAL = 60_000;
    pollPumpFunLaunches().catch((err) =>
      console.error("[instrumentation] Initial Pump.fun launch poll error:", err)
    );
    setInterval(() => {
      pollPumpFunLaunches().catch((err) =>
        console.error("[instrumentation] Pump.fun launch poll error:", err)
      );
    }, PUMPFUN_LAUNCH_INTERVAL);

    // pools.fun — SushiSwap's launchpad on Robinhood Chain (NOT pools.trade).
    // Both halves read the verified PartyFactory's own events, so a listing and
    // a launch are each one getLogs. New pairing assets are rare (the factory
    // shipped with WETH and USDG and has added none since), so 60s is ample.
    console.log("[instrumentation] Starting pools.fun quote-asset poller (every 60s)");
    const POOLSFUN_QUOTE_INTERVAL = 60_000;
    pollPoolsFunQuoteAssets().catch((err) =>
      console.error("[instrumentation] Initial pools.fun quote poll error:", err)
    );
    setInterval(() => {
      pollPoolsFunQuoteAssets().catch((err) =>
        console.error("[instrumentation] pools.fun quote poll error:", err)
      );
    }, POOLSFUN_QUOTE_INTERVAL);

    // Launches against a newly-added pools.fun quote. TokenLaunched carries the
    // paired asset with the token, so a launch is caught in the block it happens
    // — no pool to wait on. Runs tighter than the catalog poll, and makes no
    // request at all while nothing is being watched.
    console.log("[instrumentation] Starting pools.fun launch watcher (every 30s)");
    const POOLSFUN_LAUNCH_INTERVAL = 30_000;
    pollPoolsFunLaunches().catch((err) =>
      console.error("[instrumentation] Initial pools.fun launch poll error:", err)
    );
    setInterval(() => {
      pollPoolsFunLaunches().catch((err) =>
        console.error("[instrumentation] pools.fun launch poll error:", err)
      );
    }, POOLSFUN_LAUNCH_INTERVAL);

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

    // o1 Launchpad, on both chains it runs. Catalog and launches come from o1's
    // public API (needs O1_API_KEY); `selectable` is o1's own flag for a
    // pairable stock. One code path, two chain ids.
    //
    // Robinhood already has all 194 of its stocks selectable, so it seeds once
    // and then stays quiet until o1 adds a 195th — that silence is correct, not
    // a fault. Base has 4 of 13 live, so its nine dormant stocks are the ones
    // most likely to fire first.
    for (const chainKey of ["base", "rh"] as const) {
      console.log(`[instrumentation] Starting o1 ${chainKey} stock-pair poller (every 120s)`);
      pollO1Quotes(chainKey).catch((err: unknown) =>
        console.error(`[instrumentation] Initial o1 ${chainKey} quote poll error:`, err)
      );
      setInterval(() => {
        pollO1Quotes(chainKey).catch((err: unknown) =>
          console.error(`[instrumentation] o1 ${chainKey} quote poll error:`, err)
        );
      }, 120_000);

      console.log(`[instrumentation] Starting o1 ${chainKey} launch watcher (every 30s)`);
      pollO1Launches(chainKey).catch((err: unknown) =>
        console.error(`[instrumentation] Initial o1 ${chainKey} launch poll error:`, err)
      );
      setInterval(() => {
        pollO1Launches(chainKey).catch((err: unknown) =>
          console.error(`[instrumentation] o1 ${chainKey} launch poll error:`, err)
        );
      }, 30_000);
    }

    // basestonk on Base. One poller, not two: basestonk publishes no catalog of
    // pairable assets, so its stock pairs are derived from the launch feed
    // itself and both stages must read the same list in one pass.
    //
    // The consequence is that a new stock pair is announced on its first launch
    // rather than at registration — the pair alert and the inaugural launch
    // alert fire together. Launch volume runs ~25/day, so 30s is comfortably
    // faster than arrivals.
    console.log("[instrumentation] Starting basestonk stock-pair + launch watcher (every 30s)");
    pollBasestonk().catch((err: unknown) =>
      console.error("[instrumentation] Initial basestonk poll error:", err)
    );
    setInterval(() => {
      pollBasestonk().catch((err: unknown) =>
        console.error("[instrumentation] basestonk poll error:", err)
      );
    }, 30_000);

    // Solana alpha wallets — hand-picked wallets watched for deploys and buys.
    // One Helius request per wallet per pass, so cost tracks the watchlist
    // rather than chain activity, and it short-circuits when nothing is watched.
    console.log("[instrumentation] Starting Solana alpha wallet watcher (every 30s)");
    const SOLANA_ALPHA_INTERVAL = 30_000;
    pollSolanaAlphaWallets().catch((err) =>
      console.error("[instrumentation] Initial Solana alpha poll error:", err)
    );
    setInterval(() => {
      pollSolanaAlphaWallets().catch((err) =>
        console.error("[instrumentation] Solana alpha poll error:", err)
      );
    }, SOLANA_ALPHA_INTERVAL);

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
