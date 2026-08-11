-- Alpha deployers — devs who have shipped 2+ tokens that reached a $2M ATH.
--
-- A repeat deployer is a different signal to a repeat trader: the trader found
-- the winner, the deployer made it. Someone with two $2M runners behind them is
-- worth watching the moment they deploy anything new.

-- Market cap at launch, so a token's run can be measured as a multiple. Without
-- it "ATH $40M" says nothing about whether the deployer actually delivered — a
-- token that opened at $30M and peaked at $40M is not the same as one that
-- opened at $3k.
ALTER TABLE ath_tokens
  ADD COLUMN deploy_mc_usd numeric,
  -- ath_mc_usd / deploy_mc_usd, stored so success rates don't recompute on read.
  ADD COLUMN ath_multiple numeric;

ALTER TABLE token_deployers
  -- Convention: <CHAIN>_<coin1>_<coin2>_Dep  e.g. RH_sestri_frong_Dep
  ADD COLUMN label text UNIQUE,
  ADD COLUMN is_alpha boolean NOT NULL DEFAULT false,
  ADD COLUMN promoted_at timestamptz,
  -- How many of their ATH tokens went 20x or more from deploy.
  ADD COLUMN success_20x_count integer NOT NULL DEFAULT 0,
  ADD COLUMN tokens text[] NOT NULL DEFAULT '{}',
  -- Newest transaction already examined, so the watcher only inspects new ones.
  ADD COLUMN last_seen_tx text,
  ADD COLUMN last_checked_at timestamptz;

CREATE INDEX idx_token_deployers_alpha ON token_deployers(chain, is_alpha) WHERE is_alpha = true;

-- ── New launches by a tracked deployer ───────────────────────────────────────
-- One row per detected deployment, which is also what stops a launch being
-- announced twice across restarts.
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
  alerted_at       timestamptz,
  UNIQUE (chain, token_address)
);

CREATE INDEX idx_deployer_launches_deployer ON deployer_launches(deployer_id, detected_at DESC);

ALTER TABLE deployer_launches ENABLE ROW LEVEL SECURITY;
