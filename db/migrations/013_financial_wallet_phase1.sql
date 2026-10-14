-- GAIN Financial Wallet Phase 1: provider-backed persistent deposit addresses,
-- custody wallet registry, asset registry, and financial operations observability.
-- This migration does not enable mainnet operations by itself.

CREATE TABLE IF NOT EXISTS financial_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_code text NOT NULL,
  symbol text NOT NULL,
  network text NOT NULL,
  chain_id integer NOT NULL,
  contract_address text NOT NULL,
  decimals integer NOT NULL CHECK (decimals >= 0 AND decimals <= 36),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  provenance text NOT NULL DEFAULT 'CONFIGURED',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(asset_code)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_financial_assets_network_contract
  ON financial_assets(network, lower(contract_address));

INSERT INTO financial_assets(asset_code,symbol,network,chain_id,contract_address,decimals,provenance)
VALUES (
  'BSC_BINANCE_PEG_USDT',
  'USDT',
  'BEP-20',
  56,
  '0x55d398326f99059fF775485246999027B3197955',
  18,
  'BSC_MAINNET_CONFIGURED'
)
ON CONFLICT(asset_code) DO NOTHING;

ALTER TABLE wallet_deposit_addresses
  ADD COLUMN IF NOT EXISTS asset_id uuid REFERENCES financial_assets(id),
  ADD COLUMN IF NOT EXISTS chain_id integer,
  ADD COLUMN IF NOT EXISTS provider_wallet_type text,
  ADD COLUMN IF NOT EXISTS qr_payload text,
  ADD COLUMN IF NOT EXISTS last_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE wallet_deposit_addresses da
SET asset_id = fa.id,
    chain_id = 56,
    qr_payload = COALESCE(da.qr_payload, da.address),
    updated_at = now()
FROM financial_assets fa
WHERE da.currency='USDT'
  AND da.network='BEP-20'
  AND fa.asset_code='BSC_BINANCE_PEG_USDT'
  AND da.asset_id IS NULL;

CREATE TABLE IF NOT EXISTS custody_wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  provider_wallet_id text NOT NULL,
  wallet_type text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('USER_DEPOSIT','HOT_PAYOUT','RESERVE','COLD','GAS')),
  network text NOT NULL,
  address text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('CREATING','ACTIVE','DISABLED','REVOKED','ERROR')),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_wallet_id),
  UNIQUE(user_id, provider, purpose, network)
);
CREATE INDEX IF NOT EXISTS idx_custody_wallets_purpose_status
  ON custody_wallets(purpose,status,network,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_custody_wallets_user
  ON custody_wallets(user_id,purpose,status);

-- Provider wallet mapping is intentionally enforced in the application layer.
-- Existing v2.4.16 deployments may contain assignments created before custody_wallets existed;
-- adding a hard FK here would make migration 013 fail against valid legacy rows.

CREATE TABLE IF NOT EXISTS custody_provider_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  payload_hash text NOT NULL,
  status text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','PROCESSED','IGNORED','FAILED')),
  processed_at timestamptz,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider,event_id)
);
CREATE INDEX IF NOT EXISTS idx_custody_provider_events_status
  ON custody_provider_events(provider,status,created_at DESC);

ALTER TABLE deposits
  ADD COLUMN IF NOT EXISTS asset_id uuid REFERENCES financial_assets(id),
  ADD COLUMN IF NOT EXISTS token_contract text,
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS provider_event_id text,
  ADD COLUMN IF NOT EXISTS provider_wallet_id text,
  ADD COLUMN IF NOT EXISTS finalized boolean NOT NULL DEFAULT false;

ALTER TABLE withdrawals
  ADD COLUMN IF NOT EXISTS asset_id uuid REFERENCES financial_assets(id),
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS provider_withdrawal_id text,
  ADD COLUMN IF NOT EXISTS provider_status text,
  ADD COLUMN IF NOT EXISTS provider_updated_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_deposits_provider_event
  ON deposits(provider,provider_event_id)
  WHERE provider_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_withdrawals_provider_id
  ON withdrawals(provider,provider_withdrawal_id)
  WHERE provider_withdrawal_id IS NOT NULL;

COMMENT ON TABLE financial_assets IS 'Canonical asset/network registry. Contract address, chain ID and decimals are authoritative.';
COMMENT ON TABLE custody_wallets IS 'GAIN mapping of provider wallet identities to user/business purposes.';
COMMENT ON TABLE custody_provider_events IS 'Idempotent provider event inbox. Financial side-effects must be safe to retry.';
COMMENT ON COLUMN wallet_deposit_addresses.qr_payload IS 'Public deposit QR payload only; never contains secrets or signing material.';
