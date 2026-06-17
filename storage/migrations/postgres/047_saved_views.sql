-- ============================================================
-- SAVED VIEWS
-- A user's saved filter-state (URL query string) for a given
-- page (alerts/devices/flow), optionally shared with the tenant.
-- ============================================================
CREATE TABLE saved_views (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    page        TEXT        NOT NULL,
    name        TEXT        NOT NULL,
    query       TEXT        NOT NULL DEFAULT '',
    is_shared   BOOLEAN     NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, user_id, page, name)
);

CREATE INDEX idx_saved_views_lookup ON saved_views(tenant_id, page);

CREATE TRIGGER trg_saved_views_updated_at
    BEFORE UPDATE ON saved_views
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
