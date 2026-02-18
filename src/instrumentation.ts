export async function register() {
  // Only run polling on the server (Node.js runtime), not in Edge or browser
  if (typeof globalThis.setInterval !== "undefined" && typeof window === "undefined") {
    const POLL_INTERVAL = 30_000;

    // Dynamic import so this only loads server-side
    const { pollAndStoreDexProfiles } = await import("@/lib/api/dex-orders-cache");

    console.log("[instrumentation] Starting dex-profiles background poller (every 30s)");

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
  }
}
