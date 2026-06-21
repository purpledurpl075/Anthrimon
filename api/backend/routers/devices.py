from __future__ import annotations

import asyncio
import hashlib
import hmac
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

from ..dependencies import get_current_user, get_db, require_role, get_current_principal, accessible_device_ids_subquery, Principal
from ..models.alert import Alert
from ..models.credential import Credential, DeviceCredential
from ..models.device import Device
from ..models.health import DeviceHealthLatest
from ..models.interface import ARPEntry, CDPNeighbor, Interface, LLDPNeighbor, MACEntry, OSPFNeighbor, RouteEntry
from ..models.tenant import User
from ..schemas.alert import AlertRead
from ..schemas.common import PaginatedResponse
from ..schemas.device import (
    BulkAction, BulkDeviceRequest, BulkDeviceResponse,
    DeviceCreate, DeviceListRead, DeviceRead, DeviceUpdate,
)
from ..schemas.interface import InterfaceRead
from ..snmp_probe import probe_v2c, probe_v3, VENDOR_DEVICE_TYPE as _VENDOR_DEVICE_TYPE

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/devices", tags=["devices"])


def _cred_to_spec(cred) -> dict:
    """Translate a Credential row to the CredSpec JSON expected by the collector /probe endpoint."""
    if cred.type == "snmp_v3":
        return {
            "version":    "snmp_v3",
            "username":   cred.data.get("username", ""),
            "auth_key":   cred.data.get("auth_key", ""),
            "priv_key":   cred.data.get("priv_key", ""),
            "auth_proto": cred.data.get("auth_protocol", "sha256"),
            "priv_proto": cred.data.get("priv_protocol", "aes"),
        }
    return {"version": "snmp_v2c", "community": cred.data.get("community", "public")}


def _collector_token(api_key_hash: str) -> str:
    minute = str(int(time.time()) // 60)
    return hmac.new(api_key_hash.encode(), minute.encode(), hashlib.sha256).hexdigest()


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
    from sqlalchemy import cast, or_, String

    tenant_id = current_user.tenant_id
    items: list[dict] = []

    device_rows = (await db.execute(
        select(Device.id, Device.hostname, Device.fqdn).where(Device.tenant_id == tenant_id)
    )).all()
    hostname = {str(r.id): r.fqdn or r.hostname for r in device_rows}
    allowed_ids = set(hostname.keys())

    # Infrastructure uplink ports per device — only bridges/switches/routers count.
    # Used to suppress MAC entries learned via uplinks (transitive, not physical location).
    # Per-device view skips this: show everything for a specific device.
    uplink_ports: dict[str, set[str]] = {}
    if not device_id:
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
        lldp_rows = (await db.execute(
            select(cast(LLDPNeighbor.device_id, String).label("did"), LLDPNeighbor.local_port_name)
            .where(cast(LLDPNeighbor.device_id, String).in_(allowed_ids), _infra_lldp)
        )).all()
        cdp_rows = (await db.execute(
            select(cast(CDPNeighbor.device_id, String).label("did"), CDPNeighbor.local_port_name)
            .where(cast(CDPNeighbor.device_id, String).in_(allowed_ids), _infra_cdp)
        )).all()
        for r in (*lldp_rows, *cdp_rows):
            uplink_ports.setdefault(r.did, set()).add(r.local_port_name)

    # All MAC entries for tenant — filter to access ports only (global view).
    mac_q = select(MACEntry).where(cast(MACEntry.device_id, String).in_(allowed_ids))
    if device_id:
        mac_q = mac_q.where(MACEntry.device_id == device_id)
    mac_rows_all = (await db.execute(mac_q)).scalars().all()

    # Access-port MAC entries only (uplink-filtered).
    mac_access = [
        m for m in mac_rows_all
        if not (m.port_name and m.port_name in uplink_ports.get(str(m.device_id), set()))
    ]

    # mac → best (device_id, port_name, vlan_id) for ARP enrichment.
    # Prefer entries already in mac_access (access ports).
    mac_to_phys: dict[str, tuple[str, str | None, int | None]] = {}
    for m in mac_access:
        mac_to_phys[m.mac_address.lower()] = (str(m.device_id), m.port_name, m.vlan_id)

    # Build (device_id, iface_name) → iface_id for clickable port links.
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
        arp_rows = (await db.execute(q.order_by(ARPEntry.updated_at.desc()))).scalars().all()

        # Global view: deduplicate by (mac, ip) — keep most-recently-seen entry.
        seen_arp: set[tuple[str, str]] = set()
        for r in arp_rows:
            mac_str = str(r.mac_address).lower()
            ip_str  = str(r.ip_address)
            key = (mac_str, ip_str)
            if not device_id and key in seen_arp:
                continue
            seen_arp.add(key)

            did = str(r.device_id)
            # Use physical access-port info when available.
            phys = mac_to_phys.get(mac_str)
            if phys:
                phys_did, phys_port, vlan_id = phys
            else:
                phys_did, phys_port, vlan_id = did, None, None
            port_name = phys_port or r.interface_name
            items.append({
                "type": "arp", "device_id": did,
                "device_name": hostname.get(did, ""),
                "ip": ip_str, "mac": str(r.mac_address),
                "port":           port_name,
                "port_iface_id":  iface_lookup.get((phys_did, port_name)) if port_name else None,
                "vlan_interface": r.interface_name if phys_port else None,
                "vlan":           vlan_id,
                "entry_type": r.entry_type, "updated_at": r.updated_at.isoformat(),
            })

    if not type or type == "mac":
        # Global view: access-port entries only, deduplicated by mac.
        # Per-device view: show all entries.
        seen_mac: set[str] = set()
        source = mac_access if not device_id else mac_rows_all
        if search:
            source = [m for m in source if search.lower() in m.mac_address.lower()]
        for r in sorted(source, key=lambda m: m.mac_address):
            mac_str = r.mac_address.lower()
            if not device_id and mac_str in seen_mac:
                continue
            seen_mac.add(mac_str)
            did = str(r.device_id)
            items.append({
                "type": "mac", "device_id": did,
                "device_name": hostname.get(did, ""),
                "ip": None, "mac": r.mac_address,
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
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> PaginatedResponse[DeviceListRead]:
    q = select(Device).where(Device.id.in_(accessible_device_ids_subquery(principal)))

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
    from ..licensing import license_info
    lic = license_info()
    if lic.valid and lic.max_devices > 0:
        count = (await db.execute(
            select(func.count()).select_from(
                select(Device.id).where(Device.tenant_id == current_user.tenant_id, Device.is_active == True).subquery()
            )
        )).scalar_one()
        if count >= lic.max_devices:
            raise HTTPException(
                status_code=status.HTTP_402_PAYMENT_REQUIRED,
                detail=f"Device limit reached ({lic.max_devices}). Upgrade your license to add more devices.",
            )

    fields = body.model_dump(exclude_none=True, exclude={"mgmt_ip", "credential_id", "credential_ids"})
    fields.setdefault("hostname", str(body.mgmt_ip))
    if "device_type" not in fields and "vendor" in fields:
        fields.setdefault("device_type", _VENDOR_DEVICE_TYPE.get(fields["vendor"], "unknown"))

    # Validate collector_id belongs to this tenant before writing anything,
    # and fetch the full row so we can use wg_ip for the probe below.
    _collector = None
    if body.collector_id:
        from ..models.site import RemoteCollector as _RC
        _collector = (await db.execute(
            select(_RC).where(
                _RC.id == body.collector_id,
                _RC.tenant_id == current_user.tenant_id,
            )
        )).scalar_one_or_none()
        if _collector is None:
            raise HTTPException(status_code=404, detail="Collector not found")

    device = Device(
        tenant_id=current_user.tenant_id,
        **fields,
        mgmt_ip=str(body.mgmt_ip),
    )
    db.add(device)
    await db.flush()  # get device.id before probing and linking credential

    # Resolve credentials — support both singular credential_id (legacy) and
    # plural credential_ids (multi-select).  Merge into an ordered list.
    cred_ids_ordered: list[uuid.UUID] = []
    if body.credential_ids:
        cred_ids_ordered = list(body.credential_ids)
    elif body.credential_id:
        cred_ids_ordered = [body.credential_id]

    creds: list[Credential] = []
    if cred_ids_ordered:
        rows = (await db.execute(
            select(Credential).where(
                Credential.id.in_(cred_ids_ordered),
                Credential.tenant_id == current_user.tenant_id,
            )
        )).scalars().all()
        cred_map = {c.id: c for c in rows}
        for cid in cred_ids_ordered:
            if cid not in cred_map:
                raise HTTPException(status_code=404, detail=f"Credential {cid} not found")
            creds.append(cred_map[cid])

    # Probe the device using SNMP credentials only.  Non-SNMP creds (SSH, API,
    # gNMI, NETCONF) are linked to the device but not used for the initial probe.
    snmp_creds = [c for c in creds if c.type in ("snmp_v2c", "snmp_v3")]
    probed_data: dict | None = None
    probe_attempted = False
    working_cred: Credential | None = None
    ip   = str(body.mgmt_ip)
    port = body.snmp_port or 161

    if not body.collector_id:
        probe_attempted = True
        probe_list = snmp_creds if snmp_creds else [None]
        for c in probe_list:
            result = None
            if c is not None and c.type == "snmp_v3":
                result = await probe_v3(ip, c.data, port, timeout=3)
            elif c is not None and c.type == "snmp_v2c":
                result = await probe_v2c(ip, c.data.get("community", "public"), port, timeout=3)
            else:
                result = await probe_v2c(ip, "public", port, timeout=3)
            if result:
                probed_data = {
                    "hostname": result.hostname,
                    "vendor":   result.vendor,
                    "sys_descr": result.sys_descr,
                }
                working_cred = c
                break
    else:
        col = _collector
        if col and col.wg_ip:
            wg_ip = str(col.wg_ip).split("/")[0]
            import ipaddress as _ip
            if _ip.ip_address(wg_ip) in _ip.ip_network("10.100.0.0/24"):
                probe_attempted = True
                cred_specs = [_cred_to_spec(c) for c in snmp_creds] if snmp_creds else []
                try:
                    async with httpx.AsyncClient(timeout=max(3 * len(cred_specs) + 2, 10)) as hc:
                        resp = await hc.post(
                            f"http://{wg_ip}:9090/probe",
                            json={"ip": ip, "port": port, "creds": cred_specs, "timeout_s": 3},
                            headers={"Authorization": f"Bearer {_collector_token(col.api_key_hash)}"},
                        )
                    if resp.status_code == 200:
                        probed_data = resp.json()
                        if creds:
                            working_cred = creds[0]
                except Exception:
                    pass

    if probe_attempted and probed_data is None:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Device did not respond to SNMP probe. Verify the IP address, port, and credentials.",
        )

    if probed_data:
        if probed_data.get("hostname"):
            device.hostname = probed_data["hostname"]
        vendor = probed_data.get("vendor", "unknown")
        if vendor and vendor != "unknown":
            device.vendor      = vendor
            device.device_type = _VENDOR_DEVICE_TYPE.get(vendor, "unknown")
        if probed_data.get("sys_descr"):
            device.sys_description = probed_data["sys_descr"]

    # Sync snmp_version from the working credential.
    if working_cred is not None and working_cred.type == "snmp_v3":
        device.snmp_version = "v3"
    elif working_cred is not None and working_cred.type == "snmp_v2c":
        device.snmp_version = "v2c"

    # Link all selected credentials with priority ordering.
    # The credential that succeeded the probe gets priority 0.
    if creds:
        working_id = working_cred.id if working_cred else None
        ordered = sorted(creds, key=lambda c: (0 if c.id == working_id else 1))
        for pri, c in enumerate(ordered):
            db.add(DeviceCredential(device_id=device.id, credential_id=c.id, priority=pri))

    await db.commit()
    await db.refresh(device)

    # Seed api_method rows so the API-methods tab is populated immediately.
    from ..configmgmt.api_orchestrator import seed_device_methods as _seed
    asyncio.create_task(_seed(str(device.id), str(device.vendor)))

    logger.info("device_created", device_id=str(device.id), hostname=device.hostname,
                probed=probed_data is not None)
    return DeviceRead.model_validate(device)


# ── Baseline status (must be before /{device_id} to avoid path-param shadowing) ─

@router.get("/baselines/status", summary="Baseline computation health across all devices")
async def baselines_status(
    user: User         = Depends(get_current_user),
    db:   AsyncSession = Depends(get_db),
) -> dict:
    """Return last computed_at and row counts per metric_type for admin visibility."""
    rows = (await db.execute(
        text("""
            SELECT
                metric_type,
                COUNT(*)         AS row_count,
                MAX(computed_at) AS last_computed_at
            FROM metric_baselines
            GROUP BY metric_type
            ORDER BY metric_type
        """),
    )).mappings().all()

    return {
        "metrics": [
            {
                "metric_type":      r["metric_type"],
                "row_count":        r["row_count"],
                "last_computed_at": r["last_computed_at"].isoformat() if r["last_computed_at"] else None,
            }
            for r in rows
        ]
    }


# ── CSV Export (must be before /{device_id} to avoid path-param shadowing) ────

@router.get("/export.csv", summary="Export devices as CSV")
async def export_devices_csv(
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
):
    import csv
    import io
    from datetime import datetime, timezone
    from fastapi.responses import Response

    devices = (await db.execute(
        select(Device)
        .where(Device.id.in_(accessible_device_ids_subquery(principal)), Device.is_active == True)
        .order_by(Device.hostname)
    )).scalars().all()

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Hostname", "FQDN", "Management IP", "Vendor", "Type", "Status",
                "Platform", "OS Version", "Serial", "Last Seen", "Tags"])
    for d in devices:
        w.writerow([
            d.hostname,
            d.fqdn or "",
            str(d.mgmt_ip).split("/")[0],
            d.vendor,
            d.device_type,
            d.status,
            d.platform or "",
            d.os_version or "",
            d.serial_number or "",
            d.last_seen.isoformat() if d.last_seen else "",
            ",".join(d.tags or []),
        ])

    fname = f"anthrimon-devices-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.csv"
    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


# ── Sites (must be before /{device_id} to avoid path-param shadowing) ───────────

@router.get("/sites", summary="List sites for this tenant (id + name only)")
async def list_device_sites(
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    from ..models.site import Site
    rows = (await db.execute(
        select(Site.id, Site.name)
        .where(Site.tenant_id == current_user.tenant_id)
        .order_by(Site.name)
    )).all()
    return [{"id": str(r.id), "name": r.name} for r in rows]


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

    updates = {k: v for k, v in body.model_dump().items() if k in body.model_fields_set}
    if "mgmt_ip" in updates:
        updates["mgmt_ip"] = str(updates["mgmt_ip"])

    for field, value in updates.items():
        setattr(device, field, value)

    await db.commit()
    await db.refresh(device)
    logger.info("device_updated", device_id=str(device_id), fields=list(updates.keys()))

    # If this device is assigned to a remote collector, nudge it to refresh its
    # config so changes (e.g. rest_collection_enabled) take effect immediately
    # rather than waiting up to 5 minutes for the periodic poll.
    if device.collector_id:
        from ..models.site import RemoteCollector
        collector = (await db.execute(
            select(RemoteCollector).where(RemoteCollector.id == device.collector_id)
        )).scalar_one_or_none()
        if collector and collector.wg_ip and collector.api_key_hash:
            asyncio.create_task(_nudge_collector(str(collector.wg_ip), collector.api_key_hash))

    return DeviceRead.model_validate(device)


@router.post("/{device_id}/snmp-engine-id",
             summary="SSH to device and discover its SNMP engine ID")
async def discover_snmp_engine_id(
    device_id:    uuid.UUID,
    current_user: User         = Depends(require_role("admin", "superadmin", "operator")),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    """SSH to the device using its stored SSH credential, run the vendor-appropriate
    'show snmp engineID' command, and persist the result on the device record.
    Also writes the engine ID back to any linked snmp_v3 credential so that
    snmptrapd.conf is regenerated with the correct -e flag.
    """
    from ..models.credential import Credential, DeviceCredential
    from ..routers.collectors import _discover_engine_id, _push_trap_config
    from ..configmgmt.collector import _vendor_key

    device = (await db.execute(
        select(Device).where(Device.id == device_id,
                             Device.tenant_id == current_user.tenant_id)
    )).scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    ssh_cred = (await db.execute(
        select(Credential).join(
            DeviceCredential, DeviceCredential.credential_id == Credential.id
        ).where(
            DeviceCredential.device_id == device.id,
            Credential.type == "ssh",
        )
    )).scalar_one_or_none()
    if not ssh_cred:
        raise HTTPException(status_code=422, detail="Device has no SSH credential")

    vendor_key = _vendor_key(device)
    engine_id = await _discover_engine_id(str(device.mgmt_ip), vendor_key, ssh_cred.data)
    if not engine_id:
        raise HTTPException(status_code=422,
                            detail="Could not discover engine ID — check SSH credentials and vendor support")

    # Persist on device record
    device.snmp_engine_id = engine_id
    await db.commit()

    # Also update any linked snmp_v3 credentials so snmptrapd.conf stays in sync
    v3_creds = (await db.execute(
        select(Credential).join(
            DeviceCredential, DeviceCredential.credential_id == Credential.id
        ).where(
            DeviceCredential.device_id == device.id,
            Credential.type == "snmp_v3",
        )
    )).scalars().all()
    for cred in v3_creds:
        updated = dict(cred.data)
        updated["engine_id"] = engine_id
        cred.data = updated
    if v3_creds:
        await db.commit()
        asyncio.create_task(_push_trap_config(
            str(device.collector_id) if device.collector_id else None,
            str(current_user.tenant_id),
        ))

    logger.info("snmp_engine_id_discovered", device_id=str(device_id), engine_id=engine_id)
    return {"engine_id": engine_id}


async def _nudge_collector(wg_ip: str, api_key_hash: str) -> None:
    """Fire-and-forget: ask the remote collector to refresh its device config."""
    url = f"http://{wg_ip}:9090/refresh"
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            await client.post(url, headers={"Authorization": f"Bearer {_collector_token(api_key_hash)}"})
        logger.debug("collector_nudged", wg_ip=wg_ip)
    except Exception as exc:
        # Non-fatal — collector will pick up the change on its next periodic refresh.
        logger.debug("collector_nudge_failed", wg_ip=wg_ip, error=str(exc))


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


# ── Bulk operations ────────────────────────────────────────────────────────────

@router.post("/bulk", response_model=BulkDeviceResponse, summary="Apply an action to multiple devices")
async def bulk_device_action(
    body: BulkDeviceRequest,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> BulkDeviceResponse:
    if body.action == BulkAction.delete and current_user.role not in ("admin", "superadmin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can bulk-delete devices",
        )

    devices = (await db.execute(
        select(Device).where(
            Device.id.in_(body.device_ids),
            Device.tenant_id == current_user.tenant_id,
        )
    )).scalars().all()
    if not devices:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No matching devices")

    ids = [d.id for d in devices]

    if body.action in (BulkAction.add_tag, BulkAction.remove_tag):
        tag = (body.tag or "").strip()
        if not tag:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="'tag' is required")
        for device in devices:
            current_tags = list(device.tags or [])
            if body.action == BulkAction.add_tag:
                if tag not in current_tags:
                    current_tags.append(tag)
            else:
                current_tags = [t for t in current_tags if t != tag]
            device.tags = current_tags
        await db.commit()

    elif body.action == BulkAction.set_site:
        if body.site_id is not None:
            from ..models.site import Site
            site = (await db.execute(
                select(Site).where(Site.id == body.site_id, Site.tenant_id == current_user.tenant_id)
            )).scalar_one_or_none()
            if site is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Site not found")
        await db.execute(
            Device.__table__.update().where(Device.id.in_(ids)).values(site_id=body.site_id)
        )
        await db.commit()

    elif body.action == BulkAction.set_collector:
        from ..models.site import RemoteCollector
        if body.collector_id is not None:
            collector = (await db.execute(
                select(RemoteCollector).where(
                    RemoteCollector.id == body.collector_id,
                    RemoteCollector.tenant_id == current_user.tenant_id,
                )
            )).scalar_one_or_none()
            if collector is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Collector not found")

        touched_collector_ids = {d.collector_id for d in devices if d.collector_id}
        if body.collector_id:
            touched_collector_ids.add(body.collector_id)

        await db.execute(
            Device.__table__.update().where(Device.id.in_(ids)).values(collector_id=body.collector_id)
        )
        await db.commit()

        if touched_collector_ids:
            collectors = (await db.execute(
                select(RemoteCollector).where(RemoteCollector.id.in_(touched_collector_ids))
            )).scalars().all()
            for c in collectors:
                if c.wg_ip and c.api_key_hash:
                    asyncio.create_task(_nudge_collector(str(c.wg_ip), c.api_key_hash))

    elif body.action == BulkAction.set_polling_interval:
        if body.polling_interval_s is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="'polling_interval_s' is required")
        await db.execute(
            Device.__table__.update().where(Device.id.in_(ids)).values(polling_interval_s=body.polling_interval_s)
        )
        await db.commit()

    elif body.action == BulkAction.set_credential:
        if body.credential_id is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="'credential_id' is required")
        cred = (await db.execute(
            select(Credential).where(
                Credential.id == body.credential_id,
                Credential.tenant_id == current_user.tenant_id,
            )
        )).scalar_one_or_none()
        if cred is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Credential not found")

        already_linked = set((await db.execute(
            select(DeviceCredential.device_id).where(
                DeviceCredential.device_id.in_(ids),
                DeviceCredential.credential_id == body.credential_id,
            )
        )).scalars().all())

        for device_id in ids:
            if device_id not in already_linked:
                db.add(DeviceCredential(device_id=device_id, credential_id=body.credential_id, priority=0))
        await db.commit()

        if cred.type in ("snmp_v3", "snmp_v2c"):
            snmp_v = "v3" if cred.type == "snmp_v3" else "v2c"
            await db.execute(
                Device.__table__.update().where(Device.id.in_(ids)).values(snmp_version=snmp_v)
            )
            await db.commit()

        if cred.type == "snmp_v3":
            from .collectors import _push_trap_config
            collector_ids = {d.collector_id for d in devices}
            for collector_id in collector_ids:
                asyncio.create_task(_push_trap_config(
                    str(collector_id) if collector_id else None, str(current_user.tenant_id)
                ))

    elif body.action == BulkAction.delete:
        await db.execute(
            Device.__table__.delete().where(Device.id.in_(ids))
        )
        await db.commit()

    updated = len(devices)
    logger.info("devices_bulk_action", action=body.action.value, count=updated)
    return BulkDeviceResponse(updated=updated)


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


from ..services.urls import vm_url


@router.get("/{device_id}/health/history", summary="Health metric history from VictoriaMetrics")
async def get_device_health_history(
    device_id: uuid.UUID,
    hours: float = Query(default=1.0, ge=0.1, le=720.0),
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
                r = await client.get(f"{vm_url()}/api/v1/query_range",
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
                r = await client.get(f"{vm_url()}/api/v1/query_range",
                    params={"query": query, "start": start, "end": now, "step": step})
                r.raise_for_status()
                return r.json().get("data", {}).get("result", [])
        except Exception:
            return []

    # Instant query — always returns the last known value regardless of range window.
    # Used for the "current" badge so the DOM panel shows values even before history
    # accumulates (first poll after collector start).
    async def vm_instant_iface(metric: str) -> dict[str, float]:
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                r = await client.get(f"{vm_url()}/api/v1/query",
                    params={"query": f'{metric}{{device_id="{did}"}}'})
                r.raise_for_status()
                return {
                    s["metric"].get("iface", "unknown"): float(s["value"][1])
                    for s in r.json().get("data", {}).get("result", [])
                    if s.get("value")
                }
        except Exception:
            return {}

    async def vm_instant_label(metric: str, label: str) -> dict[str, float]:
        """Last-known value keyed by a single label."""
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                r = await client.get(f"{vm_url()}/api/v1/query",
                    params={"query": f'{metric}{{device_id="{did}"}}'})
                r.raise_for_status()
                return {
                    s["metric"].get(label, "unknown"): float(s["value"][1])
                    for s in r.json().get("data", {}).get("result", [])
                    if s.get("value")
                }
        except Exception:
            return {}

    async def vm_instant_rows(metric: str, *label_keys: str) -> list[dict]:
        """Last-known value for each series as a list of {labels: {…}, value: float}."""
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                r = await client.get(f"{vm_url()}/api/v1/query",
                    params={"query": f'{metric}{{device_id="{did}"}}'})
                r.raise_for_status()
                return [
                    {
                        "labels": {k: s["metric"].get(k, "") for k in label_keys},
                        "value":  float(s["value"][1]),
                    }
                    for s in r.json().get("data", {}).get("result", [])
                    if s.get("value")
                ]
        except Exception:
            return []

    (temp_results, dom_tx_results, dom_rx_results,
     dom_tx_now, dom_rx_now,
     if_flaps_raw, if_acl_drops_raw, if_err_disabled_raw,
     fib_routes_raw, tcam_used_raw, tcam_max_raw,
     fib_trend_results,
     cx_psu_ok_raw, cx_psu_power_raw, cx_psu_max_raw,
     cx_fan_ok_raw, cx_fan_rpm_raw, cx_fan_speed_raw,
     cx_vsx_raw, cx_copp_drop_raw, cx_loop_detect_raw,
     cisco_fan_raw, cisco_psu_raw,
     cisco_if_in_drops_raw, cisco_if_out_drops_raw, cisco_if_resets_raw,
     cisco_mem_used_raw, cisco_mem_free_raw) = await asyncio.gather(
        vm_multi(f'anthrimon_device_temp_celsius{{device_id="{did}"}}'),
        vm_multi(f'anthrimon_if_dom_tx_power_dbm{{device_id="{did}"}}'),
        vm_multi(f'anthrimon_if_dom_rx_power_dbm{{device_id="{did}"}}'),
        vm_instant_iface("anthrimon_if_dom_tx_power_dbm"),
        vm_instant_iface("anthrimon_if_dom_rx_power_dbm"),
        vm_instant_label("anthrimon_if_flap_count_total", "if_name"),
        vm_instant_label("anthrimon_if_acl_drops_total", "if_name"),
        vm_instant_rows("anthrimon_if_err_disabled", "if_name", "reason"),
        vm_instant_label("anthrimon_fib_routes_total", "af"),
        vm_instant_rows("anthrimon_arista_hw_util_used", "resource", "feature", "chip"),
        vm_instant_rows("anthrimon_arista_hw_util_max", "resource", "feature", "chip"),
        vm_multi(f'anthrimon_fib_routes_total{{device_id="{did}"}}'),
        # Aruba CX
        vm_instant_rows("anthrimon_cx_psu_ok",         "psu_name"),
        vm_instant_rows("anthrimon_cx_psu_power_watts", "psu_name"),
        vm_instant_rows("anthrimon_cx_psu_max_watts",   "psu_name"),
        vm_instant_rows("anthrimon_cx_fan_ok",          "fan_name"),
        vm_instant_rows("anthrimon_cx_fan_rpm",         "fan_name"),
        vm_instant_rows("anthrimon_cx_fan_speed_pct",   "fan_name"),
        vm_instant_rows("anthrimon_cx_vsx_oper_state",  "state", "role"),
        vm_instant_rows("anthrimon_cx_copp_drop_pkts_total", "class"),
        vm_instant_rows("anthrimon_cx_loop_protect_detected", "if_name"),
        # Cisco
        vm_instant_rows("anthrimon_cisco_fan_ok",  "fan_name"),
        vm_instant_rows("anthrimon_cisco_psu_ok",  "psu_name"),
        vm_instant_rows("anthrimon_cisco_if_in_queue_drops",  "if_name"),
        vm_instant_rows("anthrimon_cisco_if_out_queue_drops", "if_name"),
        vm_instant_rows("anthrimon_cisco_if_resets",          "if_name"),
        vm_instant_rows("anthrimon_cisco_mem_used_bytes",     "pool"),
        vm_instant_rows("anthrimon_cisco_mem_free_bytes",     "pool"),
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

    # Build TCAM lookup: (resource, feature, chip) → value — merge used+max into rows
    tcam_key = lambda r: (r["labels"]["resource"], r["labels"]["feature"], r["labels"]["chip"])
    tcam_used_map = {tcam_key(r): r["value"] for r in tcam_used_raw}
    tcam_max_map  = {tcam_key(r): r["value"] for r in tcam_max_raw}
    tcam_rows: list[dict] = []
    for key in sorted(tcam_used_map.keys() | tcam_max_map.keys()):
        resource, feature, chip = key
        used = tcam_used_map.get(key, 0.0)
        maximum = tcam_max_map.get(key, 0.0)
        if maximum <= 0:
            continue
        tcam_rows.append({
            "resource": resource,
            "feature":  feature,
            "chip":     chip,
            "used":     int(used),
            "max":      int(maximum),
            "pct":      round(used / maximum * 100, 1),
        })

    # FIB trend series keyed by AF
    fib_trend: dict[str, list] = {}
    for result in fib_trend_results:
        af = result["metric"].get("af", "unknown")
        fib_trend[af] = [[int(v[0]), float(v[1])] for v in result.get("values", [])]

    # Err-disabled: only ports that are currently err-disabled (value == 1)
    err_disabled = [
        {"if_name": row["labels"]["if_name"], "reason": row["labels"]["reason"]}
        for row in if_err_disabled_raw
        if row["value"] >= 1
    ]

    # ── Aruba CX hardware health ──────────────────────────────────────────────
    # Build psu_name-keyed dicts for easy frontend consumption
    def _by_label(rows: list[dict], key: str) -> dict:
        return {r["labels"][key]: r["value"] for r in rows if r["labels"].get(key)}

    cx_psu_ok    = _by_label(cx_psu_ok_raw,    "psu_name")
    cx_psu_power = _by_label(cx_psu_power_raw, "psu_name")
    cx_psu_max   = _by_label(cx_psu_max_raw,   "psu_name")

    cx_psus: list[dict] = []
    for psu_name in sorted(cx_psu_ok.keys() | cx_psu_power.keys()):
        cx_psus.append({
            "name":       psu_name,
            "ok":         int(cx_psu_ok.get(psu_name, 0)) == 1,
            "power_w":    int(cx_psu_power.get(psu_name, 0)),
            "max_w":      int(cx_psu_max.get(psu_name, 0)),
        })

    cx_fan_ok_map  = _by_label(cx_fan_ok_raw,    "fan_name")
    cx_fan_rpm_map = _by_label(cx_fan_rpm_raw,   "fan_name")
    cx_fan_spd_map = _by_label(cx_fan_speed_raw, "fan_name")

    cx_fans: list[dict] = []
    for fan_name in sorted(cx_fan_ok_map.keys() | cx_fan_rpm_map.keys()):
        cx_fans.append({
            "name":      fan_name,
            "ok":        int(cx_fan_ok_map.get(fan_name, 0)) == 1,
            "rpm":       int(cx_fan_rpm_map.get(fan_name, 0)),
            "speed_pct": int(cx_fan_spd_map.get(fan_name, 0)),
        })

    # VSX: only set if the metric exists (device has VSX enabled)
    cx_vsx: dict | None = None
    if cx_vsx_raw:
        row = cx_vsx_raw[0]
        cx_vsx = {
            "state":          row["labels"].get("state", "unknown"),
            "role":           row["labels"].get("role", "undefined"),
        }
        # Augment with ISL and config-syncing from separate series (use vm_instant_rows)
        # Those scalars are emitted as separate metrics; pull from the same batch.

    # CoPP: top-20 by drop count descending
    cx_copp = sorted(
        [{"class": r["labels"].get("class", "?"), "drop_pkts": int(r["value"])} for r in cx_copp_drop_raw if r["value"] > 0],
        key=lambda x: -x["drop_pkts"]
    )[:20]

    # Loop protect: only ports with detected loops
    cx_loops = [r["labels"].get("if_name", "?") for r in cx_loop_detect_raw if r["value"] >= 1]

    # ── Cisco hardware health + interface stats ───────────────────────────────
    cisco_fans: list[dict] = sorted(
        [{"name": r["labels"].get("fan_name", "?"), "ok": r["value"] >= 1.0}
         for r in cisco_fan_raw],
        key=lambda x: x["name"]
    )
    cisco_psus: list[dict] = sorted(
        [{"name": r["labels"].get("psu_name", "?"), "ok": r["value"] >= 1.0}
         for r in cisco_psu_raw],
        key=lambda x: x["name"]
    )

    cisco_if_in_drops  = {r["labels"].get("if_name","?"): int(r["value"]) for r in cisco_if_in_drops_raw}
    cisco_if_out_drops = {r["labels"].get("if_name","?"): int(r["value"]) for r in cisco_if_out_drops_raw}
    cisco_if_resets    = {r["labels"].get("if_name","?"): int(r["value"]) for r in cisco_if_resets_raw}

    cisco_mem_used_map = {r["labels"].get("pool","?"): int(r["value"]) for r in cisco_mem_used_raw}
    cisco_mem_free_map = {r["labels"].get("pool","?"): int(r["value"]) for r in cisco_mem_free_raw}
    cisco_mem_pools: list[dict] = []
    for pool in sorted(cisco_mem_used_map.keys() | cisco_mem_free_map.keys()):
        used  = cisco_mem_used_map.get(pool, 0)
        free  = cisco_mem_free_map.get(pool, 0)
        total = used + free
        cisco_mem_pools.append({
            "pool":      pool,
            "used":      used,
            "free":      free,
            "pct":       round(used / total * 100, 1) if total > 0 else 0.0,
        })

    return {
        "cpu_pct":       cpu_series,
        "mem_pct":       mem_pct,
        "mem_used":      mem_used,
        "mem_total":     mem_total,
        "temp_series":   temp_series,
        "dom_tx":        dom_tx_series,
        "dom_rx":        dom_rx_series,
        "dom_tx_now":    dom_tx_now,
        "dom_rx_now":    dom_rx_now,
        "if_flaps":      if_flaps_raw,
        "if_acl_drops":  if_acl_drops_raw,
        "if_err_disabled": err_disabled,
        "fib_routes":    fib_routes_raw,
        "fib_trend":     fib_trend,
        "tcam":          tcam_rows,
        # Aruba CX
        "cx_psus":       cx_psus,
        "cx_fans":       cx_fans,
        "cx_vsx":        cx_vsx,
        "cx_copp":       cx_copp,
        "cx_loops":      cx_loops,
        # Cisco
        "cisco_fans":        cisco_fans,
        "cisco_psus":        cisco_psus,
        "cisco_if_in_drops": cisco_if_in_drops,
        "cisco_if_out_drops":cisco_if_out_drops,
        "cisco_if_resets":   cisco_if_resets,
        "cisco_mem_pools":   cisco_mem_pools,
    }


@router.get("/{device_id}/latency", summary="ICMP RTT and packet-loss history from VictoriaMetrics")
async def get_device_latency(
    device_id: uuid.UUID,
    hours: float = Query(default=1.0, ge=0.1, le=720.0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _assert_device_visible(device_id, current_user, db)
    did   = str(device_id)
    now   = int(time.time())
    start = now - int(hours * 3600)
    # Probes fire every 30 s; use 60 s step for ≤1 h, 300 s for longer ranges.
    step  = 60 if hours <= 1 else 300 if hours <= 6 else 900

    async def vm_range(query: str) -> list:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                r = await client.get(f"{vm_url()}/api/v1/query_range",
                    params={"query": query, "start": start, "end": now, "step": step})
                r.raise_for_status()
                results = r.json().get("data", {}).get("result", [])
                if results:
                    return [[int(v[0]), float(v[1])] for v in results[0].get("values", [])]
        except Exception:
            pass
        return []

    rtt_avg, rtt_min, rtt_max, loss_pct = await asyncio.gather(
        vm_range(f'anthrimon_device_rtt_ms{{device_id="{did}",stat="avg"}}'),
        vm_range(f'anthrimon_device_rtt_ms{{device_id="{did}",stat="min"}}'),
        vm_range(f'anthrimon_device_rtt_ms{{device_id="{did}",stat="max"}}'),
        vm_range(f'anthrimon_device_loss_pct{{device_id="{did}"}}'),
    )

    return {
        "rtt_avg_ms":  rtt_avg,
        "rtt_min_ms":  rtt_min,
        "rtt_max_ms":  rtt_max,
        "loss_pct":    loss_pct,
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

    cred = (await db.execute(
        select(Credential).where(
            Credential.id == body.credential_id,
            Credential.tenant_id == current_user.tenant_id,
        )
    )).scalar_one_or_none()
    if cred is None:
        raise HTTPException(status_code=404, detail="Credential not found")

    link = DeviceCredential(
        device_id=device_id,
        credential_id=body.credential_id,
        priority=body.priority,
    )
    db.add(link)
    try:
        await db.commit()
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Credential already linked to this device") from exc

    # Keep device.snmp_version in sync with the highest-priority SNMP credential.
    if cred.type in ("snmp_v3", "snmp_v2c"):
        snmp_v = "v3" if cred.type == "snmp_v3" else "v2c"
        await db.execute(
            text("UPDATE devices SET snmp_version = :v WHERE id = :did"),
            {"v": snmp_v, "did": str(device_id)},
        )
        await db.commit()

    if cred.type == "snmp_v3":
        collector_id = await _device_collector_id(device_id, db)
        from .collectors import _push_trap_config
        import asyncio as _aio
        _aio.create_task(_push_trap_config(collector_id, str(current_user.tenant_id)))


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

    cred = (await db.execute(
        select(Credential).where(Credential.id == credential_id)
    )).scalar_one_or_none()

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

    if cred and cred.type == "snmp_v3":
        collector_id = await _device_collector_id(device_id, db)
        from .collectors import _push_trap_config
        import asyncio as _aio
        _aio.create_task(_push_trap_config(collector_id, str(current_user.tenant_id)))


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
    device_ip = device.mgmt_ip_str

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
    peer_device_ids = [peer_device.id for _, peer_device in inferred]
    peer_macs: dict[str, set[str]] = {}
    if peer_device_ids:
        mac_rows = (await db.execute(
            select(Interface.device_id, Interface.mac_address)
            .where(Interface.device_id.in_(peer_device_ids),
                   Interface.mac_address.isnot(None))
        )).all()
        for dev_id, mac in mac_rows:
            peer_macs.setdefault(str(dev_id), set()).add(str(mac))

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
        peer_ip = ospf_ip or peer_device.mgmt_ip_str

        if peer_ip not in seen_ips:
            results.append({
                "neighbor_ip":      peer_ip,
                "router_id":         peer_ip,
                "display_name":      str(peer_device.display_name),
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
    host = device.mgmt_ip_str

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


# ── Baseline endpoints ─────────────────────────────────────────────────────────

@router.get("/{device_id}/baselines", summary="Learned metric baselines for a device")
async def get_device_baselines(
    device_id: uuid.UUID,
    user:      User         = Depends(get_current_user),
    db:        AsyncSession = Depends(get_db),
) -> dict:
    """Return all metric_baselines rows for this device, grouped by metric_type."""
    await _assert_device_visible(device_id, user, db)

    rows = (await db.execute(
        text("""
            SELECT
                mb.id::text,
                mb.metric_type,
                mb.bucket_type,
                mb.bucket_index,
                mb.interface_id::text,
                mb.label,
                mb.window_days,
                mb.normal_up_pct,
                mb.mean,
                mb.stddev,
                mb.p5,
                mb.p95,
                mb.sample_count,
                mb.force_alert,
                mb.force_suppress,
                mb.computed_at,
                i.name  AS interface_name
            FROM metric_baselines mb
            LEFT JOIN interfaces i ON i.id = mb.interface_id
            WHERE mb.device_id = :did
            ORDER BY mb.metric_type, mb.label NULLS LAST, mb.bucket_index
        """),
        {"did": str(device_id)},
    )).mappings().all()

    # Group by metric_type for convenient frontend consumption.
    grouped: dict[str, list] = {}
    for r in rows:
        mt = r["metric_type"]
        grouped.setdefault(mt, []).append({
            "id":             r["id"],
            "bucket_type":    r["bucket_type"],
            "bucket_index":   r["bucket_index"],
            "interface_id":   r["interface_id"],
            "interface_name": r["interface_name"] or r["label"],
            "label":          r["label"],
            "window_days":    r["window_days"],
            "normal_up_pct":  r["normal_up_pct"],
            "mean":           float(r["mean"])   if r["mean"]   is not None else None,
            "stddev":         float(r["stddev"]) if r["stddev"] is not None else None,
            "p5":             float(r["p5"])     if r["p5"]     is not None else None,
            "p95":            float(r["p95"])    if r["p95"]    is not None else None,
            "sample_count":   r["sample_count"],
            "force_alert":    r["force_alert"],
            "force_suppress": r["force_suppress"],
            "computed_at":    r["computed_at"].isoformat() if r["computed_at"] else None,
        })

    return {
        "device_id": str(device_id),
        "baselines":  grouped,
    }


class BaselineOverrideRequest(BaseModel):
    force_alert:    bool = False
    force_suppress: bool = False


@router.post(
    "/{device_id}/baselines/{metric_type}/override",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    summary="Pin or suppress alerts for a specific interface/label baseline",
)
async def override_baseline(
    device_id:   uuid.UUID,
    metric_type: str,
    body:        BaselineOverrideRequest,
    label:       Optional[str] = Query(None, description="Interface name or peer IP to target"),
    user:        User         = Depends(get_current_user),
    db:          AsyncSession = Depends(get_db),
) -> None:
    """Set force_alert or force_suppress on a baseline row.

    - `force_alert=true`    → always fire this alert even if baseline says suppress
    - `force_suppress=true` → always silence even if value spikes
    - Both false            → revert to automatic baseline logic
    """
    await _assert_device_visible(device_id, user, db)

    result = await db.execute(
        text("""
            UPDATE metric_baselines
               SET force_alert    = :fa,
                   force_suppress = :fs
             WHERE device_id   = :did
               AND metric_type = :mt
               AND bucket_type = 'rolling'
               AND bucket_index = 0
               AND (
                     (:label IS NULL AND label IS NULL)
                  OR label = :label
               )
        """),
        {
            "did":   str(device_id),
            "mt":    metric_type,
            "label": label,
            "fa":    body.force_alert,
            "fs":    body.force_suppress,
        },
    )
    if result.rowcount == 0:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No baseline found for that metric_type / label combination.",
        )
    await db.commit()


# ── Internal helper ────────────────────────────────────────────────────────────

async def _assert_device_visible(device_id: uuid.UUID, user: User, db: AsyncSession) -> Device:
    result = await db.execute(
        select(Device).where(Device.id == device_id, Device.tenant_id == user.tenant_id)
    )
    device = result.scalar_one_or_none()
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")
    return device


async def _device_collector_id(device_id: uuid.UUID, db: AsyncSession) -> str | None:
    """Return the collector_id (as str) for a device, or None for hub-local."""
    row = (await db.execute(
        select(Device.collector_id).where(Device.id == device_id)
    )).scalar_one_or_none()
    return str(row) if row is not None else None
