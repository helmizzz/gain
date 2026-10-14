-- Active exchange is explicit per GAIN user. It must never be inferred from connection order.
ALTER TABLE users ADD COLUMN IF NOT EXISTS active_exchange text;
CREATE INDEX IF NOT EXISTS idx_users_active_exchange ON users(active_exchange);
UPDATE users SET active_exchange = NULL WHERE active_exchange IS NOT NULL AND btrim(active_exchange) = '';
