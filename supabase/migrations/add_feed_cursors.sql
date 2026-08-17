-- Durable per-feed cursors.
--
-- Launch watchers used to hold their position in memory only. On every restart
-- the first pass re-seeded from the live feed and returned WITHOUT alerting, so
-- anything launched while the process was down was absorbed into the seed set
-- and never reported. That cost was paid on each redeploy, not merely during
-- rare outages, and it was silent — no error, no gap warning, nothing to notice.
--
-- A cursor survives the restart, so the watcher can ask the source for
-- everything since its last confirmed position and report the backlog instead of
-- swallowing it.

CREATE TABLE IF NOT EXISTS feed_cursors (
  feed       text PRIMARY KEY,
  -- Timestamp of the newest record this feed has fully processed. Deliberately
  -- a timestamp rather than an id: the upstream `since` filter is time-based,
  -- and ids are not ordered across paginated reads.
  cursor_at  timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE feed_cursors ENABLE ROW LEVEL SECURITY;
