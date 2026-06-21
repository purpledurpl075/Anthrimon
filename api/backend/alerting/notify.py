from __future__ import annotations

import asyncio
import hashlib
import hmac as _hmac
import json
import re
import smtplib
import ssl
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import TYPE_CHECKING, Optional

import ipaddress
import socket
from urllib.parse import urlparse

import httpx
import structlog
from sqlalchemy import select, text

from .. import crypto
from ..database import AsyncSessionLocal
from ..models.alert import NotificationChannel, NotificationSendLog
from ..models.settings import SystemSetting
from .settings import get_effective_alerting_settings, load_platform_defaults

if TYPE_CHECKING:
    from ..models.alert import Alert, AlertRule

logger = structlog.get_logger(__name__)

_BLOCKED_NETS = [
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fd00::/8"),
    ipaddress.ip_network("fe80::/10"),
]


def _is_url_safe(url: str) -> bool:
    """Return False if the URL resolves to a private/loopback/link-local IP."""
    try:
        parsed = urlparse(url)
        host = parsed.hostname
        if not host:
            return False
        addrs = socket.getaddrinfo(host, parsed.port or 443, proto=socket.IPPROTO_TCP)
        for family, _type, _proto, _canon, sockaddr in addrs:
            ip = ipaddress.ip_address(sockaddr[0])
            for net in _BLOCKED_NETS:
                if ip in net:
                    logger.warning("webhook_url_blocked", url=url, resolved_ip=str(ip), blocked_by=str(net))
                    return False
    except (socket.gaierror, ValueError, OSError):
        logger.warning("webhook_url_resolve_failed", url=url)
        return False
    return True


_SMTP_KEY     = "smtp"
_TEMPLATE_KEY = "email_template"

_SEVERITY_COLOR = {
    "critical": "#dc2626",
    "major":    "#ea580c",
    "minor":    "#d97706",
    "warning":  "#ca8a04",
    "info":     "#2563eb",
}

_PD_SEVERITY = {
    "critical": "critical",
    "major":    "error",
    "minor":    "warning",
    "warning":  "warning",
    "info":     "info",
}


def _render(template: str, ctx: dict) -> str:
    return re.sub(r'\{\{(\w+)\}\}', lambda m: str(ctx.get(m.group(1), '')), template)


async def _with_retry(fn, max_attempts: int = 3) -> tuple[bool, Optional[str], int]:
    """Call async fn() up to max_attempts times with exponential backoff.
    Returns (success, error_str, attempts_used)."""
    last_exc: Optional[Exception] = None
    for attempt in range(max_attempts):
        try:
            await fn()
            return True, None, attempt + 1
        except Exception as exc:
            last_exc = exc
            if attempt < max_attempts - 1:
                await asyncio.sleep(2 ** attempt)
    return False, str(last_exc), max_attempts


async def _log_send(
    channel_id, tenant_id, alert_id,
    event: str, status: str, error: Optional[str], attempts: int,
) -> None:
    try:
        async with AsyncSessionLocal() as db:
            db.add(NotificationSendLog(
                channel_id=channel_id,
                tenant_id=tenant_id,
                alert_id=alert_id,
                event=event,
                status=status,
                error=error,
                attempts=attempts,
            ))
            await db.commit()
    except Exception as exc:
        logger.error("notify_log_write_failed", error=str(exc))


async def _load_smtp(db) -> Optional[dict]:
    """Load and decrypt SMTP server config from system_settings."""
    try:
        row = (await db.execute(
            select(SystemSetting).where(SystemSetting.key == _SMTP_KEY)
        )).scalar_one_or_none()
    except Exception:
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


def _build_ctx(alert: Alert, rule: AlertRule, resolved: bool, platform: Optional[dict] = None) -> dict:
    """Build common notification context dict shared by all channel types."""
    import zoneinfo
    platform  = platform or {}
    tag       = "RESOLVED" if resolved else alert.severity.upper()
    alert_ctx = alert.context or {}
    sev_color = _SEVERITY_COLOR.get(alert.severity, "#475569")
    base_url  = platform.get("base_url", "").rstrip("/")

    try:
        tz = zoneinfo.ZoneInfo(platform.get("timezone", "UTC"))
    except Exception:
        tz = zoneinfo.ZoneInfo("UTC")

    def _fmt_ts(dt: Optional[datetime]) -> str:
        if not dt:
            return "—"
        return dt.astimezone(tz).strftime("%Y-%m-%d %H:%M %Z")

    return {
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
        "platform_name":  platform.get("platform_name", "Anthrimon"),
        "base_url":       base_url,
        "revived_child_count": int(alert_ctx.get("revived_child_count", 0)) if resolved else 0,
    }


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

        if not channels:
            return

        email_channels = [c for c in channels if c.type == "email"]
        smtp = await _load_smtp(db) if email_channels else None

        # Email template
        tmpl_subject: Optional[str] = None
        tmpl_html:    Optional[str] = None
        if email_channels:
            metric_key = f"{_TEMPLATE_KEY}_{rule.metric}"
            mrow = (await db.execute(
                select(SystemSetting).where(SystemSetting.key == metric_key)
            )).scalar_one_or_none()
            if mrow and mrow.value.get("html"):
                tmpl_subject = mrow.value.get("subject")
                tmpl_html    = mrow.value.get("html")
            else:
                trow = (await db.execute(
                    select(SystemSetting).where(SystemSetting.key == _TEMPLATE_KEY)
                )).scalar_one_or_none()
                tmpl_subject = trow.value.get("subject") if trow else None
                tmpl_html    = trow.value.get("html")    if trow else None

        platform = await load_platform_defaults(db)
        tenant_settings = await get_effective_alerting_settings(
            db, alert.tenant_id, platform_defaults=platform,
        )

    # ── Notification pause (tenant-overridable) ─────────────────────────────────
    if tenant_settings.get("notifications_paused"):
        paused_until = tenant_settings.get("notifications_paused_until")
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
            # Resume time has passed — remove the stale override so the UI
            # badge clears without waiting for the next housekeeping tick.
            async with AsyncSessionLocal() as _db:
                await _db.execute(text("""
                    UPDATE tenants
                    SET settings = jsonb_set(
                        settings,
                        '{alerting}',
                        COALESCE(settings->'alerting', '{}')::jsonb
                        - 'notifications_paused'
                        - 'notifications_paused_until'
                    )
                    WHERE id = CAST(:tid AS uuid)
                      AND (settings->'alerting'->>'notifications_paused')::boolean = true
                """), {"tid": str(alert.tenant_id)})
                await _db.commit()
            logger.info("notification_pause_auto_cleared_on_dispatch", tenant_id=str(alert.tenant_id))
        except (ValueError, TypeError):
            pass

    # ── Business hours check (tenant-overridable) ────────────────────────────────
    if tenant_settings.get("business_hours_enabled") and not resolved:
        try:
            import zoneinfo
            tz_name  = platform.get("timezone", "UTC")
            tz       = zoneinfo.ZoneInfo(tz_name)
            now_local = datetime.now(tz)
            bh_start  = int(tenant_settings.get("business_hours_start", 8))
            bh_end    = int(tenant_settings.get("business_hours_end",   18))
            biz_days  = tenant_settings.get("business_days", [0, 1, 2, 3, 4])
            in_hours  = now_local.weekday() in biz_days and bh_start <= now_local.hour < bh_end
            if not in_hours:
                logger.info("notify_skipped_outside_business_hours", alert_id=str(alert.id))
                return
        except Exception:
            pass

    ctx   = _build_ctx(alert, rule, resolved, platform)
    loop  = asyncio.get_running_loop()
    event = "alert.resolved" if resolved else "alert.fired"

    for channel in channels:
        send_fn: Optional[object] = None

        if channel.type == "email":
            if smtp is None:
                logger.warning("notify_smtp_not_configured", alert_id=str(alert.id))
                continue
            recipients: list[str] = channel.config.get("to", [])
            if not recipients:
                continue
            subject, plain, html = _build_email(alert, rule, resolved, tmpl_subject, tmpl_html, platform, ctx)
            async def _send_email_fn(s=smtp, r=recipients, su=subject, p=plain, h=html):
                await loop.run_in_executor(None, _send_smtp, s, r, su, p, h)
            send_fn = _send_email_fn

        elif channel.type == "slack":
            webhook_url = channel.config.get("webhook_url", "")
            if not webhook_url:
                logger.warning("notify_slack_no_webhook", channel_id=str(channel.id))
                continue
            async def _send_slack_fn(u=webhook_url, c=ctx):
                await _send_slack(u, c)
            send_fn = _send_slack_fn

        elif channel.type == "webhook":
            url = channel.config.get("url", "")
            if not url:
                logger.warning("notify_webhook_no_url", channel_id=str(channel.id))
                continue
            async def _send_webhook_fn(u=url, s=channel.config.get("secret"), c=ctx):
                await _send_webhook(u, s, c)
            send_fn = _send_webhook_fn

        elif channel.type == "pagerduty":
            key = channel.config.get("integration_key", "")
            if not key:
                logger.warning("notify_pagerduty_no_key", channel_id=str(channel.id))
                continue
            async def _send_pd_fn(k=key, c=ctx, aid=str(alert.id), r=resolved):
                await _send_pagerduty(k, c, aid, r)
            send_fn = _send_pd_fn

        elif channel.type == "teams":
            webhook_url = channel.config.get("webhook_url", "")
            if not webhook_url:
                logger.warning("notify_teams_no_webhook", channel_id=str(channel.id))
                continue
            async def _send_teams_fn(u=webhook_url, c=ctx):
                await _send_teams(u, c)
            send_fn = _send_teams_fn

        if send_fn is None:
            continue

        ok, err, attempts = await _with_retry(send_fn)
        await _log_send(channel.id, channel.tenant_id, alert.id, event,
                        "success" if ok else "failure", err, attempts)
        if ok:
            logger.info("notify_sent", channel_id=str(channel.id), type=channel.type,
                        alert_id=str(alert.id), resolved=resolved)
        else:
            logger.error("notify_dispatch_error", channel_id=str(channel.id),
                         type=channel.type, alert_id=str(alert.id),
                         attempts=attempts, error=err)


# ── Slack ──────────────────────────────────────────────────────────────────────

async def _send_slack(webhook_url: str, ctx: dict) -> None:
    if not _is_url_safe(webhook_url):
        raise ValueError(f"Webhook URL resolves to a blocked private/internal address")
    tag   = ctx["tag"]
    color = "#16a34a" if ctx["tag"] == "RESOLVED" else ctx["severity_color"]

    fields = []
    if ctx.get("device_name"):
        fields.append({"type": "mrkdwn", "text": f"*Device:*\n{ctx['device_name']}"})
    fields.append({"type": "mrkdwn", "text": f"*Severity:*\n{ctx['severity'].capitalize()}"})
    fields.append({"type": "mrkdwn", "text": f"*Rule:*\n{ctx['rule_name']}"})
    if ctx["value"] != "—":
        fields.append({"type": "mrkdwn", "text": f"*Value:*\n{ctx['value']}"})
    if ctx["threshold"] != "—":
        fields.append({"type": "mrkdwn", "text": f"*Threshold:*\n{ctx['threshold']}"})
    if ctx.get("interface_name"):
        fields.append({"type": "mrkdwn", "text": f"*Interface:*\n{ctx['interface_name']}"})

    blocks: list[dict] = [
        {"type": "header", "text": {"type": "plain_text", "text": f"[{tag}] {ctx['title']}", "emoji": True}},
    ]
    if fields:
        blocks.append({"type": "section", "fields": fields[:10]})
    if ctx.get("description"):
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": ctx["description"]}})
    if ctx.get("revived_child_count"):
        n = ctx["revived_child_count"]
        blocks.append({"type": "section", "text": {"type": "mrkdwn",
            "text": f":arrow_up: Re-evaluating *{n}* previously-suppressed child alert{'s' if n != 1 else ''}."}})
    if ctx.get("alert_url"):
        blocks.append({
            "type": "actions",
            "elements": [{"type": "button", "text": {"type": "plain_text", "text": "View Alert"},
                          "url": ctx["alert_url"]}],
        })

    payload = {"blocks": blocks, "text": f"[{tag}] {ctx['title']}"}
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(webhook_url, json=payload)
        resp.raise_for_status()


async def _test_slack(webhook_url: str, platform_name: str = "Anthrimon") -> None:
    if not _is_url_safe(webhook_url):
        raise ValueError("Webhook URL resolves to a blocked private/internal address")
    payload = {
        "text": f"[TEST] {platform_name} notification test",
        "blocks": [{"type": "section", "text": {
            "type": "mrkdwn",
            "text": f"*[TEST]* _{platform_name}_ — if you see this, the Slack channel is configured correctly.",
        }}],
    }
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(webhook_url, json=payload)
        resp.raise_for_status()


# ── Generic webhook ────────────────────────────────────────────────────────────

async def _send_webhook(url: str, secret: Optional[str], ctx: dict) -> None:
    if not _is_url_safe(url):
        raise ValueError(f"Webhook URL resolves to a blocked private/internal address")
    payload: dict = {
        "event":        "alert.resolved" if ctx["tag"] == "RESOLVED" else "alert.fired",
        "alert_id":     ctx["alert_id"],
        "title":        ctx["title"],
        "rule_name":    ctx["rule_name"],
        "severity":     ctx["severity"],
        "status":       ctx["status"],
        "metric":       ctx["metric"],
        "triggered_at": ctx["triggered_at"],
    }
    if ctx["value"] != "—":
        payload["value"] = ctx["value"]
    if ctx["threshold"] != "—":
        payload["threshold"] = ctx["threshold"]
    if ctx.get("device_name"):
        payload["device_name"] = ctx["device_name"]
    if ctx.get("interface_name"):
        payload["interface_name"] = ctx["interface_name"]
    if ctx["tag"] == "RESOLVED":
        payload["resolved_at"] = ctx["resolved_at"]
        if ctx.get("revived_child_count"):
            payload["revived_child_count"] = ctx["revived_child_count"]
    if ctx.get("alert_url"):
        payload["alert_url"] = ctx["alert_url"]

    body_bytes = json.dumps(payload, separators=(",", ":")).encode()
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if secret:
        sig = _hmac.new(secret.encode(), body_bytes, hashlib.sha256).hexdigest()
        headers["X-Anthrimon-Signature"] = f"sha256={sig}"

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(url, content=body_bytes, headers=headers)
        resp.raise_for_status()


async def _test_webhook(url: str, secret: Optional[str], platform_name: str = "Anthrimon") -> None:
    if not _is_url_safe(url):
        raise ValueError("Webhook URL resolves to a blocked private/internal address")
    payload = {"event": "test", "source": platform_name,
               "message": "Webhook test — if you receive this, the endpoint is reachable."}
    body_bytes = json.dumps(payload, separators=(",", ":")).encode()
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if secret:
        sig = _hmac.new(secret.encode(), body_bytes, hashlib.sha256).hexdigest()
        headers["X-Anthrimon-Signature"] = f"sha256={sig}"
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(url, content=body_bytes, headers=headers)
        resp.raise_for_status()


# ── PagerDuty Events API v2 ────────────────────────────────────────────────────

_PD_ENQUEUE = "https://events.pagerduty.com/v2/enqueue"


async def _send_pagerduty(integration_key: str, ctx: dict, alert_id: str, resolved: bool) -> None:
    event_action = "resolve" if resolved else "trigger"
    dedup_key    = f"anthrimon-{alert_id}"

    custom: dict = {
        "rule":        ctx["rule_name"],
        "metric":      ctx["metric"],
        "triggered_at": ctx["triggered_at"],
    }
    if ctx.get("device_name"):
        custom["device"] = ctx["device_name"]
    if ctx["value"] != "—":
        custom["value"] = ctx["value"]
    if ctx["threshold"] != "—":
        custom["threshold"] = ctx["threshold"]
    if ctx.get("interface_name"):
        custom["interface"] = ctx["interface_name"]

    body: dict = {
        "routing_key":  integration_key,
        "event_action": event_action,
        "dedup_key":    dedup_key,
    }

    if not resolved:
        body["payload"] = {
            "summary":        f"[{ctx['tag']}] {ctx['title']}",
            "severity":       _PD_SEVERITY.get(ctx["severity"], "warning"),
            "source":         ctx.get("device_name") or "anthrimon",
            "custom_details": custom,
        }
        if ctx.get("alert_url"):
            body["links"] = [{"href": ctx["alert_url"], "text": "View in Anthrimon"}]

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(_PD_ENQUEUE, json=body)
        resp.raise_for_status()


async def _test_pagerduty(integration_key: str, platform_name: str = "Anthrimon") -> None:
    """Trigger a test incident then immediately resolve it."""
    dedup_key = f"anthrimon-test-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
    async with httpx.AsyncClient(timeout=10.0) as client:
        trigger = {
            "routing_key":  integration_key,
            "event_action": "trigger",
            "dedup_key":    dedup_key,
            "payload": {
                "summary":  f"[TEST] {platform_name} notification test",
                "severity": "info",
                "source":   "anthrimon",
            },
        }
        resp = await client.post(_PD_ENQUEUE, json=trigger)
        resp.raise_for_status()
        resolve = {"routing_key": integration_key, "event_action": "resolve", "dedup_key": dedup_key}
        await client.post(_PD_ENQUEUE, json=resolve)


# ── Microsoft Teams ────────────────────────────────────────────────────────────

async def _send_teams(webhook_url: str, ctx: dict) -> None:
    if not _is_url_safe(webhook_url):
        raise ValueError(f"Webhook URL resolves to a blocked private/internal address")
    resolved   = ctx["tag"] == "RESOLVED"
    hex_color  = ("#16a34a" if resolved else ctx["severity_color"]).lstrip("#")

    facts = [{"name": "Rule", "value": ctx["rule_name"]}]
    if ctx.get("device_name"):
        facts.append({"name": "Device", "value": ctx["device_name"]})
    facts.append({"name": "Severity", "value": ctx["severity"].capitalize()})
    if ctx["value"] != "—":
        facts.append({"name": "Value", "value": ctx["value"]})
    if ctx["threshold"] != "—":
        facts.append({"name": "Threshold", "value": ctx["threshold"]})
    if ctx.get("interface_name"):
        facts.append({"name": "Interface", "value": ctx["interface_name"]})
    facts.append({"name": "Triggered", "value": ctx["triggered_at"]})
    if resolved:
        facts.append({"name": "Resolved", "value": ctx["resolved_at"]})

    tag   = ctx["tag"]
    title = ctx["title"]
    card: dict = {
        "@type":       "MessageCard",
        "@context":    "https://schema.org/extensions",
        "themeColor":  hex_color,
        "summary":     f"[{tag}] {title}",
        "sections": [{
            "activityTitle":    f"**[{tag}]** {title}",
            "activitySubtitle": ctx.get("description") or "",
            "facts":            facts,
        }],
    }
    if ctx.get("alert_url"):
        card["potentialAction"] = [{
            "@type": "OpenUri",
            "name":  "View Alert",
            "targets": [{"os": "default", "uri": ctx["alert_url"]}],
        }]

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(webhook_url, json=card)
        resp.raise_for_status()


async def _test_teams(webhook_url: str, platform_name: str = "Anthrimon") -> None:
    if not _is_url_safe(webhook_url):
        raise ValueError("Webhook URL resolves to a blocked private/internal address")
    card = {
        "@type":      "MessageCard",
        "@context":   "https://schema.org/extensions",
        "themeColor": "2563eb",
        "summary":    f"[TEST] {platform_name} notification test",
        "sections": [{"activityTitle": f"[TEST] {platform_name}",
                      "activitySubtitle": "If you see this, the Teams channel is configured correctly."}],
    }
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(webhook_url, json=card)
        resp.raise_for_status()


# ── Email ──────────────────────────────────────────────────────────────────────

def _build_email(
    alert: Alert, rule: AlertRule, resolved: bool,
    tmpl_subject: Optional[str] = None,
    tmpl_html: Optional[str] = None,
    platform: Optional[dict] = None,
    ctx: Optional[dict] = None,
) -> tuple[str, str, str]:
    from ..routers.admin import DEFAULT_SUBJECT, DEFAULT_HTML

    platform = platform or {}
    if ctx is None:
        ctx = _build_ctx(alert, rule, resolved, platform)

    alert_ctx  = alert.context or {}
    sev_color  = ctx["severity_color"]
    header_color = "#16a34a" if resolved else sev_color

    duration = ""
    if resolved and alert.triggered_at and alert.resolved_at:
        secs = int((alert.resolved_at - alert.triggered_at).total_seconds())
        if secs < 60:      duration = f"{secs}s"
        elif secs < 3600:  duration = f"{secs // 60}m {secs % 60}s"
        elif secs < 86400: duration = f"{secs // 3600}h {(secs % 3600) // 60}m"
        else:              duration = f"{secs // 86400}d {(secs % 86400) // 3600}h"

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

    if resolved:
        dur_span = (f" &nbsp;<span style='color:#94a3b8;font-size:11px;font-weight:400;'>({duration})</span>"
                    if duration else "")
        resolved_row = f'<tr><td {_lbl}>Resolved</td><td {_cell}>{ctx["resolved_at"]}{dur_span}</td></tr>'
    else:
        resolved_row = ""

    ctx = {**ctx, "header_color": header_color, "value_card": value_card,
           "extra_rows": extra_rows, "resolved_row": resolved_row, "duration": duration}

    subject = _render(tmpl_subject or DEFAULT_SUBJECT, ctx)
    html    = _render(tmpl_html    or DEFAULT_HTML,    ctx)

    plain_lines = [
        f"[{ctx['tag']}] {ctx['title']}",
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
        if ctx.get("revived_child_count"):
            n = ctx["revived_child_count"]
            plain_lines.append(f"Children:  re-evaluating {n} previously-suppressed child alert{'s' if n != 1 else ''}")
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
