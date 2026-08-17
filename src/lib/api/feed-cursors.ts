import { supabase } from "@/lib/supabase";

// Durable position markers for polling feeds.
//
// Without one, a watcher's only memory of "where it got to" is a module-level
// variable, which a redeploy resets. The first pass after a restart then seeds
// from the live feed and stays silent, so every launch during the downtime is
// lost with no error and no warning. A cursor makes the gap recoverable.

/**
 * The newest record this feed has fully processed, or null if it has never run.
 *
 * Null and "failed to read" are deliberately NOT distinguished here — callers
 * treat null as "first run, seed silently", which is the safe response to both:
 * a transient DB error re-seeds rather than replaying a backlog twice.
 */
export async function getFeedCursor(feed: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("feed_cursors")
    .select("cursor_at")
    .eq("feed", feed)
    .maybeSingle();
  if (error) {
    console.error(`[cursor] failed to read ${feed}:`, error.message);
    return null;
  }
  return data?.cursor_at ?? null;
}

/**
 * Advance the cursor. Only ever moves forward: an out-of-order write (a late
 * page, a clock skew, two instances racing) must not rewind the feed and cause
 * a replay.
 */
export async function setFeedCursor(feed: string, cursorAt: string): Promise<void> {
  const current = await getFeedCursor(feed);
  if (current && Date.parse(current) >= Date.parse(cursorAt)) return;

  const { error } = await supabase
    .from("feed_cursors")
    .upsert({ feed, cursor_at: cursorAt, updated_at: new Date().toISOString() }, { onConflict: "feed" });
  if (error) console.error(`[cursor] failed to write ${feed}:`, error.message);
}
