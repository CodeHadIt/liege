-- Track NFT mints alongside token buys.
--
-- Alpha wallets minting the same collection is the same confluence signal as
-- them buying the same token, so NFTs share the tables rather than getting
-- parallel ones — asset_type is what tells them apart.

ALTER TABLE alpha_buys
  ADD COLUMN asset_type text NOT NULL DEFAULT 'erc20',   -- 'erc20' | 'erc721'
  -- NFT count received in the transaction. Mints are routinely batched (50 in a
  -- single tx in the collection that prompted this), so "how many" is the size
  -- of the position in a way that a token amount is not.
  ADD COLUMN quantity numeric,
  -- Whether the tokens came from the zero address — a mint rather than a
  -- purchase from another holder.
  ADD COLUMN is_mint boolean NOT NULL DEFAULT false;

ALTER TABLE alpha_confluence
  ADD COLUMN asset_type text NOT NULL DEFAULT 'erc20';

CREATE INDEX idx_alpha_buys_asset_type ON alpha_buys(chain, asset_type, bought_at DESC);
