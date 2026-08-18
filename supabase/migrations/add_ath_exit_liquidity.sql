-- Exit liquidity evidence on ATH tokens.
--
-- A honeypot has buyers and no sellers: the contract accepts purchases and
-- blocks disposals, so a price prints and a market cap is computed for a token
-- nobody could ever exit. EVM chains are full of them, and one in the runner
-- corpus poisons everything downstream — it contributes "top traders" who never
-- traded, and its deployer counts toward an alpha-deployer promotion.
--
-- Note that the USD ratio does NOT separate them: measured across 743 BNB Chain
-- runners, sell-USD/buy-USD sits at ~1.0 for honeypots and healthy tokens alike,
-- because the few wallets that CAN sell (the deployer) dump the whole supply.
-- The discriminator is the ratio of distinct selling wallets to distinct buying
-- wallets: healthy tokens run ~1:1, honeypots 1:10 to 1:200. One example carried
-- 201 buyers and 3 sellers.
--
-- Stored rather than merely filtered on, so the threshold can be revisited
-- without re-running the whole corpus — the same reason bot flags are kept on
-- ath_token_traders.

ALTER TABLE ath_tokens
  ADD COLUMN IF NOT EXISTS distinct_buyers  integer,
  ADD COLUMN IF NOT EXISTS distinct_sellers integer,
  ADD COLUMN IF NOT EXISTS buy_volume_usd   numeric,
  ADD COLUMN IF NOT EXISTS sell_volume_usd  numeric;

COMMENT ON COLUMN ath_tokens.distinct_sellers IS
  'Distinct wallets that successfully sold. Near-zero against many buyers indicates a honeypot.';
