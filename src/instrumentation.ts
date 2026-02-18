export async function register() {
  // Only run polling on the server (Node.js runtime), not in Edge or browser
  if (typeof globalThis.setInterval !== "undefined" && typeof window === "undefined") {
    const POLL_INTERVAL = 30_000;
    const MC_REFRESH_INTERVAL = 120_000;

    // Dynamic import so this only loads server-side
    const { pollAndStoreDexProfiles, refreshCurrentMarketCaps } = await import("@/lib/api/dex-orders-cache");

    console.log("[instrumentation] Starting dex-profiles background poller (every 30s)");
    console.log("[instrumentation] Starting MC refresh poller (every 120s)");

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
