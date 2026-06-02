-- 040_backfill.sql
-- Idempotent backfill to wire existing data into the new Phase A schema.
-- Safe to re-run: all statements use ON CONFLICT DO NOTHING or WHERE NOT EXISTS.

-- ── (a) Promote existing superadmin users to platform_admin ───────────────────
UPDATE users
SET
    is_platform_admin = true,
    platform_role     = 'platform_admin'
WHERE
    role = 'superadmin'
    AND is_platform_admin = false;

-- ── (b) Seed user_site_roles for existing admin/superadmin users ──────────────
-- Every admin-or-higher user gets an 'admin' role on every site in their tenant.
-- Users already present are skipped (ON CONFLICT DO NOTHING).
INSERT INTO user_site_roles (user_id, site_id, tenant_id, role)
SELECT
    u.id          AS user_id,
    s.id          AS site_id,
    u.tenant_id   AS tenant_id,
    'admin'       AS role
FROM
    users u
    JOIN sites s ON s.tenant_id = u.tenant_id
WHERE
    u.role IN ('superadmin', 'admin')
ON CONFLICT (user_id, site_id) DO NOTHING;

-- ── (c) Copy tenant-scoped system_settings keys into tenant_settings ──────────
-- For each tenant, merge the global system_settings blob into tenant_settings.
-- Keys that are considered tenant-scoped are listed below.  Truly global keys
-- (wg_public_endpoint, session_timeout_hours) are handled in section (d).
--
-- This creates a tenant_settings row if one does not already exist, then
-- injects the relevant keys.  Existing keys in tenant_settings are NOT
-- overwritten (so a re-run is safe).

INSERT INTO tenant_settings (tenant_id, settings, updated_at)
SELECT
    t.id,
    COALESCE(
        jsonb_strip_nulls(
            jsonb_build_object(
                'smtp',                        (SELECT value FROM system_settings WHERE key = 'smtp'),
                'email_template',              (SELECT value FROM system_settings WHERE key = 'email_template'),
                'base_url',                    (SELECT value->'base_url'                    FROM system_settings WHERE key = 'platform'),
                'platform_name',               (SELECT value->'platform_name'               FROM system_settings WHERE key = 'platform'),
                'timezone',                    (SELECT value->'timezone'                    FROM system_settings WHERE key = 'platform'),
                'alert_eval_interval_s',       (SELECT value->'alert_eval_interval_s'       FROM system_settings WHERE key = 'platform'),
                'default_renotify_s',          (SELECT value->'default_renotify_s'          FROM system_settings WHERE key = 'platform'),
                'max_alerts_per_device_per_hour', (SELECT value->'max_alerts_per_device_per_hour' FROM system_settings WHERE key = 'platform'),
                'auto_close_stale_days',       (SELECT value->'auto_close_stale_days'       FROM system_settings WHERE key = 'platform'),
                'notifications_paused',        (SELECT value->'notifications_paused'        FROM system_settings WHERE key = 'platform'),
                'notifications_paused_until',  (SELECT value->'notifications_paused_until'  FROM system_settings WHERE key = 'platform'),
                'business_hours_start',        (SELECT value->'business_hours_start'        FROM system_settings WHERE key = 'platform'),
                'business_hours_end',          (SELECT value->'business_hours_end'          FROM system_settings WHERE key = 'platform'),
                'business_days',               (SELECT value->'business_days'               FROM system_settings WHERE key = 'platform'),
                'alert_retention_days',        (SELECT value->'alert_retention_days'        FROM system_settings WHERE key = 'platform'),
                'abuseipdb_api_key',           (SELECT value->'abuseipdb_api_key'           FROM system_settings WHERE key = 'platform')
            )
        ),
        '{}'::jsonb
    ),
    now()
FROM tenants t
ON CONFLICT (tenant_id) DO UPDATE
    SET settings   = tenant_settings.settings || EXCLUDED.settings,
        updated_at = now()
    WHERE tenant_settings.settings = '{}'::jsonb;

-- ── (d) Copy truly global keys into platform_settings ─────────────────────────
INSERT INTO platform_settings (key, value, updated_at)
SELECT 'wg_public_endpoint', value->'wg_public_endpoint', now()
FROM system_settings WHERE key = 'platform' AND value ? 'wg_public_endpoint'
ON CONFLICT (key) DO NOTHING;

INSERT INTO platform_settings (key, value, updated_at)
SELECT 'session_timeout_hours', value->'session_timeout_hours', now()
FROM system_settings WHERE key = 'platform' AND value ? 'session_timeout_hours'
ON CONFLICT (key) DO NOTHING;

-- ── (e) Copy per-metric email templates ──────────────────────────────────────
-- system_settings rows with key like 'email_template_<metric>' become rows in
-- tenant_email_templates with metric=<metric> for every tenant.
INSERT INTO tenant_email_templates (tenant_id, metric, subject, html, updated_at)
SELECT
    t.id                                  AS tenant_id,
    -- strip the 'email_template_' prefix to get the metric name
    substr(ss.key, length('email_template_') + 1) AS metric,
    ss.value->>'subject'                  AS subject,
    ss.value->>'html'                     AS html,
    now()
FROM
    system_settings ss
    CROSS JOIN tenants t
WHERE
    ss.key LIKE 'email_template_%'
    AND ss.key != 'email_template'         -- 'email_template' (no suffix) = default handled via settings blob above
ON CONFLICT (tenant_id, metric) DO NOTHING;
