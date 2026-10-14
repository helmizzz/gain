-- GAIN Financial Wallet Phase 1.2
-- Persistent USER custody mapping hardening.
-- This migration does NOT enable financial operations.

CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_deposit_addresses_user_asset_network
  ON wallet_deposit_addresses(user_id, asset_id, network)
  WHERE status = 'ACTIVE' AND asset_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wallet_deposit_addresses_user_active
  ON wallet_deposit_addresses(user_id, status, network);

CREATE INDEX IF NOT EXISTS idx_custody_wallets_user_active
  ON custody_wallets(user_id, status, purpose, network);

COMMENT ON INDEX uq_wallet_deposit_addresses_user_asset_network IS
  'One active deposit address per GAIN user/asset/network. Idempotent persistence guard.';
