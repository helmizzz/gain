CREATE TABLE IF NOT EXISTS vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  discount_type text NOT NULL CHECK (discount_type IN ('PERCENTAGE', 'FIXED')),
  discount_value numeric(18, 8) NOT NULL CHECK (discount_value > 0),
  max_uses integer DEFAULT NULL,
  used_count integer NOT NULL DEFAULT 0,
  applicable_tier text NOT NULL DEFAULT 'all' CHECK (applicable_tier IN ('all', 'starter_6', 'pro_12')),
  is_active boolean NOT NULL DEFAULT true,
  expires_at timestamptz DEFAULT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS voucher_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_id uuid NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier text NOT NULL,
  original_fee numeric(18, 8) NOT NULL,
  discount_amount numeric(18, 8) NOT NULL,
  final_fee numeric(18, 8) NOT NULL,
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(voucher_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_vouchers_code ON vouchers(code);
CREATE INDEX IF NOT EXISTS idx_voucher_redemptions_user ON voucher_redemptions(user_id);
