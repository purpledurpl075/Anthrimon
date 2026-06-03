from __future__ import annotations

from typing import Optional

import structlog
from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_db, get_current_principal, Principal

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/traps", tags=["traps"])


# ── Query (user-facing, JWT authenticated) ────────────────────────────────────

@router.get("")
async def list_traps(
    device_id: Optional[str]    = Query(None),
    trap_type: Optional[str]    = Query(None),
    days:      int              = Query(7, ge=1, le=90),
    limit:     int              = Query(200, ge=1, le=1000),
    offset:    int              = Query(0, ge=0),
    principal: Principal        = Depends(get_current_principal),
    db:        AsyncSession     = Depends(get_db),
) -> dict:
    conditions = ["t.received_at > now() - make_interval(days => :days)"]
    params: dict = {"days": days, "limit": limit, "offset": offset}

    if device_id:
        conditions.append("t.device_id = CAST(:device_id AS uuid)")
        params["device_id"] = device_id

    if trap_type:
        conditions.append("t.trap_type = :trap_type")
        params["trap_type"] = trap_type

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

    return {
        "total": total_row,
        "items": [
            {
                "id":           r["id"],
                "device_id":    r["device_id"],
                "hostname":     r["hostname"],
                "source_ip":    r["source_ip"],
                "trap_type":    r["trap_type"],
                "oid":          r["oid"],
                "severity":     r["severity"],
                "varbinds":     r["varbinds"],
                "snmp_version": r["snmp_version"],
                "received_at":  r["received_at"].isoformat() if r["received_at"] else None,
            }
            for r in rows
        ],
    }


@router.get("/device/{device_id}")
async def device_traps(
    device_id: str,
    days:      int          = Query(7, ge=1, le=90),
    limit:     int          = Query(100, ge=1, le=500),
    principal: Principal    = Depends(get_current_principal),
    db:        AsyncSession = Depends(get_db),
) -> dict:
    rows = (await db.execute(text("""
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
        WHERE device_id = CAST(:did AS uuid)
          AND received_at > now() - make_interval(days => :days)
        ORDER BY received_at DESC
        LIMIT :limit
    """), {"did": device_id, "days": days, "limit": limit})).mappings().all()

    return {
        "items": [
            {
                "id":           r["id"],
                "source_ip":    r["source_ip"],
                "trap_type":    r["trap_type"],
                "oid":          r["oid"],
                "severity":     r["severity"],
                "varbinds":     r["varbinds"],
                "snmp_version": r["snmp_version"],
                "received_at":  r["received_at"].isoformat() if r["received_at"] else None,
            }
            for r in rows
        ],
    }
