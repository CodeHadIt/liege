-- Tiering: per-audience confluence windows.
--
-- Gold and Platinum subscribers get SEPARATE evaluations of the confluence state
-- machine. Confluence fires on the Nth distinct alpha wallet to buy a token, and
-- the two tiers count different wallets — Gold counts only the frozen "library"
-- (wallets added on or before ALPHA_LIBRARY_CUTOFF), Platinum counts every
-- wallet. A single shared window could not represent both: Gold would be told
-- "wallet #3" having never been shown #1 and #2.
--
-- So a window belongs to an audience. The same token can legitimately have one
-- open window per audience, with different counts, ordinals and "since first
-- ping" baselines.

ALTER TABLE alpha_confluence
  ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'platinum';

-- Existing rows were produced by the pre-tier, all-wallets evaluation, which is
-- exactly what 'platinum' means — the DEFAULT above backfills them correctly.

-- Drop the OLD uniqueness key, whatever Postgres called it.
--
-- Looked up rather than named literally: the original was created inline by
-- `UNIQUE (chain, token_address, first_buy_at)`, so its name is auto-generated.
-- A literal `DROP CONSTRAINT IF EXISTS <guess>` would silently no-op if the
-- guess were wrong, leaving the old key in place to reject the second audience's
-- row for the same token and instant — the exact collision this migration
-- exists to prevent. Failing to find it must not be silent.
DO $$
DECLARE
  con_name text;
BEGIN
  SELECT c.conname INTO con_name
  FROM pg_constraint c
  WHERE c.conrelid = 'alpha_confluence'::regclass
    AND c.contype = 'u'
    AND (
      SELECT array_agg(a.attname::text ORDER BY a.attname)
      FROM unnest(c.conkey) k
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k
    ) = ARRAY['chain','first_buy_at','token_address']
  LIMIT 1;

  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE alpha_confluence DROP CONSTRAINT %I', con_name);
    RAISE NOTICE 'dropped old uniqueness key: %', con_name;
  ELSE
    RAISE NOTICE 'no (chain, token_address, first_buy_at) unique constraint found — already migrated?';
  END IF;
END $$;

-- A token may now hold one episode per audience at the same instant, so the
-- audience has to be part of what makes an episode unique.
ALTER TABLE alpha_confluence
  DROP CONSTRAINT IF EXISTS alpha_confluence_chain_audience_token_first_buy_key;

ALTER TABLE alpha_confluence
  ADD CONSTRAINT alpha_confluence_chain_audience_token_first_buy_key
  UNIQUE (chain, audience, token_address, first_buy_at);

-- Every hot-path lookup filters on audience alongside chain, so both indexes
-- lead with it to stay useful.
DROP INDEX IF EXISTS idx_alpha_confluence_open;
DROP INDEX IF EXISTS idx_alpha_confluence_token;

CREATE INDEX IF NOT EXISTS idx_alpha_confluence_open
  ON alpha_confluence(chain, audience, is_closed, window_expires_at);

CREATE INDEX IF NOT EXISTS idx_alpha_confluence_token
  ON alpha_confluence(chain, audience, token_address);
