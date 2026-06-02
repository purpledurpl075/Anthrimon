from __future__ import annotations

import asyncio
import re
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import cast, or_, select, String, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_current_user, get_db
from ..models.alert import Alert
from ..models.bgp import BGPSession
from ..models.device import Device
from ..models.interface import ARPEntry, Interface, MACEntry
from ..models.tenant import User

router = APIRouter(tags=["search"])

_PER_TYPE = 5

# Hex chars only (used to detect MAC-like queries)
_HEX_RE = re.compile(r'^[0-9a-fA-F:.\-]+$')


def _result(type: str, id: str, title: str, subtitle: Optional[str], url: str,
             meta: Optional[str] = None) -> dict:
    return {"type": type, "id": id, "title": title, "subtitle": subtitle,
            "url": url, "meta": meta}


def _mac_pat(q: str) -> str:
    """Normalize a MAC-like query to colon-separated lowercase for ILIKE.

    PostgreSQL stores macaddr as aa:bb:cc:dd:ee:ff.
    Handles: aabbccddeeff, aa-bb-cc-dd-ee-ff, aa:bb:cc:dd:ee:ff, aabb.ccdd.eeff.
    Partial inputs (e.g. 'aa:bb') are returned as-is after colon-normalizing.
    """
    stripped = re.sub(r'[:\-\. ]', '', q).lower()
    if re.fullmatch(r'[0-9a-f]{12}', stripped):
        # Full 6-octet MAC — format with colons
        return ':'.join(stripped[i:i+2] for i in range(0, 12, 2))
    # Partial — normalize any dash/dot separators to colons
    return re.sub(r'[\-\.]', ':', q).lower()


def _looks_like_mac(q: str) -> bool:
    stripped = re.sub(r'[:\-\. ]', '', q)
    return bool(re.fullmatch(r'[0-9a-fA-F]{4,12}', stripped))


async def _search_devices(q: str, tenant_id, db: AsyncSession) -> list[dict]:
    pat = f"%{q}%"
    rows = (await db.execute(
        select(Device)
        .where(
            Device.tenant_id == tenant_id,
            Device.is_active == True,  # noqa: E712
            or_(
                Device.hostname.ilike(pat),
                Device.fqdn.ilike(pat),
                cast(Device.mgmt_ip, String).ilike(pat),
                Device.sys_description.ilike(pat),
                Device.sys_location.ilike(pat),
            ),
        )
        .limit(_PER_TYPE)
    )).scalars().all()
    return [
        _result("device", str(d.id),
                d.display_name,
                str(d.mgmt_ip).split("/")[0],
                f"/devices/{d.id}",
                d.status)
        for d in rows
    ]


async def _search_interfaces(q: str, tenant_id, db: AsyncSession) -> list[dict]:
    pat = f"%{q}%"
    rows = (await db.execute(
        select(Interface, Device.hostname)
        .join(Device, Interface.device_id == Device.id)
        .where(
            Device.tenant_id == tenant_id,
            or_(
                Interface.name.ilike(pat),
                Interface.description.ilike(pat),
            ),
        )
        .limit(_PER_TYPE)
    )).all()
    return [
        _result("interface", str(iface.id),
                iface.name,
                f"{hostname} — {iface.description}" if iface.description else hostname,
                f"/devices/{iface.device_id}/interfaces/{iface.id}",
                None)
        for iface, hostname in rows
    ]


async def _search_alerts(q: str, tenant_id, db: AsyncSession) -> list[dict]:
    pat = f"%{q}%"
    rows = (await db.execute(
        select(Alert)
        .where(
            Alert.tenant_id == tenant_id,
            Alert.status.in_(["open", "acknowledged"]),
            Alert.title.ilike(pat),
        )
        .order_by(Alert.triggered_at.desc())
        .limit(_PER_TYPE)
    )).scalars().all()
    return [
        _result("alert", str(a.id),
                a.title,
                a.severity.capitalize(),
                f"/alerts/{a.id}",
                a.severity)
        for a in rows
    ]


async def _search_bgp(q: str, tenant_id, db: AsyncSession) -> list[dict]:
    pat = f"%{q}%"
    rows = (await db.execute(
        select(BGPSession, Device.hostname)
        .join(Device, BGPSession.device_id == Device.id)
        .where(
            Device.tenant_id == tenant_id,
            or_(
                cast(BGPSession.peer_ip, String).ilike(pat),
                BGPSession.peer_description.ilike(pat),
                cast(BGPSession.peer_asn, String).ilike(pat),
            ),
        )
        .limit(_PER_TYPE)
    )).all()
    return [
        _result("bgp_peer", str(s.id),
                str(s.peer_ip).split("/")[0],
                f"{hostname} — AS{s.peer_asn}" + (f" {s.peer_description}" if s.peer_description else ""),
                f"/routing?device={s.device_id}&peer={s.peer_ip}",
                s.session_state)
        for s, hostname in rows
    ]


async def _search_addresses(q: str, tenant_id, db: AsyncSession) -> list[dict]:
    """Search ARP table (IP + MAC) and MAC address table."""
    ip_pat  = f"%{q}%"
    mac_pat = f"%{_mac_pat(q)}%"
    is_mac  = _looks_like_mac(q)

    results: list[dict] = []

    # ARP entries — match on IP or MAC
    ip_filter  = cast(ARPEntry.ip_address,  String).ilike(ip_pat)
    mac_filter = cast(ARPEntry.mac_address, String).ilike(mac_pat)
    arp_clause = mac_filter if is_mac else or_(ip_filter, mac_filter)

    arp_rows = (await db.execute(
        select(ARPEntry, Device.hostname)
        .join(Device, ARPEntry.device_id == Device.id)
        .where(Device.tenant_id == tenant_id, arp_clause)
        .order_by(ARPEntry.updated_at.desc())
        .limit(_PER_TYPE)
    )).all()

    seen_macs: set[str] = set()
    for entry, hostname in arp_rows:
        mac = str(entry.mac_address)
        seen_macs.add(mac)
        mac_url = mac.replace(":", "-")
        results.append(_result(
            "address",
            str(entry.id),
            str(entry.ip_address),
            f"{mac}  —  {hostname}" + (f" {entry.interface_name}" if entry.interface_name else ""),
            f"/clients/{mac_url}",
            None,
        ))

    # MAC table — entries that didn't already appear via ARP
    mac_rows = (await db.execute(
        select(MACEntry, Device.hostname)
        .join(Device, MACEntry.device_id == Device.id)
        .where(
            Device.tenant_id == tenant_id,
            cast(MACEntry.mac_address, String).ilike(mac_pat),
        )
        .order_by(MACEntry.updated_at.desc())
        .limit(_PER_TYPE)
    )).all()

    for entry, hostname in mac_rows:
        mac = str(entry.mac_address)
        if mac in seen_macs:
            continue
        mac_url = mac.replace(":", "-")
        vlan = f" VLAN {entry.vlan_id}" if entry.vlan_id else ""
        results.append(_result(
            "address",
            str(entry.id),
            mac,
            f"{hostname}  —  {entry.port_name or '?'}{vlan}",
            f"/clients/{mac_url}",
            None,
        ))

    return results[:_PER_TYPE]


async def _search_config(q: str, tenant_id, db: AsyncSession) -> list[dict]:
    """Search only the *current* (latest) config backup per device.

    We get the latest backup per device first, then filter by the search term.
    This prevents stale historical backups from producing false matches.
    """
    pat = f"%{q}%"
    rows = (await db.execute(
        text("""
            SELECT device_id, hostname, fqdn, collected_at
            FROM (
                SELECT DISTINCT ON (cb.device_id)
                       cb.device_id,
                       d.hostname,
                       d.fqdn,
                       cb.collected_at,
                       cb.config_text
                FROM   config_backups cb
                JOIN   devices d ON d.id = cb.device_id
                WHERE  d.tenant_id = :tid
                ORDER  BY cb.device_id, cb.collected_at DESC
            ) latest
            WHERE  config_text ILIKE :pat
            LIMIT  :lim
        """),
        {"tid": str(tenant_id), "pat": pat, "lim": _PER_TYPE},
    )).all()
    return [
        _result("config", str(r.device_id),
                r.fqdn or r.hostname,
                f"Found in current config",
                f"/config?device={r.device_id}",
                None)
        for r in rows
    ]


@router.get("/search")
async def search(
    q: str = Query(..., min_length=1, max_length=100),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    q = q.strip()
    if not q:
        return {"results": []}

    tid = current_user.tenant_id
    devices, interfaces, alerts, bgp, addresses, config = await asyncio.gather(
        _search_devices(q, tid, db),
        _search_interfaces(q, tid, db),
        _search_alerts(q, tid, db),
        _search_bgp(q, tid, db),
        _search_addresses(q, tid, db),
        _search_config(q, tid, db),
        return_exceptions=True,
    )

    results: list[dict] = []
    for bucket in (devices, interfaces, alerts, bgp, addresses, config):
        if isinstance(bucket, list):
            results.extend(bucket)

    return {"results": results}
