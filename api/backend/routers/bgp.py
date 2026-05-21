from __future__ import annotations

from typing import Optional

import structlog
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, desc, func
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_current_user, get_db
from ..models.bgp import BGPSession, BGPSessionEvent
from ..models.device import Device
from ..models.tenant import User

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
    return [_session_out(s, dev.fqdn or dev.hostname) for s, dev in rows]


@router.get("/devices/{device_id}/sessions", summary="BGP sessions for a device")
async def device_sessions(
    device_id:    str,
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
    name = dev.fqdn or dev.hostname
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

    # Top flappers (flap_count > 0, sorted descending).
    flappers = (await db.execute(
        select(BGPSession, Device)
        .join(Device, BGPSession.device_id == Device.id)
        .where(Device.tenant_id == current_user.tenant_id, BGPSession.flap_count > 0)
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
                "device_name": dev.fqdn or dev.hostname,
                "peer_ip":     str(s.peer_ip),
                "peer_asn":    s.peer_asn,
                "flap_count":  s.flap_count,
                "state":       s.session_state,
            }
            for s, dev in flappers
        ],
    }
