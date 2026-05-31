from __future__ import annotations

import asyncio
import re
import smtplib
import ssl
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import TYPE_CHECKING, Optional

import structlog
from sqlalchemy import select

from .. import crypto
from ..database import AsyncSessionLocal
from ..models.alert import NotificationChannel
from ..models.settings import SystemSetting

if TYPE_CHECKING:
    from ..models.alert import Alert, AlertRule

logger = structlog.get_logger(__name__)

_SMTP_KEY     = "smtp"
_TEMPLATE_KEY = "email_template"

_SEVERITY_COLOR = {
    "critical": "#dc2626",
    "major":    "#ea580c",
    "minor":    "#d97706",
    "warning":  "#ca8a04",
    "info":     "#2563eb",
}


def _render(template: str, ctx: dict) -> str:
    return re.sub(r'\{\{(\w+)\}\}', lambda m: str(ctx.get(m.group(1), '')), template)


async def _load_smtp(db: AsyncSession) -> Optional[dict]:
    """Load and decrypt SMTP server config from system_settings."""
    try:
        row = (await db.execute(
            select(SystemSetting).where(SystemSetting.key == _SMTP_KEY)
        )).scalar_one_or_none()
    except Exception:
        # Table doesn't exist yet (migration pending) — treat as unconfigured.
        return None
    if row is None or not row.value.get("host"):
        return None
    cfg = dict(row.value)
    if cfg.get("password") and crypto.is_configured():
        try:
            cfg["password"] = crypto.decrypt(cfg["password"])
        except Exception:
            cfg["password"] = ""
    return cfg


async def dispatch(alert: Alert, rule: AlertRule, *, resolved: bool = False) -> None:
    """Send notifications for an alert. Opens its own DB session — never call inside an eval transaction."""
    if not rule.channel_ids:
        return

    async with AsyncSessionLocal() as db:
        channels = (await db.execute(
            select(NotificationChannel).where(
                NotificationChannel.id.in_([str(c) for c in rule.channel_ids]),
                NotificationChannel.is_enabled == True,  # noqa: E712
            )
        )).scalars().all()

        email_channels = [c for c in channels if c.type == "email"]
        other_channels = [c for c in channels if c.type != "email"]

        for c in other_channels:
            logger.debug("notify_channel_type_not_implemented", type=c.type)

        if not email_channels:
            return

        smtp = await _load_smtp(db)

    if smtp is None:
        logger.warning("notify_smtp_not_configured", alert_id=str(alert.id))
        return

    async with AsyncSessionLocal() as tdb:
        # Try metric-specific template first, fall back to global default
        metric_key = f"{_TEMPLATE_KEY}_{rule.metric}"
        mrow = (await tdb.execute(
            select(SystemSetting).where(SystemSetting.key == metric_key)
        )).scalar_one_or_none()
        if mrow and mrow.value.get("html"):
            tmpl_subject = mrow.value.get("subject")
            tmpl_html    = mrow.value.get("html")
        else:
            trow = (await tdb.execute(
                select(SystemSetting).where(SystemSetting.key == _TEMPLATE_KEY)
            )).scalar_one_or_none()
            tmpl_subject = trow.value.get("subject") if trow else None
            tmpl_html    = trow.value.get("html")    if trow else None

        prow = (await tdb.execute(
            select(SystemSetting).where(SystemSetting.key == "platform")
        )).scalar_one_or_none()
        platform = prow.value if prow else {}

    # ── Global notification pause ──────────────────────────────────────────────
    if platform.get("notifications_paused"):
        paused_until = platform.get("notifications_paused_until")
        if paused_until is None:
            logger.info("notify_skipped_paused", alert_id=str(alert.id))
            return
        try:
            resume = datetime.fromisoformat(paused_until)
            if resume.tzinfo is None:
                resume = resume.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) < resume:
                logger.info("notify_skipped_paused", alert_id=str(alert.id))
                return
        except (ValueError, TypeError):
            pass

    # ── Business hours check ───────────────────────────────────────────────────
    if platform.get("business_hours_enabled") and not resolved:
        try:
            import zoneinfo
            tz_name = platform.get("timezone", "UTC")
            tz = zoneinfo.ZoneInfo(tz_name)
            now_local = datetime.now(tz)
            bh_start   = int(platform.get("business_hours_start", 8))
            bh_end     = int(platform.get("business_hours_end",   18))
            biz_days   = platform.get("business_days", [0, 1, 2, 3, 4])
            weekday    = now_local.weekday()  # Mon=0, Sun=6
            hour       = now_local.hour
            in_hours   = weekday in biz_days and bh_start <= hour < bh_end
            if not in_hours:
                logger.info("notify_skipped_outside_business_hours", alert_id=str(alert.id))
                return
        except Exception:
            pass

    subject, plain, html = _build_email(alert, rule, resolved, tmpl_subject, tmpl_html, platform)
    loop = asyncio.get_running_loop()

    for channel in email_channels:
        recipients: list[str] = channel.config.get("to", [])
        if not recipients:
            continue
        try:
            await loop.run_in_executor(None, _send_smtp, smtp, recipients, subject, plain, html)
            logger.info("notify_sent", channel_id=str(channel.id), type="email",
                        alert_id=str(alert.id), resolved=resolved)
        except Exception as exc:
            logger.error("notify_dispatch_error", channel_id=str(channel.id),
                         alert_id=str(alert.id), error=str(exc))


def _build_email(
    alert: Alert, rule: AlertRule, resolved: bool,
    tmpl_subject: Optional[str] = None,
    tmpl_html: Optional[str] = None,
    platform: Optional[dict] = None,
) -> tuple[str, str, str]:
    from ..routers.admin import DEFAULT_SUBJECT, DEFAULT_HTML

    import zoneinfo
    platform      = platform or {}
    tag           = "RESOLVED" if resolved else alert.severity.upper()
    alert_ctx     = alert.context or {}
    sev_color     = _SEVERITY_COLOR.get(alert.severity, "#475569")
    base_url      = platform.get("base_url", "").rstrip("/")
    platform_name = platform.get("platform_name", "Anthrimon")

    try:
        tz = zoneinfo.ZoneInfo(platform.get("timezone", "UTC"))
    except Exception:
        tz = zoneinfo.ZoneInfo("UTC")

    def _fmt_ts(dt: Optional[datetime]) -> str:
        if not dt:
            return "—"
        return dt.astimezone(tz).strftime("%Y-%m-%d %H:%M %Z")

    ctx = {
        "tag":            tag,
        "title":          alert.title,
        "metric":         alert_ctx.get("metric", rule.metric),
        "severity":       alert.severity,
        "severity_color": sev_color,
        "status":         "resolved" if resolved else alert.status,
        "rule_name":      rule.name,
        "description":    rule.description or "",
        "device_name":    alert_ctx.get("device_name", ""),
        "value":          str(alert_ctx["value"])     if alert_ctx.get("value")     is not None else "—",
        "threshold":      str(alert_ctx["threshold"]) if alert_ctx.get("threshold") is not None else "—",
        "interface_name": alert_ctx.get("interface_name", ""),
        "prefix":         alert_ctx.get("prefix", ""),
        "neighbor":       alert_ctx.get("neighbor", ""),
        "ospf_state":     alert_ctx.get("ospf_state", ""),
        "triggered_at":   _fmt_ts(alert.triggered_at),
        "resolved_at":    _fmt_ts(alert.resolved_at),
        "alert_url":      f"{base_url}/alerts/{alert.id}" if base_url else "",
        "alert_id":       str(alert.id),
        "platform_name":  platform_name,
    }

    # ── Pre-render conditional HTML blocks ────────────────────────────────────
    # Header uses green for resolved, severity color for active alerts.
    header_color = "#16a34a" if resolved else sev_color

    # Human-readable duration for resolved alerts.
    duration = ""
    if resolved and alert.triggered_at and alert.resolved_at:
        secs = int((alert.resolved_at - alert.triggered_at).total_seconds())
        if secs < 60:      duration = f"{secs}s"
        elif secs < 3600:  duration = f"{secs // 60}m {secs % 60}s"
        elif secs < 86400: duration = f"{secs // 3600}h {(secs % 3600) // 60}m"
        else:              duration = f"{secs // 86400}d {(secs % 86400) // 3600}h"

    # Value/threshold card: only render when both values are present.
    _card_cell = "padding:14px 20px;"
    _card_lbl  = "margin:0;font-size:10px;font-weight:700;letter-spacing:1px;color:#94a3b8;text-transform:uppercase;"
    _card_val  = "margin:4px 0 0;font-size:22px;font-weight:700;color:#0f172a;"
    if alert_ctx.get("value") is not None and alert_ctx.get("threshold") is not None:
        value_card = (
            '<table width="100%" cellpadding="0" cellspacing="0"'
            ' style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:20px;">'
            '<tr>'
            f'<td style="{_card_cell}border-right:1px solid #e2e8f0;width:50%;">'
            f'<p style="{_card_lbl}">Value</p>'
            f'<p style="{_card_val}">{ctx["value"]}</p></td>'
            f'<td style="{_card_cell}width:50%;">'
            f'<p style="{_card_lbl}">Threshold</p>'
            f'<p style="{_card_val}">{ctx["threshold"]}</p></td>'
            '</tr></table>'
        )
    else:
        value_card = ""

    # Extra detail rows: description + type-specific fields, only when non-empty.
    _lbl  = 'style="font-size:13px;color:#64748b;padding:5px 0;width:110px;vertical-align:top;"'
    _cell = 'style="font-size:13px;color:#1e293b;font-weight:500;padding:5px 0;"'
    _mono = 'style="font-size:12px;color:#1e293b;font-weight:500;padding:5px 0;font-family:ui-monospace,monospace;"'
    _extra: list[str] = []
    if rule.description:
        _extra.append(f'<tr><td {_lbl}>Note</td><td {_cell}>{rule.description}</td></tr>')
    if alert_ctx.get("interface_name"):
        _extra.append(f'<tr><td {_lbl}>Interface</td><td {_mono}>{ctx["interface_name"]}</td></tr>')
    if alert_ctx.get("prefix"):
        _extra.append(f'<tr><td {_lbl}>Prefix</td><td {_mono}>{ctx["prefix"]}</td></tr>')
    if alert_ctx.get("neighbor"):
        _extra.append(f'<tr><td {_lbl}>Neighbor</td><td {_mono}>{ctx["neighbor"]}</td></tr>')
    if alert_ctx.get("ospf_state"):
        _extra.append(f'<tr><td {_lbl}>OSPF State</td><td {_mono}>{ctx["ospf_state"]}</td></tr>')
    extra_rows = "\n        ".join(_extra)

    # Resolved row: only shown when the alert is actually resolved.
    if resolved:
        dur_span = (f" &nbsp;<span style='color:#94a3b8;font-size:11px;font-weight:400;'>({duration})</span>"
                    if duration else "")
        resolved_row = f'<tr><td {_lbl}>Resolved</td><td {_cell}>{ctx["resolved_at"]}{dur_span}</td></tr>'
    else:
        resolved_row = ""

    ctx.update({
        "header_color": header_color,
        "value_card":   value_card,
        "extra_rows":   extra_rows,
        "resolved_row": resolved_row,
        "duration":     duration,
    })

    subject = _render(tmpl_subject or DEFAULT_SUBJECT, ctx)
    html    = _render(tmpl_html    or DEFAULT_HTML,    ctx)

    # ── Plain-text fallback ────────────────────────────────────────────────────
    plain_lines = [
        f"[{tag}] {ctx['title']}",
        f"Device:    {ctx['device_name']}" if ctx["device_name"] else "",
        "",
        f"Rule:      {ctx['rule_name']}",
        f"Severity:  {ctx['severity']}",
        f"Status:    {ctx['status']}",
        f"Triggered: {ctx['triggered_at']}",
    ]
    if alert_ctx.get("value") is not None:
        plain_lines.append(f"Value:     {ctx['value']}")
    if alert_ctx.get("threshold") is not None:
        plain_lines.append(f"Threshold: {ctx['threshold']}")
    if rule.description:
        plain_lines.append(f"Note:      {rule.description}")
    if alert_ctx.get("interface_name"):
        plain_lines.append(f"Interface: {ctx['interface_name']}")
    if alert_ctx.get("prefix"):
        plain_lines.append(f"Prefix:    {ctx['prefix']}")
    if alert_ctx.get("neighbor"):
        plain_lines.append(f"Neighbor:  {ctx['neighbor']}")
    if alert_ctx.get("ospf_state"):
        plain_lines.append(f"OSPF State:{ctx['ospf_state']}")
    if resolved:
        dur_txt = f" ({duration})" if duration else ""
        plain_lines.append(f"Resolved:  {ctx['resolved_at']}{dur_txt}")
    plain_lines = [l for l in plain_lines if l is not None]
    if ctx["alert_url"]:
        plain_lines += ["", f"View alert: {ctx['alert_url']}"]
    plain_lines.append(f"Alert ID:   {ctx['alert_id']}")

    return subject, "\n".join(plain_lines), html


def _build_test_email() -> tuple[str, str]:
    subject = "[TEST] Anthrimon notification test"
    body = "\n".join([
        "This is a test notification from Anthrimon.",
        f"Sent at: {datetime.now(timezone.utc).isoformat()}",
        "If you received this, SMTP is configured correctly.",
    ])
    return subject, body


def _send_smtp(smtp: dict, recipients: list[str], subject: str, body_plain: str, body_html: str = "") -> None:
    """Blocking SMTP send — always call via run_in_executor."""
    host      = smtp.get("host", "")
    port      = int(smtp.get("port", 587))
    user      = smtp.get("user", "")
    password  = smtp.get("password", "")
    from_addr = smtp.get("from_addr", "") or smtp.get("user", "anthrimon@localhost")
    use_ssl   = bool(smtp.get("ssl", False))

    if body_html:
        msg = MIMEMultipart("alternative")
        msg.attach(MIMEText(body_plain, "plain"))
        msg.attach(MIMEText(body_html,  "html"))
    else:
        msg = MIMEText(body_plain)
    msg["Subject"] = subject
    msg["From"]    = from_addr
    msg["To"]      = ", ".join(recipients)

    if use_ssl:
        ctx = ssl.create_default_context()
        with smtplib.SMTP_SSL(host, port, context=ctx) as srv:
            if user:
                srv.login(user, password)
            srv.sendmail(from_addr, recipients, msg.as_string())
    else:
        with smtplib.SMTP(host, port) as srv:
            srv.ehlo()
            if srv.has_extn("STARTTLS"):
                srv.starttls()
                srv.ehlo()
            if user:
                srv.login(user, password)
            srv.sendmail(from_addr, recipients, msg.as_string())
