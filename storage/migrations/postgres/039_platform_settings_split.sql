-- 039_platform_settings_split.sql
-- Global platform-level settings store.  Mirrors the system_settings schema but
-- is reserved for keys that apply across all tenants (e.g. wireguard endpoint,
-- session_timeout_hours).  Tenant-specific keys are migrated to tenant_settings
-- in 040_backfill.sql.  system_settings is left intact for backward-compat reads.

CREATE TABLE IF NOT EXISTS platform_settings (
    key        TEXT        PRIMARY KEY,
    value      JSONB       NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE platform_settings IS
    'Truly global (cross-tenant) settings.  Only platform_admin may write. '
    'Tenant-scoped settings live in tenant_settings instead.';
