-- 038_audit_log_site.sql
-- Extend audit_log with site context and acting-as tenant support.
-- site_id: the site a mutating action applied to (NULL for tenant-wide ops).
-- acted_as_tenant_id: populated when a platform_admin switches tenant and acts.

ALTER TABLE audit_log
    ADD COLUMN IF NOT EXISTS site_id            UUID REFERENCES sites(id)   ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS acted_as_tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_audit_log_site
    ON audit_log(site_id) WHERE site_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_log_acted_as
    ON audit_log(acted_as_tenant_id) WHERE acted_as_tenant_id IS NOT NULL;

-- New audit action values needed for multi-tenancy events.
-- audit_action is defined as a TEXT column (String(30)), not an enum,
-- so no ALTER TYPE needed.

COMMENT ON COLUMN audit_log.site_id IS
    'Site this action pertained to, if applicable.';

COMMENT ON COLUMN audit_log.acted_as_tenant_id IS
    'Set when a platform_admin performs this action while switched into another '
    'tenant.  The users.tenant_id remains the platform admin''s home tenant.';
