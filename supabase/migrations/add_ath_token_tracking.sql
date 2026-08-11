-- Daily ATH token tracking — the pipeline that feeds the alpha wallet list.
--
-- Every day we scan Robinhood Chain for tokens that reached a $2M ATH market
-- cap, record them and their top 30 traders, then cross-reference those traders
-- against every previous ATH token. A wallet that shows up as a top trader on
-- two or more of them has repeated across independent winners, which is the
-- definition of an alpha wallet here — so it gets promoted automatically.
--
-- These tables are the memory that makes that cross-reference possible: without
-- storing the traders of past runners there is nothing to compare against.

-- ── Tokens that reached the ATH threshold ────────────────────────────────────
CREATE TABLE ath_tokens (
  id                    uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  chain                 text NOT NULL,
  token_address         text NOT NULL,
  name                  text,
  symbol                text,
  -- pons | flap | pools.trade | noxa | long | uniswap-bonding-curve | …
  launchpad             text,
  deployer_address      text,
  ath_mc_usd            numeric,
  ath_at                timestamptz,
  current_mc_usd        numeric,
  current_mc_updated_at timestamptz,
  holders               integer,
  total_supply          numeric,
  pool_address          text,
  launched_at           timestamptz,
  -- Which run picked it up: the historical backfill or a given daily scan.
  source                text,
  -- Set once the token's top traders have been captured, so a scan interrupted
  -- midway can be resumed without leaving a token half-recorded.
  traders_captured_at   timestamptz,
  added_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain, token_address)
);

CREATE INDEX idx_ath_tokens_ath_at ON ath_tokens(chain, ath_at DESC);
CREATE INDEX idx_ath_tokens_added ON ath_tokens(chain, added_at DESC);
CREATE INDEX idx_ath_tokens_deployer ON ath_tokens(chain, deployer_address);

-- ── Deployers behind those tokens ────────────────────────────────────────────
-- Tracked separately because a deployer with several $2M runners is its own
-- signal, independent of who traded them.
CREATE TABLE token_deployers (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  chain          text NOT NULL,
  address        text NOT NULL,
  -- How many ATH tokens we've seen from this deployer.
  token_count    integer NOT NULL DEFAULT 1,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  notes          text,
  UNIQUE (chain, address)
);

CREATE INDEX idx_token_deployers_count ON token_deployers(chain, token_count DESC);

-- ── Top traders per ATH token ────────────────────────────────────────────────
-- This is the corpus the daily cross-reference runs against.
CREATE TABLE ath_token_traders (
  id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  token_id            uuid NOT NULL REFERENCES ath_tokens(id) ON DELETE CASCADE,
  chain               text NOT NULL,
  -- Denormalised so the cross-reference can group by wallet without a join.
  token_address       text NOT NULL,
  token_symbol        text,
  wallet_address      text NOT NULL,
  rank                integer,

  amount_invested_usd numeric,
  avg_entry_price_usd numeric,
  entry_mc_usd        numeric,
  amount_sold_usd     numeric,
  avg_exit_price_usd  numeric,
  exit_mc_usd         numeric,

  realized_pnl_usd    numeric,
  unrealized_pnl_usd  numeric,
  total_pnl_usd       numeric,
  roi_pct             numeric,

  buy_count           integer,
  sell_count          integer,
  tx_count            integer,
  current_balance     numeric,
  current_balance_usd numeric,
  supply_pct          numeric,
  first_buy_at        timestamptz,
  last_active_at      timestamptz,

  -- Bots are stored rather than dropped: excluding them from promotion is a
  -- judgement call, and keeping the evidence lets the threshold be revisited
  -- without re-scraping every token.
  is_bot              boolean NOT NULL DEFAULT false,
  bot_reason          text,

  captured_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (token_address, wallet_address)
);

CREATE INDEX idx_ath_traders_wallet ON ath_token_traders(chain, wallet_address) WHERE is_bot = false;
CREATE INDEX idx_ath_traders_token ON ath_token_traders(token_id);

-- ── Daily scan bookkeeping ───────────────────────────────────────────────────
-- One row per run, so a restart can tell whether today's scan already happened
-- and the summary ping isn't sent twice.
CREATE TABLE ath_scan_runs (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  chain             text NOT NULL,
  -- UTC date of the run, the natural idempotency key for a daily job.
  run_date          date NOT NULL,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  candidates_scanned integer,
  tokens_found      integer,
  traders_captured  integer,
  alpha_added       integer,
  error             text,
  UNIQUE (chain, run_date)
);

ALTER TABLE ath_tokens        ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_deployers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ath_token_traders ENABLE ROW LEVEL SECURITY;
ALTER TABLE ath_scan_runs     ENABLE ROW LEVEL SECURITY;
