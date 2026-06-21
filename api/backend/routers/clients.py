from __future__ import annotations

import re
import time
from typing import Optional

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import cast, or_, select, String, text as sqla_text, union_all
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_current_user, get_db
from ..models.device import Device
from ..models.interface import ARPEntry, CDPNeighbor, Interface, LLDPNeighbor, MACEntry
from ..models.tenant import User

router = APIRouter(prefix="/clients", tags=["clients"])
logger = structlog.get_logger(__name__)

# ── OUI cache ──────────────────────────────────────────────────────────────
_oui_cache: dict[str, tuple[str, float]] = {}
_OUI_TTL = 86400.0  # 24 h


def _norm_mac(raw: str) -> str:
    stripped = re.sub(r'[:\-\. ]', '', raw).lower()
    if len(stripped) == 12:
        return ':'.join(stripped[i:i+2] for i in range(0, 12, 2))
    return raw.lower()


async def _oui_vendor(mac: str) -> Optional[str]:
    oui = mac[:8].upper()
    cached = _oui_cache.get(oui)
    if cached and (time.monotonic() - cached[1]) < _OUI_TTL:
        return cached[0] or None
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            resp = await client.get(f"https://api.macvendors.com/{oui}")
        vendor = resp.text.strip() if resp.status_code == 200 else ""
        _oui_cache[oui] = (vendor, time.monotonic())
        return vendor or None
    except Exception:
        _oui_cache[oui] = ("", time.monotonic())
        return None


# ── Endpoint ───────────────────────────────────────────────────────────────

@router.get("/{mac_param}")
async def get_client(
    mac_param: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    mac = _norm_mac(mac_param)
    if not re.fullmatch(r'[0-9a-f]{2}(:[0-9a-f]{2}){5}', mac):
        raise HTTPException(status_code=400, detail="Invalid MAC address")

    tenant_id = current_user.tenant_id

    # Fetch tenant device list once — used for both ARP/MAC queries and name map
    device_rows = (await db.execute(
        select(Device.id, Device.hostname, Device.fqdn)
        .where(Device.tenant_id == tenant_id)
    )).all()
    device_map = {str(r.id): (r.fqdn or r.hostname) for r in device_rows}
    allowed_ids = list(device_map.keys())

    arp_rows = (await db.execute(
        select(ARPEntry)
        .where(
            cast(ARPEntry.device_id, String).in_(allowed_ids),
            cast(ARPEntry.mac_address, String) == mac,
        )
        .order_by(ARPEntry.updated_at.desc())
    )).scalars().all()

    mac_rows = (await db.execute(
        select(MACEntry)
        .where(
            cast(MACEntry.device_id, String).in_(allowed_ids),
            cast(MACEntry.mac_address, String) == mac,
        )
        .order_by(MACEntry.updated_at.desc())
    )).scalars().all()

    if not arp_rows and not mac_rows:
        raise HTTPException(status_code=404, detail="Client not found")

    # Uplink ports — only for devices that have MAC entries for this client
    mac_device_ids = {str(m.device_id) for m in mac_rows}
    uplink_ports: dict[str, set[str]] = {}
    if mac_device_ids:
        # Single UNION query for LLDP + CDP uplink ports
        # Only treat ports as uplinks when the LLDP/CDP neighbor is network infrastructure
        # (switch/bridge/router). End hosts with LLDP enabled (e.g. Intel NICs) report
        # "stationOnly" and must not cause access ports to be filtered out.
        _infra_lldp = or_(
            LLDPNeighbor.remote_system_capabilities.contains(["switch"]),
            LLDPNeighbor.remote_system_capabilities.contains(["bridge"]),
            LLDPNeighbor.remote_system_capabilities.contains(["router"]),
        )
        _infra_cdp = or_(
            CDPNeighbor.remote_capabilities.contains(["switch"]),
            CDPNeighbor.remote_capabilities.contains(["router"]),
            CDPNeighbor.remote_capabilities.contains(["trans-bridge"]),
        )
        lldp_q = select(
            cast(LLDPNeighbor.device_id, String).label("device_id"),
            LLDPNeighbor.local_port_name,
        ).where(cast(LLDPNeighbor.device_id, String).in_(mac_device_ids), _infra_lldp)
        cdp_q = select(
            cast(CDPNeighbor.device_id, String).label("device_id"),
            CDPNeighbor.local_port_name,
        ).where(cast(CDPNeighbor.device_id, String).in_(mac_device_ids), _infra_cdp)
        uplink_rows = (await db.execute(union_all(lldp_q, cdp_q))).all()
        for r in uplink_rows:
            uplink_ports.setdefault(r.device_id, set()).add(r.local_port_name)

    # Port name → interface id lookup (only ports we'll actually display)
    port_names = [m.port_name for m in mac_rows if m.port_name
                  and m.port_name not in uplink_ports.get(str(m.device_id), set())]
    iface_lookup: dict[tuple[str, str], str] = {}
    if port_names:
        iface_rows = (await db.execute(
            select(Interface.id, Interface.device_id, Interface.name)
            .where(
                cast(Interface.device_id, String).in_(allowed_ids),
                Interface.name.in_(port_names),
            )
        )).all()
        iface_lookup = {(str(r.device_id), r.name): str(r.id) for r in iface_rows}

    # Physical presence: MAC table entries only, uplink ports excluded
    presences: list[dict] = []
    for m in mac_rows:
        did = str(m.device_id)
        if m.port_name and m.port_name in uplink_ports.get(did, set()):
            continue
        iface_id = iface_lookup.get((did, m.port_name or "")) if m.port_name else None
        presences.append({
            "device_id":     did,
            "device_name":   device_map.get(did),
            "port":          m.port_name,
            "port_iface_id": iface_id,
            "vlan_id":       m.vlan_id,
            "last_seen":     m.updated_at.isoformat(),
        })

    # Known IPs — deduplicate by IP, keep the most-recently-seen device per IP
    # arp_rows are already sorted desc by updated_at, so first occurrence wins
    seen_ips: set[str] = set()
    ips: list[dict] = []
    for a in arp_rows:
        ip_str = str(a.ip_address)
        if ip_str not in seen_ips:
            seen_ips.add(ip_str)
            ips.append({
                "ip":             ip_str,
                "device_id":      str(a.device_id),
                "device_name":    device_map.get(str(a.device_id)),
                "interface_name": a.interface_name,
                "last_seen":      a.updated_at.isoformat(),
            })

    # IP intelligence
    ip_intel: dict[str, dict] = {}
    if seen_ips:
        intel_rows = (await db.execute(
            sqla_text("SELECT * FROM ip_intel WHERE ip = ANY(:ips)"),
            {"ips": list(seen_ips)},
        )).all()
        for row in intel_rows:
            ip_intel[str(row.ip)] = {
                "is_private":    row.is_private,
                "country_iso":   row.country_iso,
                "country_name":  row.country_name,
                "asn":           row.asn,
                "asn_org":       row.asn_org,
                "city":          row.city,
                "abuse_score":   row.abuse_score,
                "abuse_reports": row.abuse_reports,
                "abuse_isp":     row.abuse_isp,
            }

    vendor: Optional[str] = None
    try:
        vendor = await _oui_vendor(mac)
    except Exception:
        pass

    return {
        "mac":       mac,
        "vendor":    vendor,
        "presences": presences,
        "ips":       ips,
        "ip_intel":  ip_intel,
    }
