-- 034_user_site_roles.sql
-- Site-scoped RBAC memberships.  A user may hold different roles at different
-- sites within their tenant.  Absence of a row means no site-specific grant;
-- tenant-level role from users.role remains in effect for tenant_admin users.

CREATE TABLE IF NOT EXISTS user_site_roles (
    user_id    UUID        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    site_id    UUID        NOT NULL REFERENCES sites(id)   ON DELETE CASCADE,
    tenant_id  UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    role       TEXT        NOT NULL CHECK (role IN ('readonly', 'operator', 'admin')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (user_id, site_id)
);

-- Fast lookup: "what sites does this user have access to in this tenant?"
CREATE INDEX IF NOT EXISTS idx_user_site_roles_tenant_site
    ON user_site_roles(tenant_id, site_id);

-- Fast lookup: "all memberships for a user"
CREATE INDEX IF NOT EXISTS idx_user_site_roles_user
    ON user_site_roles(user_id);

COMMENT ON TABLE user_site_roles IS
    'Site-scoped role grants.  A user not present here for a site falls back to '
    'their tenant-level role (users.role).  tenant_admin users see all sites '
    'regardless.';

COMMENT ON COLUMN user_site_roles.role IS
    'readonly: read access to site resources. '
    'operator: read + write non-destructive. '
    'admin: full control including deletion.';
