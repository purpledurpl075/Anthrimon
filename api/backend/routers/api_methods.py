from __future__ import annotations

import uuid
from typing import Optional

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..configmgmt.api_orchestrator import (
    METHOD_LABELS, VENDOR_METHODS, configure_method, probe_and_save,
)
from ..dependencies import (
    get_current_principal, get_db, Principal,
    accessible_device_ids_subquery, assert_device_access, _tenant_device_ids,
)
from ..models.api_method import DeviceApiMethod
from ..models.credential import Credential, DeviceCredential
from ..models.device import Device

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/api-methods", tags=["api-methods"])


# ── Helpers ───────────────────────────────────────────────────────────────────

def _method_row(m: DeviceApiMethod) -> dict:
    return {
        "id":               str(m.id),
        "device_id":        str(m.device_id),
        "method":           m.method,
        "label":            METHOD_LABELS.get(m.method, m.method),
        "enabled":          m.enabled,
        "reachable":        m.reachable,
        "last_probe_at":    m.last_probe_at.isoformat() if m.last_probe_at else None,
        "probe_error":      m.probe_error,
        "configure_status": m.configure_status,
        "configure_at":     m.configure_at.isoformat() if m.configure_at else None,
    }


def _has_snmp_cred(creds: list) -> bool:
    return any(c.type in ("snmp_v2c", "snmp_v3") for c in creds)


def _has_ssh_cred(creds: list) -> bool:
    return any(c.type == "ssh" for c in creds)


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/", summary="All devices with their API method status")
async def list_all(
    principal: Principal     = Depends(get_current_principal),
    db:        AsyncSession = Depends(get_db),
) -> list[dict]:
    devs = (await db.execute(
        select(Device).where(Device.id.in_(accessible_device_ids_subquery(principal)), Device.is_active == True)  # noqa
        .order_by(Device.vendor, Device.hostname)
    )).scalars().all()

    if not devs:
        return []

    dev_ids = [str(d.id) for d in devs]

    methods_rows = (await db.execute(
        select(DeviceApiMethod)
        .where(DeviceApiMethod.device_id.in_([d.id for d in devs]))
    )).scalars().all()
    methods_by_device: dict[str, list[dict]] = {}
    for m in methods_rows:
        methods_by_device.setdefault(str(m.device_id), []).append(_method_row(m))

    # Fetch credentials so we know which methods are possible
    cred_rows = (await db.execute(
        select(DeviceCredential, Credential)
        .join(Credential, Credential.id == DeviceCredential.credential_id)
        .where(DeviceCredential.device_id.in_([d.id for d in devs]))
    )).all()
    creds_by_device: dict[str, list] = {}
    for dc, c in cred_rows:
        creds_by_device.setdefault(str(dc.device_id), []).append(c)

    result = []
    for dev in devs:
        did = str(dev.id)
        creds = creds_by_device.get(did, [])
        result.append({
            "device_id":    did,
            "hostname":     dev.display_name,
            "mgmt_ip":      dev.mgmt_ip_str,
            "vendor":       str(dev.vendor),
            "supported_methods": VENDOR_METHODS.get(str(dev.vendor).lower(), ["snmp"]),
            "has_ssh_cred": _has_ssh_cred(creds),
            "methods":      methods_by_device.get(did, []),
        })

    return result


@router.post("/{device_id}/{method}/probe", summary="Probe API endpoint reachability")
async def probe(
    device_id:    str,
    method:       str,
    principal:    Principal    = Depends(get_current_principal),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    dev = await _get_device(device_id, principal, db, "readonly")
    ip = dev.mgmt_ip_str
    return await probe_and_save(device_id, method, ip)


@router.patch("/{device_id}/{method}/toggle", summary="Enable or disable an API method")
async def toggle(
    device_id:    str,
    method:       str,
    principal:    Principal    = Depends(get_current_principal),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    dev = await _get_device(device_id, principal, db, "operator")

    row = (await db.execute(
        select(DeviceApiMethod)
        .where(DeviceApiMethod.device_id == dev.id, DeviceApiMethod.method == method)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "method row not found")

    row.enabled = not row.enabled

    # Mirror to rest_collection_enabled for backward compat
    if method == "aruba_cx_rest":
        await db.execute(text("""
            UPDATE devices SET rest_collection_enabled = :v WHERE id = CAST(:did AS uuid)
        """), {"v": row.enabled, "did": device_id})

    await db.commit()
    return {"method": method, "enabled": row.enabled}


@router.get("/{device_id}/{method}/commands", summary="Preview SSH commands for a method")
async def get_commands(
    device_id:    str,
    method:       str,
    principal:    Principal    = Depends(get_current_principal),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    from ..configmgmt.api_orchestrator import (
        _build_arista_eapi_commands, _build_cx_rest_commands, _detect_mgmt_vrf,
    )
    from ..models.credential import Credential, DeviceCredential
    from .. import crypto
    import json

    if method in ("arista_eapi", "aruba_cx_rest"):
        dev = await _get_device(device_id, principal, db, "operator")
        cred_row = (await db.execute(
            select(Credential)
            .join(DeviceCredential, DeviceCredential.credential_id == Credential.id)
            .where(DeviceCredential.device_id == device_id, Credential.type == "ssh")
            .order_by(DeviceCredential.priority)
        )).scalar_one_or_none()
        if cred_row:
            cred_data: dict = cred_row.data if isinstance(cred_row.data, dict) else json.loads(cred_row.data)
            if cred_data.get("password") and crypto.is_configured():
                try:
                    cred_data["password"] = crypto.decrypt(cred_data["password"])
                except Exception:
                    logger.warning("credential_decryption_failed", credential_id=str(cred_row.id))
                    cred_data.pop("password", None)
            host = dev.mgmt_ip_str
            vendor = str(dev.vendor or "")
            vrf = await _detect_mgmt_vrf(vendor, device_id, host, cred_data)
        else:
            vrf = "default"
        cmds = _build_arista_eapi_commands(vrf) if method == "arista_eapi" else _build_cx_rest_commands(vrf)
        return {"commands": cmds, "vrf": vrf}

    return {"commands": []}


@router.post("/{device_id}/{method}/configure", summary="SSH auto-configure to enable API method")
async def configure(
    device_id:    str,
    method:       str,
    principal:    Principal    = Depends(get_current_principal),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    await _get_device(device_id, principal, db, "operator")
    return await configure_method(device_id, method)


@router.post("/probe-all", summary="Probe all non-SNMP methods for tenant devices")
async def probe_all(
    principal: Principal     = Depends(get_current_principal),
    db:        AsyncSession = Depends(get_db),
) -> dict:
    device_ids = await _tenant_device_ids(principal, db)
    rows = (await db.execute(text("""
        SELECT dam.device_id::text, dam.method, d.mgmt_ip::text
        FROM device_api_methods dam
        JOIN devices d ON d.id = dam.device_id
        WHERE dam.method != 'snmp'
          AND dam.device_id = ANY(:device_ids)
    """), {"device_ids": device_ids})).all()

    import asyncio
    from ..configmgmt.api_orchestrator import probe_and_save as _pas
    results = await asyncio.gather(
        *[_pas(r[0], r[1], r[2].split("/")[0]) for r in rows],
        return_exceptions=True,
    )
    ok = sum(1 for r in results if isinstance(r, dict) and r.get("reachable"))
    return {"probed": len(rows), "reachable": ok}


# ── Auth helper ───────────────────────────────────────────────────────────────

async def _get_device(device_id: str, principal: Principal, db: AsyncSession, min_role: str = "readonly") -> Device:
    await assert_device_access(principal, uuid.UUID(device_id), min_role, db)
    dev = (await db.execute(
        select(Device).where(
            Device.id == device_id,
            Device.tenant_id == principal.active_tenant_id,
        )
    )).scalar_one_or_none()
    if dev is None:
        raise HTTPException(404, "device not found")
    return dev
