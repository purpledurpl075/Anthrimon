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
from ..dependencies import get_db, require_role
from ..models.settings import SystemSetting
from ..models.tenant import User
from ..schemas.admin import SmtpSettingsRead, SmtpSettingsWrite

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/admin", tags=["admin"])

_SMTP_KEY     = "smtp"
_TEMPLATE_KEY = "email_template"
_PLATFORM_KEY = "platform"

PLATFORM_DEFAULTS: dict = {
    # General
    "base_url":                      "",
    "platform_name":                 "Anthrimon",
    "timezone":                      "UTC",
    # Session & security
    "session_timeout_hours":         24,
    # Alerting engine
    "alert_eval_interval_s":         15,
    "default_renotify_s":            3600,
    "max_alerts_per_device_per_hour": 0,
    "auto_close_stale_days":         0,
    # Notifications
    "notifications_paused":          False,
    "notifications_paused_until":    None,
    "business_hours_enabled":        False,
    "business_hours_start":          8,
    "business_hours_end":            18,
    "business_days":                 [0, 1, 2, 3, 4],
    # Data
    "alert_retention_days":          90,
    # Threat intelligence
    "abuseipdb_api_key":             "",
    # Remote collectors
    "wg_public_endpoint":            "",
}


class PlatformSettingsRead(BaseModel):
    base_url:                       str
    platform_name:                  str
    timezone:                       str
    session_timeout_hours:          int
    alert_eval_interval_s:          int
    default_renotify_s:             int
    max_alerts_per_device_per_hour: int
    auto_close_stale_days:          int
    notifications_paused:           bool
    notifications_paused_until:     Optional[str]
    business_hours_enabled:         bool
    business_hours_start:           int
    business_hours_end:             int
    business_days:                  list[int]
    alert_retention_days:           int
    abuseipdb_api_key:              str        = ""
    wg_public_endpoint:             str        = ""


class PlatformSettingsWrite(BaseModel):
    base_url:                       str        = ""
    platform_name:                  str        = "Anthrimon"
    timezone:                       str        = "UTC"
    session_timeout_hours:          int        = 24
    alert_eval_interval_s:          int        = 15
    default_renotify_s:             int        = 3600
    max_alerts_per_device_per_hour: int        = 0
    auto_close_stale_days:          int        = 0
    notifications_paused:           bool       = False
    notifications_paused_until:     Optional[str] = None
    business_hours_enabled:         bool       = False
    business_hours_start:           int        = 8
    business_hours_end:             int        = 18
    business_days:                  list[int]  = [0, 1, 2, 3, 4]
    alert_retention_days:           int        = 90
    abuseipdb_api_key:              str        = ""
    wg_public_endpoint:             str        = ""

DEFAULT_SUBJECT  = "[{{tag}}] {{title}}"

_HERO_SVG = """<img src="data:image/png;base64,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" width="560" alt="Anthrimon" style="display:block;border:0;" />"""


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
    _: User = Depends(require_role("admin", "superadmin")),
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
    _: User = Depends(require_role("admin", "superadmin")),
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
    _: User = Depends(require_role("admin", "superadmin")),
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
    _: User = Depends(require_role("admin", "superadmin")),
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
    _: User = Depends(require_role("admin", "superadmin")),
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
    _: User = Depends(require_role("admin", "superadmin")),
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
    _: User = Depends(require_role("admin", "superadmin")),
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
    _: User = Depends(require_role("admin", "superadmin")),
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
    _: User = Depends(require_role("admin", "superadmin")),
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
    _: User = Depends(require_role("admin", "superadmin")),
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


# ── Platform settings ──────────────────────────────────────────────────────────

async def load_platform_settings(db: AsyncSession) -> dict:
    """Return merged platform settings (stored overrides + defaults)."""
    row = (await db.execute(
        select(SystemSetting).where(SystemSetting.key == _PLATFORM_KEY)
    )).scalar_one_or_none()
    stored = row.value if row else {}
    return {**PLATFORM_DEFAULTS, **stored}


@router.get("/settings/platform", response_model=PlatformSettingsRead,
            summary="Get platform-wide configuration")
async def get_platform_settings(
    _: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> PlatformSettingsRead:
    cfg = await load_platform_settings(db)
    return PlatformSettingsRead(**cfg)


@router.put("/settings/platform", response_model=PlatformSettingsRead,
            summary="Save platform-wide configuration")
async def save_platform_settings(
    body: PlatformSettingsWrite,
    _: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> PlatformSettingsRead:
    value = body.model_dump()
    row = (await db.execute(
        select(SystemSetting).where(SystemSetting.key == _PLATFORM_KEY)
    )).scalar_one_or_none()
    if row:
        row.value = value
    else:
        db.add(SystemSetting(key=_PLATFORM_KEY, value=value))
    await db.commit()
    logger.info("platform_settings_updated")
    return PlatformSettingsRead(**value)


# ── Data management ────────────────────────────────────────────────────────────

_CH_URL = "http://localhost:8123"


async def _ch_admin(query: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(_CH_URL, content=" ".join(query.split()) + " FORMAT JSON",
                                 headers={"Content-Type": "text/plain"})
    resp.raise_for_status()
    return resp.json().get("data", [])


@router.get("/data/stats", summary="Storage usage stats across alerts, flow, and syslog")
async def data_stats(
    _: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> dict:
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

    import re as _re
    def _ttl(engine_full: str) -> int:
        m = _re.search(r'toIntervalDay\((\d+)\)', engine_full)
        return int(m.group(1)) if m else 90

    ttl_map = {r["name"]: _ttl(r["engine_full"]) for r in ch_ttls}
    platform = await load_platform_settings(db)

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
            "oldest":         ch_flow_oldest[0].get("oldest") if ch_flow_oldest else None,
            "retention_days": ttl_map.get("flow_records", 90),
        },
        "syslog": {
            "rows":           int(ch_syslog[0]["rows"]) if ch_syslog else 0,
            "size":           ch_syslog[0].get("size", "0 B") if ch_syslog else "0 B",
            "oldest":         ch_syslog_oldest[0].get("oldest") if ch_syslog_oldest else None,
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
    current_user: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if not 1 <= body.retention_days <= 3650:
        raise HTTPException(status_code=400, detail="retention_days must be 1–3650")
    settings = await load_platform_settings(db)
    settings["alert_retention_days"] = body.retention_days
    row = (await db.execute(
        select(SystemSetting).where(SystemSetting.key == _PLATFORM_KEY)
    )).scalar_one_or_none()
    if row:
        row.value = settings
    else:
        db.add(SystemSetting(key=_PLATFORM_KEY, value=settings))
    await db.commit()
    return {"retention_days": body.retention_days}


@router.put("/data/retention/flow", summary="Set flow data TTL in ClickHouse")
async def set_flow_retention(body: RetentionUpdate, _: User = Depends(require_role("admin", "superadmin"))) -> dict:
    if not 1 <= body.retention_days <= 3650:
        raise HTTPException(status_code=400, detail="retention_days must be 1–3650")
    d = body.retention_days
    for table, col in [("flow_records","flow_start"),("flow_agg_1min","minute"),
                       ("flow_agg_proto_5min","bucket"),("flow_agg_asn_5min","bucket"),
                       ("flow_agg_iface_1hr","hour")]:
        await _ch_admin(f"ALTER TABLE {table} MODIFY TTL toDateTime({col}) + toIntervalDay({d})")
    return {"retention_days": d}


@router.put("/data/retention/syslog", summary="Set syslog data TTL in ClickHouse")
async def set_syslog_retention(body: RetentionUpdate, _: User = Depends(require_role("admin", "superadmin"))) -> dict:
    if not 1 <= body.retention_days <= 3650:
        raise HTTPException(status_code=400, detail="retention_days must be 1–3650")
    d = body.retention_days
    for table, col in [("syslog_messages","ts"),("syslog_agg_1hr","hour")]:
        await _ch_admin(f"ALTER TABLE {table} MODIFY TTL toDateTime({col}) + toIntervalDay({d})")
    return {"retention_days": d}
