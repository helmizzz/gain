-- GAIN v2.4.16 bot/exchange isolation hardening.
-- A bot runtime identity must never migrate an existing durable position/order
-- from one exchange account to another merely because the active exchange changed.
DROP INDEX IF EXISTS uq_bots_external_bot_id;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bots_user_external_exchange_symbol
  ON bots(user_id, external_bot_id, exchange_account_id, upper(symbol))
  WHERE external_bot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bots_user_external_exchange
  ON bots(user_id, external_bot_id, exchange_account_id, updated_at DESC)
  WHERE external_bot_id IS NOT NULL;

COMMENT ON INDEX uq_bots_user_external_exchange_symbol IS
  'Exchange/account-scoped bot identity; switching exchange creates/uses a distinct durable bot scope instead of rebinding old positions.';
