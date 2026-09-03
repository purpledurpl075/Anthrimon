from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.settings import PlatformSetting
from ..models.tenant import Tenant

# Platform-wide setting defaults consulted by the alerting engine, the
# notification pipeline, and a handful of other endpoints (collector
# bootstrap, flow IP enrichment, channel test sends). Stored one row per key
# in `platform_settings` (PlatformSetting), editable via PUT /platform/settings
# (platform_admin only).
PLATFORM_DEFAULTS: dict = {
    # Branding / outbound links — used in alert emails & webhooks
    "base_url":      "",
    "platform_name": "Anthrimon",
    "timezone":      "UTC",
    # Report branding (Advanced Reports) — org name/logo shown in generated
    # PDF report headers/footers. Defaults to Anthrimon's own mark (same SVG
    # as the sidebar's collapsed-state icon, frontend/dashboard/public/logo-icon.svg)
    # until an admin uploads a replacement via Platform Settings.
    "report_company_name":  "",
    "report_logo_data_uri": (
        "data:image/svg+xml;base64,"
        "PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgdmlld0JveD0iMCAwIDIwMCAyMDAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+"
        "CiAgICA8cmVjdCB4PSIxMCIgeT0iMTAiIHdpZHRoPSIxODAiIGhlaWdodD0iMTgwIiByeD0iMzYiIHJ5PSIzNiIgZmlsbD0iIzBkMWIyNCIvPgogICAgPHBvbHlnb24gcG9pbnRzPSI0OCwxNjIuNCA2Mi41NiwxNjIuNCAxMDQuMzY4LDQ0Ljg4IDk1LjYzMiw0NC44OCIgZmlsbD0iI2ZmZmZmZiIvPgogICAgPHBvbHlnb24gcG9pbnRzPSIxNTIsMTYyLjQgMTM3LjQ0LDE2Mi40IDk1LjYzMiw0NC44OCAxMDQuMzY4LDQ0Ljg4IiBmaWxsPSIjZmZmZmZmIi8+CiAgICA8cmVjdCB4PSI3Mi45NiIgeT0iMTA5Ljk4NCIgd2lkdGg9IjU0LjA4IiBoZWlnaHQ9IjguNzM2IiBmaWxsPSIjZmZmZmZmIi8+CiAgICA8Y2lyY2xlIGN4PSIxMDAiIGN5PSIxMjcuNDU2IiByPSI1LjUzMjgiIGZpbGw9IiM1Y2I4NWMiLz4KPC9zdmc+Cg=="
    ),
    # Alerting engine — platform-wide defaults; tenants may override the
    # subset in TENANT_OVERRIDABLE_KEYS via /admin/settings/alerting
    "device_down_stale_min_s":        90,
    "device_down_stale_multiplier":   6.0,
    "max_alerts_per_device_per_hour": 0,
    "auto_close_stale_days":          0,
    "alert_retention_days":           90,
    # Mass-simultaneous-failure heuristic — groups N unrelated device_down
    # alerts that first-fire within the same short window under one
    # correlation_id for operator clarity, without suppressing any of them.
    "mass_failure_min_devices": 3,
    "mass_failure_window_s":    30,
    # Notifications
    "notifications_paused":       False,
    "notifications_paused_until": None,
    "business_hours_enabled":     False,
    "business_hours_start":       8,
    "business_hours_end":         18,
    "business_days":              [0, 1, 2, 3, 4],
    # Threat intelligence
    "abuseipdb_api_key": "",
    # Remote collectors
    "wg_public_endpoint": "",
    # Postgres housekeeping (api/backend/housekeeping.py) — pruning windows for
    # otherwise-unbounded operational tables
    "interface_status_log_days":        90,
    "bgp_session_events_days":          90,
    "notification_send_log_days":       90,
    "trap_events_days":                 30,
    "config_backups_keep_per_device":   50,
    "compliance_results_keep_per_pair": 20,
    "report_runs_retention_days":       90,
    # Routing tables (bgp_sessions, ospf_neighbors, isis_neighbors) are never
    # row-deleted by the collector — a genuinely decommissioned peer just sits
    # forever marked idle/down. This prunes rows that have been in that
    # terminal state longer than the window, same housekeeping sweep as above.
    "stale_routing_rows_days":          30,
    # Scheduler retry/failure-notify (feature 6) — consecutive failures a
    # schedule must hit before a report_failure AlertRule notification fires.
    "report_schedule_failure_threshold": 3,
    # Host-level storage — applied via privileged helper scripts, see
    # scripts/apply-vm-retention.sh and scripts/apply-journald-limit.sh
    "vm_retention_months":  12,
    "journald_max_use_mb":  1024,
}

# Of the keys above, these may be overridden per-tenant in
# Tenant.settings["alerting"]. The rest (branding, WireGuard endpoint,
# AbuseIPDB key) are truly global and apply to every tenant.
TENANT_OVERRIDABLE_KEYS: frozenset[str] = frozenset({
    "device_down_stale_min_s",
    "device_down_stale_multiplier",
    "max_alerts_per_device_per_hour",
    "auto_close_stale_days",
    "alert_retention_days",
    "notifications_paused",
    "notifications_paused_until",
    "business_hours_enabled",
    "business_hours_start",
    "business_hours_end",
    "business_days",
    "mass_failure_min_devices",
    "mass_failure_window_s",
    "stale_routing_rows_days",
})


async def load_platform_defaults(db: AsyncSession) -> dict:
    """All platform-wide setting defaults, merged with any PlatformSetting overrides."""
    rows = (await db.execute(
        select(PlatformSetting).where(PlatformSetting.key.in_(PLATFORM_DEFAULTS.keys()))
    )).scalars().all()
    stored = {r.key: r.value for r in rows}
    result = dict(PLATFORM_DEFAULTS)
    for k in result:
        if k in stored:
            v = stored[k]
            result[k] = v if not isinstance(v, dict) else v.get("value", result[k])
    return result


async def get_effective_alerting_settings(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    platform_defaults: dict | None = None,
) -> dict:
    """Effective alerting settings for one tenant: platform-wide defaults for
    the tenant-overridable keys, with this tenant's Tenant.settings["alerting"]
    overrides applied on top."""
    platform = platform_defaults if platform_defaults is not None else await load_platform_defaults(db)
    effective = {k: platform[k] for k in TENANT_OVERRIDABLE_KEYS}

    tenant_settings = (await db.execute(
        select(Tenant.settings).where(Tenant.id == tenant_id)
    )).scalar_one_or_none()
    overrides = (tenant_settings or {}).get("alerting") or {}
    for k, v in overrides.items():
        if k in TENANT_OVERRIDABLE_KEYS:
            effective[k] = v
    return effective
