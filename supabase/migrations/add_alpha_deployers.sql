-- Alpha deployers — devs who have shipped 2+ tokens that reached a $2M ATH.
--
-- A repeat deployer is a different signal to a repeat trader: the trader found
-- the winner, the deployer made it. Someone with two $2M runners behind them is
-- worth watching the moment they deploy anything new.

-- Launch market cap is treated as a constant $5k — the bonding-curve start on
-- this chain — rather than derived per token. Deriving it was unreliable: the
-- figure came from a pool's first candle, and for any token that migrated off
-- its curve the deepest pool opens long after launch (CASHCAT read as launching
-- at $117M). A fixed base makes "20x" mean exactly $100k ATH for every token.

-- Two counts live on this table and they must never be confused:
--
--   ath_token_count  — deploys that reached the $2M ATH bar (the runners)
--   total_deploys    — every token this dev has ever shipped (the denominator)
--
-- The original column was called token_count, which reads like the second but
-- holds the first. Renamed so the distinction is visible at the schema level.
ALTER TABLE token_deployers RENAME COLUMN token_count TO ath_token_count;

ALTER TABLE token_deployers
  -- Convention: <CHAIN>_<coin1>_<coin2>_Dep  e.g. RH_sestri_frong_Dep
  ADD COLUMN label text UNIQUE,
  ADD COLUMN is_alpha boolean NOT NULL DEFAULT false,
  ADD COLUMN promoted_at timestamptz,
  -- Deploys that reached $100k ATH (20x from the $5k base).
  ADD COLUMN success_20x_count integer NOT NULL DEFAULT 0,
  -- Every token this dev has deployed, successful or not — the denominator.
  ADD COLUMN total_deploys integer NOT NULL DEFAULT 0,
  -- Symbols of the $2M runners only, matching ath_token_count.
  ADD COLUMN ath_token_symbols text[] NOT NULL DEFAULT '{}',
  -- Newest transaction already examined, so the watcher only inspects new ones.
  ADD COLUMN last_seen_tx text,
  ADD COLUMN last_checked_at timestamptz;

CREATE INDEX idx_token_deployers_alpha ON token_deployers(chain, is_alpha) WHERE is_alpha = true;

-- ── Every token deployed by a tracked dev ────────────────────────────────────
-- Both the historical record and the live feed. This is the denominator for the
-- success rate: measuring hits against ath_tokens alone would be meaningless,
-- since a token only enters that table by clearing $2M and would therefore
-- always count as a success. A dev's rate only means something against
-- everything they shipped, including the failures.
CREATE TABLE deployer_launches (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  deployer_id      uuid NOT NULL REFERENCES token_deployers(id) ON DELETE CASCADE,
  chain            text NOT NULL,
  deployer_address text NOT NULL,
  token_address    text NOT NULL,
  token_name       text,
  token_symbol     text,
  tx_hash          text,
  detected_at      timestamptz NOT NULL DEFAULT now(),
  launched_at      timestamptz,
  mc_at_alert_usd  numeric,
  ath_mc_usd       numeric,
  -- ath_mc_usd >= 100k, stored so the rate is a count rather than a scan.
  is_success       boolean NOT NULL DEFAULT false,
  alerted_at       timestamptz,
  UNIQUE (chain, token_address)
);

CREATE INDEX idx_deployer_launches_deployer ON deployer_launches(deployer_id, detected_at DESC);

ALTER TABLE deployer_launches ENABLE ROW LEVEL SECURITY;
