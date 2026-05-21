from __future__ import annotations

import asyncio
import time
import uuid
from typing import List, Optional

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..dependencies import get_current_user, get_db, require_role
from ..models.alert import Alert
from ..models.credential import Credential, DeviceCredential
from ..models.device import Device
from ..models.health import DeviceHealthLatest
from ..models.interface import ARPEntry, CDPNeighbor, Interface, LLDPNeighbor, MACEntry, OSPFNeighbor, RouteEntry
from ..models.tenant import User
from ..schemas.alert import AlertRead
from ..schemas.common import PaginatedResponse
from ..schemas.device import DeviceCreate, DeviceListRead, DeviceRead, DeviceUpdate
from ..schemas.interface import InterfaceRead

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/devices", tags=["devices"])

_VENDOR_DEVICE_TYPE: dict[str, str] = {
    "arista":       "switch",
    "aruba_cx":     "switch",
    "procurve":     "switch",
    "cisco_nxos":   "switch",
    "cisco_ios":    "router",
    "cisco_iosxe":  "router",
    "cisco_iosxr":  "router",
    "juniper":      "router",
    "fortios":      "firewall",
}


# ── Global address table — must be registered before /{device_id} routes ──────

@router.get("/addresses", summary="ARP and MAC address table across all devices")
async def get_all_addresses(
    search: Optional[str] = Query(default=None),
    type: Optional[str] = Query(default=None, description="arp | mac"),
    device_id: Optional[uuid.UUID] = Query(default=None),
    limit: int = Query(default=500, ge=1, le=5000),
    offset: int = Query(default=0, ge=0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    from sqlalchemy import cast, String, or_

    tenant_id = current_user.tenant_id
    items: list[dict] = []

    device_rows = (await db.execute(
        select(Device.id, Device.hostname, Device.fqdn).where(Device.tenant_id == tenant_id)
    )).all()
    hostname = {str(r.id): r.fqdn or r.hostname for r in device_rows}
    allowed_ids = set(hostname.keys())

    # Build MAC→(physical_port, vlan_id) lookup so ARP entries can show the
    # physical port rather than the L3 SVI (e.g. "Vlan2").
    mac_q = select(MACEntry).where(cast(MACEntry.device_id, String).in_(allowed_ids))
    if device_id:
        mac_q = mac_q.where(MACEntry.device_id == device_id)
    mac_rows_all = (await db.execute(mac_q)).scalars().all()
    # (device_id, normalised_mac) → (port_name, vlan_id)
    mac_lookup: dict[tuple[str, str], tuple[str | None, int | None]] = {
        (str(m.device_id), m.mac_address.lower()): (m.port_name, m.vlan_id)
        for m in mac_rows_all
    }

    # Build (device_id, iface_name) → iface_id so port names become clickable links.
    iface_q = select(Interface.id, Interface.device_id, Interface.name).where(
        cast(Interface.device_id, String).in_(allowed_ids)
    )
    if device_id:
        iface_q = iface_q.where(Interface.device_id == device_id)
    iface_rows = (await db.execute(iface_q)).all()
    iface_lookup: dict[tuple[str, str], str] = {
        (str(r.device_id), r.name): str(r.id) for r in iface_rows
    }

    if not type or type == "arp":
        q = select(ARPEntry).where(cast(ARPEntry.device_id, String).in_(allowed_ids))
        if device_id:
            q = q.where(ARPEntry.device_id == device_id)
        if search:
            q = q.where(or_(
                cast(ARPEntry.ip_address, String).ilike(f"%{search}%"),
                cast(ARPEntry.mac_address, String).ilike(f"%{search}%"),
            ))
        rows = (await db.execute(q.order_by(ARPEntry.ip_address))).scalars().all()
        for r in rows:
            did      = str(r.device_id)
            mac_info = mac_lookup.get((did, str(r.mac_address).lower()))
            phys_port = mac_info[0] if mac_info else None
            vlan_id   = mac_info[1] if mac_info else None
            port_name = phys_port or r.interface_name
            items.append({
                "type": "arp", "device_id": did,
                "device_name": hostname.get(did, ""),
                "ip": str(r.ip_address), "mac": str(r.mac_address),
                "port":           port_name,
                "port_iface_id":  iface_lookup.get((did, port_name)) if port_name else None,
                "vlan_interface": r.interface_name if phys_port else None,
                "vlan":           vlan_id,
                "entry_type": r.entry_type, "updated_at": r.updated_at.isoformat(),
            })

    if not type or type == "mac":
        q = select(MACEntry).where(cast(MACEntry.device_id, String).in_(allowed_ids))
        if device_id:
            q = q.where(MACEntry.device_id == device_id)
        if search:
            q = q.where(cast(MACEntry.mac_address, String).ilike(f"%{search}%"))
        rows = (await db.execute(q.order_by(MACEntry.mac_address))).scalars().all()
        for r in rows:
            did = str(r.device_id)
            items.append({
                "type": "mac", "device_id": did,
                "device_name": hostname.get(did, ""),
                "ip": None, "mac": str(r.mac_address),
                "port":          r.port_name,
                "port_iface_id": iface_lookup.get((did, r.port_name)) if r.port_name else None,
                "vlan_interface": None, "vlan": r.vlan_id,
                "entry_type": r.entry_type, "updated_at": r.updated_at.isoformat(),
            })

    total = len(items)
    return {"total": total, "limit": limit, "offset": offset, "items": items[offset: offset + limit]}


# ── List ───────────────────────────────────────────────────────────────────────

@router.get("", response_model=PaginatedResponse[DeviceListRead], summary="List devices")
async def list_devices(
    status_filter: Optional[str] = Query(default=None, alias="status"),
    vendor: Optional[str] = Query(default=None),
    site_id: Optional[uuid.UUID] = Query(default=None),
    is_active: bool = Query(default=True),
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PaginatedResponse[DeviceListRead]:
    q = select(Device).where(Device.tenant_id == current_user.tenant_id)

    if is_active is not None:
        q = q.where(Device.is_active == is_active)
    if status_filter:
        q = q.where(Device.status == status_filter)
    if vendor:
        q = q.where(Device.vendor == vendor)
    if site_id:
        q = q.where(Device.site_id == site_id)

    total_result = await db.execute(select(func.count()).select_from(q.subquery()))
    total = total_result.scalar_one()

    result = await db.execute(q.order_by(Device.hostname).limit(limit).offset(offset))
    devices = result.scalars().all()

    return PaginatedResponse(
        total=total,
        limit=limit,
        offset=offset,
        items=[DeviceListRead.model_validate(d) for d in devices],
    )


# ── Create ─────────────────────────────────────────────────────────────────────

@router.post("", response_model=DeviceRead, status_code=status.HTTP_201_CREATED, summary="Add a device")
async def create_device(
    body: DeviceCreate,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> DeviceRead:
    fields = body.model_dump(exclude_none=True, exclude={"mgmt_ip", "credential_id"})
    if "device_type" not in fields and "vendor" in fields:
        fields.setdefault("device_type", _VENDOR_DEVICE_TYPE.get(fields["vendor"], "unknown"))
    device = Device(
        tenant_id=current_user.tenant_id,
        **fields,
        mgmt_ip=str(body.mgmt_ip),
    )
    db.add(device)
    await db.flush()  # get device.id before linking credential

    if body.credential_id:
        cred = (await db.execute(
            select(Credential).where(
                Credential.id == body.credential_id,
                Credential.tenant_id == current_user.tenant_id,
            )
        )).scalar_one_or_none()
        if cred is None:
            raise HTTPException(status_code=404, detail="Credential not found")
        db.add(DeviceCredential(device_id=device.id, credential_id=body.credential_id, priority=0))

    await db.commit()
    await db.refresh(device)
    logger.info("device_created", device_id=str(device.id), hostname=device.hostname)
    return DeviceRead.model_validate(device)


# ── Get one ────────────────────────────────────────────────────────────────────

@router.get("/{device_id}", response_model=DeviceRead, summary="Get device details")
async def get_device(
    device_id: uuid.UUID,
    include_health: bool = Query(default=False, alias="include_health"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DeviceRead:
    q = select(Device).where(Device.id == device_id, Device.tenant_id == current_user.tenant_id)

    if include_health:
        q = q.options(selectinload(Device.health), selectinload(Device.site))

    result = await db.execute(q)
    device = result.scalar_one_or_none()
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")

    return DeviceRead.model_validate(device)


# ── Update ─────────────────────────────────────────────────────────────────────

@router.patch("/{device_id}", response_model=DeviceRead, summary="Update device fields")
async def update_device(
    device_id: uuid.UUID,
    body: DeviceUpdate,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> DeviceRead:
    result = await db.execute(
        select(Device).where(Device.id == device_id, Device.tenant_id == current_user.tenant_id)
    )
    device = result.scalar_one_or_none()
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")

    updates = body.model_dump(exclude_none=True)
    if "mgmt_ip" in updates:
        updates["mgmt_ip"] = str(updates["mgmt_ip"])

    for field, value in updates.items():
        setattr(device, field, value)

    await db.commit()
    await db.refresh(device)
    logger.info("device_updated", device_id=str(device_id), fields=list(updates.keys()))
    return DeviceRead.model_validate(device)


# ── Delete ─────────────────────────────────────────────────────────────────────

@router.delete("/{device_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None, summary="Remove a device")
async def delete_device(
    device_id: uuid.UUID,
    current_user: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> None:
    result = await db.execute(
        select(Device).where(Device.id == device_id, Device.tenant_id == current_user.tenant_id)
    )
    device = result.scalar_one_or_none()
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")

    await db.delete(device)
    await db.commit()
    logger.info("device_deleted", device_id=str(device_id))


# ── Sub-resources ──────────────────────────────────────────────────────────────

@router.get("/{device_id}/interfaces", response_model=List[InterfaceRead], summary="List interfaces for a device")
async def list_device_interfaces(
    device_id: uuid.UUID,
    oper_status: Optional[str] = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> List[InterfaceRead]:
    await _assert_device_visible(device_id, current_user, db)

    q = select(Interface).where(Interface.device_id == device_id)
    if oper_status:
        q = q.where(Interface.oper_status == oper_status)

    result = await db.execute(q.order_by(Interface.if_index))
    return [InterfaceRead.model_validate(i) for i in result.scalars().all()]


@router.get("/{device_id}/health", summary="Latest health metrics for a device")
async def get_device_health(
    device_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _assert_device_visible(device_id, current_user, db)

    result = await db.execute(
        select(DeviceHealthLatest).where(DeviceHealthLatest.device_id == device_id)
    )
    health = result.scalar_one_or_none()
    if health is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No health data yet for this device")

    return {
        "device_id": str(health.device_id),
        "collected_at": health.collected_at,
        "cpu_util_pct": health.cpu_util_pct,
        "mem_used_bytes": health.mem_used_bytes,
        "mem_total_bytes": health.mem_total_bytes,
        "mem_util_pct": round(health.mem_used_bytes / health.mem_total_bytes * 100, 2)
            if health.mem_used_bytes and health.mem_total_bytes else None,
        "temperatures": health.temperatures,
        "uptime_seconds": health.uptime_seconds,
    }


_VM_URL = "http://localhost:8428"


@router.get("/{device_id}/health/history", summary="Health metric history from VictoriaMetrics")
async def get_device_health_history(
    device_id: uuid.UUID,
    hours: float = Query(default=1.0, ge=0.1, le=48.0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _assert_device_visible(device_id, current_user, db)
    did   = str(device_id)
    now   = int(time.time())
    start = now - int(hours * 3600)
    step  = 60 if hours <= 1 else 300 if hours <= 6 else 900

    async def vm_range(query: str) -> list:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                r = await client.get(f"{_VM_URL}/api/v1/query_range",
                    params={"query": query, "start": start, "end": now, "step": step})
                r.raise_for_status()
                results = r.json().get("data", {}).get("result", [])
                if results:
                    return [[int(v[0]), float(v[1])] for v in results[0].get("values", [])]
        except Exception:
            pass
        return []

    # Parallel fetch of CPU, mem used, mem total
    cpu_series, mem_used, mem_total = await asyncio.gather(
        vm_range(f'avg(anthrimon_device_cpu_util_pct{{device_id="{did}"}})'),
        vm_range(f'anthrimon_device_mem_used_bytes{{device_id="{did}",mem_type="ram"}}'),
        vm_range(f'anthrimon_device_mem_total_bytes{{device_id="{did}",mem_type="ram"}}'),
    )

    # Compute memory % from raw byte series
    mem_pct: list = []
    if mem_used and mem_total:
        total_map = {int(ts): v for ts, v in mem_total}
        for ts, used in mem_used:
            tot = total_map.get(int(ts))
            if tot and tot > 0:
                mem_pct.append([int(ts), round(used / tot * 100, 1)])

    # Temperature + optical power series — one series per sensor/iface
    temp_series:   dict[str, list] = {}
    dom_tx_series: dict[str, list] = {}
    dom_rx_series: dict[str, list] = {}

    async def vm_multi(query: str) -> list[dict]:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                r = await client.get(f"{_VM_URL}/api/v1/query_range",
                    params={"query": query, "start": start, "end": now, "step": step})
                r.raise_for_status()
                return r.json().get("data", {}).get("result", [])
        except Exception:
            return []

    temp_results, dom_tx_results, dom_rx_results = await asyncio.gather(
        vm_multi(f'anthrimon_device_temp_celsius{{device_id="{did}"}}'),
        vm_multi(f'anthrimon_if_dom_tx_power_dbm{{device_id="{did}"}}'),
        vm_multi(f'anthrimon_if_dom_rx_power_dbm{{device_id="{did}"}}'),
    )

    for result in temp_results:
        sensor = result["metric"].get("sensor", "unknown")
        temp_series[sensor] = [[int(v[0]), float(v[1])] for v in result.get("values", [])]

    for result in dom_tx_results:
        iface = result["metric"].get("iface", "unknown")
        dom_tx_series[iface] = [[int(v[0]), float(v[1])] for v in result.get("values", [])]

    for result in dom_rx_results:
        iface = result["metric"].get("iface", "unknown")
        dom_rx_series[iface] = [[int(v[0]), float(v[1])] for v in result.get("values", [])]

    return {
        "cpu_pct":     cpu_series,
        "mem_pct":     mem_pct,
        "mem_used":    mem_used,
        "mem_total":   mem_total,
        "temp_series": temp_series,
        "dom_tx":      dom_tx_series,
        "dom_rx":      dom_rx_series,
    }


@router.get("/{device_id}/alerts", response_model=List[AlertRead], summary="Active alerts for a device")
async def get_device_alerts(
    device_id: uuid.UUID,
    alert_status: Optional[str] = Query(default="open", alias="status"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> List[AlertRead]:
    await _assert_device_visible(device_id, current_user, db)

    q = select(Alert).where(Alert.device_id == device_id, Alert.tenant_id == current_user.tenant_id)
    if alert_status:
        q = q.where(Alert.status == alert_status)

    result = await db.execute(q.order_by(Alert.triggered_at.desc()))
    return [AlertRead.model_validate(a) for a in result.scalars().all()]


# ── Alert exclusions ───────────────────────────────────────────────────────────

class _AlertExclusionsBody(BaseModel):
    metrics: list[str] = []
    interface_ids: list[str] = []


@router.put("/{device_id}/alert-exclusions", summary="Set alert exclusions for a device")
async def set_alert_exclusions(
    device_id: uuid.UUID,
    body: _AlertExclusionsBody,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    device = await _assert_device_visible(device_id, current_user, db)
    device.alert_exclusions = {"metrics": body.metrics, "interface_ids": body.interface_ids}
    await db.commit()
    return device.alert_exclusions


# ── Credential linking ─────────────────────────────────────────────────────────

class _CredentialLinkBody(BaseModel):
    credential_id: uuid.UUID
    priority: int = 0


@router.get("/{device_id}/credentials", summary="List credentials assigned to a device")
async def list_device_credentials(
    device_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    await _assert_device_visible(device_id, current_user, db)
    rows = (await db.execute(
        select(DeviceCredential, Credential)
        .join(Credential, Credential.id == DeviceCredential.credential_id)
        .where(DeviceCredential.device_id == device_id)
        .order_by(DeviceCredential.priority)
    )).all()
    return [
        {"credential_id": str(dc.credential_id), "name": c.name,
         "type": c.type, "priority": dc.priority}
        for dc, c in rows
    ]


@router.post("/{device_id}/credentials", status_code=status.HTTP_204_NO_CONTENT,
             response_model=None, summary="Attach a credential to a device")
async def link_device_credential(
    device_id: uuid.UUID,
    body: _CredentialLinkBody,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> None:
    await _assert_device_visible(device_id, current_user, db)

    if (await db.execute(
        select(Credential).where(
            Credential.id == body.credential_id,
            Credential.tenant_id == current_user.tenant_id,
        )
    )).scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Credential not found")

    link = DeviceCredential(
        device_id=device_id,
        credential_id=body.credential_id,
        priority=body.priority,
    )
    db.add(link)
    try:
        await db.commit()
    except Exception:
        await db.rollback()


@router.delete("/{device_id}/credentials/{credential_id}",
               status_code=status.HTTP_204_NO_CONTENT, response_model=None,
               summary="Remove a credential from a device")
async def unlink_device_credential(
    device_id: uuid.UUID,
    credential_id: uuid.UUID,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> None:
    await _assert_device_visible(device_id, current_user, db)
    link = (await db.execute(
        select(DeviceCredential).where(
            DeviceCredential.device_id == device_id,
            DeviceCredential.credential_id == credential_id,
        )
    )).scalar_one_or_none()
    if link is None:
        raise HTTPException(status_code=404, detail="Credential not assigned to this device")
    await db.delete(link)
    await db.commit()


# ── Global address table (all devices) ────────────────────────────────────────

# ── Address table ─────────────────────────────────────────────────────────────

@router.get("/{device_id}/addresses", summary="ARP and MAC address table")
async def get_addresses(
    device_id: uuid.UUID,
    search: Optional[str] = Query(default=None, description="Partial MAC or IP"),
    type: Optional[str] = Query(default=None, description="arp | mac"),
    limit: int = Query(default=500, ge=1, le=5000),
    offset: int = Query(default=0, ge=0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    from sqlalchemy import or_, cast, String, func as sqlfunc

    await _assert_device_visible(device_id, current_user, db)

    items: list[dict] = []

    # MAC→(physical_port, vlan_id) so ARP rows can show the physical port
    mac_rows_all = (await db.execute(
        select(MACEntry).where(MACEntry.device_id == device_id)
    )).scalars().all()
    mac_lookup: dict[str, tuple[str | None, int | None]] = {
        m.mac_address.lower(): (m.port_name, m.vlan_id) for m in mac_rows_all
    }

    # iface_name → iface_id so port names become clickable links
    iface_rows = (await db.execute(
        select(Interface.id, Interface.name).where(Interface.device_id == device_id)
    )).all()
    iface_lookup: dict[str, str] = {r.name: str(r.id) for r in iface_rows}

    if not type or type == "arp":
        q = select(ARPEntry).where(ARPEntry.device_id == device_id)
        if search:
            q = q.where(or_(
                cast(ARPEntry.ip_address, String).ilike(f"%{search}%"),
                cast(ARPEntry.mac_address, String).ilike(f"%{search}%"),
            ))
        rows = (await db.execute(q.order_by(ARPEntry.ip_address))).scalars().all()
        for r in rows:
            mac_info  = mac_lookup.get(str(r.mac_address).lower())
            phys_port = mac_info[0] if mac_info else None
            vlan_id   = mac_info[1] if mac_info else None
            port_name = phys_port or r.interface_name
            items.append({
                "type":           "arp",
                "ip":             str(r.ip_address),
                "mac":            str(r.mac_address),
                "port":           port_name,
                "port_iface_id":  iface_lookup.get(port_name) if port_name else None,
                "vlan_interface": r.interface_name if phys_port else None,
                "vlan":           vlan_id,
                "entry_type":     r.entry_type,
                "updated_at":     r.updated_at.isoformat(),
            })

    if not type or type == "mac":
        q = select(MACEntry).where(MACEntry.device_id == device_id)
        if search:
            q = q.where(cast(MACEntry.mac_address, String).ilike(f"%{search}%"))
        rows = (await db.execute(q.order_by(MACEntry.mac_address))).scalars().all()
        for r in rows:
            items.append({
                "type":           "mac",
                "ip":             None,
                "mac":            str(r.mac_address),
                "port":           r.port_name,
                "port_iface_id":  iface_lookup.get(r.port_name) if r.port_name else None,
                "vlan_interface": None,
                "vlan":           r.vlan_id,
                "entry_type":     r.entry_type,
                "updated_at":     r.updated_at.isoformat(),
            })

    total = len(items)
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "items": items[offset: offset + limit],
    }


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/{device_id}/routes", summary="IP routing table")
async def get_routes(
    device_id: uuid.UUID,
    protocol: Optional[str] = Query(default=None, description="connected|static|ospf|other"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    await _assert_device_visible(device_id, current_user, db)
    q = select(RouteEntry).where(RouteEntry.device_id == device_id)
    if protocol:
        q = q.where(RouteEntry.protocol == protocol)
    rows = (await db.execute(
        q.order_by(RouteEntry.destination)
    )).scalars().all()
    return [
        {
            "destination":    r.destination,
            "next_hop":       r.next_hop or None,
            "protocol":       r.protocol,
            "metric":         r.metric,
            "interface_name": r.interface_name,
            "updated_at":     r.updated_at.isoformat(),
        }
        for r in rows
    ]


# ── VLANs ─────────────────────────────────────────────────────────────────────

@router.get("/{device_id}/vlans", summary="VLAN membership")
async def get_device_vlans(
    device_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    await _assert_device_visible(device_id, current_user, db)
    result = await db.execute(
        text("""
            SELECT v.vlan_id, v.name,
                   i.name AS interface_name,
                   iv.tagged
            FROM vlans v
            LEFT JOIN interface_vlans iv ON iv.vlan_id = v.vlan_id
            LEFT JOIN interfaces i ON i.id = iv.interface_id AND i.device_id = :did
            WHERE v.device_id = :did
            ORDER BY v.vlan_id, i.name
        """),
        {"did": device_id},
    )
    rows = result.mappings().all()
    vlans: dict[int, dict] = {}
    for row in rows:
        vid = row["vlan_id"]
        if vid not in vlans:
            vlans[vid] = {"vlan_id": vid, "name": row["name"], "ports": []}
        if row["interface_name"] is not None:
            vlans[vid]["ports"].append({
                "interface": row["interface_name"],
                "tagged": bool(row["tagged"]),
            })
    return list(vlans.values())


# ── STP ────────────────────────────────────────────────────────────────────────

@router.get("/{device_id}/stp", summary="STP port states")
async def get_device_stp(
    device_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    await _assert_device_visible(device_id, current_user, db)
    result = await db.execute(
        text("""
            SELECT i.name AS interface_name, i.if_index,
                   s.stp_state, s.stp_role
            FROM interface_stp s
            JOIN interfaces i ON i.id = s.interface_id
            WHERE i.device_id = :did
            ORDER BY i.if_index
        """),
        {"did": device_id},
    )
    rows = result.mappings().all()
    return [
        {
            "interface": row["interface_name"],
            "state": row["stp_state"],
            "role": row["stp_role"],
        }
        for row in rows
    ]


# ── OSPF ──────────────────────────────────────────────────────────────────────

@router.get("/{device_id}/ospf", summary="OSPF neighbor state")
async def get_ospf_neighbors(
    device_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    from sqlalchemy import cast, String, or_

    device = await _assert_device_visible(device_id, current_user, db)
    device_ip = str(device.mgmt_ip).split("/")[0]

    # Direct: rows where this device is the reporter
    direct = (await db.execute(
        select(OSPFNeighbor)
        .where(OSPFNeighbor.device_id == device_id)
        .order_by(OSPFNeighbor.neighbor_router_id)
    )).scalars().all()

    # Inferred: rows from OTHER devices that list this device's IP as the neighbor.
    # Covers devices whose SNMP agent doesn't expose OSPF-MIB (e.g. UniFi).
    inferred = (await db.execute(
        select(OSPFNeighbor, Device)
        .join(Device, Device.id == OSPFNeighbor.device_id)
        .where(
            OSPFNeighbor.device_id != device_id,
            Device.tenant_id == current_user.tenant_id,
            cast(OSPFNeighbor.neighbor_ip, String).contains(device_ip),
        )
    )).all()

    results = [
        {
            "neighbor_ip":      str(r.neighbor_ip) if r.neighbor_ip else None,
            "router_id":         str(r.neighbor_router_id) if r.neighbor_router_id else None,
            "state":             r.state,
            "area":              r.area,
            "interface_name":    r.interface_name,
            "priority":          r.priority,
            "last_state_change": r.last_state_change.isoformat() if r.last_state_change else None,
            "updated_at":        r.updated_at.isoformat(),
            "inferred":          False,
        }
        for r in direct
    ]

    # Add inferred entries (seen from the peer's perspective).
    # To find the peer's OSPF-facing IP, look in THIS device's ARP table for
    # an entry whose MAC matches the peer's known interfaces.
    # Fall back to the peer's mgmt_ip if not found.
    peer_macs = {}
    for _, peer_device in inferred:
        iface_macs = (await db.execute(
            select(Interface.mac_address)
            .where(Interface.device_id == peer_device.id,
                   Interface.mac_address.isnot(None))
        )).scalars().all()
        peer_macs[str(peer_device.id)] = {str(m) for m in iface_macs}

    local_arp = (await db.execute(
        select(ARPEntry).where(ARPEntry.device_id == device_id)
    )).scalars().all()
    arp_by_mac = {str(a.mac_address): str(a.ip_address) for a in local_arp}

    seen_ips = {r["neighbor_ip"] for r in results}
    for row, peer_device in inferred:
        # Try to find the peer's OSPF IP from this device's ARP table
        ospf_ip = None
        for mac in peer_macs.get(str(peer_device.id), []):
            if mac in arp_by_mac:
                ospf_ip = arp_by_mac[mac]
                break
        peer_ip = ospf_ip or str(peer_device.mgmt_ip).split("/")[0]

        if peer_ip not in seen_ips:
            results.append({
                "neighbor_ip":      peer_ip,
                "router_id":         peer_ip,
                "display_name":      str(peer_device.fqdn or peer_device.hostname),
                "state":             row.state,
                "area":              row.area,
                "interface_name":    None,
                "priority":          None,
                "last_state_change": row.last_state_change.isoformat() if row.last_state_change else None,
                "updated_at":        row.updated_at.isoformat(),
                "inferred":          True,
            })

    return results


# ── Neighbors ────────────────────────────────────────────────────────────────

@router.get("/{device_id}/neighbors", summary="List LLDP and CDP neighbors")
async def list_neighbors(
    device_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _assert_device_visible(device_id, current_user, db)

    lldp_rows = (await db.execute(
        select(LLDPNeighbor)
        .where(LLDPNeighbor.device_id == device_id)
        .order_by(LLDPNeighbor.local_port_name)
    )).scalars().all()

    cdp_rows = (await db.execute(
        select(CDPNeighbor)
        .where(CDPNeighbor.device_id == device_id)
        .order_by(CDPNeighbor.local_port_name)
    )).scalars().all()

    return {
        "lldp": [
            {
                "local_port": n.local_port_name,
                "remote_system_name": n.remote_system_name,
                "remote_port": n.remote_port_id or n.remote_port_desc,
                "remote_chassis_id": n.remote_chassis_id,
                "remote_chassis_id_subtype": n.remote_chassis_id_subtype,
                "remote_mgmt_ip": str(n.remote_mgmt_ip) if n.remote_mgmt_ip else None,
                "capabilities": n.remote_system_capabilities or [],
                "updated_at": n.updated_at.isoformat(),
            }
            for n in lldp_rows
        ],
        "cdp": [
            {
                "local_port": n.local_port_name,
                "remote_device": n.remote_device_id,
                "remote_port": n.remote_port_id,
                "remote_mgmt_ip": str(n.remote_mgmt_ip) if n.remote_mgmt_ip else None,
                "platform": n.remote_platform,
                "capabilities": n.remote_capabilities or [],
                "native_vlan": n.native_vlan,
                "duplex": n.duplex,
                "updated_at": n.updated_at.isoformat(),
            }
            for n in cdp_rows
        ],
    }


# ── SNMP diagnostic ────────────────────────────────────────────────────────────

_DIAG_OIDS = {
    "sysDescr":    "1.3.6.1.2.1.1.1.0",
    "sysUpTime":   "1.3.6.1.2.1.1.3.0",
    "sysName":     "1.3.6.1.2.1.1.5.0",
    "sysLocation": "1.3.6.1.2.1.1.6.0",
    "sysContact":  "1.3.6.1.2.1.1.4.0",
}


@router.post("/{device_id}/snmp-diag", summary="Run a live SNMP diagnostic against a device")
async def snmp_diag(
    device_id: uuid.UUID,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    import asyncio, time, json as _json

    device = await _assert_device_visible(device_id, current_user, db)

    cred_row = (await db.execute(
        select(DeviceCredential, Credential)
        .join(Credential, Credential.id == DeviceCredential.credential_id)
        .where(
            DeviceCredential.device_id == device_id,
            Credential.type.in_(["snmp_v2c", "snmp_v3"]),
        )
        .order_by(DeviceCredential.priority)
    )).first()

    if cred_row is None:
        raise HTTPException(status_code=400, detail="No SNMP credential assigned to this device")

    dc, cred = cred_row
    cred_data = cred.data if isinstance(cred.data, dict) else _json.loads(cred.data)
    host = str(device.mgmt_ip).split("/")[0]

    try:
        from pysnmp.hlapi.v3arch.asyncio import (
            CommunityData, ContextData, ObjectIdentity, ObjectType,
            SnmpEngine, UdpTransportTarget, UsmUserData, get_cmd,
        )
        import pysnmp.hlapi.v3arch.asyncio as hlapi

        engine = SnmpEngine()
        transport = await UdpTransportTarget.create((host, device.snmp_port or 161), timeout=5, retries=1)
        obj_types = [ObjectType(ObjectIdentity(oid)) for oid in _DIAG_OIDS.values()]

        if cred.type == "snmp_v2c":
            auth = CommunityData(cred_data.get("community", "public"), mpModel=1)
        else:
            _AUTH = {"md5": "usmHMACMD5AuthProtocol", "sha": "usmHMACSHAAuthProtocol",
                     "sha256": "usmHMAC192SHA256AuthProtocol", "sha512": "usmHMAC384SHA512AuthProtocol"}
            _PRIV = {"des": "usmDESPrivProtocol", "aes": "usmAesCfb128Protocol",
                     "aes192": "usmAesCfb192Protocol", "aes256": "usmAesCfb256Protocol"}
            auth = UsmUserData(
                cred_data["username"],
                authKey=cred_data.get("auth_key", ""),
                privKey=cred_data.get("priv_key", ""),
                authProtocol=getattr(hlapi, _AUTH.get(cred_data.get("auth_protocol", "sha256").lower(), "usmHMAC192SHA256AuthProtocol")),
                privProtocol=getattr(hlapi, _PRIV.get(cred_data.get("priv_protocol", "aes").lower(), "usmAesCfb128Protocol")),
            )

        t0 = time.monotonic()
        err_ind, err_status, _, vbs = await get_cmd(engine, auth, transport, ContextData(), *obj_types)
        elapsed_ms = round((time.monotonic() - t0) * 1000)

        if err_ind:
            return {"success": False, "credential_name": cred.name, "credential_type": cred.type,
                    "error": str(err_ind), "results": [], "response_ms": elapsed_ms}
        if err_status:
            return {"success": False, "credential_name": cred.name, "credential_type": cred.type,
                    "error": f"{err_status.prettyPrint()} at index {int(err_status) - 1}",
                    "results": [], "response_ms": elapsed_ms}

        results = []
        label_by_oid = {v: k for k, v in _DIAG_OIDS.items()}
        for vb in vbs:
            oid_str = str(vb[0])
            # Strip instance suffix for label lookup
            base = ".".join(oid_str.split(".")[:11])
            label = label_by_oid.get(oid_str) or label_by_oid.get(base) or oid_str
            results.append({"oid": label, "value": str(vb[1])})

        return {"success": True, "credential_name": cred.name, "credential_type": cred.type,
                "response_ms": elapsed_ms, "results": results, "error": None}

    except Exception as exc:
        return {"success": False, "credential_name": cred.name, "credential_type": cred.type,
                "error": str(exc), "results": [], "response_ms": None}


# ── Internal helper ────────────────────────────────────────────────────────────

async def _assert_device_visible(device_id: uuid.UUID, user: User, db: AsyncSession) -> Device:
    result = await db.execute(
        select(Device).where(Device.id == device_id, Device.tenant_id == user.tenant_id)
    )
    device = result.scalar_one_or_none()
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")
    return device
