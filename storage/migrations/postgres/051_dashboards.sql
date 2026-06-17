-- ============================================================
-- DASHBOARDS
-- User-created, optionally tenant-shared custom dashboards built
-- from a catalog of summary + generic "metric" widgets.
-- ============================================================
CREATE TABLE dashboards (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT        NOT NULL,
    description TEXT        NOT NULL DEFAULT '',
    is_shared   BOOLEAN     NOT NULL DEFAULT false,
    is_default  BOOLEAN     NOT NULL DEFAULT false,
    layout      JSONB       NOT NULL DEFAULT '{"widgets": [], "time_range": "24h", "refresh_interval_s": 60}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, user_id, name)
);

CREATE INDEX idx_dashboards_tenant_user   ON dashboards(tenant_id, user_id);
CREATE INDEX idx_dashboards_tenant_shared ON dashboards(tenant_id) WHERE is_shared;
CREATE UNIQUE INDEX idx_dashboards_one_default ON dashboards(tenant_id, user_id) WHERE is_default;

CREATE TRIGGER trg_dashboards_updated_at
    BEFORE UPDATE ON dashboards
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Grant access to the app user (table is created by the migration-running
-- role, typically postgres, not anthrimon).
GRANT SELECT, INSERT, UPDATE, DELETE ON dashboards TO anthrimon;
