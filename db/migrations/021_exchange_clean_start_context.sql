-- v2.4.16 clean-start context.
-- This table does NOT delete exchange history. It establishes the first timestamp
-- that the local application should expose after an explicit clean-start.
CREATE TABLE IF NOT EXISTS exchange_context_resets (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exchange text NOT NULL,
  sandbox boolean NOT NULL DEFAULT true,
  cutoff_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, exchange, sandbox)
);

CREATE INDEX IF NOT EXISTS idx_exchange_context_resets_user_time
  ON exchange_context_resets(user_id, cutoff_at DESC);

COMMENT ON TABLE exchange_context_resets IS
  'Local presentation cutoff for explicit trading clean-start. Exchange-side execution facts are never deleted here.';
