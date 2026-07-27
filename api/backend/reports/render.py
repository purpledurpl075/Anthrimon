"""Report HTML templating (Jinja2) + HTML->PDF rendering (Playwright,
headless Chromium). Reports are rendered with the same visual language as
the dashboard (slate/blue palette) so they don't look like a bolted-on
afterthought.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from pathlib import Path

import structlog
from jinja2 import Environment, FileSystemLoader, select_autoescape
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..alerting.settings import load_platform_defaults
from ..models.tenant import Tenant

logger = structlog.get_logger(__name__)

_TEMPLATES_DIR = Path(__file__).parent / "templates"

TITLES = {
    "capacity":         "Capacity & Utilisation Report",
    "sla":              "SLA / Uptime Report",
    "inventory":        "Inventory Report",
    "compliance":       "Config Compliance Report",
    "alert_summary":    "Alert Summary Report",
    "config_changes":   "Config Change History Report",
    "flow_top_talkers": "Top Talkers Report",
    "interface_health": "Interface Errors & Health Report",
    "bgp_health":        "BGP / Routing Health Report",
    "syslog_security":  "Syslog / Security Events Report",
    "bundle":           "Combined Report",
}
SUBTITLES = {
    "capacity":         "Interface utilisation and CPU trends across monitored devices.",
    "sla":              "Per-device uptime and availability against device-down alert history.",
    "inventory":        "Full device inventory snapshot.",
    "compliance":       "Config compliance pass/fail summary and per-device drift.",
    "alert_summary":    "Alert volume and mean-time-to-acknowledge/resolve by severity and device.",
    "config_changes":   "Recent config deploys — who changed what, and how much.",
    "flow_top_talkers": "Top bandwidth consumers by source/destination and protocol.",
    "interface_health": "Interface errors, discards, and link-state flaps across devices.",
    "bgp_health":        "BGP session uptime, flap counts, and prefix counts.",
    "syslog_security":  "Syslog severity trends and matched security patterns.",
    "bundle":           "Multiple report types combined into a single document.",
}


def _fmt_bps(v: float | None) -> str:
    if v is None:
        return "—"
    for unit, div in (("Gbps", 1e9), ("Mbps", 1e6), ("Kbps", 1e3)):
        if v >= div:
            return f"{v / div:.1f} {unit}"
    return f"{v:.0f} bps"


def _fmt_bytes(v: float | None) -> str:
    if v is None:
        return "—"
    for unit, div in (("GB", 1e9), ("MB", 1e6), ("KB", 1e3)):
        if v >= div:
            return f"{v / div:.1f} {unit}"
    return f"{v:.0f} B"


def _fmt_duration(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.0f}s"
    minutes = seconds / 60
    if minutes < 60:
        return f"{minutes:.0f}m"
    hours = minutes / 60
    if hours < 24:
        return f"{hours:.1f}h"
    return f"{hours / 24:.1f}d"


def _fmt_date(v: str | None) -> str:
    """Format a period_start/period_end ISO string (from aggregations.py's
    normalize_range) for display — e.g. "2026-07-01 00:00 UTC"."""
    if not v:
        return "—"
    try:
        dt = datetime.fromisoformat(v)
        return dt.strftime("%Y-%m-%d %H:%M UTC")
    except ValueError:
        return v


_env = Environment(
    loader=FileSystemLoader(str(_TEMPLATES_DIR)),
    autoescape=select_autoescape(["html"]),
)
_env.filters["fmt_bps"] = _fmt_bps
_env.filters["fmt_bytes"] = _fmt_bytes
_env.filters["fmt_duration"] = _fmt_duration
_env.filters["fmt_date"] = _fmt_date


async def _branding(db: AsyncSession, tenant_id: uuid.UUID) -> dict:
    defaults = await load_platform_defaults(db)
    tenant_name = (await db.execute(
        select(Tenant.name).where(Tenant.id == tenant_id)
    )).scalar_one_or_none()
    return {
        "company_name": defaults.get("report_company_name") or defaults.get("platform_name") or "Anthrimon",
        "logo_data_uri": defaults.get("report_logo_data_uri") or "",
        "tenant_name": tenant_name or "",
    }


async def render_report_html(
    db: AsyncSession, tenant_id: uuid.UUID, report_type: str, data: dict, *,
    generated_by: str | None = None,
    comparison: dict | None = None,
) -> str:
    branding = await _branding(db, tenant_id)
    template = _env.get_template(f"{report_type}.html")
    return template.render(
        title=TITLES.get(report_type, report_type.title()),
        subtitle=SUBTITLES.get(report_type, ""),
        generated_at=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        generated_by=generated_by,
        comparison=comparison,
        data=data,
        **branding,
    )


async def html_to_pdf_bytes(html: str) -> bytes:
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        try:
            page = await browser.new_page()
            await page.set_content(html, wait_until="networkidle")
            return await page.pdf(
                format="A4",
                print_background=True,
                margin={"top": "0", "bottom": "0", "left": "0", "right": "0"},
            )
        finally:
            await browser.close()
