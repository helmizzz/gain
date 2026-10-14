-- Fail-closed operational controls for payout governance, destination whitelist,
-- screening evidence, daily reconciliations, and reserve snapshots.
ALTER TABLE withdrawals
  ADD COLUMN IF NOT EXISTS withdrawal_address_id uuid,
  ADD COLUMN IF NOT EXISTS screening_status text NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS screening_provider text,
  ADD COLUMN IF NOT EXISTS screening_reference text,
  ADD COLUMN IF NOT EXISTS screening_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS screening_reason_code text;
ALTER TABLE withdrawals
  ADD COLUMN IF NOT EXISTS processor_claim_id uuid,
  ADD COLUMN IF NOT EXISTS processor_claimed_by text,
  ADD COLUMN IF NOT EXISTS processor_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS processor_lease_until timestamptz,
  ADD COLUMN IF NOT EXISTS processor_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_payout_id text,
  ADD COLUMN IF NOT EXISTS payout_submitted_at timestamptz;
ALTER TABLE deposits
  ADD COLUMN IF NOT EXISTS source_address text,
  ADD COLUMN IF NOT EXISTS screening_status text NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS screening_provider text,
  ADD COLUMN IF NOT EXISTS screening_reference text,
  ADD COLUMN IF NOT EXISTS screening_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS screening_reason_code text;

DO $$ BEGIN
  ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_screening_status_check
    CHECK (screening_status IN ('PENDING','CLEAR','BLOCKED','ERROR'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE deposits ADD CONSTRAINT deposits_screening_status_check
    CHECK (screening_status IN ('PENDING','CLEAR','BLOCKED','ERROR'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS withdrawal_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  currency text NOT NULL DEFAULT 'USDT' CHECK (currency='USDT'),
  network text NOT NULL CHECK (network='BEP-20'),
  address text NOT NULL CHECK (address ~* '^0x[a-f0-9]{40}$'),
  label text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REMOVED')),
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  cooldown_until timestamptz NOT NULL,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_withdrawal_addresses_active_user_address
  ON withdrawal_addresses(user_id, network, lower(address)) WHERE status='ACTIVE';
CREATE INDEX IF NOT EXISTS idx_withdrawal_addresses_user
  ON withdrawal_addresses(user_id, status, created_at DESC);
ALTER TABLE withdrawals DROP CONSTRAINT IF EXISTS withdrawals_withdrawal_address_id_fkey;
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_withdrawal_address_id_fkey
  FOREIGN KEY (withdrawal_address_id) REFERENCES withdrawal_addresses(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_withdrawals_screening_queue
  ON withdrawals(screening_status, requested_at) WHERE status IN ('REVIEW','PROCESSING');
CREATE INDEX IF NOT EXISTS idx_withdrawals_payout_claim
  ON withdrawals(status,processor_lease_until,approved_at,requested_at)
  WHERE status='PROCESSING' AND screening_status='CLEAR';

CREATE TABLE IF NOT EXISTS withdrawal_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  withdrawal_id uuid NOT NULL REFERENCES withdrawals(id) ON DELETE RESTRICT,
  admin_uid text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('APPROVE','REJECT')),
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(withdrawal_id, admin_uid)
);
CREATE INDEX IF NOT EXISTS idx_withdrawal_approvals_withdrawal
  ON withdrawal_approvals(withdrawal_id, created_at);

CREATE TABLE IF NOT EXISTS withdrawal_screening_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  withdrawal_id uuid NOT NULL REFERENCES withdrawals(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING','CLEAR','BLOCKED','ERROR')),
  reason_code text NOT NULL DEFAULT '',
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_event_id)
);
CREATE INDEX IF NOT EXISTS idx_withdrawal_screening_events_withdrawal
  ON withdrawal_screening_events(withdrawal_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS deposit_screening_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_id uuid NOT NULL REFERENCES deposits(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('CLEAR','BLOCKED','ERROR')),
  reason_code text NOT NULL DEFAULT '',
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_event_id)
);
CREATE INDEX IF NOT EXISTS idx_deposit_screening_events_deposit
  ON deposit_screening_events(deposit_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS financial_reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_date date NOT NULL,
  asset text NOT NULL,
  network text NOT NULL,
  ledger_liability numeric(30,10) NOT NULL,
  custody_assets numeric(30,10),
  bank_assets numeric(30,10),
  status text NOT NULL CHECK (status IN ('MATCHED','DISCREPANCY','INCOMPLETE')),
  source_refs jsonb NOT NULL DEFAULT '{}',
  difference numeric(30,10),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(business_date, asset, network)
);
CREATE TABLE IF NOT EXISTS financial_reconciliation_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES financial_reconciliation_runs(id) ON DELETE RESTRICT,
  item_type text NOT NULL CHECK (item_type IN ('LEDGER_ONLY','CUSTODY_ONLY','BANK_ONLY','AMOUNT_MISMATCH','MISSING_SOURCE')),
  reference_id text NOT NULL,
  ledger_amount numeric(30,10),
  custody_amount numeric(30,10),
  bank_amount numeric(30,10),
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_financial_recon_items_run ON financial_reconciliation_items(run_id);

CREATE TABLE IF NOT EXISTS reserve_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_date date NOT NULL,
  asset text NOT NULL,
  network text NOT NULL,
  customer_liabilities numeric(30,10) NOT NULL,
  custody_assets numeric(30,10),
  bank_assets numeric(30,10),
  coverage_ratio numeric(20,10),
  attestation_status text NOT NULL CHECK (attestation_status IN ('UNATTESTED','INDEPENDENTLY_ATTESTED')),
  source_refs jsonb NOT NULL DEFAULT '{}',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(business_date, asset, network)
);

COMMENT ON TABLE withdrawal_addresses IS 'Customer-approved payout destinations; withdrawal requests must wait for cooldown_until.';
COMMENT ON TABLE withdrawal_approvals IS 'Immutable maker-checker decisions; payout requires two different admin_uid values.';
COMMENT ON TABLE withdrawal_screening_events IS 'Provider screening evidence; payout remains held unless latest result is CLEAR.';
COMMENT ON TABLE financial_reconciliation_runs IS 'Daily ledger/custody/bank comparison; never auto-posts corrections.';
COMMENT ON TABLE reserve_snapshots IS 'Coverage report inputs; system-created records remain UNATTESTED absent independent evidence.';
