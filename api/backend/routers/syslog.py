from __future__ import annotations

import ipaddress
from typing import Optional

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_db, get_current_principal, accessible_device_ids_subquery, Principal, assert_device_access
from ..models.device import Device

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/syslog", tags=["syslog"])

_CH_URL = "http://localhost:8123"

SEVERITY_NAMES = {
    0: "emergency", 1: "alert", 2: "critical", 3: "error",
    4: "warning",   5: "notice", 6: "info",    7: "debug",
}
FACILITY_NAMES = {
    0: "kern",  1: "user",  2: "mail",   3: "daemon",
    4: "auth",  5: "syslog", 6: "lpr",   7: "news",
    8: "uucp",  9: "cron",  10: "authpriv", 11: "ftp",
    16: "local0", 17: "local1", 18: "local2", 19: "local3",
    20: "local4", 21: "local5", 22: "local6", 23: "local7",
}

SEV_COLOR = {
    0: "#dc2626", 1: "#dc2626", 2: "#dc2626",  # emergency/alert/critical → red
    3: "#ea580c",                               # error → orange
    4: "#d97706",                               # warning → amber
    5: "#2563eb",                               # notice → blue
    6: "#64748b",                               # info → slate
    7: "#94a3b8",                               # debug → light
}


async def _ch(query: str) -> list[dict]:
    # Collapse all whitespace to single spaces — ClickHouse 26.x has a bug where
    # multiline/indented HTTP POST bodies return 0 rows despite rows_read > 0.
    flat = " ".join(query.split()) + " FORMAT JSON"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                _CH_URL,
                content=flat,
                headers={"Content-Type": "text/plain"},
            )
        resp.raise_for_status()
        return resp.json().get("data", [])
    except Exception as exc:
        logger.error("clickhouse_query_failed", error=str(exc))
        raise HTTPException(status_code=503, detail="Syslog data unavailable") from exc


async def _assert_device_in_tenant(device_id: str, principal: Principal, db: AsyncSession) -> None:
    import uuid as _uuid
    await assert_device_access(principal, _uuid.UUID(device_id), "readonly", db)


async def _tenant_device_ids(principal: Principal, db: AsyncSession) -> list[str]:
    rows = (await db.execute(
        accessible_device_ids_subquery(principal)
        .where(Device.is_active == True)  # noqa: E712
    )).scalars().all()
    return [str(r) for r in rows]


def _device_filter(device_ids: list[str]) -> str:
    ids = ", ".join(f"toUUID('{d}')" for d in device_ids)
    return f"device_id IN ({ids})"


def _quote_str(s: str) -> str:
    """Escape a string for use in a ClickHouse query."""
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/summary", summary="Syslog message totals for the selected window")
async def syslog_summary(
    device_id:    Optional[str] = Query(default=None),
    minutes:      int           = Query(default=60, ge=1, le=10080),
    principal:    Principal = Depends(get_current_principal),
    db:           AsyncSession  = Depends(get_db),
) -> dict:
    if device_id:
        await _assert_device_in_tenant(device_id, principal, db)
        device_ids = [device_id]
    else:
        device_ids = await _tenant_device_ids(principal, db)
    if not device_ids:
        return {"total": 0, "by_severity": {}, "by_facility": {}, "active_devices": 0}

    rows = await _ch(f"""
        SELECT
            severity,
            count() AS n
        FROM syslog_messages
        WHERE {_device_filter(device_ids)}
          AND received_at >= now() - INTERVAL {minutes} MINUTE
        GROUP BY severity
        ORDER BY severity
    """)

    by_sev = {SEVERITY_NAMES.get(int(r["severity"]), str(r["severity"])): int(r["n"]) for r in rows}
    total = sum(by_sev.values())

    dev_rows = await _ch(f"""
        SELECT uniq(device_id) AS n
        FROM syslog_messages
        WHERE {_device_filter(device_ids)}
          AND received_at >= now() - INTERVAL {minutes} MINUTE
    """)

    return {
        "total":          total,
        "by_severity":    by_sev,
        "active_devices": int(dev_rows[0]["n"]) if dev_rows else 0,
    }


@router.get("/messages", summary="Query syslog messages with filters")
async def syslog_messages(
    device_id:    Optional[str] = Query(default=None),
    severity_max: Optional[int] = Query(default=None, ge=0, le=7,
                                        description="Max severity (0=emerg … 7=debug). "
                                                    "e.g. 4 = warning and above"),
    program:      Optional[str] = Query(default=None),
    q:            Optional[str] = Query(default=None, description="Full-text search in message"),
    minutes:      int           = Query(default=60,  ge=1, le=10080),
    limit:        int           = Query(default=200, ge=1, le=1000),
    offset:       int           = Query(default=0,   ge=0),
    principal:    Principal = Depends(get_current_principal),
    db:           AsyncSession  = Depends(get_db),
) -> dict:
    if device_id:
        await _assert_device_in_tenant(device_id, principal, db)
        device_ids = [device_id]
    else:
        device_ids = await _tenant_device_ids(principal, db)
    if not device_ids:
        return {"messages": [], "total": 0}

    clauses = [
        _device_filter(device_ids),
        f"received_at >= now() - INTERVAL {minutes} MINUTE",
    ]
    if severity_max is not None:
        clauses.append(f"severity <= {severity_max}")
    if program:
        clauses.append(f"program = {_quote_str(program)}")
    if q:
        clauses.append(f"positionCaseInsensitive(message, {_quote_str(q)}) > 0")

    where = " AND ".join(clauses)

    count_rows = await _ch(f"SELECT count() AS n FROM syslog_messages WHERE {where}")
    total = int(count_rows[0]["n"]) if count_rows else 0

    rows = await _ch(f"""
        SELECT
            toString(device_id)             AS device_uuid,
            IPv4NumToString(device_ip)      AS device_ip,
            facility,
            severity,
            toUnixTimestamp(ts) * 1000      AS ts_ms,
            hostname,
            program,
            pid,
            message,
            raw
        FROM syslog_messages
        WHERE {where}
        ORDER BY received_at DESC
        LIMIT {limit} OFFSET {offset}
    """)

    # Enrich with device names
    dev_rows = (await db.execute(
        select(Device.id, Device.hostname, Device.fqdn)
        .where(Device.tenant_id == principal.active_tenant_id)
    )).all()
    dev_name = {str(r.id): r.fqdn or r.hostname for r in dev_rows}

    return {
        "total": total,
        "messages": [
            {
                "device_id":      r["device_uuid"],
                "device_name":    dev_name.get(r["device_uuid"], r["hostname"] or r["device_ip"]),
                "device_ip":      r["device_ip"],
                "facility":       int(r["facility"]),
                "facility_name":  FACILITY_NAMES.get(int(r["facility"]), str(r["facility"])),
                "severity":       int(r["severity"]),
                "severity_name":  SEVERITY_NAMES.get(int(r["severity"]), str(r["severity"])),
                "severity_color": SEV_COLOR.get(int(r["severity"]), "#94a3b8"),
                "ts_ms":          int(r["ts_ms"]),
                "hostname":       r["hostname"],
                "program":        r["program"],
                "pid":            r["pid"],
                "message":        r["message"],
                "raw":            r["raw"],
            }
            for r in rows
        ],
    }


@router.get("/rate", summary="Log message rate over time (per hour)")
async def syslog_rate(
    device_id:    Optional[str] = Query(default=None),
    hours:        int           = Query(default=24, ge=1, le=720),
    principal:    Principal = Depends(get_current_principal),
    db:           AsyncSession  = Depends(get_db),
) -> list[dict]:
    if device_id:
        await _assert_device_in_tenant(device_id, principal, db)
        device_ids = [device_id]
    else:
        device_ids = await _tenant_device_ids(principal, db)
    if not device_ids:
        return []

    rows = await _ch(f"""
        SELECT
            toUnixTimestamp(toStartOfHour(received_at)) * 1000 AS ts_ms,
            severity,
            count() AS n
        FROM syslog_messages
        WHERE {_device_filter(device_ids)}
          AND received_at >= now() - INTERVAL {hours} HOUR
        GROUP BY ts_ms, severity
        ORDER BY ts_ms ASC, severity ASC
    """)

    return [
        {
            "ts_ms":         int(r["ts_ms"]),
            "severity":      int(r["severity"]),
            "severity_name": SEVERITY_NAMES.get(int(r["severity"]), str(r["severity"])),
            "count":         int(r["n"]),
        }
        for r in rows
    ]


@router.get("/top-programs", summary="Programs generating the most messages")
async def top_programs(
    device_id:    Optional[str] = Query(default=None),
    minutes:      int           = Query(default=60,  ge=1, le=10080),
    limit:        int           = Query(default=15,  ge=1, le=50),
    principal:    Principal = Depends(get_current_principal),
    db:           AsyncSession  = Depends(get_db),
) -> list[dict]:
    if device_id:
        await _assert_device_in_tenant(device_id, principal, db)
        device_ids = [device_id]
    else:
        device_ids = await _tenant_device_ids(principal, db)
    if not device_ids:
        return []

    rows = await _ch(f"""
        SELECT
            program,
            count()           AS total,
            countIf(severity <= 3) AS errors
        FROM syslog_messages
        WHERE {_device_filter(device_ids)}
          AND received_at >= now() - INTERVAL {minutes} MINUTE
        GROUP BY program
        ORDER BY total DESC
        LIMIT {limit}
    """)

    return [
        {
            "program": r["program"] or "(unknown)",
            "total":   int(r["total"]),
            "errors":  int(r["errors"]),
        }
        for r in rows
    ]


@router.get("/top-devices", summary="Devices by log volume")
async def top_devices(
    minutes:      int = Query(default=60, ge=1, le=10080),
    limit:        int = Query(default=10, ge=1, le=50),
    principal:    Principal = Depends(get_current_principal),
    db:           AsyncSession  = Depends(get_db),
) -> list[dict]:
    device_ids = await _tenant_device_ids(principal, db)
    if not device_ids:
        return []

    rows = await _ch(f"""
        SELECT
            toString(device_id)        AS device_uuid,
            count()                    AS total,
            countIf(severity <= 3)     AS errors,
            countIf(severity = 4)      AS warnings
        FROM syslog_messages
        WHERE {_device_filter(device_ids)}
          AND received_at >= now() - INTERVAL {minutes} MINUTE
        GROUP BY device_id
        ORDER BY total DESC
        LIMIT {limit}
    """)

    dev_rows = (await db.execute(
        select(Device.id, Device.hostname, Device.fqdn, Device.device_type)
        .where(Device.tenant_id == principal.active_tenant_id)
    )).all()
    dev_info = {str(r.id): {"name": r.fqdn or r.hostname, "type": r.device_type} for r in dev_rows}

    return [
        {
            "device_id":   r["device_uuid"],
            "device_name": dev_info.get(r["device_uuid"], {}).get("name", r["device_uuid"][:8]),
            "device_type": dev_info.get(r["device_uuid"], {}).get("type", "unknown"),
            "total":       int(r["total"]),
            "errors":      int(r["errors"]),
            "warnings":    int(r["warnings"]),
        }
        for r in rows
    ]


@router.get("/heatmap", summary="Message count by hour-of-day × day-of-week (last 7 days)")
async def syslog_heatmap(
    principal:    Principal = Depends(get_current_principal),
    db:           AsyncSession  = Depends(get_db),
) -> list[dict]:
    device_ids = await _tenant_device_ids(principal, db)
    if not device_ids:
        return []

    dev_filter = _device_filter(device_ids)
    rows = await _ch(f"""
        SELECT
            toDayOfWeek(ts) - 1      AS dow,
            toHour(ts)               AS hr,
            count()                  AS cnt
        FROM syslog_messages
        WHERE {dev_filter}
          AND ts >= now() - INTERVAL 7 DAY
        GROUP BY dow, hr
        ORDER BY dow, hr
    """)
    return [{"dow": int(r["dow"]), "hr": int(r["hr"]), "count": int(r["cnt"])} for r in rows]
