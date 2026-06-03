from __future__ import annotations

import asyncio
import hashlib
import hmac
import ipaddress
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_current_user, get_db, require_role
from ..models.tenant import User
from ..schemas.discovery import DiscoveredDevice, SweepJob, SweepRequest
from ..snmp_probe import probe_v2c as _probe_v2c, probe_v3 as _probe_v3

logger = structlog.get_logger(__name__)
router = APIRouter(tags=["discovery"])

_jobs:      dict[uuid.UUID, SweepJob]     = {}
_job_tasks: dict[uuid.UUID, asyncio.Task] = {}
_jobs_lock = asyncio.Lock()

JOB_EXPIRE_MINUTES = 60

_WG_SUBNET = ipaddress.ip_network("10.100.0.0/24")


def _control_token(api_key_hash: str) -> str:
    minute = str(int(time.time()) // 60)
    return hmac.new(api_key_hash.encode(), minute.encode(), hashlib.sha256).hexdigest()


def _cred_to_spec(cred_data: dict, cred_type: str) -> dict:
    if cred_type == "snmp_v3":
        return {
            "version":    "snmp_v3",
            "username":   cred_data.get("username", ""),
            "auth_key":   cred_data.get("auth_key", ""),
            "priv_key":   cred_data.get("priv_key", ""),
            "auth_proto": cred_data.get("auth_protocol", "sha256"),
            "priv_proto": cred_data.get("priv_protocol", "aes"),
        }
    return {"version": "snmp_v2c", "community": cred_data.get("community", "public")}


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


async def _run_remote_sweep(
    job_id: uuid.UUID, req: SweepRequest,
    tenant_id: uuid.UUID,
    creds: list[tuple[uuid.UUID, dict, str]],
) -> None:
    """Forward a sweep to a remote collector and translate results back into the job."""
    from ..database import AsyncSessionLocal
    from ..models.site import RemoteCollector

    async with _jobs_lock:
        _jobs[job_id].status = "running"

    cred_specs = [_cred_to_spec(cd, ct) for _, cd, ct in creds]

    existing_ips: dict[str, uuid.UUID] = {}
    col = None
    async with AsyncSessionLocal() as db:
        col = (await db.execute(
            select(RemoteCollector).where(
                RemoteCollector.id == str(req.collector_id),
                RemoteCollector.tenant_id == tenant_id,
            )
        )).scalar_one_or_none()

        rows = await db.execute(
            text("SELECT id, host(mgmt_ip) FROM devices WHERE tenant_id = :tid"),
            {"tid": str(tenant_id)},
        )
        for row in rows:
            existing_ips[row[1]] = row[0]

    wg_ip = str(col.wg_ip).split("/")[0] if col and col.wg_ip else None
    if col is None or not wg_ip or ipaddress.ip_address(wg_ip) not in _WG_SUBNET:
        async with _jobs_lock:
            _jobs[job_id].status      = "error"
            _jobs[job_id].error       = "Collector not found or not connected to WireGuard"
            _jobs[job_id].finished_at = datetime.now(timezone.utc)
        return
    network = ipaddress.ip_network(req.cidr, strict=False)
    n_hosts = max(network.num_addresses - 2, 1)
    timeout = max(req.timeout_s * n_hosts / max(req.max_concurrent, 1) * 2 + 30, 60)

    try:
        async with httpx.AsyncClient(timeout=timeout) as hc:
            resp = await hc.post(
                f"http://{wg_ip}:9090/sweep",
                json={
                    "cidr":           req.cidr,
                    "port":           req.port,
                    "creds":          cred_specs,
                    "timeout_s":      req.timeout_s,
                    "max_concurrent": req.max_concurrent,
                },
                headers={"Authorization": f"Bearer {_control_token(col.api_key_hash)}"},
            )
        if resp.status_code != 200:
            raise Exception(f"Collector returned HTTP {resp.status_code}: {resp.text[:200]}")
        data = resp.json()
    except asyncio.CancelledError:
        async with _jobs_lock:
            _jobs[job_id].status      = "cancelled"
            _jobs[job_id].finished_at = datetime.now(timezone.utc)
        return
    except Exception as exc:
        async with _jobs_lock:
            _jobs[job_id].status      = "error"
            _jobs[job_id].error       = str(exc)
            _jobs[job_id].finished_at = datetime.now(timezone.utc)
        return

    found_devices: list[DiscoveredDevice] = []
    for item in data.get("found", []):
        ip = item.get("ip", "")
        found_devices.append(DiscoveredDevice(
            ip=ip,
            hostname=item.get("hostname", ip),
            vendor=item.get("vendor", "unknown"),
            sys_descr=item.get("sys_descr", ""),
            sys_object_id=item.get("sys_object_id", ""),
            already_in_db=(ip in existing_ips),
            device_id=existing_ips.get(ip),
        ))

    async with _jobs_lock:
        if _jobs[job_id].status != "cancelled":
            _jobs[job_id].total       = data.get("total", 0)
            _jobs[job_id].scanned     = data.get("scanned", 0)
            _jobs[job_id].found       = found_devices
            _jobs[job_id].status      = "done"
            _jobs[job_id].finished_at = datetime.now(timezone.utc)

    logger.info("remote_sweep_complete", job_id=str(job_id), cidr=req.cidr,
                found=len(found_devices), collector_id=str(req.collector_id))


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

    # Validate collector_id at the API boundary (not inside the background task).
    if req.collector_id is not None:
        from ..models.site import RemoteCollector
        col_row = (await db.execute(
            select(RemoteCollector).where(
                RemoteCollector.id == str(req.collector_id),
                RemoteCollector.tenant_id == current_user.tenant_id,
            )
        )).scalar_one_or_none()
        if col_row is None:
            raise HTTPException(status_code=404, detail="Collector not found")
        if not col_row.wg_ip:
            raise HTTPException(status_code=409, detail="Collector has no WireGuard IP — bootstrap it first")
        if ipaddress.ip_address(str(col_row.wg_ip).split("/")[0]) not in _WG_SUBNET:
            raise HTTPException(status_code=409, detail="Collector WireGuard IP is outside expected subnet")

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

    if req.collector_id is None:
        run_fn = _run_sweep(job_id, req, current_user.tenant_id, creds)
    else:
        run_fn = _run_remote_sweep(job_id, req, current_user.tenant_id, creds)

    task = asyncio.create_task(run_fn, name=f"sweep-{job_id}")
    _job_tasks[job_id] = task

    logger.info("sweep_started", job_id=str(job_id), cidr=req.cidr,
                remote=(req.collector_id is not None))
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
