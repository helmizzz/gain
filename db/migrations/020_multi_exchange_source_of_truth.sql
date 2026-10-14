-- Multi-exchange source-of-truth hardening.
CREATE INDEX IF NOT EXISTS idx_orders_user_exchange_created_at ON orders (user_id, lower(exchange), created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fills_order_exchange_trade ON fills (order_id, exchange_trade_id);
CREATE INDEX IF NOT EXISTS idx_positions_bot_symbol ON positions (bot_id, upper(symbol));
UPDATE users u SET active_exchange = NULL, updated_at = now()
WHERE u.active_exchange IS NOT NULL AND NOT EXISTS (SELECT 1 FROM exchange_credentials ec WHERE ec.user_id = u.id AND lower(ec.exchange) = lower(u.active_exchange) AND upper(coalesce(ec.status, 'ACTIVE')) = 'ACTIVE');
COMMENT ON COLUMN users.active_exchange IS 'Authoritative active exchange context; exchange balances/orders/trades are fetched from the selected exchange API and never from browser snapshots.';
