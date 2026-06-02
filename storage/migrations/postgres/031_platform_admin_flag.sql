-- 031_platform_admin_flag.sql
-- Introduce the "platform plane" alongside the existing tenant-scoped user_role.
-- platform_role is free-text (not an enum) to avoid ALTER TYPE … ADD VALUE migrations.
-- Existing user_role='superadmin' is kept as a legacy alias; auto-promotion happens
-- in 040_backfill.sql.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS platform_role      TEXT
        CHECK (platform_role IN ('platform_admin', 'platform_support'));

COMMENT ON COLUMN users.is_platform_admin IS
    'True when this user may act across all tenants (platform plane). '
    'Independent of tenant-scoped role.';

COMMENT ON COLUMN users.platform_role IS
    'platform_admin: full cross-tenant write access. '
    'platform_support: cross-tenant read + limited writes. '
    'NULL for ordinary tenant users.';
