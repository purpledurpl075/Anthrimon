-- ============================================================
-- ADVANCED REPORTS
-- Scheduled, branded PDF/CSV reports for capacity, SLA, and
-- inventory. Licensed feature (module license_key: "reports").
-- ============================================================

CREATE TABLE scheduled_reports (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name           TEXT        NOT NULL,
    report_type    TEXT        NOT NULL CHECK (report_type IN ('capacity', 'sla', 'inventory')),
    formats        TEXT[]      NOT NULL DEFAULT '{pdf}',
    filters        JSONB       NOT NULL DEFAULT '{}',
    -- Standard 5-field cron expression (UTC), same as
    -- maintenance_windows.recurrence_cron — parsed with croniter, already a
    -- project dependency.
    recurrence_cron TEXT       NOT NULL,
    recipients     TEXT[]      NOT NULL DEFAULT '{}',
    is_enabled     BOOLEAN     NOT NULL DEFAULT true,
    last_run_at    TIMESTAMPTZ,
    next_run_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_scheduled_reports_tenant ON scheduled_reports(tenant_id);
CREATE INDEX idx_scheduled_reports_due    ON scheduled_reports(next_run_at) WHERE is_enabled;

CREATE TRIGGER trg_scheduled_reports_updated_at
    BEFORE UPDATE ON scheduled_reports
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE report_runs (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    scheduled_report_id UUID        REFERENCES scheduled_reports(id) ON DELETE SET NULL,
    report_type         TEXT        NOT NULL CHECK (report_type IN ('capacity', 'sla', 'inventory')),
    format              TEXT        NOT NULL CHECK (format IN ('pdf', 'csv')),
    status              TEXT        NOT NULL DEFAULT 'pending'
                                     CHECK (status IN ('pending', 'running', 'success', 'failed')),
    error               TEXT,
    file_path           TEXT,
    file_size_bytes     BIGINT,
    triggered_by        UUID        REFERENCES users(id) ON DELETE SET NULL,
    emailed_to          TEXT[],
    started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ
);

CREATE INDEX idx_report_runs_tenant     ON report_runs(tenant_id, started_at DESC);
CREATE INDEX idx_report_runs_scheduled  ON report_runs(scheduled_report_id);

-- Grant access to the app user (tables are created by the migration-running
-- role, typically postgres, not anthrimon).
GRANT SELECT, INSERT, UPDATE, DELETE ON scheduled_reports TO anthrimon;
GRANT SELECT, INSERT, UPDATE, DELETE ON report_runs       TO anthrimon;
