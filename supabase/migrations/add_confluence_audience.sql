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

ALTER TABLE alpha_confluence
  DROP CONSTRAINT IF EXISTS alpha_confluence_chain_token_address_first_buy_at_key;

-- A token may now hold one episode per audience at the same instant, so the
-- audience has to be part of what makes an episode unique.
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
