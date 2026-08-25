import { supabase } from "@/lib/supabase";

// Durable "already announced" sets for catalog watchers.
//
// The in-memory version of this re-seeds on every restart, which silently
// absorbs anything listed while the process was down. Because a catalog watcher
// only ever alerts on the transition from unseen to seen, a swallowed listing
// can never be announced later — it is lost, not delayed.

/** Feed identifiers. Kept here so the set of watchers is visible in one place. */
export const FEED = {
  LONG_STOCKS: "long.rh.stocks",
  FLAP_RH_QUOTES: "flap.rh.quotes",
  BSC_QUOTES: "bsc.quotes",
  PUMPFUN_QUOTES: "pumpfun.quotes",
  SUNRISE_PAIRS: "sunrise.pairs",
  STONKFUN_QUOTES: "stonkfun.quotes",
  O1_BASE_STOCKS: "o1.base.stocks",
  O1_RH_STOCKS: "o1.rh.stocks",
  BASESTONK_STOCKS: "basestonk.base.stocks",
} as const;

export type Feed = (typeof FEED)[keyof typeof FEED];

/**
 * The keys this feed has already announced.
 *
 * Returns null on a read failure — deliberately distinct from an empty set. An
 * empty set means "this feed has never run, seed it silently"; null means "we do
 * not know", and a caller that confused the two would replay an entire catalog
 * into the channel after a transient database blip.
 */
export async function loadSeen(feed: Feed): Promise<Set<string> | null> {
  const out = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("feed_seen")
      .select("key")
      .eq("feed", feed)
      .range(from, from + PAGE - 1);
    if (error) {
      console.error(`[feed-seen] failed to load ${feed}:`, error.message);
      return null;
    }
    for (const r of data ?? []) out.add(String(r.key));
    if ((data?.length ?? 0) < PAGE) break;
  }
  return out;
}

/**
 * Record keys as announced. Idempotent — re-marking an existing key is a no-op
 * rather than an error, so a caller never has to diff before writing.
 */
export async function markSeen(feed: Feed, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const rows = [...new Set(keys)].map((key) => ({ feed, key }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase
      .from("feed_seen")
      .upsert(rows.slice(i, i + 500), { onConflict: "feed,key", ignoreDuplicates: true });
    if (error) console.error(`[feed-seen] failed to mark ${feed}:`, error.message);
  }
}

/**
 * Resolve a catalog watcher's seen-set for this pass.
 *
 * `firstRun` means this feed has NEVER been recorded — the only case where
 * seeding silently is correct. It is measured on the stored set alone, before
 * the in-memory union: a restarted process has a populated fallback and an empty
 * store only on a genuine first run, and conflating the two would re-seed and
 * reintroduce exactly the bug this replaces.
 *
 * `degraded` means the store could not be read — a missing table before the
 * migration runs, or a transient database error. The caller carries on using the
 * in-memory set, which is exactly the behaviour this replaces: no worse than
 * before, and it keeps alerting.
 *
 * Going silent instead was the first design and it was wrong. A watcher that
 * stops reporting because a table is missing turns a deployment-ordering problem
 * into missed listings — the very failure this whole change exists to fix.
 * Nothing is written while degraded, so the store stays authoritative and simply
 * resumes once it is reachable.
 */
export async function resolveSeen(
  feed: Feed,
  fallback: Set<string>
): Promise<{ seen: Set<string>; firstRun: boolean; degraded: boolean }> {
  const stored = await loadSeen(feed);
  if (stored === null) return { seen: fallback, firstRun: fallback.size === 0, degraded: true };

  const firstRun = stored.size === 0;
  // Union with what this process already knows, so a key marked earlier in the
  // same run is never re-announced if its write has not landed yet.
  for (const k of fallback) stored.add(k);
  return { seen: stored, firstRun, degraded: false };
}
