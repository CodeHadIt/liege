-- Alpha wallets — the confluence alert system.
--
-- "Alpha wallets" are addresses that were top-30 traders on multiple tokens that
-- hit a meaningful ATH market cap, with automated wallets filtered out. The
-- alert fires only on CONFLUENCE: two or more of them buying the same token
-- inside a short window.

-- ── The wallets themselves ───────────────────────────────────────────────────
CREATE TABLE alpha_wallets (
  id                 uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  -- Label follows the convention: <CHAIN>_<coin1>_<coin2>_<totalPnl>
  -- e.g. RH_cashcat_tendies_1.7M — the two tokens are the wallet's biggest
  -- winners, so the label alone tells you what this wallet is known for.
  label              text NOT NULL UNIQUE,
  address            text NOT NULL,
  chain              text NOT NULL,               -- 'rh' | 'bsc' | 'solana' …
  token_count        integer NOT NULL DEFAULT 0,  -- tokens it was a top trader on
  tokens             text[]  NOT NULL DEFAULT '{}',
  total_pnl_usd      numeric,
  total_invested_usd numeric,
  aggregate_roi_pct  numeric,
  best_rank          integer,
  -- Kept so the bot filter stays auditable after the fact, and so the threshold
  -- can be revisited without re-deriving the dataset.
  max_tx_on_a_token  integer,
  source             text,                        -- dataset that produced it
  notes              text,
  is_active          boolean NOT NULL DEFAULT true,
  added_at           timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain, address)
);

CREATE INDEX idx_alpha_wallets_chain_active ON alpha_wallets(chain, is_active);
CREATE INDEX idx_alpha_wallets_address ON alpha_wallets(address);

-- ── Individual buys we detected ──────────────────────────────────────────────
CREATE TABLE alpha_buys (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  wallet_id      uuid NOT NULL REFERENCES alpha_wallets(id) ON DELETE CASCADE,
  chain          text NOT NULL,
  token_address  text NOT NULL,
  token_symbol   text,
  token_name     text,
  tx_hash        text NOT NULL,
  block_number   bigint,
  bought_at      timestamptz NOT NULL DEFAULT now(),
  amount_usd     numeric,
  market_cap_usd numeric,
  supply_pct     numeric,
  liquidity_usd  numeric,
  -- One buy per (tx, wallet, token): a swap can emit several transfers of the
  -- same token to the same wallet, and those are one purchase, not several.
  UNIQUE (tx_hash, wallet_id, token_address)
);

CREATE INDEX idx_alpha_buys_token ON alpha_buys(chain, token_address, bought_at DESC);
CREATE INDEX idx_alpha_buys_wallet ON alpha_buys(wallet_id, bought_at DESC);

-- ── One row per token being watched for confluence ───────────────────────────
CREATE TABLE alpha_confluence (
  id                 uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  chain              text NOT NULL,
  token_address      text NOT NULL,
  token_symbol       text,
  token_name         text,
  first_buy_at       timestamptz NOT NULL,
  -- Confluence only counts inside a fixed window after the first alpha buy;
  -- past this we stop watching the token entirely.
  window_expires_at  timestamptz NOT NULL,
  wallet_count       integer NOT NULL DEFAULT 1,
  alerts_sent        integer NOT NULL DEFAULT 0,
  first_alert_mc_usd numeric,      -- baseline for the "up N x since first ping" line
  last_alert_at      timestamptz,
  is_closed          boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- A token can have separate confluence episodes; the window start makes each
  -- one its own row rather than reviving a stale watch.
  UNIQUE (chain, token_address, first_buy_at)
);

CREATE INDEX idx_alpha_confluence_open ON alpha_confluence(chain, is_closed, window_expires_at);
CREATE INDEX idx_alpha_confluence_token ON alpha_confluence(chain, token_address);

-- ── Row Level Security ───────────────────────────────────────────────────────
-- These tables are only ever touched server-side, through the service role key
-- (see src/lib/supabase.ts), and the service role bypasses RLS. So RLS is
-- enabled with NO policies: the server keeps full access, while anon and
-- authenticated clients get nothing.
--
-- This matters more here than for the app's other tables — the alpha wallet
-- list and its buy history are the edge this system exists to produce, and
-- PostgREST would otherwise expose them to anyone holding the public anon key.
ALTER TABLE alpha_wallets    ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_buys       ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_confluence ENABLE ROW LEVEL SECURITY;
