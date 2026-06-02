-- 032_tenant_settings.sql
-- Per-tenant settings store.  One row per tenant; settings is a freeform JSONB
-- bag (smtp, alert_eval_interval_s, business_hours, etc.).  Replaces the global
-- system_settings rows for all tenant-scoped keys (migration happens in 040).

CREATE TABLE IF NOT EXISTS tenant_settings (
    tenant_id  UUID        PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    settings   JSONB       NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE tenant_settings IS
    'Per-tenant key/value settings.  Replaces the tenant-scoped keys in system_settings. '
    'One row per tenant; created lazily or by 040_backfill.';
