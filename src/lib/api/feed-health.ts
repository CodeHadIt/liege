import { supabase } from "@/lib/supabase";

// Liveness state for every upstream the alert system depends on.
//
// The question this answers is "can production still reach this source?", which
// is deliberately NOT the same as "has this feed produced anything lately". The
// Robinhood registry can go a fortnight without a new stock and be perfectly
// healthy; StonkFun answered nothing for two days and was broken. Only the
// second is worth waking someone for, and only a fetch probe distinguishes them.

export interface HealthRow {
  source: string;
  label: string;
  chain: string | null;
  last_ok_at: string | null;
  last_fail_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  down_alerted: boolean;
}

/** Every row, keyed by source. Null when the store cannot be read. */
export async function loadHealth(): Promise<Map<string, HealthRow> | null> {
  const { data, error } = await supabase.from("feed_health").select("*");
  if (error) {
    console.error("[health] failed to load:", error.message);
    return null;
  }
  return new Map((data ?? []).map((r) => [String(r.source), r as HealthRow]));
}

/**
 * Record one probe outcome.
 *
 * A success clears the failure count so a flapping source does not creep toward
 * the alert threshold over days, and clears `down_alerted` so the next genuine
 * outage is reported rather than suppressed by a stale flag.
 */
export async function recordProbe(
  source: string,
  label: string,
  chain: string | null,
  ok: boolean,
  error: string | null,
  prior: HealthRow | undefined
): Promise<void> {
  const now = new Date().toISOString();
  const row = ok
    ? {
        source,
        label,
        chain,
        last_ok_at: now,
        last_fail_at: prior?.last_fail_at ?? null,
        last_error: prior?.last_error ?? null,
        consecutive_failures: 0,
        down_alerted: false,
        updated_at: now,
      }
    : {
        source,
        label,
        chain,
        last_ok_at: prior?.last_ok_at ?? null,
        last_fail_at: now,
        last_error: (error ?? "unknown").slice(0, 400),
        consecutive_failures: (prior?.consecutive_failures ?? 0) + 1,
        down_alerted: prior?.down_alerted ?? false,
        updated_at: now,
      };

  const { error: err } = await supabase.from("feed_health").upsert(row, { onConflict: "source" });
  if (err) console.error(`[health] failed to record ${source}:`, err.message);
}

/** Flip the "we have already said this is down" flag. */
export async function setDownAlerted(source: string, value: boolean): Promise<void> {
  const { error } = await supabase
    .from("feed_health")
    .update({ down_alerted: value, updated_at: new Date().toISOString() })
    .eq("source", source);
  if (error) console.error(`[health] failed to set down_alerted for ${source}:`, error.message);
}
