from __future__ import annotations

import asyncio
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

import structlog
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel
from sqlalchemy import func, select, desc, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..configmgmt.collector import collect_device, _deploy_ssh, _vendor_key
from ..configmgmt.compliance import run_compliance_for_device, evaluate_policy
from ..configmgmt.golden_config import evaluate_golden_config
from ..configmgmt import proxy as _proxy
from ..dependencies import (
    get_current_user, get_current_principal, get_db, require_role, Principal,
    accessible_device_ids_subquery, assert_device_access,
)
from ..models.config import (
    CompliancePolicy, ComplianceResult, ConfigBackup, ConfigDiff,
    GoldenConfig, GoldenConfigResult,
)
from ..models.device import Device
from ..models.site import RemoteCollector
from ..models.tenant import User

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/config", tags=["config"])


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _assert_device(device_id: str, principal: Principal, db: AsyncSession, min_role: str = "readonly") -> Device:
    await assert_device_access(principal, uuid.UUID(device_id), min_role, db)
    dev = (await db.execute(
        select(Device).where(
            Device.id == device_id,
            Device.tenant_id == principal.active_tenant_id,
        )
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
    principal:    Principal     = Depends(get_current_principal),
    db:           AsyncSession  = Depends(get_db),
) -> list[dict]:
    await _assert_device(device_id, principal, db)
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
    principal:    Principal    = Depends(get_current_principal),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    b = (await db.execute(
        select(ConfigBackup)
        .join(Device, ConfigBackup.device_id == Device.id)
        .where(ConfigBackup.id == backup_id, Device.tenant_id == principal.active_tenant_id)
    )).scalar_one_or_none()
    if b is None:
        raise HTTPException(status_code=404, detail="Backup not found")
    await assert_device_access(principal, b.device_id, "readonly", db)
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
    principal:    Principal     = Depends(get_current_principal),
    db:           AsyncSession  = Depends(get_db),
) -> list[dict]:
    await _assert_device(device_id, principal, db)
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
    principal:    Principal    = Depends(get_current_principal),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    d = (await db.execute(
        select(ConfigDiff)
        .join(Device, ConfigDiff.device_id == Device.id)
        .where(ConfigDiff.id == diff_id, Device.tenant_id == principal.active_tenant_id)
    )).scalar_one_or_none()
    if d is None:
        raise HTTPException(status_code=404, detail="Diff not found")
    await assert_device_access(principal, d.device_id, "readonly", db)
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
    principal:        Principal     = Depends(get_current_principal),
    db:               AsyncSession  = Depends(get_db),
) -> dict:
    await _assert_device(device_id, principal, db, min_role="operator")

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
    principal:    Principal    = Depends(get_current_principal),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    await _assert_device(device_id, principal, db)

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
    principal:    Principal     = Depends(get_current_principal),
    db:           AsyncSession  = Depends(get_db),
) -> list[dict]:
    q = (
        select(ComplianceResult, CompliancePolicy, Device)
        .join(CompliancePolicy, ComplianceResult.policy_id == CompliancePolicy.id)
        .join(Device, ComplianceResult.device_id == Device.id)
        .where(CompliancePolicy.tenant_id == principal.active_tenant_id)
    )
    if device_id:
        await _assert_device(device_id, principal, db)
        q = q.where(ComplianceResult.device_id == device_id)
    else:
        q = q.where(Device.id.in_(accessible_device_ids_subquery(principal)))
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


# ── Golden config endpoints ───────────────────────────────────────────────────

class GoldenConfigCreate(BaseModel):
    name:            str
    description:     Optional[str] = None
    device_selector: Optional[dict] = None
    template_text:   str = ""
    is_enabled:      bool = True


class GoldenConfigUpdate(BaseModel):
    name:            Optional[str] = None
    description:     Optional[str] = None
    device_selector: Optional[dict] = None
    template_text:   Optional[str] = None
    is_enabled:      Optional[bool] = None


def _golden_out(g: GoldenConfig) -> dict:
    return {
        "id":              str(g.id),
        "tenant_id":       str(g.tenant_id),
        "name":            g.name,
        "description":     g.description,
        "is_enabled":      g.is_enabled,
        "device_selector": g.device_selector,
        "template_text":   g.template_text,
        "created_at":      g.created_at.isoformat(),
        "updated_at":      g.updated_at.isoformat(),
    }


@router.get("/golden", summary="List golden configs")
async def list_golden_configs(
    current_user: User         = Depends(get_current_user),
    db:           AsyncSession = Depends(get_db),
) -> list[dict]:
    rows = (await db.execute(
        select(GoldenConfig)
        .where(GoldenConfig.tenant_id == current_user.tenant_id)
        .order_by(GoldenConfig.name)
    )).scalars().all()
    return [_golden_out(g) for g in rows]


@router.post("/golden", summary="Create golden config", status_code=status.HTTP_201_CREATED)
async def create_golden_config(
    body:         GoldenConfigCreate,
    current_user: User         = Depends(require_role("admin", "superadmin")),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    g = GoldenConfig(
        tenant_id=current_user.tenant_id,
        **body.model_dump(),
    )
    db.add(g)
    await db.commit()
    await db.refresh(g)
    return _golden_out(g)


# /golden/results and /golden/{golden_id}/evaluate MUST be before
# /golden/{golden_id} so FastAPI doesn't swallow the literal path segments as
# UUID values (same pattern as /deploy/multi vs /deploy/{device_id}).

@router.get("/golden/results", summary="Latest golden config drift results per device")
async def golden_config_results(
    device_id:    Optional[str] = Query(default=None),
    principal:    Principal     = Depends(get_current_principal),
    db:           AsyncSession  = Depends(get_db),
) -> list[dict]:
    q = (
        select(GoldenConfigResult, GoldenConfig, Device)
        .join(GoldenConfig, GoldenConfigResult.golden_config_id == GoldenConfig.id)
        .join(Device, GoldenConfigResult.device_id == Device.id)
        .where(GoldenConfig.tenant_id == principal.active_tenant_id)
    )
    if device_id:
        await _assert_device(device_id, principal, db)
        q = q.where(GoldenConfigResult.device_id == device_id)
    else:
        q = q.where(Device.id.in_(accessible_device_ids_subquery(principal)))
    q = q.order_by(desc(GoldenConfigResult.checked_at)).limit(200)

    rows = (await db.execute(q)).all()

    # Deduplicate: latest result per (device, golden config)
    seen: set = set()
    out = []
    for result, golden, device in rows:
        key = (str(result.device_id), str(result.golden_config_id))
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "id":                 str(result.id),
            "device_id":          str(result.device_id),
            "device_name":        device.display_name,
            "golden_config_id":   str(result.golden_config_id),
            "golden_config_name": golden.name,
            "score":              float(result.score),
            "matched_lines":      result.matched_lines,
            "total_lines":        result.total_lines,
            "missing_lines":      result.missing_lines,
            "checked_at":         result.checked_at.isoformat(),
        })
    return out


@router.post("/golden/{golden_id}/evaluate",
             summary="Run a golden config against all matching devices")
async def run_golden_config(
    golden_id:    uuid.UUID,
    current_user: User         = Depends(require_role("operator", "admin", "superadmin")),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    golden = (await db.execute(
        select(GoldenConfig).where(
            GoldenConfig.id == golden_id,
            GoldenConfig.tenant_id == current_user.tenant_id,
        )
    )).scalar_one_or_none()
    if golden is None:
        raise HTTPException(status_code=404, detail="Golden config not found")

    devices = (await db.execute(
        select(Device).where(
            Device.tenant_id == current_user.tenant_id,
            Device.is_active == True,  # noqa: E712
        )
    )).scalars().all()

    sel = golden.device_selector
    matching: list[Device] = []
    for dev in devices:
        if sel:
            if "device_ids" in sel and str(dev.id) not in (sel["device_ids"] or []):
                continue
            if "vendors" in sel and dev.vendor not in (sel["vendors"] or []):
                continue
        matching.append(dev)

    device_ids = [dev.id for dev in matching]
    backup_rows = []
    if device_ids:
        backup_rows = (await db.execute(
            select(ConfigBackup).where(
                ConfigBackup.device_id.in_(device_ids),
                ConfigBackup.is_latest == True,  # noqa: E712
            )
        )).scalars().all()
    backup_by_device = {b.device_id: b for b in backup_rows}

    evaluated, skipped, scores = 0, 0, []
    for dev in matching:
        backup = backup_by_device.get(dev.id)
        if backup is None:
            skipped += 1
            continue
        r = await evaluate_golden_config(golden, dev, backup.config_text, str(backup.id), db)
        evaluated += 1
        scores.append(float(r.score))

    return {
        "evaluated": evaluated,
        "skipped":   skipped,
        "avg_score": round(sum(scores) / len(scores), 2) if scores else None,
    }


@router.patch("/golden/{golden_id}", summary="Update golden config")
async def update_golden_config(
    golden_id:    uuid.UUID,
    body:         GoldenConfigUpdate,
    current_user: User         = Depends(require_role("admin", "superadmin")),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    g = (await db.execute(
        select(GoldenConfig).where(
            GoldenConfig.id == golden_id,
            GoldenConfig.tenant_id == current_user.tenant_id,
        )
    )).scalar_one_or_none()
    if g is None:
        raise HTTPException(status_code=404, detail="Golden config not found")
    for field, value in body.model_dump(exclude_none=True).items():
        setattr(g, field, value)
    g.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(g)
    return _golden_out(g)


@router.delete("/golden/{golden_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
async def delete_golden_config(
    golden_id:    uuid.UUID,
    current_user: User         = Depends(require_role("admin", "superadmin")),
    db:           AsyncSession = Depends(get_db),
) -> None:
    g = (await db.execute(
        select(GoldenConfig).where(
            GoldenConfig.id == golden_id,
            GoldenConfig.tenant_id == current_user.tenant_id,
        )
    )).scalar_one_or_none()
    if g:
        await db.delete(g)
        await db.commit()


# ── Config deploy ─────────────────────────────────────────────────────────────

class DeployRequest(BaseModel):
    commands: list[str]        # config lines to push
    save:     bool = True      # write memory / commit after deploy


class MultiDeployRequest(BaseModel):
    commands:        list[str]
    device_selector: Optional[dict] = None   # None = all tenant devices
    variables:       dict = {}               # user-defined template vars
    save:            bool = True
    max_concurrent:  int  = 5               # max parallel SSH connections


# /deploy/multi and /deploy/preview MUST be before /deploy/{device_id}
# so FastAPI doesn't swallow the literal path segments as UUID values.

@router.post("/deploy/multi", summary="Push config commands to multiple devices")
async def deploy_config_multi(
    body:         MultiDeployRequest,
    request:      Request,
    current_user: User          = Depends(require_role("operator", "admin", "superadmin")),
    db:           AsyncSession  = Depends(get_db),
) -> dict:
    import json as _json
    from .. import crypto
    from ..audit import audit as _audit
    from ..models.credential import Credential, DeviceCredential
    from ..alerting.evaluators import resolve_devices

    commands = [c for c in body.commands if c.strip()]
    if not commands:
        raise HTTPException(status_code=400, detail="No commands provided")

    devices = await resolve_devices(db, str(current_user.tenant_id), body.device_selector)
    if not devices:
        return {"results": [], "total": 0, "succeeded": 0, "failed": 0}

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

    import uuid as _uuid_mod
    all_uuids = [_uuid_mod.UUID(dev_row["id"]) for dev_row in devices]
    dev_objs: dict[str, Device] = {
        str(d.id): d
        for d in (await db.execute(
            select(Device).where(Device.id.in_(all_uuids))
        )).scalars().all()
    }

    sem = asyncio.Semaphore(min(body.max_concurrent, 10))

    # Pre-load the collectors owning any collector-managed targets, so the
    # concurrent deploy tasks don't touch the request DB session (unsafe under
    # concurrency).  Hub-managed devices have collector_id NULL and skip this.
    col_ids = {d.collector_id for d in dev_objs.values() if d.collector_id}
    col_map: dict = {}
    if col_ids:
        for c in (await db.execute(
            select(RemoteCollector).where(RemoteCollector.id.in_(col_ids))
        )).scalars():
            col_map[c.id] = c

    async def _deploy_one(did: str) -> dict:
        dev_obj = dev_objs.get(did)
        if not dev_obj:
            return {"device_id": did, "hostname": did[:8], "success": False,
                    "error": "Device not found", "output": ""}
        cred_data = cred_map.get(did)
        if not cred_data:
            return {"device_id": did, "hostname": dev_obj.display_name,
                    "success": False, "error": "No SSH credential", "output": ""}

        merged_vars = {**_device_vars(dev_obj), **body.variables}
        resolved_cmds = _substitute(commands, merged_vars)
        resolved_cmds = [c for c in resolved_cmds if c.strip()]
        vendor = _vendor_key(dev_obj)
        collector = col_map.get(dev_obj.collector_id) if dev_obj.collector_id else None

        async with sem:
            try:
                output = await _deploy_to_device(
                    dev_obj, vendor, cred_data, resolved_cmds, body.save, collector)
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

    # Audit each device sequentially on the shared session — must happen
    # AFTER gather() since concurrent tasks can't safely touch `db`.
    for r in results:
        dev_obj = dev_objs.get(r["device_id"])
        if dev_obj is None:
            continue
        new_value = {"action": "deploy", "method": "ssh",
                      "vendor": _vendor_key(dev_obj), "commands": commands,
                      "saved": body.save, "name": dev_obj.display_name,
                      "result": "success" if r["success"] else "failed"}
        if not r["success"]:
            new_value["error"] = r["error"]
        await _audit(db, action="config_push", resource_type="device",
                     resource_id=dev_obj.id, new_value=new_value,
                     user=current_user, request=request)
    await db.commit()

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
    from ..alerting.evaluators import resolve_devices
    selector: Optional[dict] = None
    if vendor:
        selector = {"vendors": [vendor]}
    elif tag:
        selector = {"tags": [tag]}
    devices = await resolve_devices(db, str(current_user.tenant_id), selector)
    return [
        {"id": d["id"], "hostname": d.get("hostname", ""),
         "mgmt_ip": d.get("mgmt_ip", ""), "vendor": d.get("vendor", "")}
        for d in devices
    ]


@router.post("/deploy/{device_id}", summary="Push config commands to a device via SSH")
async def deploy_config(
    device_id:    str,
    body:         DeployRequest,
    request:      Request,
    principal:    Principal     = Depends(get_current_principal),
    db:           AsyncSession  = Depends(get_db),
) -> dict:
    import asyncio, json as _json
    from .. import crypto
    from ..audit import audit as _audit
    from ..models.credential import Credential, DeviceCredential

    dev = await _assert_device(device_id, principal, db, min_role="operator")
    current_user = principal.user

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

    vendor = _vendor_key(dev)

    # Collector-managed devices are on a remote LAN the hub can't SSH to —
    # delegate the deploy to the owning collector.  Hub-managed devices run
    # directly.
    collector = None
    if dev.collector_id is not None:
        collector = (await db.execute(
            select(RemoteCollector).where(RemoteCollector.id == dev.collector_id)
        )).scalar_one_or_none()

    try:
        output = await _deploy_to_device(dev, vendor, cred_data, commands, body.save, collector)
    except Exception as exc:
        logger.error("config_deploy_failed", device=dev.hostname, error=str(exc))
        await _audit(db, action="config_push", resource_type="device",
                     resource_id=dev.id,
                     new_value={"action": "deploy", "method": "ssh",
                                "vendor": vendor, "commands": commands,
                                "saved": body.save, "result": "failed",
                                "error": str(exc), "name": dev.display_name},
                     user=current_user, request=request)
        await db.commit()
        raise HTTPException(status_code=502, detail=f"Deploy failed: {exc}")

    logger.info("config_deployed", device=dev.hostname, commands=len(commands),
                save=body.save, via="collector" if dev.collector_id else "hub")

    await _audit(db, action="config_push", resource_type="device",
                 resource_id=dev.id,
                 new_value={"action": "deploy", "method": "ssh",
                            "vendor": vendor, "commands": commands,
                            "saved": body.save, "result": "success",
                            "name": dev.display_name},
                 user=current_user, request=request)
    await db.commit()

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


# ── Rollback to a previous backup (device-pulls-from-HTTP) ────────────────────

class RollbackRequest(BaseModel):
    backup_id: uuid.UUID
    reason:    str            # required justification, audited
    save:      bool = True
    # The caller must echo back the device's hostname character-for-character
    # to confirm intent.  This is the only safety guard between an admin click
    # and live equipment getting reconfigured.
    confirm_hostname: str


async def _resolve_mgmt_vrf(db: AsyncSession, dev: Device) -> tuple[str | None, str | None]:
    """Find the VRF the device's monitored IP lives in, plus the interface that
    bears it, by matching the mgmt IP against the polled interface table.

    Returns (vrf_name | None, interface_name | None).  vrf is None when the IP
    is in the global table or we couldn't determine it; the rollback recipes
    treat None as 'global' (no VRF steering).  Used to make the HTTP config
    transfer egress the correct routing table — see configmgmt/rollback.py.
    """
    import json as _json
    mgmt_ip = dev.mgmt_ip_str
    # GIN-indexed JSONB containment: any interface whose ip_addresses array has
    # an element with this address.  Prefer a row that actually carries a VRF.
    row = (await db.execute(
        text("""
            SELECT name, vrf
              FROM interfaces
             WHERE device_id = :did
               AND ip_addresses @> :probe
             ORDER BY (vrf IS NOT NULL) DESC, if_index
             LIMIT 1
        """),
        {"did": str(dev.id), "probe": _json.dumps([{"address": mgmt_ip}])},
    )).first()
    if row is None:
        logger.info("rollback_vrf_unresolved", device=dev.display_name, mgmt_ip=mgmt_ip)
        return None, None
    return (row.vrf or None), (row.name or None)


async def _rollback_via_hub(host, vendor, cred_data, target, body, vrf, source_if):
    """Hub-managed device: hub hosts the one-shot server and SSHes the device.
    Returns (output, config_served)."""
    from ..configmgmt import rollback as _rb

    fetcher = _rb.serve_rollback_for_vendor(
        vendor, config_text=target.config_text or "",
        expected_source_ip=host,
        timeout=120.0,
    )
    try:
        recipe = _rb.build_recipe(vendor, fetcher.url_for_device(), save=body.save,
                                  vrf=vrf, source_if=source_if,
                                  sftp_password=fetcher.sftp_password)
        loop = asyncio.get_running_loop()
        output = await loop.run_in_executor(
            None, _rb.run_recipe, host, 22, vendor, cred_data, recipe,
        )
        return output, fetcher.served_event.is_set()
    finally:
        fetcher.shutdown()


async def _rollback_via_collector(db, dev, host, vendor, cred_data, target, body, vrf, source_if):
    """Collector-managed device: the owning collector hosts the one-shot server
    on its LAN IP and SSHes the device.  The hub builds the recipe (with a
    '{{URL}}' placeholder the collector substitutes) and ships it the config
    text.  Returns (output, config_served)."""
    from ..configmgmt import rollback as _rb

    col = (await db.execute(
        select(RemoteCollector).where(RemoteCollector.id == dev.collector_id)
    )).scalar_one_or_none()
    if col is None or not col.wg_ip or not col.api_key_hash:
        raise RuntimeError("device's collector is offline or has no WireGuard IP")

    recipe = _rb.build_recipe(vendor, "{{URL}}", save=body.save, vrf=vrf, source_if=source_if,
                              sftp_password="{{SFTP_PASSWORD}}")
    payload = {
        "operation":          "rollback",
        "device_ip":          host,
        "ssh_port":           22,
        "vendor":             vendor,
        "username":           cred_data.get("username", ""),
        "password":           cred_data.get("password", ""),
        "enable_secret":      cred_data.get("enable_secret", "") or "",
        "enter_enable":       vendor in _proxy.ENABLE_VENDORS,
        "serve_config":       target.config_text or "",
        "serve_transport":    "sftp" if vendor in _rb._SFTP_VENDORS else "http",
        "expected_source_ip": host,
        "steps":              _proxy.steps_from_recipe(recipe),
        "final_read_command": "show running-config" if recipe.show_running_after else "",
    }
    data = await _proxy.config_exec(
        wg_ip=str(col.wg_ip), api_key_hash=col.api_key_hash, payload=payload)
    return data.get("output", ""), bool(data.get("config_served"))


def _deploy_steps(vendor: str, commands: list[str], save: bool) -> list[dict]:
    """Build generic config-mode send/expect steps for the collector executor.

    Covers the IOS/EOS/NX-OS/Aruba-CX 'configure terminal … end' shape plus
    Junos (configure/commit) and IOS-XR (configure/commit) candidate models.
    The hub-local path uses Netmiko's send_config_set; this is the delegated
    equivalent for collector-managed devices."""
    s = _proxy.step
    if vendor == "juniper":
        return [s("configure", delay=1.5), *[s(c) for c in commands],
                s("commit and-quit", delay=8.0, expect=r"(commit complete|error|warning)")]
    if vendor == "cisco_iosxr":
        return [s("configure terminal", delay=1.5), *[s(c) for c in commands],
                s("commit", delay=5.0), s("end", delay=1.0)]

    steps = [s("configure terminal", delay=1.5), *[s(c) for c in commands], s("end", delay=1.0)]
    if save:
        if vendor == "cisco_nxos":
            steps.append(s("copy running-config startup-config", delay=3.0))
        else:
            steps.append(s("write memory", delay=3.0, expect=r"(y/n|filename)"))
    return steps


async def _deploy_to_device(dev, vendor, cred_data, commands, save, collector) -> str:
    """Run a config deploy either hub-direct or via the owning collector.
    `collector` is the pre-loaded RemoteCollector (or None for hub-managed).
    Does no DB I/O so it is safe to call concurrently."""
    if dev.collector_id is not None:
        if collector is None or not collector.wg_ip or not collector.api_key_hash:
            raise RuntimeError("device's collector is offline or has no WireGuard IP")
        payload = {
            "operation":          "deploy",
            "device_ip":          dev.mgmt_ip_str,
            "ssh_port":           22,
            "vendor":             vendor,
            "username":           cred_data.get("username", ""),
            "password":           cred_data.get("password", ""),
            "enable_secret":      cred_data.get("enable_secret", "") or "",
            "enter_enable":       vendor in _proxy.ENABLE_VENDORS,
            "serve_config":       "",
            "expected_source_ip": "",
            "steps":              _deploy_steps(vendor, commands, save),
            "final_read_command": "",
        }
        data = await _proxy.config_exec(
            wg_ip=str(collector.wg_ip), api_key_hash=collector.api_key_hash, payload=payload)
        return data.get("output", "")

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None, _deploy_ssh, dev.mgmt_ip_str, 22, vendor, cred_data, commands, save)


@router.post("/rollback/{device_id}",
             summary="Roll a device's config back to a previously-captured backup")
async def rollback_config(
    device_id:    str,
    body:         RollbackRequest,
    request:      Request,
    principal:    Principal     = Depends(get_current_principal),
    db:           AsyncSession  = Depends(get_db),
) -> dict:
    """Roll a device back to a stored snapshot using *vendor-native replace*
    semantics.  Instead of pasting config in line-by-line over SSH (which
    deadlocks on interactive prompts), we:

      1. Mint a one-shot HTTP token bound to (device_id, backup_id, source_ip).
      2. SSH to the device and run a tiny vendor-specific recipe that tells the
         device to fetch the config from us and apply it atomically using its
         own replace primitive (configure replace / commit replace / load
         override / copy running-config).

    Required: admin role + a written hostname-confirm + a written reason
    (audit trail).
    """
    import asyncio, json as _json
    from .. import crypto
    from ..audit import audit as _audit
    from ..configmgmt import rollback as _rb
    from ..models.credential import Credential, DeviceCredential

    dev = await _assert_device(device_id, principal, db, min_role="operator")
    current_user = principal.user

    if not body.reason.strip():
        raise HTTPException(status_code=400, detail="A reason is required for rollback")

    # Vendor support check — only vendors with verified recipes are allowed
    vendor = _vendor_key(dev)
    if vendor not in _rb.supported_vendors():
        raise HTTPException(
            status_code=422,
            detail=(f"Rollback isn't implemented for vendor '{vendor}'. "
                    f"Supported: {sorted(_rb.supported_vendors())}. "
                    f"ProCurve needs TFTP support; FortiOS/Ubiquiti need REST."),
        )

    # Type-to-confirm guard — caller must echo back the device hostname exactly.
    if body.confirm_hostname != dev.display_name:
        raise HTTPException(
            status_code=400,
            detail=(f"Type-confirmation mismatch. Set confirm_hostname to "
                    f"'{dev.display_name}' (exact match) in the request body."),
        )

    # Load the target backup and confirm it belongs to this device
    target = (await db.execute(
        select(ConfigBackup)
        .where(ConfigBackup.id == body.backup_id, ConfigBackup.device_id == device_id)
    )).scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=404, detail="Backup not found for this device")
    if target.is_latest:
        raise HTTPException(status_code=400, detail="Refusing to roll back to the latest snapshot (already current)")
    if not (target.config_text or "").strip():
        raise HTTPException(status_code=400, detail="Target backup is empty")

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

    host = dev.mgmt_ip_str

    # Resolve the VRF the device's monitored IP lives in so the device fetches
    # the config over the correct routing table (global vs a VRF).  Without this
    # the HTTP copy can egress the wrong interface and silently hang/fail.
    mgmt_vrf, mgmt_if = await _resolve_mgmt_vrf(db, dev)
    logger.info("rollback_mgmt_path", device=dev.display_name,
                mgmt_ip=host, vrf=mgmt_vrf or "global", interface=mgmt_if,
                via="collector" if dev.collector_id else "hub")

    # Device-pulls-from-HTTP.  For a hub-managed device the hub hosts the
    # one-shot server and SSHes the device directly.  For a collector-managed
    # device the device is on a remote LAN the hub can't reach — delegate to the
    # owning collector, which hosts the server on its own LAN IP and does the
    # SSH.  All vendor logic stays here; only execution moves.
    try:
        if dev.collector_id is not None:
            output, served = await _rollback_via_collector(
                db, dev, host, vendor, cred_data, target, body, mgmt_vrf, mgmt_if)
        else:
            output, served = await _rollback_via_hub(
                host, vendor, cred_data, target, body, mgmt_vrf, mgmt_if)
    except Exception as exc:
        logger.error("config_rollback_failed", device=dev.hostname, error=str(exc))
        await _audit(db, action="config_push", resource_type="device",
                     resource_id=dev.id,
                     new_value={"action": "rollback", "method": "http-fetch",
                                "backup_id": str(body.backup_id),
                                "reason": body.reason, "result": "failed",
                                "error": str(exc), "name": dev.display_name},
                     user=current_user, request=request)
        await db.commit()
        raise HTTPException(status_code=502, detail=f"Rollback failed: {exc}")

    logger.info("config_rolled_back", device=dev.hostname,
                backup_id=str(body.backup_id), vendor=vendor,
                save=body.save, config_served=served,
                via="collector" if dev.collector_id else "hub")

    await _audit(db, action="config_push", resource_type="device",
                 resource_id=dev.id,
                 new_value={"action":    "rollback",
                            "method":    "http-fetch",
                            "vendor":    vendor,
                            "vrf":       mgmt_vrf or "global",
                            "source_interface": mgmt_if,
                            "backup_id": str(body.backup_id),
                            "backup_collected_at": target.collected_at.isoformat(),
                            "backup_hash": target.config_hash,
                            "reason":    body.reason,
                            "saved":     body.save,
                            "result":    "success",
                            "name":      dev.display_name},
                 user=current_user, request=request)
    await db.commit()

    # Re-collect to capture the new state
    async def _backup():
        from ..database import AsyncSessionLocal
        async with AsyncSessionLocal() as s:
            await collect_device(device_id, s)
    asyncio.create_task(_backup())

    return {
        "device_id": device_id,
        "hostname":  dev.display_name,
        "backup_id": str(body.backup_id),
        "vendor":    vendor,
        "vrf":       mgmt_vrf or "global",
        "saved":     body.save,
        "output":    output,
    }


# NOTE: the device pulls the rollback config from the ephemeral one-shot HTTP
# server started by rollback.serve_rollback() (device-facing IP, ports
# 5050-5054), NOT from this API.  There is deliberately no rollback-fetch route
# here — see configmgmt/rollback.py for the rationale (devices don't trust the
# self-signed cert and don't proxy cleanly through nginx).


# ── Git-backed config archive ─────────────────────────────────────────────────

class GitRemoteRequest(BaseModel):
    remote_url: str
    branch:     str = "main"


@router.get("/git/status", summary="Git config-archive status for this tenant")
async def git_status(
    current_user: User         = Depends(get_current_user),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    from ..configmgmt import git_archive
    return await git_archive.repo_status(db, current_user.tenant_id)


@router.get("/git/log/{device_id}", summary="Git commit history for a device's archived config")
async def git_log(
    device_id:    str,
    limit:        int          = Query(default=50, le=200),
    principal:    Principal    = Depends(get_current_principal),
    db:           AsyncSession = Depends(get_db),
) -> list[dict]:
    from ..configmgmt import git_archive
    dev = await _assert_device(device_id, principal, db)
    return await git_archive.get_log(principal.active_tenant_id, dev, limit=limit)


@router.get("/git/show/{device_id}/{commit_hash}", summary="Config text at a given archive commit")
async def git_show(
    device_id:    str,
    commit_hash:  str,
    principal:    Principal    = Depends(get_current_principal),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    from ..configmgmt import git_archive
    dev = await _assert_device(device_id, principal, db)
    text = await git_archive.get_file_at_commit(principal.active_tenant_id, dev, commit_hash)
    if text is None:
        raise HTTPException(status_code=404, detail="Commit or file not found")
    return {"device_id": device_id, "commit": commit_hash, "config_text": text}


@router.post("/git/remote", summary="Configure the config-archive git remote (admin only)")
async def git_set_remote(
    body:         GitRemoteRequest,
    current_user: User         = Depends(require_role("admin", "superadmin")),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    from ..configmgmt import git_archive
    remote_url = body.remote_url.strip()
    if not remote_url:
        raise HTTPException(status_code=400, detail="remote_url is required")
    branch = body.branch.strip() or "main"
    await git_archive.set_remote(db, current_user.tenant_id, remote_url, branch)
    return await git_archive.repo_status(db, current_user.tenant_id)


@router.delete("/git/remote", summary="Remove the config-archive git remote (admin only)")
async def git_remove_remote(
    current_user: User         = Depends(require_role("admin", "superadmin")),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    from ..configmgmt import git_archive
    await git_archive.remove_remote(db, current_user.tenant_id)
    return await git_archive.repo_status(db, current_user.tenant_id)


@router.post("/git/push", summary="Manually push the config archive to its remote")
async def git_push(
    current_user: User         = Depends(require_role("operator", "admin", "superadmin")),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    from ..configmgmt import git_archive
    return await git_archive.push_now(db, current_user.tenant_id)


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

