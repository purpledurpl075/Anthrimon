"""Change management workflow — create, approve, reject, execute config changes."""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Optional

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import (
    get_current_principal, get_db, Principal,
    accessible_device_ids_subquery, assert_device_access, _has_tenant_role,
)
from ..models.device import Device
from ..models.orchestration import ChangeAction, ChangeRequest
from ..models.tenant import User
from ..schemas.orchestration import (
    ApproveRequest, ChangeActionRead, ChangeRequestCreate,
    ChangeRequestRead, RejectRequest,
)

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/changes", tags=["changes"])


async def _enrich(cr: ChangeRequest, db: AsyncSession) -> ChangeRequestRead:
    user_ids = {cr.requested_by}
    if cr.approved_by:
        user_ids.add(cr.approved_by)
    if cr.executed_by:
        user_ids.add(cr.executed_by)
    device_ids = {a.device_id for a in cr.actions}

    names: dict[uuid.UUID, str] = {}
    if user_ids:
        rows = (await db.execute(
            select(User.id, User.username).where(User.id.in_(user_ids))
        )).all()
        names = {r.id: r.username for r in rows}

    dev_names: dict[uuid.UUID, str] = {}
    if device_ids:
        rows = (await db.execute(
            select(Device.id, Device.hostname).where(Device.id.in_(device_ids))
        )).all()
        dev_names = {r.id: r.hostname for r in rows}

    read = ChangeRequestRead.model_validate(cr)
    read.requested_by_name = names.get(cr.requested_by)
    read.approved_by_name = names.get(cr.approved_by) if cr.approved_by else None
    read.executed_by_name = names.get(cr.executed_by) if cr.executed_by else None
    for ar in read.actions:
        ar.device_name = dev_names.get(ar.device_id)
    return read


@router.post("", response_model=ChangeRequestRead, status_code=status.HTTP_201_CREATED,
             summary="Create a change request")
async def create_change_request(
    body: ChangeRequestCreate,
    request: Request,
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> ChangeRequestRead:
    if not _has_tenant_role(principal, "operator"):
        raise HTTPException(status_code=403, detail="Requires operator role")

    for act in body.actions:
        await assert_device_access(principal, act.device_id, "operator", db)

    cr = ChangeRequest(
        tenant_id=principal.active_tenant_id,
        title=body.title,
        description=body.description,
        rollback_plan=body.rollback_plan,
        scheduled_at=body.scheduled_at,
        status="pending_approval",
        requested_by=principal.user.id,
    )
    db.add(cr)
    await db.flush()

    for i, act in enumerate(body.actions):
        db.add(ChangeAction(
            change_request_id=cr.id,
            device_id=act.device_id,
            step_order=i,
            action_type=act.action_type,
            payload=act.payload,
        ))

    from ..audit import audit as _audit
    await _audit(db, action="create", resource_type="change_request",
                 resource_id=cr.id, new_value={"title": cr.title, "actions": len(body.actions)},
                 user=principal.user, request=request)
    await db.commit()
    await db.refresh(cr)
    return await _enrich(cr, db)


@router.get("", response_model=list[ChangeRequestRead], summary="List change requests")
async def list_change_requests(
    cr_status: Optional[str] = Query(default=None, alias="status"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> list[ChangeRequestRead]:
    q = select(ChangeRequest).where(ChangeRequest.tenant_id == principal.active_tenant_id)
    if cr_status:
        q = q.where(ChangeRequest.status == cr_status)
    q = q.order_by(ChangeRequest.created_at.desc()).limit(limit).offset(offset)
    rows = (await db.execute(q)).scalars().all()
    return [await _enrich(cr, db) for cr in rows]


@router.get("/{cr_id}", response_model=ChangeRequestRead, summary="Get change request detail")
async def get_change_request(
    cr_id: uuid.UUID,
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> ChangeRequestRead:
    cr = await _get_cr(cr_id, principal, db)
    return await _enrich(cr, db)


@router.post("/{cr_id}/approve", response_model=ChangeRequestRead, summary="Approve a change request")
async def approve_change_request(
    cr_id: uuid.UUID,
    body: ApproveRequest,
    request: Request,
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> ChangeRequestRead:
    if not _has_tenant_role(principal, "tenant_admin"):
        raise HTTPException(status_code=403, detail="Requires tenant admin role")

    cr = await _get_cr(cr_id, principal, db)
    if cr.status != "pending_approval":
        raise HTTPException(status_code=409, detail=f"Cannot approve — status is '{cr.status}'")
    if cr.requested_by == principal.user.id:
        raise HTTPException(status_code=403, detail="Cannot approve your own change request")

    cr.status = "approved"
    cr.approved_by = principal.user.id
    cr.approval_notes = body.notes

    from ..audit import audit as _audit
    await _audit(db, action="update", resource_type="change_request",
                 resource_id=cr.id, new_value={"action": "approve", "title": cr.title},
                 user=principal.user, request=request)
    await db.commit()
    await db.refresh(cr)
    return await _enrich(cr, db)


@router.post("/{cr_id}/reject", response_model=ChangeRequestRead, summary="Reject a change request")
async def reject_change_request(
    cr_id: uuid.UUID,
    body: RejectRequest,
    request: Request,
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> ChangeRequestRead:
    if not _has_tenant_role(principal, "tenant_admin"):
        raise HTTPException(status_code=403, detail="Requires tenant admin role")

    cr = await _get_cr(cr_id, principal, db)
    if cr.status != "pending_approval":
        raise HTTPException(status_code=409, detail=f"Cannot reject — status is '{cr.status}'")

    cr.status = "rejected"
    cr.rejection_reason = body.reason

    from ..audit import audit as _audit
    await _audit(db, action="update", resource_type="change_request",
                 resource_id=cr.id, new_value={"action": "reject", "reason": body.reason, "title": cr.title},
                 user=principal.user, request=request)
    await db.commit()
    await db.refresh(cr)
    return await _enrich(cr, db)


@router.post("/{cr_id}/execute", response_model=ChangeRequestRead, summary="Execute an approved change")
async def execute_change_request(
    cr_id: uuid.UUID,
    request: Request,
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> ChangeRequestRead:
    if not _has_tenant_role(principal, "operator"):
        raise HTTPException(status_code=403, detail="Requires operator role")

    cr = await _get_cr(cr_id, principal, db)
    if cr.status != "approved":
        raise HTTPException(status_code=409, detail=f"Cannot execute — status is '{cr.status}'")

    cr.status = "executing"
    cr.executed_by = principal.user.id
    cr.executed_at = datetime.now(timezone.utc)
    await db.commit()

    from ..configmgmt.collector import _deploy_ssh, _vendor_key
    from ..configmgmt import proxy as _proxy
    from ..models.credential import Credential, DeviceCredential
    from ..models.site import RemoteCollector
    from .. import crypto
    import json as _json

    all_ok = True
    for action in cr.actions:
        action.status = "running"
        action.started_at = datetime.now(timezone.utc)
        await db.commit()

        if action.action_type == "wait_seconds":
            secs = action.payload.get("seconds", 10)
            await asyncio.sleep(min(secs, 300))
            action.status = "completed"
            action.completed_at = datetime.now(timezone.utc)
            await db.commit()
            continue

        try:
            dev = (await db.execute(
                select(Device).where(Device.id == action.device_id)
            )).scalar_one_or_none()
            if dev is None:
                raise RuntimeError("Device not found")

            commands = action.payload.get("commands", [])
            if action.action_type == "config_push":
                config_text = action.payload.get("config_text", "")
                if config_text:
                    commands = [line for line in config_text.splitlines() if line.strip()]

            if not commands and action.action_type == "command_run":
                commands = action.payload.get("commands", [])

            if not commands:
                raise RuntimeError("No commands in action payload")

            cred_row = (await db.execute(
                select(DeviceCredential, Credential)
                .join(Credential, Credential.id == DeviceCredential.credential_id)
                .where(DeviceCredential.device_id == action.device_id, Credential.type == "ssh")
                .order_by(DeviceCredential.priority)
            )).first()
            if cred_row is None:
                raise RuntimeError("No SSH credential assigned to device")

            _, cred = cred_row
            cred_data = cred.data if isinstance(cred.data, dict) else _json.loads(cred.data)
            if cred_data.get("password") and crypto.is_configured():
                try:
                    cred_data["password"] = crypto.decrypt(cred_data["password"])
                except Exception:
                    logger.warning("credential_decryption_failed", credential_id=str(cred.id))

            vendor = _vendor_key(dev)
            collector = None
            if dev.collector_id is not None:
                collector = (await db.execute(
                    select(RemoteCollector).where(RemoteCollector.id == dev.collector_id)
                )).scalar_one_or_none()

            from .config_mgmt import _deploy_to_device
            save = action.payload.get("save", True)
            output = await _deploy_to_device(dev, vendor, cred_data, commands, save, collector)

            action.status = "completed"
            action.output = output[:10000] if output else ""
            action.completed_at = datetime.now(timezone.utc)

        except Exception as exc:
            action.status = "failed"
            action.error_message = str(exc)[:2000]
            action.completed_at = datetime.now(timezone.utc)
            all_ok = False
            await db.commit()

            for remaining in cr.actions:
                if remaining.status == "pending":
                    remaining.status = "skipped"
            break

        await db.commit()

    cr.status = "completed" if all_ok else "failed"
    cr.completed_at = datetime.now(timezone.utc)

    from ..audit import audit as _audit
    await _audit(db, action="update", resource_type="change_request",
                 resource_id=cr.id,
                 new_value={"action": "execute", "result": cr.status, "title": cr.title},
                 user=principal.user, request=request)
    await db.commit()
    await db.refresh(cr)
    return await _enrich(cr, db)


@router.post("/{cr_id}/cancel", response_model=ChangeRequestRead, summary="Cancel a change request")
async def cancel_change_request(
    cr_id: uuid.UUID,
    request: Request,
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> ChangeRequestRead:
    cr = await _get_cr(cr_id, principal, db)
    if cr.status not in ("draft", "pending_approval", "approved"):
        raise HTTPException(status_code=409, detail=f"Cannot cancel — status is '{cr.status}'")
    if cr.requested_by != principal.user.id and not _has_tenant_role(principal, "tenant_admin"):
        raise HTTPException(status_code=403, detail="Only the requester or a tenant admin can cancel")

    cr.status = "cancelled"

    from ..audit import audit as _audit
    await _audit(db, action="update", resource_type="change_request",
                 resource_id=cr.id, new_value={"action": "cancel", "title": cr.title},
                 user=principal.user, request=request)
    await db.commit()
    await db.refresh(cr)
    return await _enrich(cr, db)


async def _get_cr(cr_id: uuid.UUID, principal: Principal, db: AsyncSession) -> ChangeRequest:
    cr = (await db.execute(
        select(ChangeRequest).where(
            ChangeRequest.id == cr_id,
            ChangeRequest.tenant_id == principal.active_tenant_id,
        )
    )).scalar_one_or_none()
    if cr is None:
        raise HTTPException(status_code=404, detail="Change request not found")
    return cr
