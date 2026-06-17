from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import structlog
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import (
    get_db, get_current_principal, Principal, assert_device_access,
    _tenant_device_ids, _assert_device_in_tenant,
)
from ..models.alert import Alert, AlertRule
from ..models.device import Device
from ..snmp_oids import enrich_varbind, resolve_oid
from ..trap_catalog import describe_trap

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/traps", tags=["traps"])


# ── Helpers ────────────────────────────────────────────────────────────────────

def _window_clause(days: int, minutes: Optional[int], col: str = "received_at") -> tuple[str, dict]:
    """Build a time-window WHERE fragment. `minutes` takes precedence over `days`
    when provided, so callers can opt into finer-grained windows (15m/1h/6h/...)
    while keeping `days` as the back-compat default."""
    if minutes is not None:
        return f"{col} >= now() - make_interval(mins => :mins)", {"mins": minutes}
    return f"{col} >= now() - make_interval(days => :days)", {"days": days}


async def _resolve_device_ids(device_id: Optional[str], principal: Principal, db: AsyncSession) -> list[str]:
    if device_id:
        await _assert_device_in_tenant(device_id, principal, db)
        return [device_id]
    return await _tenant_device_ids(principal, db)


def _like_to_regex(pattern: str) -> re.Pattern:
    """Translate a SQL LIKE pattern (% and _ wildcards) to an anchored regex,
    for matching a trap's trap_type against an alert rule's custom_oid pattern."""
    parts = []
    for ch in pattern:
        if ch == "%":
            parts.append(".*")
        elif ch == "_":
            parts.append(".")
        else:
            parts.append(re.escape(ch))
    return re.compile(f"^{''.join(parts)}$")


async def _fetch_active_snmp_trap_alerts(db: AsyncSession, device_ids: list[str]) -> dict[str, list[dict]]:
    """Return open/acknowledged snmp_trap alerts, grouped by device_id, with the
    rule's trap_type pattern (compiled to regex) and the alert's active time
    window — used to flag traps that correlate with a currently-firing alert."""
    if not device_ids:
        return {}

    rows = (await db.execute(
        select(
            Alert.id, Alert.device_id, Alert.severity, Alert.status, Alert.title,
            Alert.triggered_at, Alert.resolved_at,
            AlertRule.custom_oid, AlertRule.duration_seconds,
        )
        .join(AlertRule, Alert.rule_id == AlertRule.id)
        .where(
            AlertRule.metric == "snmp_trap",
            Alert.status.in_(["open", "acknowledged"]),
            Alert.device_id.in_([uuid.UUID(d) for d in device_ids]),
        )
    )).all()

    now = datetime.now(timezone.utc)
    by_device: dict[str, list[dict]] = {}
    for r in rows:
        by_device.setdefault(str(r.device_id), []).append({
            "alert_id":       str(r.id),
            "alert_title":    r.title,
            "alert_severity": r.severity,
            "alert_status":   r.status,
            "pattern":        _like_to_regex(r.custom_oid or "%"),
            "window_start":   r.triggered_at - timedelta(seconds=r.duration_seconds),
            "window_end":     r.resolved_at or now,
        })
    return by_device


_NO_ALERT = {"alert_id": None, "alert_title": None, "alert_severity": None, "alert_status": None}


def _correlate(device_id: Optional[str], trap_type: str, received_at, alerts_by_device: dict) -> dict:
    if not device_id or received_at is None:
        return _NO_ALERT
    for alert in alerts_by_device.get(device_id, []):
        if alert["window_start"] <= received_at <= alert["window_end"] and alert["pattern"].match(trap_type):
            return {
                "alert_id":       alert["alert_id"],
                "alert_title":    alert["alert_title"],
                "alert_severity": alert["alert_severity"],
                "alert_status":   alert["alert_status"],
            }
    return _NO_ALERT


def _enrich_item(row, alerts_by_device: dict, device_id: Optional[str] = None) -> dict:
    """Build a trap item dict from a trap_events row, adding catalog info
    (label/description/category/is_cataloged) and alert-correlation fields."""
    catalog = describe_trap(row["trap_type"])
    received_at = row["received_at"]
    did = device_id if device_id is not None else row.get("device_id")

    item = {
        "id":           row["id"],
        "device_id":    did,
        "hostname":     row.get("hostname"),
        "source_ip":    row["source_ip"],
        "trap_type":    row["trap_type"],
        "oid":          row["oid"],
        "oid_name":     resolve_oid(row["oid"]),
        "severity":     row["severity"],
        "varbinds":     [enrich_varbind(v) for v in (row["varbinds"] or [])],
        "snmp_version": row["snmp_version"],
        "received_at":  received_at.isoformat() if received_at else None,
        "label":        catalog["label"],
        "description":  catalog["description"],
        "category":     catalog["category"],
        "is_cataloged": catalog["is_cataloged"],
    }
    item.update(_correlate(did, row["trap_type"], received_at, alerts_by_device))
    return item


# ── Query (user-facing, JWT authenticated) ────────────────────────────────────

@router.get("")
async def list_traps(
    device_id: Optional[str]    = Query(None),
    trap_type: Optional[str]    = Query(None),
    severity:  Optional[str]    = Query(None),
    q:         Optional[str]    = Query(None, description="Free-text search across trap type, OID, and varbinds"),
    days:      int              = Query(7, ge=1, le=90),
    minutes:   Optional[int]    = Query(None, ge=1, le=129600, description="Overrides `days` when set"),
    limit:     int              = Query(200, ge=1, le=1000),
    offset:    int              = Query(0, ge=0),
    principal: Principal        = Depends(get_current_principal),
    db:        AsyncSession     = Depends(get_db),
) -> dict:
    device_ids = await _tenant_device_ids(principal, db)

    window_sql, window_params = _window_clause(days, minutes, "t.received_at")
    conditions = [
        window_sql,
        "t.device_id = ANY(:device_ids)",
    ]
    params: dict = {"limit": limit, "offset": offset, "device_ids": device_ids, **window_params}

    if device_id:
        conditions.append("t.device_id = CAST(:device_id AS uuid)")
        params["device_id"] = device_id

    if trap_type:
        conditions.append("t.trap_type = :trap_type")
        params["trap_type"] = trap_type

    if severity:
        conditions.append("t.severity = :severity")
        params["severity"] = severity

    if q:
        conditions.append("(t.trap_type ILIKE :q OR t.oid ILIKE :q OR t.varbinds::text ILIKE :q)")
        params["q"] = f"%{q}%"

    where = " AND ".join(conditions)

    rows = (await db.execute(text(f"""
        SELECT
            t.id::text,
            t.device_id::text,
            d.hostname,
            t.source_ip::text,
            t.trap_type,
            t.oid,
            t.severity,
            t.varbinds,
            t.snmp_version,
            t.received_at
        FROM trap_events t
        LEFT JOIN devices d ON d.id = t.device_id
        WHERE {where}
        ORDER BY t.received_at DESC
        LIMIT :limit OFFSET :offset
    """), params)).mappings().all()

    total_row = (await db.execute(text(f"""
        SELECT count(*) FROM trap_events t WHERE {where}
    """), params)).scalar_one()

    alerts_by_device = await _fetch_active_snmp_trap_alerts(
        db, list({r["device_id"] for r in rows if r["device_id"]})
    )

    return {
        "total": total_row,
        "items": [_enrich_item(r, alerts_by_device) for r in rows],
    }


@router.get("/summary", summary="Trap totals for the selected window")
async def traps_summary(
    device_id: Optional[str] = Query(None),
    minutes:   int           = Query(60, ge=1, le=10080),
    principal: Principal     = Depends(get_current_principal),
    db:        AsyncSession  = Depends(get_db),
) -> dict:
    device_ids = await _resolve_device_ids(device_id, principal, db)
    if not device_ids:
        return {"total": 0, "by_severity": {}, "active_devices": 0, "active_sources": 0}

    sev_rows = (await db.execute(text("""
        SELECT severity, count(*) AS n
        FROM trap_events
        WHERE device_id = ANY(:device_ids)
          AND received_at >= now() - make_interval(mins => :mins)
        GROUP BY severity
    """), {"device_ids": device_ids, "mins": minutes})).mappings().all()

    by_sev = {r["severity"]: int(r["n"]) for r in sev_rows}
    total = sum(by_sev.values())

    counts_row = (await db.execute(text("""
        SELECT count(DISTINCT device_id) AS active_devices,
               count(DISTINCT source_ip) AS active_sources
        FROM trap_events
        WHERE device_id = ANY(:device_ids)
          AND received_at >= now() - make_interval(mins => :mins)
    """), {"device_ids": device_ids, "mins": minutes})).mappings().one()

    return {
        "total":          total,
        "by_severity":    by_sev,
        "active_devices": int(counts_row["active_devices"]),
        "active_sources": int(counts_row["active_sources"]),
    }


@router.get("/rate", summary="Trap rate over time (per hour)")
async def traps_rate(
    device_id: Optional[str] = Query(None),
    hours:     int           = Query(24, ge=1, le=720),
    principal: Principal     = Depends(get_current_principal),
    db:        AsyncSession  = Depends(get_db),
) -> list[dict]:
    device_ids = await _resolve_device_ids(device_id, principal, db)
    if not device_ids:
        return []

    rows = (await db.execute(text("""
        SELECT
            (EXTRACT(EPOCH FROM date_trunc('hour', received_at)) * 1000)::bigint AS ts_ms,
            severity,
            count(*) AS n
        FROM trap_events
        WHERE device_id = ANY(:device_ids)
          AND received_at >= now() - make_interval(hours => :hours)
        GROUP BY ts_ms, severity
        ORDER BY ts_ms ASC, severity ASC
    """), {"device_ids": device_ids, "hours": hours})).mappings().all()

    return [
        {"ts_ms": int(r["ts_ms"]), "severity": r["severity"], "count": int(r["n"])}
        for r in rows
    ]


@router.get("/top-types", summary="Trap types by volume")
async def traps_top_types(
    device_id: Optional[str] = Query(None),
    minutes:   int           = Query(60, ge=1, le=10080),
    limit:     int           = Query(15, ge=1, le=50),
    principal: Principal     = Depends(get_current_principal),
    db:        AsyncSession  = Depends(get_db),
) -> list[dict]:
    device_ids = await _resolve_device_ids(device_id, principal, db)
    if not device_ids:
        return []

    rows = (await db.execute(text("""
        SELECT
            trap_type,
            count(*) AS total,
            count(*) FILTER (WHERE severity = 'critical') AS critical,
            count(*) FILTER (WHERE severity = 'warning')  AS warning
        FROM trap_events
        WHERE device_id = ANY(:device_ids)
          AND received_at >= now() - make_interval(mins => :mins)
        GROUP BY trap_type
        ORDER BY total DESC
        LIMIT :limit
    """), {"device_ids": device_ids, "mins": minutes, "limit": limit})).mappings().all()

    result = []
    for r in rows:
        catalog = describe_trap(r["trap_type"])
        result.append({
            "trap_type":    r["trap_type"],
            "total":        int(r["total"]),
            "critical":     int(r["critical"]),
            "warning":      int(r["warning"]),
            "label":        catalog["label"],
            "category":     catalog["category"],
            "is_cataloged": catalog["is_cataloged"],
        })
    return result


@router.get("/top-devices", summary="Devices by trap volume")
async def traps_top_devices(
    minutes:   int          = Query(60, ge=1, le=10080),
    limit:     int          = Query(10, ge=1, le=50),
    principal: Principal    = Depends(get_current_principal),
    db:        AsyncSession = Depends(get_db),
) -> list[dict]:
    device_ids = await _tenant_device_ids(principal, db)
    if not device_ids:
        return []

    rows = (await db.execute(text("""
        SELECT
            device_id::text AS device_id,
            count(*) AS total,
            count(*) FILTER (WHERE severity = 'critical') AS critical,
            count(*) FILTER (WHERE severity = 'warning')  AS warnings
        FROM trap_events
        WHERE device_id = ANY(:device_ids)
          AND received_at >= now() - make_interval(mins => :mins)
        GROUP BY device_id
        ORDER BY total DESC
        LIMIT :limit
    """), {"device_ids": device_ids, "mins": minutes, "limit": limit})).mappings().all()

    dev_rows = (await db.execute(
        select(Device.id, Device.hostname, Device.fqdn, Device.device_type)
        .where(Device.tenant_id == principal.active_tenant_id)
    )).all()
    dev_info = {str(r.id): {"name": r.fqdn or r.hostname, "type": r.device_type} for r in dev_rows}

    return [
        {
            "device_id":   r["device_id"],
            "device_name": dev_info.get(r["device_id"], {}).get("name", r["device_id"][:8]),
            "device_type": dev_info.get(r["device_id"], {}).get("type", "unknown"),
            "total":       int(r["total"]),
            "critical":    int(r["critical"]),
            "warnings":    int(r["warnings"]),
        }
        for r in rows
    ]


@router.get("/device/{device_id}")
async def device_traps(
    device_id: str,
    severity:  Optional[str] = Query(None),
    q:         Optional[str] = Query(None, description="Free-text search across trap type, OID, and varbinds"),
    days:      int           = Query(7, ge=1, le=90),
    minutes:   Optional[int] = Query(None, ge=1, le=129600, description="Overrides `days` when set"),
    limit:     int           = Query(100, ge=1, le=500),
    principal: Principal     = Depends(get_current_principal),
    db:        AsyncSession  = Depends(get_db),
) -> dict:
    await assert_device_access(principal, uuid.UUID(device_id), "readonly", db)

    window_sql, window_params = _window_clause(days, minutes, "received_at")
    conditions = [
        "device_id = CAST(:did AS uuid)",
        window_sql,
    ]
    params: dict = {"did": device_id, "limit": limit, **window_params}

    if severity:
        conditions.append("severity = :severity")
        params["severity"] = severity

    if q:
        conditions.append("(trap_type ILIKE :q OR oid ILIKE :q OR varbinds::text ILIKE :q)")
        params["q"] = f"%{q}%"

    where = " AND ".join(conditions)

    rows = (await db.execute(text(f"""
        SELECT
            id::text,
            source_ip::text,
            trap_type,
            oid,
            severity,
            varbinds,
            snmp_version,
            received_at
        FROM trap_events
        WHERE {where}
        ORDER BY received_at DESC
        LIMIT :limit
    """), params)).mappings().all()

    alerts_by_device = await _fetch_active_snmp_trap_alerts(db, [device_id])

    return {
        "items": [_enrich_item(r, alerts_by_device, device_id=device_id) for r in rows],
    }
