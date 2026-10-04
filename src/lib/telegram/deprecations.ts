// ── Deprecated features ───────────────────────────────────────────────────────
// Switched off as a product, kept as code.
//
// The stock-pair launch feeds (§3–§8 of the alert doc) — StonkFun, Sunrise, Long,
// Flap, Pons, pools.fun, Four.meme, o1, basestonk, Pump.fun and the HOOD watch —
// were retired on 2026-10-05 at the owner's request. Every watcher, formatter,
// cursor, seen-set and verification script stays exactly where it is; nothing
// reaches a chat and nothing polls an upstream.
//
// Deleting them would have been the wrong move twice over: the launch-window
// machinery is what every future platform watcher is built from, and the
// accumulated knowledge of each platform's quirks (which API is dead, which
// catalog is geo-blocked, which router lies about its launches) lives in those
// files and in §3–§8. That is worth more than the lines it costs to keep.
//
// Resurrection is one environment variable, no code change:
//
//     ALERTS_STOCK_FEEDS=on
//
// Read §15 of the alert doc before doing that. The launch watchers resume from
// durable cursors, so a feed that has been dark for weeks will have a backlog to
// work through on its first pass.

/**
 * Are the stock-pair feeds live?
 *
 * Deprecated by default. The switch is read at call time rather than captured at
 * import, so flipping the variable and restarting is all it takes — and a stale
 * module-level copy can never disagree with the environment.
 */
export function stockFeedsEnabled(): boolean {
  return (process.env.ALERTS_STOCK_FEEDS ?? "").trim().toLowerCase() === "on";
}

/**
 * Guard for the top of a deprecated poller.
 *
 * Returns true when the caller should stop. It logs once per process per feed —
 * enough to make the state visible in a boot log, not enough to fill one at a
 * 30-second cadence.
 */
const announced = new Set<string>();

export function stockFeedDeprecated(feed: string): boolean {
  if (stockFeedsEnabled()) return false;
  if (!announced.has(feed)) {
    announced.add(feed);
    console.log(`[deprecated] ${feed} is retired — set ALERTS_STOCK_FEEDS=on to restore it`);
  }
  return true;
}
