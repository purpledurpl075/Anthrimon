from __future__ import annotations

import asyncio
import uuid
from typing import Optional

import httpx
import structlog
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, desc, func, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_current_user, get_db
from ..models.bgp import BGPSession, BGPSessionEvent
from ..models.device import Device
from ..models.interface import OSPFNeighbor, ISISNeighbor, ISISArea
from ..models.tenant import User

VM_BASE = "http://localhost:8428"

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/bgp", tags=["bgp"])

STATE_COLOR = {
    "established":  "#16a34a",
    "active":       "#d97706",
    "connect":      "#2563eb",
    "opensent":     "#7c3aed",
    "openconfirm":  "#7c3aed",
    "idle":         "#94a3b8",
    "unknown":      "#94a3b8",
}


def _session_out(s: BGPSession, device_name: str = "") -> dict:
    peer_asn = s.peer_asn
    local_asn = s.local_asn
    return {
        "id":                  str(s.id),
        "device_id":           str(s.device_id),
        "device_name":         device_name,
        "vrf":                 s.vrf,
        "peer_ip":             str(s.peer_ip),
        "peer_asn":            peer_asn,
        "local_asn":           local_asn,
        "peer_router_id":      s.peer_router_id,
        "peer_description":    s.peer_description,
        "admin_status":        s.admin_status,
        "session_type":        "iBGP" if peer_asn and peer_asn == local_asn else "eBGP",
        "session_state":       s.session_state,
        "state_color":         STATE_COLOR.get(s.session_state, "#94a3b8"),
        "prefixes_received":   s.prefixes_received,
        "prefixes_advertised": s.prefixes_advertised,
        "uptime_seconds":      s.uptime_seconds,
        "in_updates":          s.in_updates,
        "out_updates":         s.out_updates,
        "flap_count":          s.flap_count,
        "last_state_change":   s.last_state_change.isoformat() if s.last_state_change else None,
        "updated_at":          s.updated_at.isoformat(),
    }


@router.get("/sessions", summary="All BGP sessions across tenant devices")
async def list_all_sessions(
    state:        Optional[str] = Query(default=None),
    current_user: User          = Depends(get_current_user),
    db:           AsyncSession  = Depends(get_db),
) -> list[dict]:
    q = (
        select(BGPSession, Device)
        .join(Device, BGPSession.device_id == Device.id)
        .where(Device.tenant_id == current_user.tenant_id)
        .order_by(Device.hostname, BGPSession.peer_ip)
    )
    if state:
        q = q.where(BGPSession.session_state == state)
    rows = (await db.execute(q)).all()
    return [_session_out(s, dev.display_name) for s, dev in rows]


@router.get("/devices/{device_id}/sessions", summary="BGP sessions for a device")
async def device_sessions(
    device_id:    uuid.UUID,
    current_user: User         = Depends(get_current_user),
    db:           AsyncSession = Depends(get_db),
) -> list[dict]:
    dev = (await db.execute(
        select(Device).where(Device.id == device_id, Device.tenant_id == current_user.tenant_id)
    )).scalar_one_or_none()
    if dev is None:
        return []
    rows = (await db.execute(
        select(BGPSession).where(BGPSession.device_id == device_id).order_by(BGPSession.peer_ip)
    )).scalars().all()
    name = dev.display_name
    return [_session_out(s, name) for s in rows]


@router.get("/sessions/{session_id}/events", summary="State-change history for a BGP session")
async def session_events(
    session_id:   str,
    limit:        int  = Query(default=50, ge=1, le=500),
    current_user: User = Depends(get_current_user),
    db:           AsyncSession = Depends(get_db),
) -> list[dict]:
    # Verify session belongs to this tenant via device join.
    sess = (await db.execute(
        select(BGPSession)
        .join(Device, BGPSession.device_id == Device.id)
        .where(BGPSession.id == session_id, Device.tenant_id == current_user.tenant_id)
    )).scalar_one_or_none()
    if sess is None:
        return []
    events = (await db.execute(
        select(BGPSessionEvent)
        .where(BGPSessionEvent.session_id == session_id)
        .order_by(desc(BGPSessionEvent.recorded_at))
        .limit(limit)
    )).scalars().all()
    return [
        {
            "id":          str(e.id),
            "prev_state":  e.prev_state,
            "new_state":   e.new_state,
            "recorded_at": e.recorded_at.isoformat(),
        }
        for e in events
    ]


@router.get("/summary", summary="BGP health summary across all tenant devices")
async def bgp_summary(
    current_user: User         = Depends(get_current_user),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    rows = (await db.execute(
        select(BGPSession.session_state, func.count().label("n"))
        .join(Device, BGPSession.device_id == Device.id)
        .where(Device.tenant_id == current_user.tenant_id)
        .group_by(BGPSession.session_state)
    )).all()
    by_state = {r.session_state: r.n for r in rows}
    total = sum(by_state.values())
    established = by_state.get("established", 0)

    # Top flappers: flap_count > 1 (>1 means it dropped and re-established;
    # count of 1 is just the initial connection, not a flap).
    flappers = (await db.execute(
        select(BGPSession, Device)
        .join(Device, BGPSession.device_id == Device.id)
        .where(Device.tenant_id == current_user.tenant_id, BGPSession.flap_count > 1)
        .order_by(desc(BGPSession.flap_count))
        .limit(5)
    )).all()

    return {
        "total":       total,
        "established": established,
        "down":        total - established,
        "by_state":    by_state,
        "top_flappers": [
            {
                "session_id":  str(s.id),
                "device_name": dev.display_name,
                "peer_ip":     str(s.peer_ip),
                "peer_asn":    s.peer_asn,
                "flap_count":  s.flap_count,
                "state":       s.session_state,
            }
            for s, dev in flappers
        ],
    }


@router.get("/prefix-totals", summary="Total BGP prefixes received and advertised across all sessions")
async def bgp_prefix_totals(
    current_user: User         = Depends(get_current_user),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    rows = (await db.execute(text("""
        SELECT
            COUNT(*)                                                        AS sessions,
            SUM(prefixes_received)                                          AS total_rx,
            SUM(prefixes_advertised)                                        AS total_tx,
            COUNT(*) FILTER (WHERE s.session_state = 'established'::bgp_session_state) AS established
        FROM bgp_sessions s
        JOIN devices d ON d.id = s.device_id
        WHERE d.tenant_id = :tid
    """), {"tid": str(current_user.tenant_id)})).mappings().one()

    top = (await db.execute(
        select(BGPSession, Device)
        .join(Device, BGPSession.device_id == Device.id)
        .where(
            Device.tenant_id == current_user.tenant_id,
            text("bgp_sessions.session_state = 'established'::bgp_session_state"),
            BGPSession.prefixes_received.isnot(None),
        )
        .order_by(BGPSession.prefixes_received.desc())
        .limit(8)
    )).all()

    return {
        "sessions":    int(rows["sessions"]   or 0),
        "established": int(rows["established"] or 0),
        "total_rx":    int(rows["total_rx"]   or 0),
        "total_tx":    int(rows["total_tx"]   or 0),
        "top_receivers": [
            {
                "device":      dev.display_name,
                "peer_ip":     str(s.peer_ip),
                "peer_asn":    s.peer_asn,
                "prefixes_rx": s.prefixes_received,
            }
            for s, dev in top
        ],
    }


@router.get("/devices/{device_id}/prefix-history", summary="Prefix count + update rate time-series for all BGP peers on a device")
async def bgp_prefix_history(
    device_id:    uuid.UUID,
    hours:        int  = Query(default=24, ge=1, le=168),
    current_user: User = Depends(get_current_user),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    """
    Returns per-peer time-series:
      - prefix_count:  anthrimon_bgp_prefixes_received (gauge)
      - update_rate:   rate(anthrimon_bgp_in_updates_total[5m]) — incoming UPDATE msg/s
    Both sampled at 5-min resolution over the requested window.
    """
    # Verify device belongs to tenant
    dev = (await db.execute(
        select(Device).where(Device.id == device_id, Device.tenant_id == current_user.tenant_id)
    )).scalar_one_or_none()
    if not dev:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Device not found")

    import time as _time
    step  = 300  # 5-minute resolution
    end   = int(_time.time())
    start = end - hours * 3600

    async def vm_range(query: str) -> list[dict]:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.get(f"{VM_BASE}/api/v1/query_range", params={
                    "query": query,
                    "start": start,
                    "end":   end,
                    "step":  step,
                })
            series = r.json().get("data", {}).get("result", [])
        except Exception:
            logger.exception("bgp_vm_query_failed")
            return []
        out = []
        for s in series:
            out.append({
                "peer_ip":  s["metric"].get("peer_ip", ""),
                "peer_asn": s["metric"].get("peer_asn", ""),
                "values":   [[int(ts * 1000), float(v)] for ts, v in s.get("values", [])],
            })
        return out

    device_filter = f'device_id="{device_id}"'
    prefix_series, update_series = await asyncio.gather(
        vm_range(f'anthrimon_bgp_prefixes_received{{{device_filter}}}'),
        vm_range(f'rate(anthrimon_bgp_in_updates_total{{{device_filter}}}[5m]) * 60'),
    )

    return {
        "prefix_count": prefix_series,
        "update_rate":  update_series,
    }


@router.get("/flap-log", summary="Recent BGP state transitions")
async def bgp_flap_log(
    limit:        int  = Query(default=20, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    db:           AsyncSession = Depends(get_db),
) -> list[dict]:
    from ..models.bgp import BGPSessionEvent
    from sqlalchemy import desc as sqldesc

    rows = (await db.execute(
        select(BGPSessionEvent, BGPSession, Device)
        .join(BGPSession, BGPSessionEvent.session_id == BGPSession.id)
        .join(Device, BGPSession.device_id == Device.id)
        .where(Device.tenant_id == current_user.tenant_id)
        .order_by(sqldesc(BGPSessionEvent.recorded_at))
        .limit(limit)
    )).all()

    return [
        {
            "recorded_at": e.recorded_at.isoformat(),
            "device":      dev.display_name,
            "peer_ip":     str(s.peer_ip),
            "peer_asn":    s.peer_asn,
            "prev_state":  e.prev_state,
            "new_state":   e.new_state,
        }
        for e, s, dev in rows
    ]


@router.get("/ospf-neighbors", summary="All OSPF neighbours across tenant devices")
async def ospf_neighbors_all(
    current_user: User         = Depends(get_current_user),
    db:           AsyncSession = Depends(get_db),
) -> list[dict]:
    rows = (await db.execute(
        select(OSPFNeighbor, Device)
        .join(Device, OSPFNeighbor.device_id == Device.id)
        .where(Device.tenant_id == current_user.tenant_id)
        .order_by(Device.hostname, OSPFNeighbor.area, OSPFNeighbor.neighbor_ip)
    )).all()
    return [
        {
            "id":                 str(n.id),
            "device_id":          str(n.device_id),
            "device_name":        dev.display_name,
            "vrf":                n.vrf,
            "neighbor_router_id": str(n.neighbor_router_id) if n.neighbor_router_id else None,
            "neighbor_ip":        str(n.neighbor_ip) if n.neighbor_ip else None,
            "interface_name":     n.interface_name,
            "area":               n.area or "backbone",
            "state":              n.state,
            "priority":           n.priority,
            "uptime_seconds":     n.uptime_seconds,
            "last_state_change":  n.last_state_change.isoformat() if n.last_state_change else None,
        }
        for n, dev in rows
    ]


@router.get("/ospf-areas", summary="OSPF neighbor counts grouped by area")
async def ospf_areas(
    current_user: User         = Depends(get_current_user),
    db:           AsyncSession = Depends(get_db),
) -> list[dict]:
    rows = (await db.execute(text("""
        SELECT
            o.area,
            o.vrf,
            COUNT(*)                                                            AS total,
            COUNT(*) FILTER (WHERE o.state = 'full'::ospf_neighbor_state)      AS full
        FROM ospf_neighbors o
        JOIN devices d ON d.id = o.device_id
        WHERE d.tenant_id = :tid
        GROUP BY o.area, o.vrf
        ORDER BY o.area
    """), {"tid": str(current_user.tenant_id)})).mappings().all()

    return [
        {
            "area":    r["area"] or "backbone",
            "vrf":     r["vrf"],
            "total":    int(r["total"]),
            "full":     int(r["full"]),
            "not_full": int(r["total"]) - int(r["full"]),
        }
        for r in rows
    ]


# ── IS-IS ─────────────────────────────────────────────────────────────────────

@router.get("/isis-neighbors", summary="All IS-IS adjacencies across tenant devices")
async def isis_neighbors_all(
    current_user: User         = Depends(get_current_user),
    db:           AsyncSession = Depends(get_db),
) -> list[dict]:
    rows = (await db.execute(
        select(ISISNeighbor, Device)
        .join(Device, ISISNeighbor.device_id == Device.id)
        .where(Device.tenant_id == current_user.tenant_id)
        .order_by(Device.hostname, ISISNeighbor.interface_name, ISISNeighbor.sys_id)
    )).all()
    return [
        {
            "id":               str(n.id),
            "device_id":        str(n.device_id),
            "device_name":      dev.display_name,
            "instance":         n.instance,
            "sys_id":           n.sys_id,
            "hostname":         n.hostname,
            "interface_name":   n.interface_name,
            "circuit_type":     n.circuit_type or "level-1-2",
            "adjacency_state":  n.adjacency_state,
            "ipv4_address":     str(n.ipv4_address) if n.ipv4_address else None,
            "ipv6_address":     str(n.ipv6_address) if n.ipv6_address else None,
            "uptime_seconds":   n.uptime_seconds,
            "last_state_change": n.last_state_change.isoformat() if n.last_state_change else None,
        }
        for n, dev in rows
    ]


@router.get("/isis-summary", summary="IS-IS adjacency counts by device")
async def isis_summary(
    current_user: User         = Depends(get_current_user),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    rows = (await db.execute(text("""
        SELECT
            COUNT(*)                                                                  AS total,
            COUNT(*) FILTER (WHERE i.adjacency_state = 'up'::isis_adj_state)         AS up,
            COUNT(*) FILTER (WHERE i.adjacency_state != 'up'::isis_adj_state
                               AND i.adjacency_state != 'unknown'::isis_adj_state)   AS down,
            COUNT(DISTINCT i.device_id)                                               AS devices
        FROM isis_neighbors i
        JOIN devices d ON d.id = i.device_id
        WHERE d.tenant_id = :tid
    """), {"tid": str(current_user.tenant_id)})).mappings().all()

    r = rows[0] if rows else {}
    return {
        "total":   int(r.get("total") or 0),
        "up":      int(r.get("up") or 0),
        "down":    int(r.get("down") or 0),
        "devices": int(r.get("devices") or 0),
    }


@router.get("/isis-areas", summary="IS-IS area addresses per device and instance")
async def isis_areas(
    current_user: User         = Depends(get_current_user),
    db:           AsyncSession = Depends(get_db),
) -> list[dict]:
    rows = (await db.execute(
        select(ISISArea, Device)
        .join(Device, ISISArea.device_id == Device.id)
        .where(Device.tenant_id == current_user.tenant_id)
        .order_by(Device.hostname, ISISArea.instance, ISISArea.area_addr)
    )).all()
    return [
        {
            "device_id":   str(a.device_id),
            "device_name": dev.display_name,
            "instance":    a.instance,
            "area_addr":   a.area_addr,
        }
        for a, dev in rows
    ]
