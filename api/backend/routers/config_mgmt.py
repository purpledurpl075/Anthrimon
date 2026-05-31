from __future__ import annotations

import asyncio
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

import structlog
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import func, select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from ..configmgmt.collector import collect_device, _deploy_ssh, _vendor_key
from ..configmgmt.compliance import run_compliance_for_device, evaluate_policy
from ..dependencies import get_current_user, get_db, require_role
from ..models.config import (
    CompliancePolicy, ComplianceResult, ConfigBackup, ConfigDiff
)
from ..models.device import Device
from ..models.tenant import User

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/config", tags=["config"])


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _assert_device(device_id: str, tenant_id: uuid.UUID, db: AsyncSession) -> Device:
    dev = (await db.execute(
        select(Device).where(Device.id == device_id, Device.tenant_id == tenant_id)
    )).scalar_one_or_none()
    if dev is None:
        raise HTTPException(status_code=404, detail="Device not found")
    return dev


# ── Backup endpoints ──────────────────────────────────────────────────────────

@router.get("/backups", summary="List config backups for a device")
async def list_backups(
    device_id:    str           = Query(...),
    limit:        int           = Query(default=20, ge=1, le=100),
    offset:       int           = Query(default=0, ge=0),
    current_user: User          = Depends(get_current_user),
    db:           AsyncSession  = Depends(get_db),
) -> list[dict]:
    await _assert_device(device_id, current_user.tenant_id, db)
    rows = (await db.execute(
        select(ConfigBackup)
        .where(ConfigBackup.device_id == device_id)
        .order_by(desc(ConfigBackup.collected_at))
        .limit(limit).offset(offset)
    )).scalars().all()
    return [
        {
            "id":                str(b.id),
            "device_id":         str(b.device_id),
            "collected_at":      b.collected_at.isoformat(),
            "config_hash":       b.config_hash,
            "collection_method": b.collection_method,
            "is_latest":         b.is_latest,
            "size_bytes":        len(b.config_text.encode()),
        }
        for b in rows
    ]


@router.get("/backups/{backup_id}", summary="Get a config backup (full text)")
async def get_backup(
    backup_id:    uuid.UUID,
    current_user: User         = Depends(get_current_user),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    b = (await db.execute(
        select(ConfigBackup)
        .join(Device, ConfigBackup.device_id == Device.id)
        .where(ConfigBackup.id == backup_id, Device.tenant_id == current_user.tenant_id)
    )).scalar_one_or_none()
    if b is None:
        raise HTTPException(status_code=404, detail="Backup not found")
    return {
        "id":                str(b.id),
        "device_id":         str(b.device_id),
        "collected_at":      b.collected_at.isoformat(),
        "config_hash":       b.config_hash,
        "collection_method": b.collection_method,
        "is_latest":         b.is_latest,
        "config_text":       b.config_text,
    }


@router.get("/diffs", summary="List config diffs for a device")
async def list_diffs(
    device_id:    str           = Query(...),
    limit:        int           = Query(default=20, ge=1, le=100),
    current_user: User          = Depends(get_current_user),
    db:           AsyncSession  = Depends(get_db),
) -> list[dict]:
    await _assert_device(device_id, current_user.tenant_id, db)
    rows = (await db.execute(
        select(ConfigDiff)
        .where(ConfigDiff.device_id == device_id)
        .order_by(desc(ConfigDiff.created_at))
        .limit(limit)
    )).scalars().all()
    return [
        {
            "id":             str(d.id),
            "device_id":      str(d.device_id),
            "prev_backup_id": str(d.prev_backup_id) if d.prev_backup_id else None,
            "curr_backup_id": str(d.curr_backup_id),
            "lines_added":    d.lines_added,
            "lines_removed":  d.lines_removed,
            "created_at":     d.created_at.isoformat(),
        }
        for d in rows
    ]


@router.get("/diffs/{diff_id}", summary="Get a config diff (full text)")
async def get_diff(
    diff_id:      uuid.UUID,
    current_user: User         = Depends(get_current_user),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    d = (await db.execute(
        select(ConfigDiff)
        .join(Device, ConfigDiff.device_id == Device.id)
        .where(ConfigDiff.id == diff_id, Device.tenant_id == current_user.tenant_id)
    )).scalar_one_or_none()
    if d is None:
        raise HTTPException(status_code=404, detail="Diff not found")
    return {
        "id":             str(d.id),
        "device_id":      str(d.device_id),
        "prev_backup_id": str(d.prev_backup_id) if d.prev_backup_id else None,
        "curr_backup_id": str(d.curr_backup_id),
        "diff_text":      d.diff_text,
        "lines_added":    d.lines_added,
        "lines_removed":  d.lines_removed,
        "created_at":     d.created_at.isoformat(),
    }


@router.post("/collect/{device_id}", summary="Trigger immediate config collection")
async def trigger_collect(
    device_id:        str,
    background_tasks: BackgroundTasks,
    current_user:     User          = Depends(require_role("operator", "admin", "superadmin")),
    db:               AsyncSession  = Depends(get_db),
) -> dict:
    await _assert_device(device_id, current_user.tenant_id, db)

    async def _run():
        from ..database import AsyncSessionLocal
        async with AsyncSessionLocal() as s:
            backup = await collect_device(device_id, s)
            if backup:
                logger.info("manual_collect_done", device=device_id, backup=str(backup.id))

    background_tasks.add_task(_run)
    return {"status": "collecting", "device_id": device_id}


# ── Device config summary (for device detail page) ────────────────────────────

@router.get("/status/{device_id}", summary="Config status for a device")
async def device_config_status(
    device_id:    str,
    current_user: User         = Depends(get_current_user),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    await _assert_device(device_id, current_user.tenant_id, db)

    latest = (await db.execute(
        select(ConfigBackup)
        .where(ConfigBackup.device_id == device_id, ConfigBackup.is_latest == True)  # noqa: E712
    )).scalar_one_or_none()

    backup_count = (await db.execute(
        select(func.count())
        .select_from(ConfigBackup)
        .where(ConfigBackup.device_id == device_id)
    )).scalar_one()

    latest_diff = (await db.execute(
        select(ConfigDiff)
        .where(ConfigDiff.device_id == device_id)
        .order_by(desc(ConfigDiff.created_at))
        .limit(1)
    )).scalar_one_or_none()

    # Latest compliance result per policy
    compliance_rows = (await db.execute(
        select(ComplianceResult)
        .where(ComplianceResult.device_id == device_id)
        .order_by(desc(ComplianceResult.checked_at))
        .limit(20)
    )).scalars().all()

    # Deduplicate — keep only latest per policy
    seen: set = set()
    compliance_latest = []
    for r in compliance_rows:
        if r.policy_id not in seen:
            seen.add(r.policy_id)
            compliance_latest.append(r)

    fail_count = sum(1 for r in compliance_latest if r.status == "fail")

    return {
        "has_backup":      latest is not None,
        "last_collected":  latest.collected_at.isoformat() if latest else None,
        "backup_count":    backup_count,
        "last_changed_at": latest_diff.created_at.isoformat() if latest_diff else None,
        "last_diff": {
            "id":            str(latest_diff.id),
            "lines_added":   latest_diff.lines_added,
            "lines_removed": latest_diff.lines_removed,
        } if latest_diff else None,
        "compliance_fail_count": fail_count,
        "compliance_total":      len(compliance_latest),
    }


# ── Compliance policy endpoints ───────────────────────────────────────────────

class PolicyCreate(BaseModel):
    name:            str
    description:     Optional[str] = None
    device_selector: Optional[dict] = None
    rules:           list = []
    severity:        str = "warning"
    is_enabled:      bool = True


class PolicyUpdate(BaseModel):
    name:            Optional[str] = None
    description:     Optional[str] = None
    device_selector: Optional[dict] = None
    rules:           Optional[list] = None
    severity:        Optional[str] = None
    is_enabled:      Optional[bool] = None


def _policy_out(p: CompliancePolicy) -> dict:
    return {
        "id":              str(p.id),
        "tenant_id":       str(p.tenant_id),
        "name":            p.name,
        "description":     p.description,
        "is_enabled":      p.is_enabled,
        "device_selector": p.device_selector,
        "rules":           p.rules,
        "severity":        p.severity,
        "created_at":      p.created_at.isoformat(),
        "updated_at":      p.updated_at.isoformat(),
    }


@router.get("/policies", summary="List compliance policies")
async def list_policies(
    current_user: User         = Depends(get_current_user),
    db:           AsyncSession = Depends(get_db),
) -> list[dict]:
    rows = (await db.execute(
        select(CompliancePolicy)
        .where(CompliancePolicy.tenant_id == current_user.tenant_id)
        .order_by(CompliancePolicy.name)
    )).scalars().all()
    return [_policy_out(p) for p in rows]


@router.post("/policies", summary="Create compliance policy",
             status_code=status.HTTP_201_CREATED)
async def create_policy(
    body:         PolicyCreate,
    current_user: User         = Depends(require_role("admin", "superadmin")),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    p = CompliancePolicy(
        tenant_id=current_user.tenant_id,
        **body.model_dump(),
    )
    db.add(p)
    await db.commit()
    await db.refresh(p)
    return _policy_out(p)


@router.patch("/policies/{policy_id}", summary="Update compliance policy")
async def update_policy(
    policy_id:    uuid.UUID,
    body:         PolicyUpdate,
    current_user: User         = Depends(require_role("admin", "superadmin")),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    p = (await db.execute(
        select(CompliancePolicy).where(
            CompliancePolicy.id == policy_id,
            CompliancePolicy.tenant_id == current_user.tenant_id,
        )
    )).scalar_one_or_none()
    if p is None:
        raise HTTPException(status_code=404, detail="Policy not found")
    for field, value in body.model_dump(exclude_none=True).items():
        setattr(p, field, value)
    p.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(p)
    return _policy_out(p)


@router.delete("/policies/{policy_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
async def delete_policy(
    policy_id:    uuid.UUID,
    current_user: User         = Depends(require_role("admin", "superadmin")),
    db:           AsyncSession = Depends(get_db),
) -> None:
    p = (await db.execute(
        select(CompliancePolicy).where(
            CompliancePolicy.id == policy_id,
            CompliancePolicy.tenant_id == current_user.tenant_id,
        )
    )).scalar_one_or_none()
    if p:
        await db.delete(p)
        await db.commit()


@router.post("/policies/{policy_id}/evaluate",
             summary="Run a compliance policy against all matching devices")
async def run_policy(
    policy_id:    uuid.UUID,
    current_user: User         = Depends(require_role("operator", "admin", "superadmin")),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    policy = (await db.execute(
        select(CompliancePolicy).where(
            CompliancePolicy.id == policy_id,
            CompliancePolicy.tenant_id == current_user.tenant_id,
        )
    )).scalar_one_or_none()
    if policy is None:
        raise HTTPException(status_code=404, detail="Policy not found")

    devices = (await db.execute(
        select(Device).where(
            Device.tenant_id == current_user.tenant_id,
            Device.is_active == True,  # noqa: E712
        )
    )).scalars().all()

    # Batch-fetch all latest backups in one query instead of N+1.
    device_ids = [dev.id for dev in devices]
    backup_rows = (await db.execute(
        select(ConfigBackup).where(
            ConfigBackup.device_id.in_(device_ids),
            ConfigBackup.is_latest == True,  # noqa: E712
        )
    )).scalars().all()
    backup_by_device = {b.device_id: b for b in backup_rows}

    results = {"pass": 0, "fail": 0, "error": 0, "skip": 0}
    for dev in devices:
        backup = backup_by_device.get(dev.id)
        if backup is None:
            results["skip"] += 1
            continue
        r = await evaluate_policy(policy, dev, backup.config_text, str(backup.id), db)
        results[r.status] = results.get(r.status, 0) + 1

    return results


@router.get("/compliance/results", summary="Latest compliance results per device")
async def compliance_results(
    device_id:    Optional[str] = Query(default=None),
    current_user: User          = Depends(get_current_user),
    db:           AsyncSession  = Depends(get_db),
) -> list[dict]:
    q = (
        select(ComplianceResult, CompliancePolicy, Device)
        .join(CompliancePolicy, ComplianceResult.policy_id == CompliancePolicy.id)
        .join(Device, ComplianceResult.device_id == Device.id)
        .where(CompliancePolicy.tenant_id == current_user.tenant_id)
    )
    if device_id:
        q = q.where(ComplianceResult.device_id == device_id)
    q = q.order_by(desc(ComplianceResult.checked_at)).limit(200)

    rows = (await db.execute(q)).all()

    # Deduplicate: latest result per (device, policy)
    seen: set = set()
    out = []
    for result, policy, device in rows:
        key = (str(result.device_id), str(result.policy_id))
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "id":          str(result.id),
            "device_id":   str(result.device_id),
            "device_name": device.display_name,
            "policy_id":   str(result.policy_id),
            "policy_name": policy.name,
            "severity":    policy.severity,
            "status":      result.status,
            "checked_at":  result.checked_at.isoformat(),
            "findings":    result.findings,
        })
    return out


# ── Config deploy ─────────────────────────────────────────────────────────────

class DeployRequest(BaseModel):
    commands: list[str]        # config lines to push
    save:     bool = True      # write memory / commit after deploy


@router.post("/deploy/{device_id}", summary="Push config commands to a device via SSH")
async def deploy_config(
    device_id:    str,
    body:         DeployRequest,
    current_user: User          = Depends(require_role("operator", "admin", "superadmin")),
    db:           AsyncSession  = Depends(get_db),
) -> dict:
    import asyncio, json as _json
    from .. import crypto
    from ..models.credential import Credential, DeviceCredential

    dev = await _assert_device(device_id, current_user.tenant_id, db)

    # Require at least one non-empty command
    commands = [c for c in body.commands if c.strip()]
    if not commands:
        raise HTTPException(status_code=400, detail="No commands provided")
    if len(commands) > 200:
        raise HTTPException(status_code=400, detail="Too many commands (max 200)")

    # Load SSH credential
    cred_row = (await db.execute(
        select(DeviceCredential, Credential)
        .join(Credential, Credential.id == DeviceCredential.credential_id)
        .where(DeviceCredential.device_id == device_id, Credential.type == "ssh")
        .order_by(DeviceCredential.priority)
    )).first()
    if cred_row is None:
        raise HTTPException(status_code=400, detail="No SSH credential assigned to this device")

    _, cred = cred_row
    cred_data = cred.data if isinstance(cred.data, dict) else _json.loads(cred.data)
    if cred_data.get("password") and crypto.is_configured():
        try:
            cred_data["password"] = crypto.decrypt(cred_data["password"])
        except Exception:
            pass

    host   = dev.mgmt_ip_str
    vendor = _vendor_key(dev)

    loop = asyncio.get_running_loop()
    try:
        output = await loop.run_in_executor(
            None, _deploy_ssh, host, 22, vendor, cred_data, commands, body.save
        )
    except Exception as exc:
        logger.error("config_deploy_failed", device=dev.hostname, error=str(exc))
        raise HTTPException(status_code=502, detail=f"Deploy failed: {exc}")

    logger.info("config_deployed", device=dev.hostname, commands=len(commands), save=body.save)

    # Trigger a backup in the background to capture the new state
    async def _backup():
        from ..database import AsyncSessionLocal
        async with AsyncSessionLocal() as s:
            await collect_device(device_id, s)

    asyncio.create_task(_backup())

    return {
        "device_id": device_id,
        "hostname":  dev.display_name,
        "commands":  len(commands),
        "saved":     body.save,
        "output":    output,
    }


# ── Template variable substitution ───────────────────────────────────────────

def _substitute(commands: list[str], variables: dict) -> list[str]:
    """Replace {{var}} placeholders in commands with values from the variables dict."""
    result = []
    for cmd in commands:
        for k, v in variables.items():
            cmd = cmd.replace(f"{{{{{k}}}}}", str(v))
        result.append(cmd)
    return result


def _device_vars(dev: Device) -> dict:
    """Built-in per-device template variables."""
    return {
        "hostname":    dev.display_name,
        "mgmt_ip":     dev.mgmt_ip_str,
        "vendor":      dev.vendor or "",
        "device_type": dev.device_type or "",
        "fqdn":        dev.display_name,
    }


# ── Multi-device deploy ───────────────────────────────────────────────────────

class MultiDeployRequest(BaseModel):
    commands:        list[str]
    device_selector: Optional[dict] = None   # None = all tenant devices
    variables:       dict = {}               # user-defined template vars
    save:            bool = True
    max_concurrent:  int  = 5               # max parallel SSH connections


@router.post("/deploy/multi", summary="Push config commands to multiple devices")
async def deploy_config_multi(
    body:         MultiDeployRequest,
    current_user: User          = Depends(require_role("operator", "admin", "superadmin")),
    db:           AsyncSession  = Depends(get_db),
) -> dict:
    import json as _json
    from .. import crypto
    from ..models.credential import Credential, DeviceCredential
    from ..alerting.evaluators import resolve_devices

    commands = [c for c in body.commands if c.strip()]
    if not commands:
        raise HTTPException(status_code=400, detail="No commands provided")

    # Resolve target devices
    devices = await resolve_devices(db, str(current_user.tenant_id), body.device_selector)
    if not devices:
        return {"results": [], "total": 0, "succeeded": 0, "failed": 0}

    # Pre-load SSH credentials for all devices
    cred_map: dict[str, dict] = {}
    for dev_row in devices:
        did = dev_row["id"]
        cred_row = (await db.execute(
            select(DeviceCredential, Credential)
            .join(Credential, Credential.id == DeviceCredential.credential_id)
            .where(DeviceCredential.device_id == did, Credential.type == "ssh")
            .order_by(DeviceCredential.priority)
        )).first()
        if cred_row is None:
            continue
        _, cred = cred_row
        cred_data = cred.data if isinstance(cred.data, dict) else _json.loads(cred.data)
        if cred_data.get("password") and crypto.is_configured():
            try:
                cred_data["password"] = crypto.decrypt(cred_data["password"])
            except Exception:
                pass
        cred_map[did] = cred_data

    # Load full Device objects for template variable resolution
    dev_objs: dict[str, Device] = {}
    for did in cred_map:
        dev_obj = (await db.execute(select(Device).where(Device.id == did))).scalar_one_or_none()
        if dev_obj:
            dev_objs[did] = dev_obj

    sem = asyncio.Semaphore(min(body.max_concurrent, 10))

    async def _deploy_one(did: str) -> dict:
        dev_obj = dev_objs.get(did)
        if not dev_obj:
            return {"device_id": did, "hostname": did[:8], "success": False,
                    "error": "Device not found", "output": ""}
        cred_data = cred_map.get(did)
        if not cred_data:
            return {"device_id": did, "hostname": dev_obj.display_name,
                    "success": False, "error": "No SSH credential", "output": ""}

        # Merge built-in device vars with user vars (user vars take precedence)
        merged_vars = {**_device_vars(dev_obj), **body.variables}
        resolved_cmds = _substitute(commands, merged_vars)
        # Filter out empty commands after substitution
        resolved_cmds = [c for c in resolved_cmds if c.strip()]

        host   = dev_obj.mgmt_ip_str
        vendor = _vendor_key(dev_obj)

        async with sem:
            loop = asyncio.get_running_loop()
            try:
                output = await loop.run_in_executor(
                    None, _deploy_ssh, host, 22, vendor, cred_data, resolved_cmds, body.save
                )
                # Trigger backup
                async def _bk():
                    from ..database import AsyncSessionLocal
                    async with AsyncSessionLocal() as s:
                        await collect_device(did, s)
                asyncio.create_task(_bk())
                return {"device_id": did, "hostname": dev_obj.display_name,
                        "success": True, "error": None, "output": output}
            except Exception as exc:
                return {"device_id": did, "hostname": dev_obj.display_name,
                        "success": False, "error": str(exc), "output": ""}

    results = await asyncio.gather(*[_deploy_one(d["id"]) for d in devices])
    succeeded = sum(1 for r in results if r["success"])
    logger.info("multi_deploy_complete", total=len(results), succeeded=succeeded,
                user=current_user.username)

    return {
        "results":   list(results),
        "total":     len(results),
        "succeeded": succeeded,
        "failed":    len(results) - succeeded,
    }


@router.get("/deploy/preview", summary="Preview devices matching a selector")
async def deploy_preview(
    vendor:       Optional[str] = None,
    tag:          Optional[str] = None,
    current_user: User          = Depends(get_current_user),
    db:           AsyncSession  = Depends(get_db),
) -> list[dict]:
    """Return devices that would be targeted by a given selector."""
    from ..alerting.evaluators import resolve_devices

    selector: Optional[dict] = None
    if vendor:
        selector = {"vendors": [vendor]}
    elif tag:
        selector = {"tags": [tag]}

    devices = await resolve_devices(db, str(current_user.tenant_id), selector)
    return [
        {
            "id":          d["id"],
            "hostname":    d.get("hostname", ""),
            "mgmt_ip":     d.get("mgmt_ip", ""),
            "vendor":      d.get("vendor", ""),
        }
        for d in devices
    ]
