-- v2.4.16 execution safety hardening.
-- Reservations bridge PostgreSQL financial state and the external exchange side effect.
-- A reservation is created before createOrder() and remains until the exchange order
-- reaches a definitive terminal state and financial settlement has completed.
CREATE TABLE IF NOT EXISTS order_execution_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  exchange text NOT NULL,
  symbol text NOT NULL,
  side text NOT NULL CHECK (side IN ('buy','sell')),
  quantity numeric(30,10) NOT NULL CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED','RELEASED','SETTLED','UNKNOWN')),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_order_reservations_bot_active
  ON order_execution_reservations(bot_id, status)
  WHERE status IN ('RESERVED','UNKNOWN');
CREATE INDEX IF NOT EXISTS idx_order_reservations_user_exchange
  ON order_execution_reservations(user_id, exchange, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_user_exchange_time
  ON orders(user_id, exchange, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_bot_exchange_symbol_time
  ON orders(bot_id, exchange, symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fills_order_time
  ON fills(order_id, filled_at DESC);

ALTER TABLE positions ADD COLUMN IF NOT EXISTS reserved_quantity numeric(30,10) NOT NULL DEFAULT 0;
ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_reserved_quantity_nonnegative;
ALTER TABLE positions ADD CONSTRAINT positions_reserved_quantity_nonnegative
  CHECK (reserved_quantity >= 0);

COMMENT ON TABLE order_execution_reservations IS 'Execution reservation barrier between durable financial positions and external exchange order submission.';
COMMENT ON COLUMN positions.reserved_quantity IS 'Quantity reserved by admitted exchange SELL orders; never included in available position quantity.';
