-- GAIN Native BSC Custody v1
-- Replaces external custody-provider address generation with self-hosted BSC HD derivation
-- and enables an isolated hot-wallet signer for automatic USDT withdrawals.

CREATE SEQUENCE IF NOT EXISTS gain_bsc_deposit_index_seq START WITH 0 INCREMENT BY 1 MINVALUE 0 NO CYCLE;

ALTER TABLE wallet_deposit_addresses
  ADD COLUMN IF NOT EXISTS derivation_index integer,
  ADD COLUMN IF NOT EXISTS derivation_path text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_native_bsc_deposit_derivation_index
  ON wallet_deposit_addresses(derivation_index)
  WHERE provider='native-bsc' AND derivation_index IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_native_bsc_deposit_addresses
  ON wallet_deposit_addresses(provider,network,status,derivation_index);

CREATE TABLE IF NOT EXISTS native_bsc_transaction_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL CHECK (event_type IN ('DEPOSIT','WITHDRAWAL','SWEEP','GAS')),
  tx_hash text NOT NULL,
  log_index bigint,
  user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  address text,
  source_address text,
  destination_address text,
  asset text NOT NULL DEFAULT 'USDT',
  network text NOT NULL DEFAULT 'BEP-20',
  amount numeric(30,10),
  block_number bigint,
  confirmations integer NOT NULL DEFAULT 0,
  status text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(network,tx_hash,event_type,log_index)
);

CREATE INDEX IF NOT EXISTS idx_native_bsc_events_time
  ON native_bsc_transaction_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_native_bsc_events_user
  ON native_bsc_transaction_events(user_id,created_at DESC);

COMMENT ON TABLE native_bsc_transaction_events IS
  'Read/audit projection of native BSC custody activity. Authoritative balances remain wallet_ledger + deposits/withdrawals.';

INSERT INTO system_settings(key,value)
VALUES (
  'native_bsc_policy_v1',
  '{"network":"BSC","chainId":56,"asset":"USDT","tokenDecimals":18,"mode":"NATIVE_BSC","autoWithdrawalEnabled":false}'
)
ON CONFLICT(key) DO NOTHING;
