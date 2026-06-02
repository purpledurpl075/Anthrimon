-- 033_tenant_email_templates.sql
-- Per-tenant email template overrides, keyed by (tenant_id, metric).
-- metric='default' is the per-tenant fallback when no per-metric override exists.
-- Look-up order: tenant+metric → tenant+default → global system_settings fallback.

CREATE TABLE IF NOT EXISTS tenant_email_templates (
    tenant_id  UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    metric     TEXT        NOT NULL,   -- e.g. 'interface_status', 'cpu', 'default'
    subject    TEXT,
    html       TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, metric)
);

CREATE INDEX IF NOT EXISTS idx_tenant_email_templates_tenant
    ON tenant_email_templates(tenant_id);

COMMENT ON TABLE tenant_email_templates IS
    'Per-tenant per-metric email template overrides.  metric=''default'' is the '
    'tenant-wide fallback; specific metric names override it.';

COMMENT ON COLUMN tenant_email_templates.metric IS
    'Alert metric name or the literal ''default''.  Matches alert_rules.metric.';
