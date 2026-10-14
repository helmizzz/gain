-- Add role column to users table for RBAC (Role-Based Access Control)
ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user';

-- Ensure role is one of the allowed values
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_chk;
ALTER TABLE users ADD CONSTRAINT users_role_chk CHECK (role IN ('user', 'admin', 'superadmin'));

-- Optional: Create an index for faster querying of admins (useful for admin panel)
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
