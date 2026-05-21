from __future__ import annotations

import asyncio
import ipaddress
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_current_user, get_db, require_role
from ..models.tenant import User
from ..schemas.discovery import DiscoveredDevice, SweepJob, SweepRequest

logger = structlog.get_logger(__name__)
router = APIRouter(tags=["discovery"])

_jobs:      dict[uuid.UUID, SweepJob]     = {}
_job_tasks: dict[uuid.UUID, asyncio.Task] = {}
_jobs_lock = asyncio.Lock()

JOB_EXPIRE_MINUTES = 60

_VENDOR_PREFIXES: list[tuple[str, str]] = [
    ("1.3.6.1.4.1.2636.",   "juniper"),
    ("1.3.6.1.4.1.30065.",  "arista"),
    ("1.3.6.1.4.1.12356.",  "fortios"),
    ("1.3.6.1.4.1.47196.",  "aruba_cx"),
    ("1.3.6.1.4.1.11.",     "procurve"),
    ("1.3.6.1.4.1.9.12.",   "cisco_nxos"),
    ("1.3.6.1.4.1.9.6.",    "cisco_iosxe"),
    ("1.3.6.1.4.1.9.1.",    "cisco_ios"),
    ("1.3.6.1.4.1.9.",      "cisco_ios"),
]
_SYSDESCR_OVERRIDES: list[tuple[str, str, str]] = [
    ("cisco_ios", r"NX-OS",  "cisco_nxos"),
    ("cisco_ios", r"IOS-XR", "cisco_iosxr"),
]


def _detect_vendor(sys_object_id: str, sys_descr: str) -> str:
    vendor = "unknown"
    for prefix, v in _VENDOR_PREFIXES:
        if sys_object_id.startswith(prefix):
            vendor = v
            break
    for oid_vendor, pattern, corrected in _SYSDESCR_OVERRIDES:
        if vendor == oid_vendor and re.search(pattern, sys_descr, re.IGNORECASE):
            vendor = corrected
            break
    return vendor


_SYS_DESCR     = "1.3.6.1.2.1.1.1.0"
_SYS_OBJECT_ID = "1.3.6.1.2.1.1.2.0"
_SYS_NAME      = "1.3.6.1.2.1.1.5.0"


async def _probe_v2c(ip: str, community: str, port: int, timeout: int) -> Optional[DiscoveredDevice]:
    from pysnmp.hlapi.v3arch.asyncio import (
        CommunityData, ContextData, ObjectIdentity, ObjectType,
        SnmpEngine, UdpTransportTarget, get_cmd,
    )
    engine = SnmpEngine()
    try:
        transport = await UdpTransportTarget.create((ip, port), timeout=timeout, retries=0)
        err_indication, err_status, _, var_binds = await get_cmd(
            engine, CommunityData(community, mpModel=1), transport, ContextData(),
            ObjectType(ObjectIdentity(_SYS_DESCR)),
            ObjectType(ObjectIdentity(_SYS_OBJECT_ID)),
            ObjectType(ObjectIdentity(_SYS_NAME)),
        )
        if err_indication or err_status:
            return None
        sys_descr = str(var_binds[0][1]) if len(var_binds) > 0 else ""
        sys_oid   = str(var_binds[1][1]) if len(var_binds) > 1 else ""
        sys_name  = str(var_binds[2][1]) if len(var_binds) > 2 else ip
        return DiscoveredDevice(ip=ip, hostname=sys_name, vendor=_detect_vendor(sys_oid, sys_descr),
                                sys_descr=sys_descr, sys_object_id=sys_oid, already_in_db=False)
    except asyncio.CancelledError:
        raise
    except Exception:
        return None


_AUTH_PROTO_MAP = {"md5": "usmHMACMD5AuthProtocol", "sha": "usmHMACSHAAuthProtocol",
                   "sha256": "usmHMAC192SHA256AuthProtocol", "sha512": "usmHMAC384SHA512AuthProtocol"}
_PRIV_PROTO_MAP = {"des": "usmDESPrivProtocol", "aes": "usmAesCfb128Protocol",
                   "aes192": "usmAesCfb192Protocol", "aes256": "usmAesCfb256Protocol"}


async def _probe_v3(ip: str, cred_data: dict, port: int, timeout: int) -> Optional[DiscoveredDevice]:
    from pysnmp.hlapi.v3arch.asyncio import (
        ContextData, ObjectIdentity, ObjectType, SnmpEngine,
        UdpTransportTarget, UsmUserData, get_cmd,
    )
    import pysnmp.hlapi.v3arch.asyncio as hlapi
    auth_proto = getattr(hlapi, _AUTH_PROTO_MAP.get(cred_data.get("auth_protocol", "sha256").lower(), "usmHMAC192SHA256AuthProtocol"))
    priv_proto = getattr(hlapi, _PRIV_PROTO_MAP.get(cred_data.get("priv_protocol", "aes").lower(), "usmAesCfb128Protocol"))
    engine = SnmpEngine()
    try:
        transport = await UdpTransportTarget.create((ip, port), timeout=timeout, retries=0)
        err_indication, err_status, _, var_binds = await get_cmd(
            engine,
            UsmUserData(cred_data["username"], authKey=cred_data.get("auth_key", ""),
                        privKey=cred_data.get("priv_key", ""),
                        authProtocol=auth_proto, privProtocol=priv_proto),
            transport, ContextData(),
            ObjectType(ObjectIdentity(_SYS_DESCR)),
            ObjectType(ObjectIdentity(_SYS_OBJECT_ID)),
            ObjectType(ObjectIdentity(_SYS_NAME)),
        )
        if err_indication or err_status:
            return None
        sys_descr = str(var_binds[0][1]) if len(var_binds) > 0 else ""
        sys_oid   = str(var_binds[1][1]) if len(var_binds) > 1 else ""
        sys_name  = str(var_binds[2][1]) if len(var_binds) > 2 else ip
        return DiscoveredDevice(ip=ip, hostname=sys_name, vendor=_detect_vendor(sys_oid, sys_descr),
                                sys_descr=sys_descr, sys_object_id=sys_oid, already_in_db=False)
    except asyncio.CancelledError:
        raise
    except Exception:
        return None


async def _run_sweep(
    job_id: uuid.UUID, req: SweepRequest,
    tenant_id: uuid.UUID,
    creds: list[tuple[uuid.UUID, dict, str]],  # [(cred_id, cred_data, cred_type), ...]
) -> None:
    from ..database import AsyncSessionLocal

    network = ipaddress.ip_network(req.cidr, strict=False)
    hosts   = list(network.hosts())

    async with _jobs_lock:
        _jobs[job_id].total  = len(hosts)
        _jobs[job_id].status = "running"

    existing_ips: dict[str, uuid.UUID] = {}
    async with AsyncSessionLocal() as db:
        rows = await db.execute(
            text("SELECT id, host(mgmt_ip) FROM devices WHERE tenant_id = :tid"),
            {"tid": str(tenant_id)},
        )
        for row in rows:
            existing_ips[row[1]] = row[0]

    sem = asyncio.Semaphore(req.max_concurrent)
    probe_tasks: list[asyncio.Task] = []

    async def probe_one(ip_obj: ipaddress.IPv4Address) -> None:
        ip = str(ip_obj)
        result = None
        working_cred_id = None
        try:
            async with sem:
                for cred_id, cred_data, cred_type in creds:
                    try:
                        if cred_type == "snmp_v2c":
                            r = await _probe_v2c(ip, cred_data.get("community", "public"), req.port, req.timeout_s)
                        else:
                            r = await _probe_v3(ip, cred_data, req.port, req.timeout_s)
                        if r:
                            result = r
                            working_cred_id = cred_id
                            break
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        continue
        except asyncio.CancelledError:
            return

        async with _jobs_lock:
            if _jobs[job_id].status == "cancelled":
                return
            _jobs[job_id].scanned += 1
            if result:
                result.credential_id = working_cred_id
                if ip in existing_ips:
                    result.already_in_db = True
                    result.device_id = existing_ips[ip]
                _jobs[job_id].found.append(result)

    try:
        probe_tasks = [asyncio.create_task(probe_one(h)) for h in hosts]
        await asyncio.gather(*probe_tasks, return_exceptions=True)
    except asyncio.CancelledError:
        for t in probe_tasks:
            t.cancel()
        await asyncio.gather(*probe_tasks, return_exceptions=True)
        async with _jobs_lock:
            _jobs[job_id].status      = "cancelled"
            _jobs[job_id].finished_at = datetime.now(timezone.utc)
        return

    async with _jobs_lock:
        if _jobs[job_id].status != "cancelled":
            _jobs[job_id].status      = "done"
            _jobs[job_id].finished_at = datetime.now(timezone.utc)

    logger.info("sweep_complete", job_id=str(job_id), cidr=req.cidr,
                found=len(_jobs[job_id].found), scanned=len(hosts))


def _expire_jobs() -> None:
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=JOB_EXPIRE_MINUTES)
    to_del = [
        jid for jid, j in _jobs.items()
        if j.status in ("done", "cancelled", "error")
        and j.finished_at
        and j.finished_at.replace(tzinfo=timezone.utc) < cutoff
    ]
    for jid in to_del:
        _jobs.pop(jid, None)
        _job_tasks.pop(jid, None)


@router.post("/discovery/sweep", response_model=SweepJob,
             status_code=status.HTTP_202_ACCEPTED,
             summary="Start a background SNMP sweep")
async def start_sweep(
    req:          SweepRequest,
    current_user: User         = Depends(require_role("admin", "superadmin", "operator")),
    db:           AsyncSession = Depends(get_db),
) -> SweepJob:
    try:
        network = ipaddress.ip_network(req.cidr, strict=False)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid CIDR notation")
    if network.num_addresses > 1024:
        raise HTTPException(status_code=400, detail="CIDR too large — max /22 (1022 hosts)")

    from ..models.credential import Credential
    cred_rows = (await db.execute(
        select(Credential).where(
            Credential.id.in_(req.credential_ids),
            Credential.tenant_id == current_user.tenant_id,
            Credential.type.in_(("snmp_v2c", "snmp_v3")),
        )
    )).scalars().all()

    if not cred_rows:
        raise HTTPException(status_code=404, detail="No valid SNMP credentials found")

    # Preserve the order requested by the caller
    cred_map = {c.id: c for c in cred_rows}
    creds = [
        (cid, cred_map[cid].data, cred_map[cid].type)
        for cid in req.credential_ids
        if cid in cred_map
    ]

    job_id = uuid.uuid4()
    job = SweepJob(
        job_id=job_id, status="pending", cidr=req.cidr, total=0, scanned=0,
        started_at=datetime.now(timezone.utc), tenant_id=current_user.tenant_id,
    )
    async with _jobs_lock:
        _expire_jobs()
        _jobs[job_id] = job

    task = asyncio.create_task(
        _run_sweep(job_id, req, current_user.tenant_id, creds),
        name=f"sweep-{job_id}",
    )
    _job_tasks[job_id] = task

    logger.info("sweep_started", job_id=str(job_id), cidr=req.cidr)
    return job


@router.get("/discovery/sweep", summary="List sweep jobs for this tenant")
async def list_sweeps(current_user: User = Depends(get_current_user)) -> list[dict]:
    async with _jobs_lock:
        return sorted([
            {
                "job_id":     str(j.job_id),
                "status":     j.status,
                "cidr":       j.cidr,
                "total":      j.total,
                "scanned":    j.scanned,
                "found":      len(j.found),
                "started_at": j.started_at.isoformat(),
                "finished_at":j.finished_at.isoformat() if j.finished_at else None,
            }
            for j in _jobs.values()
            if j.tenant_id == current_user.tenant_id
        ], key=lambda x: x["started_at"], reverse=True)


@router.get("/discovery/sweep/{job_id}", response_model=SweepJob,
            summary="Get sweep job status and results")
async def get_sweep(
    job_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
) -> SweepJob:
    async with _jobs_lock:
        job = _jobs.get(job_id)
    if job is None or job.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=404, detail="Sweep job not found")
    return job


@router.delete("/discovery/sweep/{job_id}", status_code=204, response_model=None,
               summary="Cancel a running sweep")
async def cancel_sweep(
    job_id: uuid.UUID,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
) -> None:
    async with _jobs_lock:
        job  = _jobs.get(job_id)
        task = _job_tasks.get(job_id)
    if job is None or job.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=404, detail="Sweep job not found")
    if job.status not in ("pending", "running"):
        return
    if task and not task.done():
        task.cancel()
    async with _jobs_lock:
        _jobs[job_id].status      = "cancelled"
        _jobs[job_id].finished_at = datetime.now(timezone.utc)
    logger.info("sweep_cancelled", job_id=str(job_id))
