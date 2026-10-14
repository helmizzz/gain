-- Financial controls for provider-assigned deposit addresses and withdrawal settlement.
-- This does not create custody addresses or wallets; an approved custody provider must provision them.

CREATE TABLE IF NOT EXISTS wallet_deposit_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  currency text NOT NULL CHECK (currency = 'USDT'),
  network text NOT NULL CHECK (network = 'BEP-20'),
  address text NOT NULL CHECK (address ~* '^0x[a-f0-9]{40}$'),
  provider text NOT NULL,
  provider_wallet_id text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_deposit_address_active_user
  ON wallet_deposit_addresses(user_id, currency, network) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_deposit_address_address
  ON wallet_deposit_addresses(lower(address), network);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_deposit_address_provider_ref
  ON wallet_deposit_addresses(provider, provider_wallet_id) WHERE provider_wallet_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wallet_deposit_addresses_user_status
  ON wallet_deposit_addresses(user_id, network, status);

-- A chain transaction can only settle one withdrawal. Existing duplicates must be reconciled manually;
-- do not silently choose which customer payout is valid.
CREATE UNIQUE INDEX IF NOT EXISTS uq_withdrawals_tx_hash_nonnull
  ON withdrawals(lower(tx_hash)) WHERE tx_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_deposits_network_tx_hash_ci
  ON deposits(network, lower(tx_hash));

-- Keep the authoritative financial event log append-only for ordinary application connections.
CREATE OR REPLACE FUNCTION prevent_wallet_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'wallet_ledger is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wallet_ledger_no_update ON wallet_ledger;
CREATE TRIGGER wallet_ledger_no_update
  BEFORE UPDATE OR DELETE ON wallet_ledger
  FOR EACH ROW EXECUTE FUNCTION prevent_wallet_ledger_mutation();
