from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from textwrap import dedent

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException
from typing import Optional

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import crypto
from ..alerting.notify import _build_test_email, _send_smtp
from ..alerting.settings import TENANT_OVERRIDABLE_KEYS, get_effective_alerting_settings, load_platform_defaults
from ..dependencies import get_db, require_role, require_tenant_user, require_platform, Principal
from ..models.settings import PlatformSetting, SystemSetting
from ..models.tenant import Tenant, User
from ..schemas.admin import SmtpSettingsRead, SmtpSettingsWrite

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/admin", tags=["admin"])

_SMTP_KEY     = "smtp"
_TEMPLATE_KEY = "email_template"

DEFAULT_SUBJECT  = "[{{tag}}] {{title}}"

_HERO_SVG = """<img src="https://raw.githubusercontent.com/purpledurpl075/Anthri-mon/5c936c28dd22fe8c19056c46fb3a2b8895a26e11/logos/05-banner-hero.svg" width="560" alt="Anthrimon" style="display:block;border:0;" />"""


DEFAULT_HTML = dedent("""\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

  <!-- Hero banner -->
  <tr>
    <td style="padding:0;line-height:0;">""" + _HERO_SVG + """</td>
  </tr>

  <!-- Header: green when resolved, severity color otherwise -->
  <tr>
    <td style="background:{{header_color}};padding:24px 32px;">
      <p style="margin:0 0 4px;color:rgba(255,255,255,0.7);font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">{{tag}} &middot; {{platform_name}}</p>
      <h1 style="margin:0 0 4px;color:#ffffff;font-size:20px;font-weight:700;line-height:1.35;">{{title}}</h1>
      <p style="margin:0;color:rgba(255,255,255,0.85);font-size:13px;font-weight:500;">{{device_name}}</p>
    </td>
  </tr>

  <!-- Body -->
  <tr>
    <td style="padding:28px 32px;">

      <!-- Value/threshold card — rendered only when values are present -->
      {{value_card}}

      <!-- Core details -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
        <tr>
          <td style="font-size:13px;color:#64748b;padding:5px 0;width:110px;vertical-align:top;">Rule</td>
          <td style="font-size:13px;color:#1e293b;font-weight:500;padding:5px 0;">{{rule_name}}</td>
        </tr>
        <tr>
          <td style="font-size:13px;color:#64748b;padding:5px 0;">Severity</td>
          <td style="font-size:13px;font-weight:700;padding:5px 0;color:{{severity_color}};text-transform:capitalize;">{{severity}}</td>
        </tr>
        <tr>
          <td style="font-size:13px;color:#64748b;padding:5px 0;">Triggered</td>
          <td style="font-size:13px;color:#1e293b;padding:5px 0;">{{triggered_at}}</td>
        </tr>
        <!-- extra_rows: description, interface, prefix, neighbor, ospf_state — only when non-empty -->
        {{extra_rows}}
        <!-- resolved_row: shown only when alert is resolved, includes duration -->
        {{resolved_row}}
      </table>

      <!-- CTA button -->
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td align="center">
            <a href="{{alert_url}}" style="display:inline-block;background:#1e293b;color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;padding:12px 32px;border-radius:8px;letter-spacing:0.2px;">View alert &rarr;</a>
          </td>
        </tr>
      </table>

    </td>
  </tr>

  <!-- Footer -->
  <tr>
    <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 32px;text-align:center;">
      <p style="margin:0;font-size:11px;color:#94a3b8;">{{platform_name}} &middot; Ref&nbsp;{{alert_id}} &middot; <a href="{{alert_url}}" style="color:#94a3b8;text-decoration:underline;">Manage alert</a></p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>
""")


class EmailTemplateRead(BaseModel):
    subject: str
    html:    str


class EmailTemplateWrite(BaseModel):
    subject: str
    html:    str


async def _get_smtp_row(db: AsyncSession) -> SystemSetting | None:
    return (await db.execute(
        select(SystemSetting).where(SystemSetting.key == _SMTP_KEY)
    )).scalar_one_or_none()


@router.get("/settings/smtp", response_model=SmtpSettingsRead)
async def get_smtp_settings(
    _: User = Depends(require_tenant_user("tenant_admin")),
    db: AsyncSession = Depends(get_db),
) -> SmtpSettingsRead:
    row = await _get_smtp_row(db)
    if row is None:
        return SmtpSettingsRead()
    v = row.value
    return SmtpSettingsRead(
        host=v.get("host", ""),
        port=v.get("port", 587),
        user=v.get("user", ""),
        from_addr=v.get("from_addr", ""),
        ssl=v.get("ssl", False),
        password_set=bool(v.get("password")),
    )


@router.put("/settings/smtp", response_model=SmtpSettingsRead)
async def update_smtp_settings(
    body: SmtpSettingsWrite,
    _: User = Depends(require_tenant_user("tenant_admin")),
    db: AsyncSession = Depends(get_db),
) -> SmtpSettingsRead:
    row = await _get_smtp_row(db)
    existing = row.value if row else {}

    new_value: dict = {
        "host":      body.host,
        "port":      body.port,
        "user":      body.user,
        "from_addr": body.from_addr,
        "ssl":       body.ssl,
    }

    if body.password is None:
        # Keep whatever is stored
        new_value["password"] = existing.get("password", "")
    elif body.password == "":
        new_value["password"] = ""
    else:
        if not crypto.is_configured():
            raise HTTPException(status_code=400,
                                detail="ANTHRIMON_ENCRYPTION_KEY is not set — cannot encrypt password")
        new_value["password"] = crypto.encrypt(body.password)

    if row is None:
        db.add(SystemSetting(key=_SMTP_KEY, value=new_value))
    else:
        row.value = new_value
        row.updated_at = datetime.now(timezone.utc)

    await db.commit()
    logger.info("smtp_settings_updated", host=body.host, port=body.port)

    return SmtpSettingsRead(
        host=new_value["host"],
        port=new_value["port"],
        user=new_value["user"],
        from_addr=new_value["from_addr"],
        ssl=new_value["ssl"],
        password_set=bool(new_value.get("password")),
    )


@router.post("/settings/smtp/test", status_code=204, response_model=None,
             summary="Send a test email using the current SMTP settings")
async def test_smtp_settings(
    _: User = Depends(require_tenant_user("tenant_admin")),
    db: AsyncSession = Depends(get_db),
) -> None:
    row = await _get_smtp_row(db)
    if row is None or not row.value.get("host"):
        raise HTTPException(status_code=400, detail="SMTP is not configured")

    smtp_cfg = await _smtp_config_from_row(row)
    recipient = smtp_cfg.get("from_addr") or smtp_cfg.get("user")
    if not recipient:
        raise HTTPException(status_code=400, detail="Set a From address before sending a test")
    subject, body_text = _build_test_email()
    loop = asyncio.get_running_loop()
    try:
        await loop.run_in_executor(None, _send_smtp, smtp_cfg, [recipient], subject, body_text, "")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"SMTP error: {exc}") from exc


async def _smtp_config_from_row(row: SystemSetting) -> dict:
    """Resolve the stored SMTP config, decrypting the password if needed."""
    v = dict(row.value)
    if v.get("password") and crypto.is_configured():
        try:
            v["password"] = crypto.decrypt(v["password"])
        except Exception:
            v["password"] = ""
    return v


@router.get("/settings/email-template", response_model=EmailTemplateRead,
            summary="Get the HTML email alert template")
async def get_email_template(
    _: User = Depends(require_tenant_user("tenant_admin")),
    db: AsyncSession = Depends(get_db),
) -> EmailTemplateRead:
    row = (await db.execute(
        select(SystemSetting).where(SystemSetting.key == _TEMPLATE_KEY)
    )).scalar_one_or_none()
    if row:
        return EmailTemplateRead(subject=row.value.get("subject", DEFAULT_SUBJECT),
                                 html=row.value.get("html", DEFAULT_HTML))
    return EmailTemplateRead(subject=DEFAULT_SUBJECT, html=DEFAULT_HTML)


@router.put("/settings/email-template", response_model=EmailTemplateRead,
            summary="Save the HTML email alert template")
async def save_email_template(
    body: EmailTemplateWrite,
    _: User = Depends(require_tenant_user("tenant_admin")),
    db: AsyncSession = Depends(get_db),
) -> EmailTemplateRead:
    row = (await db.execute(
        select(SystemSetting).where(SystemSetting.key == _TEMPLATE_KEY)
    )).scalar_one_or_none()
    value = {"subject": body.subject, "html": body.html}
    if row:
        row.value = value
    else:
        db.add(SystemSetting(key=_TEMPLATE_KEY, value=value))
    await db.commit()
    return EmailTemplateRead(**value)


@router.delete("/settings/email-template", status_code=204, response_model=None,
               summary="Reset the HTML email template to default")
async def reset_email_template(
    _: User = Depends(require_tenant_user("tenant_admin")),
    db: AsyncSession = Depends(get_db),
) -> None:
    row = (await db.execute(
        select(SystemSetting).where(SystemSetting.key == _TEMPLATE_KEY)
    )).scalar_one_or_none()
    if row:
        await db.delete(row)
        await db.commit()


# ── Per-metric email templates ─────────────────────────────────────────────────

ALERT_METRICS = [
    "device_down", "interface_down", "interface_flap", "uptime",
    "temperature", "cpu_util_pct", "mem_util_pct",
    "interface_errors", "interface_util_pct",
    "ospf_state", "route_missing", "config_change", "syslog_match", "custom_oid",
]

# Subjects tailored per metric — richer than the generic "[{{tag}}] {{title}}"
METRIC_DEFAULT_SUBJECTS: dict[str, str] = {
    "device_down":        "[{{tag}}] {{device_name}} is unreachable",
    "interface_down":     "[{{tag}}] {{interface_name}} down on {{device_name}}",
    "interface_flap":     "[{{tag}}] {{interface_name}} flapping on {{device_name}}",
    "uptime":             "[{{tag}}] {{device_name}} rebooted (uptime {{value}}s)",
    "temperature":        "[{{tag}}] Temperature alert on {{device_name}} — {{value}}°C",
    "cpu_util_pct":       "[{{tag}}] CPU high on {{device_name}} — {{value}}%",
    "mem_util_pct":       "[{{tag}}] Memory high on {{device_name}} — {{value}}%",
    "interface_errors":   "[{{tag}}] Interface errors on {{device_name}}/{{interface_name}}",
    "interface_util_pct": "[{{tag}}] High bandwidth on {{device_name}}/{{interface_name}} — {{value}}%",
    "ospf_state":         "[{{tag}}] OSPF neighbor {{neighbor}} issue on {{device_name}}",
    "route_missing":      "[{{tag}}] Route {{prefix}} missing on {{device_name}}",
    "syslog_match":       "[{{tag}}] Syslog pattern matched on {{device_name}}",
    "config_change":      "[{{tag}}] Config changed on {{device_name}}",
    "custom_oid":         "[{{tag}}] {{title}}",
}

# State metrics: no meaningful value/threshold — use a simplified layout
_STATE_METRICS = {"device_down", "interface_down", "interface_flap", "ospf_state",
                  "route_missing", "uptime", "config_change", "syslog_match"}

DEFAULT_HTML_STATE = dedent("""\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

  <!-- Hero banner -->
  <tr>
    <td style="padding:0;line-height:0;">""" + _HERO_SVG + """</td>
  </tr>

  <!-- Header: green when resolved, severity color otherwise -->
  <tr>
    <td style="background:{{header_color}};padding:24px 32px;">
      <p style="margin:0 0 4px;color:rgba(255,255,255,0.7);font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">{{tag}} &middot; {{platform_name}}</p>
      <h1 style="margin:0 0 4px;color:#ffffff;font-size:20px;font-weight:700;line-height:1.35;">{{title}}</h1>
      <p style="margin:0;color:rgba(255,255,255,0.85);font-size:13px;font-weight:500;">{{device_name}}</p>
    </td>
  </tr>

  <!-- Body -->
  <tr>
    <td style="padding:28px 32px;">

      <!-- Core details -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
        <tr>
          <td style="font-size:13px;color:#64748b;padding:5px 0;width:110px;vertical-align:top;">Rule</td>
          <td style="font-size:13px;color:#1e293b;font-weight:500;padding:5px 0;">{{rule_name}}</td>
        </tr>
        <tr>
          <td style="font-size:13px;color:#64748b;padding:5px 0;">Severity</td>
          <td style="font-size:13px;font-weight:700;padding:5px 0;color:{{severity_color}};text-transform:capitalize;">{{severity}}</td>
        </tr>
        <tr>
          <td style="font-size:13px;color:#64748b;padding:5px 0;">Triggered</td>
          <td style="font-size:13px;color:#1e293b;padding:5px 0;">{{triggered_at}}</td>
        </tr>
        <!-- extra_rows: description, interface, prefix, neighbor, ospf_state — only when non-empty -->
        {{extra_rows}}
        <!-- resolved_row: shown only when alert is resolved, includes duration -->
        {{resolved_row}}
      </table>

      <!-- CTA button -->
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td align="center">
            <a href="{{alert_url}}" style="display:inline-block;background:#1e293b;color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;padding:12px 32px;border-radius:8px;letter-spacing:0.2px;">View alert &rarr;</a>
          </td>
        </tr>
      </table>

    </td>
  </tr>

  <!-- Footer -->
  <tr>
    <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 32px;text-align:center;">
      <p style="margin:0;font-size:11px;color:#94a3b8;">{{platform_name}} &middot; Ref&nbsp;{{alert_id}} &middot; <a href="{{alert_url}}" style="color:#94a3b8;text-decoration:underline;">Manage alert</a></p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>
""")


def _metric_defaults(metric: str) -> tuple[str, str]:
    """Return (default_subject, default_html) for a given metric."""
    subject = METRIC_DEFAULT_SUBJECTS.get(metric, DEFAULT_SUBJECT)
    html = DEFAULT_HTML_STATE if metric in _STATE_METRICS else DEFAULT_HTML
    return subject, html


class EmailTemplateStatus(BaseModel):
    metric: str
    label:  str
    is_custom: bool
    subject: str
    html: str


@router.get("/settings/email-templates", response_model=list[EmailTemplateStatus],
            summary="List all email templates (default + per-metric)")
async def list_email_templates(
    _: User = Depends(require_tenant_user("tenant_admin")),
    db: AsyncSession = Depends(get_db),
) -> list[EmailTemplateStatus]:
    _METRIC_LABELS = {
        "device_down": "Device unreachable", "interface_down": "Interface down",
        "interface_flap": "Interface flapping", "uptime": "Device rebooted",
        "temperature": "Temperature high", "cpu_util_pct": "CPU utilisation",
        "mem_util_pct": "Memory utilisation", "interface_errors": "Interface errors",
        "interface_util_pct": "Interface utilisation", "ospf_state": "OSPF neighbor issue",
        "route_missing": "Route missing", "custom_oid": "Custom OID",
    }
    # Load all template rows in one query
    rows = (await db.execute(
        select(SystemSetting).where(
            SystemSetting.key.in_(
                [_TEMPLATE_KEY] + [f"{_TEMPLATE_KEY}_{m}" for m in ALERT_METRICS]
            )
        )
    )).scalars().all()
    stored = {r.key: r.value for r in rows}

    result = []
    for metric in ALERT_METRICS:
        key = f"{_TEMPLATE_KEY}_{metric}"
        def_subj, def_html = _metric_defaults(metric)
        if key in stored and stored[key].get("html"):
            result.append(EmailTemplateStatus(
                metric=metric, label=_METRIC_LABELS.get(metric, metric),
                is_custom=True,
                subject=stored[key].get("subject", def_subj),
                html=stored[key]["html"],
            ))
        else:
            result.append(EmailTemplateStatus(
                metric=metric, label=_METRIC_LABELS.get(metric, metric),
                is_custom=False, subject=def_subj, html=def_html,
            ))
    return result


@router.get("/settings/email-templates/{metric}", response_model=EmailTemplateRead,
            summary="Get email template for a specific alert metric")
async def get_metric_template(
    metric: str,
    _: User = Depends(require_tenant_user("tenant_admin")),
    db: AsyncSession = Depends(get_db),
) -> EmailTemplateRead:
    if metric not in ALERT_METRICS:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Unknown metric")
    key = f"{_TEMPLATE_KEY}_{metric}"
    row = (await db.execute(select(SystemSetting).where(SystemSetting.key == key))).scalar_one_or_none()
    def_subj, def_html = _metric_defaults(metric)
    if row and row.value.get("html"):
        return EmailTemplateRead(
            subject=row.value.get("subject", def_subj),
            html=row.value["html"],
        )
    return EmailTemplateRead(subject=def_subj, html=def_html)


@router.put("/settings/email-templates/{metric}", response_model=EmailTemplateRead,
            summary="Save email template for a specific alert metric")
async def save_metric_template(
    metric: str,
    body: EmailTemplateWrite,
    _: User = Depends(require_tenant_user("tenant_admin")),
    db: AsyncSession = Depends(get_db),
) -> EmailTemplateRead:
    if metric not in ALERT_METRICS:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Unknown metric")
    key = f"{_TEMPLATE_KEY}_{metric}"
    row = (await db.execute(select(SystemSetting).where(SystemSetting.key == key))).scalar_one_or_none()
    value = {"subject": body.subject, "html": body.html}
    if row:
        row.value = value
    else:
        db.add(SystemSetting(key=key, value=value))
    await db.commit()
    return EmailTemplateRead(**value)


@router.delete("/settings/email-templates/{metric}", status_code=204, response_model=None,
               summary="Reset a metric email template to default")
async def reset_metric_template(
    metric: str,
    _: User = Depends(require_tenant_user("tenant_admin")),
    db: AsyncSession = Depends(get_db),
) -> None:
    if metric not in ALERT_METRICS:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Unknown metric")
    key = f"{_TEMPLATE_KEY}_{metric}"
    row = (await db.execute(select(SystemSetting).where(SystemSetting.key == key))).scalar_one_or_none()
    if row:
        await db.delete(row)
        await db.commit()


# ── Tenant settings ────────────────────────────────────────────────────────────

class TenantSettingsRead(BaseModel):
    name:          str
    slug:          str
    contact_name:  Optional[str] = None
    contact_email: Optional[str] = None
    notes:         Optional[str] = None


class TenantSettingsWrite(BaseModel):
    name:          str
    contact_name:  Optional[str] = None
    contact_email: Optional[str] = None
    notes:         Optional[str] = None


@router.get("/tenant", response_model=TenantSettingsRead,
            summary="Get current tenant identity and site settings")
async def get_tenant_settings(
    current_user: User = Depends(require_tenant_user("tenant_admin")),
    db: AsyncSession = Depends(get_db),
) -> TenantSettingsRead:
    tenant = (await db.execute(
        select(Tenant).where(Tenant.id == current_user.tenant_id)
    )).scalar_one()
    s = tenant.settings or {}
    return TenantSettingsRead(
        name=tenant.name,
        slug=tenant.slug,
        contact_name=s.get("contact_name"),
        contact_email=s.get("contact_email"),
        notes=s.get("notes"),
    )


@router.put("/tenant", response_model=TenantSettingsRead,
            summary="Update current tenant identity")
async def save_tenant_settings(
    body: TenantSettingsWrite,
    current_user: User = Depends(require_tenant_user("tenant_admin")),
    db: AsyncSession = Depends(get_db),
) -> TenantSettingsRead:
    tenant = (await db.execute(
        select(Tenant).where(Tenant.id == current_user.tenant_id)
    )).scalar_one()
    tenant.name = body.name.strip()
    tenant.settings = {
        **(tenant.settings or {}),
        "contact_name":  body.contact_name or None,
        "contact_email": body.contact_email or None,
        "notes":         body.notes or None,
    }
    await db.commit()
    await db.refresh(tenant)
    s = tenant.settings or {}
    return TenantSettingsRead(
        name=tenant.name,
        slug=tenant.slug,
        contact_name=s.get("contact_name"),
        contact_email=s.get("contact_email"),
        notes=s.get("notes"),
    )


# ── Tenant alerting settings (per-tenant overrides of platform defaults) ───────

class TenantAlertingSettings(BaseModel):
    device_down_stale_min_s:        int
    max_alerts_per_device_per_hour: int
    auto_close_stale_days:          int
    alert_retention_days:           int
    notifications_paused:           bool
    notifications_paused_until:     Optional[str] = None
    business_hours_enabled:         bool
    business_hours_start:           int
    business_hours_end:             int
    business_days:                  list[int]


class TenantAlertingSettingsRead(TenantAlertingSettings):
    # The platform-wide defaults for these same keys, so the UI can show
    # which fields this tenant has overridden vs. inherited.
    platform_defaults: dict


@router.get("/settings/alerting", response_model=TenantAlertingSettingsRead,
            summary="Get this tenant's effective alerting settings")
async def get_tenant_alerting_settings(
    current_user: User = Depends(require_tenant_user("tenant_admin")),
    db: AsyncSession = Depends(get_db),
) -> TenantAlertingSettingsRead:
    platform_defaults = await load_platform_defaults(db)
    effective = await get_effective_alerting_settings(db, current_user.tenant_id, platform_defaults)
    return TenantAlertingSettingsRead(
        **effective,
        platform_defaults={k: platform_defaults[k] for k in TENANT_OVERRIDABLE_KEYS},
    )


@router.put("/settings/alerting", response_model=TenantAlertingSettingsRead,
            summary="Set this tenant's alerting setting overrides")
async def save_tenant_alerting_settings(
    body: TenantAlertingSettings,
    current_user: User = Depends(require_tenant_user("tenant_admin")),
    db: AsyncSession = Depends(get_db),
) -> TenantAlertingSettingsRead:
    if not 1 <= body.alert_retention_days <= 3650:
        raise HTTPException(status_code=400, detail="alert_retention_days must be 1–3650")

    platform_defaults = await load_platform_defaults(db)

    # Only persist values that differ from the platform default, so this
    # tenant continues to track future platform-default changes for any
    # field it hasn't explicitly customized.
    overrides = {}
    for key in TENANT_OVERRIDABLE_KEYS:
        val = getattr(body, key)
        if val != platform_defaults[key]:
            overrides[key] = val

    tenant = (await db.execute(
        select(Tenant).where(Tenant.id == current_user.tenant_id)
    )).scalar_one()
    tenant.settings = {**(tenant.settings or {}), "alerting": overrides}
    await db.commit()
    logger.info("tenant_alerting_settings_updated",
                tenant_id=str(current_user.tenant_id), overrides=sorted(overrides.keys()))

    effective = {**{k: platform_defaults[k] for k in TENANT_OVERRIDABLE_KEYS}, **overrides}
    return TenantAlertingSettingsRead(
        **effective,
        platform_defaults={k: platform_defaults[k] for k in TENANT_OVERRIDABLE_KEYS},
    )


# ── Sites ──────────────────────────────────────────────────────────────────────

import uuid as _uuid
from sqlalchemy import func as sqla_func

from ..models.device import Device
from ..models.site import Site


class SiteRead(BaseModel):
    id:           _uuid.UUID
    name:         str
    description:  Optional[str] = None
    location:     Optional[str] = None
    device_count: int = 0


class SiteWrite(BaseModel):
    name:        str
    description: Optional[str] = None
    location:    Optional[str] = None


@router.get("/sites", response_model=list[SiteRead], summary="List sites for this tenant")
async def list_sites(
    current_user: User = Depends(require_tenant_user("tenant_admin")),
    db: AsyncSession = Depends(get_db),
) -> list[SiteRead]:
    rows = (await db.execute(
        select(
            Site.id, Site.name, Site.description, Site.location,
            sqla_func.count(Device.id).label("device_count"),
        )
        .outerjoin(Device, Device.site_id == Site.id)
        .where(Site.tenant_id == current_user.tenant_id)
        .group_by(Site.id)
        .order_by(Site.name)
    )).all()
    return [SiteRead(id=r.id, name=r.name, description=r.description,
                     location=r.location, device_count=r.device_count) for r in rows]


@router.post("/sites", response_model=SiteRead, status_code=201, summary="Create a site")
async def create_site(
    body: SiteWrite,
    current_user: User = Depends(require_tenant_user("tenant_admin")),
    db: AsyncSession = Depends(get_db),
) -> SiteRead:
    site = Site(
        tenant_id=current_user.tenant_id,
        name=body.name.strip(),
        description=body.description or None,
        location=body.location or None,
    )
    db.add(site)
    await db.commit()
    await db.refresh(site)
    return SiteRead(id=site.id, name=site.name, description=site.description,
                    location=site.location, device_count=0)


@router.patch("/sites/{site_id}", response_model=SiteRead, summary="Update a site")
async def update_site(
    site_id: _uuid.UUID,
    body: SiteWrite,
    current_user: User = Depends(require_tenant_user("tenant_admin")),
    db: AsyncSession = Depends(get_db),
) -> SiteRead:
    site = (await db.execute(
        select(Site).where(Site.id == site_id, Site.tenant_id == current_user.tenant_id)
    )).scalar_one_or_none()
    if not site:
        raise HTTPException(status_code=404, detail="Site not found")
    site.name = body.name.strip()
    site.description = body.description or None
    site.location = body.location or None
    await db.commit()
    await db.refresh(site)
    count = (await db.execute(
        select(sqla_func.count(Device.id)).where(Device.site_id == site.id)
    )).scalar_one()
    return SiteRead(id=site.id, name=site.name, description=site.description,
                    location=site.location, device_count=count)


@router.delete("/sites/{site_id}", status_code=204, response_model=None, summary="Delete a site")
async def delete_site(
    site_id: _uuid.UUID,
    current_user: User = Depends(require_tenant_user("tenant_admin")),
    db: AsyncSession = Depends(get_db),
) -> None:
    site = (await db.execute(
        select(Site).where(Site.id == site_id, Site.tenant_id == current_user.tenant_id)
    )).scalar_one_or_none()
    if not site:
        raise HTTPException(status_code=404, detail="Site not found")
    await db.delete(site)
    await db.commit()


class SiteDevicesWrite(BaseModel):
    device_ids: list[_uuid.UUID]


@router.get("/sites/{site_id}/devices", summary="List devices in a site")
async def get_site_devices(
    site_id: _uuid.UUID,
    current_user: User = Depends(require_tenant_user("tenant_admin")),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    site = (await db.execute(
        select(Site).where(Site.id == site_id, Site.tenant_id == current_user.tenant_id)
    )).scalar_one_or_none()
    if not site:
        raise HTTPException(status_code=404, detail="Site not found")
    devices = (await db.execute(
        select(Device.id, Device.hostname, Device.fqdn, Device.mgmt_ip, Device.vendor)
        .where(Device.site_id == site_id)
        .order_by(Device.hostname)
    )).all()
    return [{"id": str(d.id), "hostname": d.hostname, "fqdn": d.fqdn,
             "mgmt_ip": str(d.mgmt_ip) if d.mgmt_ip else None, "vendor": d.vendor}
            for d in devices]


@router.put("/sites/{site_id}/devices", summary="Set devices assigned to a site")
async def set_site_devices(
    site_id: _uuid.UUID,
    body: SiteDevicesWrite,
    current_user: User = Depends(require_tenant_user("tenant_admin")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    site = (await db.execute(
        select(Site).where(Site.id == site_id, Site.tenant_id == current_user.tenant_id)
    )).scalar_one_or_none()
    if not site:
        raise HTTPException(status_code=404, detail="Site not found")
    # Clear previous assignments for this site, then set new ones
    await db.execute(
        Device.__table__.update()
        .where(Device.site_id == site_id)
        .values(site_id=None)
    )
    if body.device_ids:
        await db.execute(
            Device.__table__.update()
            .where(
                Device.id.in_(body.device_ids),
                Device.tenant_id == current_user.tenant_id,
            )
            .values(site_id=site_id)
        )
    await db.commit()
    return {"assigned": len(body.device_ids)}


@router.get("/devices/unassigned", summary="List devices not assigned to any site")
async def get_unassigned_devices(
    current_user: User = Depends(require_tenant_user("tenant_admin")),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    devices = (await db.execute(
        select(Device.id, Device.hostname, Device.fqdn, Device.mgmt_ip, Device.vendor, Device.site_id)
        .where(Device.tenant_id == current_user.tenant_id)
        .order_by(Device.hostname)
    )).all()
    return [{"id": str(d.id), "hostname": d.hostname, "fqdn": d.fqdn,
             "mgmt_ip": str(d.mgmt_ip) if d.mgmt_ip else None,
             "vendor": d.vendor, "site_id": str(d.site_id) if d.site_id else None}
            for d in devices]


# ── Data management ────────────────────────────────────────────────────────────

from ..services.urls import ch_url


async def _ch_admin(query: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(ch_url(), content=" ".join(query.split()) + " FORMAT JSON",
                                 headers={"Content-Type": "text/plain"})
    resp.raise_for_status()
    return resp.json().get("data", [])


@router.get("/data/stats", summary="Storage usage stats across alerts, flow, and syslog")
async def data_stats(
    _: Principal = Depends(require_platform()),
    db: AsyncSession = Depends(get_db),
) -> dict:
    import re as _re
    from sqlalchemy import func, text
    from ..models.alert import Alert

    alert_count_row = (await db.execute(select(func.count()).select_from(Alert))).scalar_one()
    alert_size_row = (await db.execute(text(
        "SELECT pg_size_pretty(pg_total_relation_size('alerts'))"
    ))).scalar_one()
    oldest_alert = (await db.execute(
        select(func.min(Alert.triggered_at)).select_from(Alert)
    )).scalar_one_or_none()

    cb_count = (await db.execute(text("SELECT count(*) FROM config_backups"))).scalar_one()
    cb_size = (await db.execute(text(
        "SELECT pg_size_pretty(pg_total_relation_size('config_backups'))"
    ))).scalar_one()

    platform = await load_platform_defaults(db)

    # ClickHouse queries — degrade gracefully if unavailable
    ch_flow: list[dict] = []
    ch_flow_oldest: list[dict] = []
    ch_syslog: list[dict] = []
    ch_syslog_oldest: list[dict] = []
    ch_ttls: list[dict] = []
    try:
        ch_flow = await _ch_admin(
            "SELECT count() AS rows, formatReadableSize(sum(bytes_on_disk)) AS size "
            "FROM system.parts WHERE database='default' AND table='flow_records' AND active=1"
        )
        ch_flow_oldest = await _ch_admin(
            "SELECT min(flow_start) AS oldest FROM flow_records"
        )
        ch_syslog = await _ch_admin(
            "SELECT count() AS rows, formatReadableSize(sum(bytes_on_disk)) AS size "
            "FROM system.parts WHERE database='default' AND table='syslog_messages' AND active=1"
        )
        ch_syslog_oldest = await _ch_admin(
            "SELECT min(received_at) AS oldest FROM syslog_messages"
        )
        ch_ttls = await _ch_admin(
            "SELECT name, engine_full FROM system.tables "
            "WHERE database='default' AND name IN ('flow_records','syslog_messages')"
        )
    except Exception as exc:
        logger.warning("data_stats_clickhouse_unavailable", error=str(exc))

    def _ttl(engine_full: str) -> int:
        m = _re.search(r'toIntervalDay\((\d+)\)', engine_full)
        return int(m.group(1)) if m else 90

    def _oldest(rows: list[dict], key: str) -> Optional[str]:
        """Return ISO timestamp or None; treats epoch/zero as absent."""
        val = rows[0].get(key) if rows else None
        if not val:
            return None
        s = str(val)
        if s.startswith("0000") or s.startswith("1970-01-01 00:00:00") or s == "1970-01-01T00:00:00":
            return None
        return s

    ttl_map = {r["name"]: _ttl(r["engine_full"]) for r in ch_ttls}

    return {
        "alerts": {
            "count":          alert_count_row,
            "size":           alert_size_row,
            "oldest":         oldest_alert.isoformat() if oldest_alert else None,
            "retention_days": platform.get("alert_retention_days", 90),
        },
        "flow": {
            "rows":           int(ch_flow[0]["rows"]) if ch_flow else 0,
            "size":           ch_flow[0].get("size", "0 B") if ch_flow else "0 B",
            "oldest":         _oldest(ch_flow_oldest, "oldest"),
            "retention_days": ttl_map.get("flow_records", 90),
        },
        "syslog": {
            "rows":           int(ch_syslog[0]["rows"]) if ch_syslog else 0,
            "size":           ch_syslog[0].get("size", "0 B") if ch_syslog else "0 B",
            "oldest":         _oldest(ch_syslog_oldest, "oldest"),
            "retention_days": ttl_map.get("syslog_messages", 90),
        },
        "config": {
            "backup_count": cb_count,
            "size":         cb_size,
        },
    }


class RetentionUpdate(BaseModel):
    retention_days: int


@router.put("/data/retention/alerts", summary="Set alert retention days")
async def set_alert_retention(
    body: RetentionUpdate,
    _: Principal = Depends(require_platform()),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if not 1 <= body.retention_days <= 3650:
        raise HTTPException(status_code=400, detail="retention_days must be 1–3650")
    row = (await db.execute(
        select(PlatformSetting).where(PlatformSetting.key == "alert_retention_days")
    )).scalar_one_or_none()
    if row:
        row.value = body.retention_days
        row.updated_at = datetime.utcnow()
    else:
        db.add(PlatformSetting(key="alert_retention_days", value=body.retention_days))
    await db.commit()
    return {"retention_days": body.retention_days}


@router.put("/data/retention/flow", summary="Set flow data TTL in ClickHouse")
async def set_flow_retention(body: RetentionUpdate, _: Principal = Depends(require_platform())) -> dict:
    if not 1 <= body.retention_days <= 3650:
        raise HTTPException(status_code=400, detail="retention_days must be 1–3650")
    d = body.retention_days
    errors: list[str] = []
    for table, col in [("flow_records","flow_start"),("flow_agg_1min","minute"),
                       ("flow_agg_proto_5min","bucket"),("flow_agg_asn_5min","bucket"),
                       ("flow_agg_iface_1hr","hour")]:
        try:
            await _ch_admin(f"ALTER TABLE {table} MODIFY TTL toDateTime({col}) + toIntervalDay({d})")
        except Exception as exc:
            errors.append(f"{table}: {exc}")
    if errors:
        raise HTTPException(status_code=502, detail="Some TTLs failed to update: " + "; ".join(errors))
    return {"retention_days": d}


@router.put("/data/retention/syslog", summary="Set syslog data TTL in ClickHouse")
async def set_syslog_retention(body: RetentionUpdate, _: Principal = Depends(require_platform())) -> dict:
    if not 1 <= body.retention_days <= 3650:
        raise HTTPException(status_code=400, detail="retention_days must be 1–3650")
    d = body.retention_days
    errors: list[str] = []
    for table, col in [("syslog_messages","ts"),("syslog_agg_1hr","hour")]:
        try:
            await _ch_admin(f"ALTER TABLE {table} MODIFY TTL toDateTime({col}) + toIntervalDay({d})")
        except Exception as exc:
            errors.append(f"{table}: {exc}")
    if errors:
        raise HTTPException(status_code=502, detail="Some TTLs failed to update: " + "; ".join(errors))
    return {"retention_days": d}
