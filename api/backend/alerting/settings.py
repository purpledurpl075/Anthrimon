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
    # Alerting engine — platform-wide defaults; tenants may override the
    # subset in TENANT_OVERRIDABLE_KEYS via /admin/settings/alerting
    "device_down_stale_min_s":        90,
    "max_alerts_per_device_per_hour": 0,
    "auto_close_stale_days":          0,
    "alert_retention_days":           90,
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
}

# Of the keys above, these may be overridden per-tenant in
# Tenant.settings["alerting"]. The rest (branding, WireGuard endpoint,
# AbuseIPDB key) are truly global and apply to every tenant.
TENANT_OVERRIDABLE_KEYS: frozenset[str] = frozenset({
    "device_down_stale_min_s",
    "max_alerts_per_device_per_hour",
    "auto_close_stale_days",
    "alert_retention_days",
    "notifications_paused",
    "notifications_paused_until",
    "business_hours_enabled",
    "business_hours_start",
    "business_hours_end",
    "business_days",
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
