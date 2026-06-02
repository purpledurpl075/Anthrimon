-- 041_user_tenant_access.sql
-- Cross-tenant access grants.  A platform admin can grant a user access to
-- additional tenants beyond their home tenant.  The home tenant is always
-- implicitly accessible; only additional tenants need a row here.

CREATE TABLE IF NOT EXISTS user_tenant_access (
    user_id    UUID        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    tenant_id  UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    role       TEXT        NOT NULL CHECK (role IN ('readonly', 'operator', 'admin')),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (user_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_user_tenant_access_user
    ON user_tenant_access(user_id);

CREATE INDEX IF NOT EXISTS idx_user_tenant_access_tenant
    ON user_tenant_access(tenant_id);

COMMENT ON TABLE user_tenant_access IS
    'Cross-tenant access grants managed by platform admins.  A user''s home '
    'tenant (users.tenant_id) is always accessible without a row here.  '
    'Additional tenants require an explicit grant with a role for that tenant.';
