-- Durable "already announced" sets for catalog watchers.
--
-- A catalog watcher (new stock, new quote asset) alerts on anything not in its
-- seen-set, and seeds that set silently on its first pass so a redeploy does not
-- replay the whole catalog. Holding the set in memory makes the seed run again
-- on EVERY restart, which silently absorbs anything listed while the process was
-- down — no error, no gap warning, and the listing can never be announced later
-- because the watcher only ever alerts on the transition to "unseen".
--
-- It cost a real alert: HOODon (Ondo's tokenized Robinhood stock on Flap) was in
-- the catalog, on the right chain, rwa and available — it passed every filter and
-- was still never announced, because it appeared during one of twelve deploys
-- between 2026-08-17 and 2026-08-21. Worse, a swallowed listing never gets a
-- launch watch opened either, so launches against it go unreported too.
--
-- Persisting the set means a restart resumes instead of re-seeding.
--
-- This is deliberately separate from `feed_cursors`. A cursor answers "how far
-- through an ordered stream am I" and suits a feed with a timestamp or block
-- height. A catalog has no ordering — assets are added and occasionally removed
-- — so the question is membership, not position.

CREATE TABLE IF NOT EXISTS feed_seen (
  -- Which watcher, e.g. 'flap.rh.quotes'.
  feed          text NOT NULL,
  -- Stable identity of the thing announced: a contract address or mint,
  -- lowercased for EVM chains. NOT a symbol — symbols get reused.
  key           text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (feed, key)
);

-- Every read is "give me the whole set for this feed", so the primary key's
-- leading column already serves it; this index is for the cleanup path.
CREATE INDEX IF NOT EXISTS idx_feed_seen_age ON feed_seen(feed, first_seen_at);

ALTER TABLE feed_seen ENABLE ROW LEVEL SECURITY;
