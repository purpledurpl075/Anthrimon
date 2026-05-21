from __future__ import annotations

import asyncio
import time as _time
from datetime import datetime, timezone
from typing import Any

import httpx
import structlog
from fastapi import APIRouter, Depends, Query
from sqlalchemy import cast, func, select, text, String
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_current_user, get_db
from ..models.alert import Alert
from ..models.device import Device
from ..models.interface import Interface
from ..models.tenant import User
from ..database import AsyncSessionLocal

_VM_URL = "http://localhost:8428"

logger = structlog.get_logger(__name__)
router = APIRouter(tags=["overview"])

# ── Server-side cache ──────────────────────────────────────────────────────────
# tenant_id → (computed_at, result)
_overview_cache: dict[str, tuple[float, dict]] = {}
_CACHE_TTL = 10  # seconds


# ── Parallel query helpers ────────────────────────────────────────────────────

async def _fetch_device_stats(tid) -> dict:
    """Device counts, poll health, last poll — 2 queries in one session."""
    async with AsyncSessionLocal() as db:
        # status + type counts + poll health in a single aggregation pass
        rows = (await db.execute(text("""
            SELECT
                status::text,
                device_type::text,
                COUNT(*) AS n,
                SUM(CASE WHEN last_polled > NOW() - INTERVAL '2 minutes' THEN 1 ELSE 0 END) AS polled_recently,
                MAX(last_polled) AS max_last_polled
            FROM devices
            WHERE tenant_id = :tid AND is_active = true
            GROUP BY status, device_type
        """), {"tid": str(tid)})).mappings().all()

        problem_rows = (await db.execute(text("""
            SELECT id::text, hostname, fqdn, mgmt_ip::text, vendor, device_type, status::text, last_seen
            FROM devices
            WHERE tenant_id = :tid
              AND is_active = true
              AND (
                status IN ('down'::device_status, 'unreachable'::device_status)
                OR last_polled IS NULL
                OR last_polled < NOW() - INTERVAL '90 seconds'
              )
            ORDER BY last_seen ASC NULLS FIRST
            LIMIT 8
        """), {"tid": str(tid)})).mappings().all()

    status_counts: dict[str, int] = {}
    type_counts:   dict[str, int] = {}
    polled_recently = 0
    last_polled_at  = None

    for r in rows:
        st = r["status"]
        dt = r["device_type"] or "unknown"
        n  = r["n"]
        status_counts[st] = status_counts.get(st, 0) + n
        type_counts[dt]   = type_counts.get(dt, 0) + n
        polled_recently  += r["polled_recently"] or 0
        mp = r["max_last_polled"]
        if mp and (last_polled_at is None or mp > last_polled_at):
            last_polled_at = mp

    return {
        "status_counts":   status_counts,
        "type_counts":     type_counts,
        "polled_recently": polled_recently,
        "last_polled_at":  last_polled_at,
        "problem_devices": [
            {
                "id":          r["id"],
                "hostname":    r["fqdn"] or r["hostname"],
                "mgmt_ip":     r["mgmt_ip"],
                "vendor":      r["vendor"],
                "device_type": r["device_type"],
                "status":      r["status"],
                "last_seen":   r["last_seen"].isoformat() if r["last_seen"] else None,
            }
            for r in problem_rows
        ],
    }


async def _fetch_alert_stats(tid) -> dict:
    """All alert data — 4 queries in one session."""
    async with AsyncSessionLocal() as db:
        # severity counts
        sev_rows = (await db.execute(text("""
            SELECT severity::text, COUNT(*) AS n
            FROM alerts
            WHERE tenant_id = :tid AND status = 'open'::alert_status
            GROUP BY severity
        """), {"tid": str(tid)})).mappings().all()

        # recent open alerts
        recent_rows = (await db.execute(text("""
            SELECT id::text, title, severity::text, triggered_at, device_id::text
            FROM alerts
            WHERE tenant_id = :tid AND status = 'open'::alert_status
            ORDER BY CASE severity
                WHEN 'critical' THEN 1 WHEN 'major' THEN 2 WHEN 'minor' THEN 3 WHEN 'warning' THEN 4 ELSE 5
            END, triggered_at DESC
            LIMIT 8
        """), {"tid": str(tid)})).mappings().all()

        # alert trend (hourly last 24h)
        trend_rows = (await db.execute(text("""
            SELECT date_trunc('hour', triggered_at) AS hour, COUNT(id) AS n
            FROM alerts
            WHERE tenant_id = :tid AND triggered_at > NOW() - INTERVAL '24 hours'
            GROUP BY 1 ORDER BY 1
        """), {"tid": str(tid)})).mappings().all()

        # recently resolved
        resolved_rows = (await db.execute(text("""
            SELECT id::text, title, severity::text, resolved_at, device_id::text
            FROM alerts
            WHERE tenant_id = :tid
              AND status = 'resolved'::alert_status
              AND resolved_at > NOW() - INTERVAL '1 hour'
            ORDER BY resolved_at DESC
            LIMIT 8
        """), {"tid": str(tid)})).mappings().all()

        # top alerting devices
        top_rows = (await db.execute(text("""
            SELECT a.device_id::text, d.hostname, d.fqdn, d.device_type::text, COUNT(a.id) AS n
            FROM alerts a
            JOIN devices d ON d.id = a.device_id
            WHERE a.tenant_id = :tid
              AND a.status = 'open'::alert_status
              AND a.device_id IS NOT NULL
            GROUP BY a.device_id, d.hostname, d.fqdn, d.device_type
            ORDER BY COUNT(a.id) DESC
            LIMIT 5
        """), {"tid": str(tid)})).mappings().all()

    sev_counts = {r["severity"]: r["n"] for r in sev_rows}
    return {
        "by_severity":         sev_counts,
        "open":                sum(sev_counts.values()),
        "critical":            sev_counts.get("critical", 0),
        "major":               sev_counts.get("major", 0),
        "recent_alerts":       [
            {"id": r["id"], "title": r["title"], "severity": r["severity"],
             "triggered_at": r["triggered_at"].isoformat() if r["triggered_at"] else None,
             "device_id": r["device_id"]}
            for r in recent_rows
        ],
        "alert_trend":         [
            [int(r["hour"].timestamp() * 1000), r["n"]] for r in trend_rows
        ],
        "recently_resolved":   [
            {"id": r["id"], "title": r["title"], "severity": r["severity"],
             "resolved_at": r["resolved_at"].isoformat() if r["resolved_at"] else None,
             "device_id": r["device_id"]}
            for r in resolved_rows
        ],
        "top_alerting_devices": [
            {"device_id": r["device_id"], "hostname": r["fqdn"] or r["hostname"],
             "device_type": r["device_type"], "count": r["n"]}
            for r in top_rows
        ],
    }


async def _fetch_interfaces_down(tid) -> int:
    async with AsyncSessionLocal() as db:
        result = (await db.execute(text("""
            SELECT COUNT(*) FROM interfaces i
            JOIN devices d ON d.id = i.device_id
            WHERE d.tenant_id = :tid
              AND d.is_active = true
              AND i.oper_status  = 'down'::if_status
              AND i.admin_status = 'up'::if_status
        """), {"tid": str(tid)})).scalar_one()
    return result or 0


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/overview", summary="Dashboard summary stats")
async def overview(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    tid = current_user.tenant_id
    cache_key = str(tid)

    # Return cached result if fresh
    entry = _overview_cache.get(cache_key)
    if entry and (_time.monotonic() - entry[0]) < _CACHE_TTL:
        return entry[1]

    # Run the three independent query groups in parallel
    device_stats, alert_stats, ifaces_down = await asyncio.gather(
        _fetch_device_stats(tid),
        _fetch_alert_stats(tid),
        _fetch_interfaces_down(tid),
    )

    sc = device_stats["status_counts"]
    result: dict[str, Any] = {
        "devices": {
            "total":       sum(sc.values()),
            "up":          sc.get("up", 0),
            "down":        sc.get("down", 0),
            "unreachable": sc.get("unreachable", 0),
            "unknown":     sc.get("unknown", 0),
            "by_type":     device_stats["type_counts"],
        },
        "alerts": {
            "open":        alert_stats["open"],
            "critical":    alert_stats["critical"],
            "major":       alert_stats["major"],
            "by_severity": alert_stats["by_severity"],
        },
        "interfaces_down":      ifaces_down,
        "poll_health": {
            "polled_recently": device_stats["polled_recently"],
            "total_active":    sum(sc.values()),
        },
        "last_polled_at":       device_stats["last_polled_at"].isoformat()
                                if device_stats["last_polled_at"] else None,
        "problem_devices":      device_stats["problem_devices"],
        "recent_alerts":        alert_stats["recent_alerts"],
        "top_alerting_devices": alert_stats["top_alerting_devices"],
        "alert_trend":          alert_stats["alert_trend"],
        "recently_resolved":    alert_stats["recently_resolved"],
        "generated_at":         datetime.now(timezone.utc).isoformat(),
    }

    _overview_cache[cache_key] = (_time.monotonic(), result)
    return result


@router.get("/overview/top-bandwidth", summary="Top interfaces and devices by current bandwidth")
async def top_bandwidth(
    limit: int = Query(default=8, ge=1, le=20),
    window_minutes: int = Query(default=30, ge=1, le=360),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    tid = current_user.tenant_id

    iface_rows = (await db.execute(
        select(Interface.id, Interface.device_id, Interface.if_index,
               Interface.name, Interface.speed_bps)
        .join(Device, Interface.device_id == Device.id)
        .where(Device.tenant_id == tid, Device.is_active == True)  # noqa: E712
    )).all()

    if not iface_rows:
        return {"top_interfaces": [], "top_devices": []}

    dev_rows = (await db.execute(
        select(Device.id, Device.hostname, Device.fqdn, Device.device_type)
        .where(Device.tenant_id == tid, Device.is_active == True)  # noqa: E712
    )).all()
    device_info = {
        str(r.id): {"hostname": r.fqdn or r.hostname, "device_type": r.device_type or "unknown"}
        for r in dev_rows
    }

    device_ids_re = "|".join({str(r.device_id) for r in iface_rows})
    key_to_iface  = {(str(r.device_id), str(r.if_index)): r for r in iface_rows}

    now = int(_time.time())
    if window_minutes <= 5:
        step, topk_win = 15, "2m"
    elif window_minutes <= 30:
        step, topk_win = 60, "5m"
    else:
        step, topk_win = 300, "10m"
    start = now - window_minutes * 60

    # Reuse a single client for all VictoriaMetrics calls
    async with httpx.AsyncClient(timeout=8, limits=httpx.Limits(max_connections=20)) as client:

        # Step 1: instant topk query
        topk_q = (
            f'topk({limit * 2},'
            f' rate(anthrimon_if_in_octets_total{{device_id=~"{device_ids_re}"}}[{topk_win}]) * 8'
            f' + rate(anthrimon_if_out_octets_total{{device_id=~"{device_ids_re}"}}[{topk_win}]) * 8)'
        )
        try:
            topk_resp = await client.get(f"{_VM_URL}/api/v1/query", params={"query": topk_q})
            topk_results = topk_resp.json().get("data", {}).get("result", [])
        except Exception:
            logger.exception("top_bandwidth_topk_failed")
            return {"top_interfaces": [], "top_devices": []}

        candidates: list[tuple[str, str, float, object]] = []
        for series in topk_results:
            did = series["metric"].get("device_id", "")
            idx = series["metric"].get("if_index", "")
            val = float(series["value"][1]) if series.get("value") else 0.0
            iface = key_to_iface.get((did, idx))
            if iface:
                candidates.append((did, idx, val, iface))

        candidates.sort(key=lambda x: x[2], reverse=True)
        candidates = candidates[:limit]

        if not candidates:
            return {"top_interfaces": [], "top_devices": []}

        # Step 2: fetch all range series in parallel — reuse same client
        async def fetch_range(did: str, idx: str, metric: str) -> list:
            q = f'rate({metric}{{device_id="{did}",if_index="{idx}"}}[{topk_win}]) * 8'
            try:
                resp = await client.get(
                    f"{_VM_URL}/api/v1/query_range",
                    params={"query": q, "start": start, "end": now, "step": step},
                )
                results = resp.json().get("data", {}).get("result", [])
                return [[int(v[0]), float(v[1])]
                        for v in (results[0].get("values", []) if results else [])]
            except Exception:
                return []

        all_series = await asyncio.gather(*[
            coro
            for did, idx, _, _ in candidates
            for coro in (
                fetch_range(did, idx, "anthrimon_if_in_octets_total"),
                fetch_range(did, idx, "anthrimon_if_out_octets_total"),
            )
        ])

    top_interfaces = []
    device_totals: dict[str, dict] = {}

    for i, (did, idx, _, iface) in enumerate(candidates):
        in_series  = all_series[i * 2]
        out_series = all_series[i * 2 + 1]
        cur_in  = in_series[-1][1]  if in_series  else 0.0
        cur_out = out_series[-1][1] if out_series else 0.0
        speed   = iface.speed_bps
        util    = round((cur_in + cur_out) / speed * 100, 1) if speed else None

        dev = device_info.get(did, {"hostname": did[:8], "device_type": "unknown"})
        top_interfaces.append({
            "device_id":       did,
            "device_name":     dev["hostname"],
            "device_type":     dev["device_type"],
            "iface_id":        str(iface.id),
            "iface_name":      iface.name,
            "speed_bps":       speed,
            "current_in_bps":  cur_in,
            "current_out_bps": cur_out,
            "util_pct":        util,
            "in_series":       in_series,
            "out_series":      out_series,
        })

        if did not in device_totals:
            device_totals[did] = {
                "device_id":   did,
                "device_name": dev["hostname"],
                "device_type": dev["device_type"],
                "total_bps":   0.0,
            }
        device_totals[did]["total_bps"] += cur_in + cur_out

    top_devices = sorted(device_totals.values(), key=lambda x: x["total_bps"], reverse=True)[:5]
    return {"top_interfaces": top_interfaces, "top_devices": top_devices}
