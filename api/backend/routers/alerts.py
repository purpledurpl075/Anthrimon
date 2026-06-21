from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket, WebSocketDisconnect, status
from sqlalchemy import func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..alerting.ws_manager import manager as alert_ws_manager
from ..database import AsyncSessionLocal
from ..dependencies import (
    get_current_user, get_current_principal, get_db, require_role, Principal,
    accessible_device_ids_subquery, assert_device_access, _has_tenant_role,
    _principal_from_jwt,
)
from ..models.alert import Alert, AlertComment, AlertRule
from ..models.tenant import User
from ..schemas.alert import AlertRead, AlertRuleCreate, AlertRuleRead, AlertRuleUpdate, SuppressedChildSummary, AlertBulkRequest
from ..schemas.common import PaginatedResponse

logger = structlog.get_logger(__name__)
router = APIRouter(tags=["alerts"])


def _validate_alert_rule_body(body) -> None:
    """Raise 422 if metric-specific config is invalid."""
    import json as _json
    import re as _re
    metric = getattr(body, "metric", None) or ""
    if metric == "syslog_match":
        raw_oid = getattr(body, "custom_oid", None) or ""
        # custom_oid is stored as a JSON string: '{"pattern": "OSPF.*down"}'
        try:
            custom = _json.loads(raw_oid) if raw_oid else {}
        except _json.JSONDecodeError:
            raise HTTPException(
                status_code=422,
                detail="custom_oid must be a JSON object, e.g. {\"pattern\": \"OSPF.*down\"}",
            )
        pattern = (custom.get("pattern") or "").strip() if isinstance(custom, dict) else ""
        if not pattern:
            raise HTTPException(
                status_code=422,
                detail="syslog_match rules require custom_oid.pattern (regex string)",
            )
        try:
            _re.compile(pattern)
        except _re.error as exc:
            raise HTTPException(
                status_code=422,
                detail=f"Invalid regex pattern in custom_oid.pattern: {exc}",
            )


# ── Alerts ─────────────────────────────────────────────────────────────────────

_VALID_ALERT_STATUSES = {"open", "acknowledged", "resolved", "suppressed", "expired"}


@router.get("/alerts", response_model=PaginatedResponse[AlertRead], summary="List alerts")
async def list_alerts(
    alert_status: Optional[str] = Query(default=None, alias="status"),
    severity: Optional[str] = Query(default=None),
    device_id: Optional[uuid.UUID] = Query(default=None),
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> PaginatedResponse[AlertRead]:
    if alert_status and alert_status not in _VALID_ALERT_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid status '{alert_status}'. Valid values: {sorted(_VALID_ALERT_STATUSES)}",
        )

    q = select(Alert).where(
        Alert.tenant_id == principal.active_tenant_id,
        or_(Alert.device_id.is_(None), Alert.device_id.in_(accessible_device_ids_subquery(principal))),
    )

    if alert_status:
        q = q.where(Alert.status == alert_status)
    if severity:
        q = q.where(Alert.severity == severity)
    if device_id:
        q = q.where(Alert.device_id == device_id)

    total = (await db.execute(select(func.count()).select_from(q.subquery()))).scalar_one()
    items = (await db.execute(q.order_by(Alert.triggered_at.desc()).limit(limit).offset(offset))).scalars().all()

    # One round-trip to fetch suppressed-child counts for these alerts.
    counts: dict[uuid.UUID, int] = {}
    if items:
        ids = [a.id for a in items]
        rows = (await db.execute(
            select(Alert.suppressed_by_alert_id, func.count(Alert.id))
            .where(Alert.suppressed_by_alert_id.in_(ids), Alert.status == "suppressed")
            .group_by(Alert.suppressed_by_alert_id)
        )).all()
        counts = {row[0]: row[1] for row in rows}

    out = []
    for a in items:
        r = AlertRead.model_validate(a)
        r.suppressed_child_count = counts.get(a.id, 0)
        out.append(r)

    return PaginatedResponse(total=total, limit=limit, offset=offset, items=out)


@router.websocket("/alerts/ws")
async def alerts_ws(ws: WebSocket, token: str = Query(...)):
    """Live alert feed — pushes {"event": "alerts_changed"} whenever an
    alert in the caller's tenant is created, updated, or resolved. Client
    should refetch GET /alerts on receipt. JWT in `token` query-param
    (browser WS limitation, same pattern as /probes/ws)."""
    await ws.accept()
    async with AsyncSessionLocal() as db:
        principal = await _principal_from_jwt(token, db)
    if principal is None:
        await ws.close(code=1008)
        return

    tenant_id = principal.active_tenant_id
    alert_ws_manager.connect(tenant_id, ws)
    try:
        while True:
            await ws.receive_text()  # block until disconnect; ignore content
    except WebSocketDisconnect:
        pass
    finally:
        alert_ws_manager.disconnect(tenant_id, ws)


@router.get("/alerts/{alert_id}", response_model=AlertRead, summary="Get a single alert")
async def get_alert(
    alert_id: uuid.UUID,
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> AlertRead:
    alert = await _get_alert(alert_id, principal, db)
    if alert.device_id is not None:
        await assert_device_access(principal, alert.device_id, "readonly", db)

    # Fetch the suppressed children — id, title, severity, device name, metric.
    child_rows = (await db.execute(text("""
        SELECT a.id, a.title, a.severity, a.triggered_at,
               ar.metric, d.hostname
          FROM alerts a
     LEFT JOIN alert_rules ar ON ar.id = a.rule_id
     LEFT JOIN devices d      ON d.id  = a.device_id
         WHERE a.suppressed_by_alert_id = :pid
           AND a.status = 'suppressed'
         ORDER BY a.triggered_at DESC
         LIMIT 200
    """), {"pid": alert.id})).all()

    children = [
        SuppressedChildSummary(
            id=row.id, title=row.title, severity=row.severity,
            metric=row.metric, device_name=row.hostname,
            triggered_at=row.triggered_at,
        )
        for row in child_rows
    ]

    read = AlertRead.model_validate(alert)
    read.suppressed_child_count = len(child_rows)
    read.suppressed_children = children
    return read


@router.post("/alerts/{alert_id}/acknowledge", response_model=AlertRead, summary="Acknowledge an open alert")
async def acknowledge_alert(
    alert_id: uuid.UUID,
    request: Request,
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> AlertRead:
    alert = await _get_alert(alert_id, principal, db)
    if alert.device_id is not None:
        await assert_device_access(principal, alert.device_id, "operator", db)
    elif not principal.is_platform_admin and not _has_tenant_role(principal, "operator"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Requires operator access")
    current_user = principal.user

    if alert.status != "open":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Alert is already '{alert.status}'")

    now = datetime.now(timezone.utc)
    alert.status = "acknowledged"
    alert.acknowledged_at = now
    alert.acknowledged_by = current_user.id

    from ..audit import audit as _audit
    await _audit(db, action="ack_alert", resource_type="alert",
                 resource_id=alert.id, new_value={"title": alert.title},
                 user=current_user, request=request)
    await db.commit()
    await db.refresh(alert)
    await alert_ws_manager.broadcast(principal.active_tenant_id, {"event": "alerts_changed"})
    logger.info("alert_acknowledged", alert_id=str(alert_id), by=str(current_user.id))
    return AlertRead.model_validate(alert)


@router.post("/alerts/{alert_id}/resolve", response_model=AlertRead, summary="Manually resolve an alert")
async def resolve_alert(
    alert_id: uuid.UUID,
    request: Request,
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> AlertRead:
    alert = await _get_alert(alert_id, principal, db)
    if alert.device_id is not None:
        await assert_device_access(principal, alert.device_id, "operator", db)
    elif not principal.is_platform_admin and not _has_tenant_role(principal, "operator"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Requires operator access")
    current_user = principal.user

    if alert.status == "resolved":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Alert is already resolved")

    now = datetime.now(timezone.utc)
    alert.status = "resolved"
    alert.resolved_at = now
    alert.resolved_by = current_user.id

    from ..audit import audit as _audit
    await _audit(db, action="resolve_alert", resource_type="alert",
                 resource_id=alert.id, new_value={"title": alert.title},
                 user=current_user, request=request)
    await db.commit()
    await db.refresh(alert)
    await alert_ws_manager.broadcast(principal.active_tenant_id, {"event": "alerts_changed"})
    logger.info("alert_resolved", alert_id=str(alert_id), by=str(current_user.id))
    return AlertRead.model_validate(alert)


# ── Bulk operations ───────────────────────────────────────────────────────────

@router.post("/alerts/bulk", summary="Bulk acknowledge or resolve alerts")
async def bulk_alert_action(
    body: AlertBulkRequest,
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if not principal.is_platform_admin and not _has_tenant_role(principal, "operator"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Requires operator access")

    alerts = (await db.execute(
        select(Alert).where(
            Alert.id.in_(body.alert_ids),
            Alert.tenant_id == principal.active_tenant_id,
        )
    )).scalars().all()

    now = datetime.now(timezone.utc)
    updated = 0
    for alert in alerts:
        if body.action.value == "acknowledge" and alert.status == "open":
            alert.status = "acknowledged"
            alert.acknowledged_at = now
            alert.acknowledged_by = principal.user.id
            updated += 1
        elif body.action.value == "resolve" and alert.status in ("open", "acknowledged"):
            alert.status = "resolved"
            alert.resolved_at = now
            alert.resolved_by = principal.user.id
            updated += 1

    await db.commit()
    await alert_ws_manager.broadcast(principal.active_tenant_id, {"event": "alerts_changed"})
    logger.info("bulk_alert_action", action=body.action.value, requested=len(body.alert_ids), updated=updated)
    return {"updated": updated}


# ── CSV Export ────────────────────────────────────────────────────────────────

@router.get("/alerts/export.csv", summary="Export alerts as CSV")
async def export_alerts_csv(
    alert_status: Optional[str] = Query(default=None, alias="status"),
    severity: Optional[str] = Query(default=None),
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
):
    import csv
    import io
    from fastapi.responses import Response

    q = select(Alert).where(
        Alert.tenant_id == principal.active_tenant_id,
        or_(Alert.device_id.is_(None), Alert.device_id.in_(accessible_device_ids_subquery(principal))),
    )
    if alert_status:
        q = q.where(Alert.status == alert_status)
    if severity:
        q = q.where(Alert.severity == severity)
    q = q.order_by(Alert.triggered_at.desc()).limit(50_000)

    alerts = (await db.execute(q)).scalars().all()

    device_ids = {a.device_id for a in alerts if a.device_id}
    device_names: dict[uuid.UUID, str] = {}
    if device_ids:
        from ..models.device import Device
        rows = (await db.execute(
            select(Device.id, Device.hostname).where(Device.id.in_(device_ids))
        )).all()
        device_names = {r.id: r.hostname for r in rows}

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Triggered", "Severity", "Status", "Title", "Device", "Message",
                "Acknowledged At", "Resolved At"])
    for a in alerts:
        w.writerow([
            a.triggered_at.isoformat() if a.triggered_at else "",
            a.severity,
            a.status,
            a.title or "",
            device_names.get(a.device_id, "") if a.device_id else "",
            a.message or "",
            a.acknowledged_at.isoformat() if a.acknowledged_at else "",
            a.resolved_at.isoformat() if a.resolved_at else "",
        ])

    fname = f"anthrimon-alerts-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.csv"
    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


# ── Alert Rules ────────────────────────────────────────────────────────────────

@router.get("/alert-rules", response_model=PaginatedResponse[AlertRuleRead], summary="List alert rules")
async def list_alert_rules(
    is_enabled: Optional[bool] = Query(default=None),
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PaginatedResponse[AlertRuleRead]:
    q = select(AlertRule).where(AlertRule.tenant_id == current_user.tenant_id)
    if is_enabled is not None:
        q = q.where(AlertRule.is_enabled == is_enabled)

    total = (await db.execute(select(func.count()).select_from(q.subquery()))).scalar_one()
    items = (await db.execute(q.order_by(AlertRule.name).limit(limit).offset(offset))).scalars().all()

    return PaginatedResponse(
        total=total, limit=limit, offset=offset,
        items=[AlertRuleRead.model_validate(r) for r in items],
    )


@router.post("/alert-rules", response_model=AlertRuleRead, status_code=status.HTTP_201_CREATED, summary="Create an alert rule")
async def create_alert_rule(
    body: AlertRuleCreate,
    request: Request,
    current_user: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> AlertRuleRead:
    _validate_alert_rule_body(body)
    rule = AlertRule(
        tenant_id=current_user.tenant_id,
        **body.model_dump(mode='json', exclude_none=True),
    )
    db.add(rule)
    await db.flush()
    from ..audit import audit as _audit
    await _audit(db, action="create", resource_type="alert_rule",
                 resource_id=rule.id,
                 new_value={"name": rule.name, "metric": rule.metric, "severity": rule.severity},
                 user=current_user, request=request)
    await db.commit()
    await db.refresh(rule)
    logger.info("alert_rule_created", rule_id=str(rule.id), name=rule.name)
    return AlertRuleRead.model_validate(rule)


@router.get("/alert-rules/{rule_id}", response_model=AlertRuleRead, summary="Get an alert rule")
async def get_alert_rule(
    rule_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AlertRuleRead:
    rule = await _get_rule(rule_id, current_user.tenant_id, db)
    return AlertRuleRead.model_validate(rule)


@router.patch("/alert-rules/{rule_id}", response_model=AlertRuleRead, summary="Update an alert rule")
async def update_alert_rule(
    rule_id: uuid.UUID,
    body: AlertRuleUpdate,
    request: Request,
    current_user: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> AlertRuleRead:
    _validate_alert_rule_body(body)
    rule = await _get_rule(rule_id, current_user.tenant_id, db)
    before = {"name": rule.name, "metric": rule.metric, "severity": rule.severity,
              "threshold": rule.threshold, "is_enabled": rule.is_enabled}

    for field, value in body.model_dump(mode='json', exclude_none=True).items():
        setattr(rule, field, value)

    after = {"name": rule.name, "metric": rule.metric, "severity": rule.severity,
             "threshold": rule.threshold, "is_enabled": rule.is_enabled}
    from ..audit import audit as _audit
    await _audit(db, action="update", resource_type="alert_rule",
                 resource_id=rule.id, old_value=before, new_value=after,
                 user=current_user, request=request)
    await db.commit()
    await db.refresh(rule)
    return AlertRuleRead.model_validate(rule)


@router.delete("/alert-rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None, summary="Delete an alert rule")
async def delete_alert_rule(
    rule_id: uuid.UUID,
    request: Request,
    current_user: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> None:
    rule = await _get_rule(rule_id, current_user.tenant_id, db)
    from ..audit import audit as _audit
    await _audit(db, action="delete", resource_type="alert_rule",
                 resource_id=rule.id, old_value={"name": rule.name, "metric": rule.metric},
                 user=current_user, request=request)
    await db.delete(rule)
    await db.commit()
    logger.info("alert_rule_deleted", rule_id=str(rule_id))


# ── Comments ───────────────────────────────────────────────────────────────────

@router.get("/alerts/{alert_id}/comments", summary="List comments on an alert")
async def list_comments(
    alert_id: uuid.UUID,
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    alert = await _get_alert(alert_id, principal, db)
    if alert.device_id is not None:
        await assert_device_access(principal, alert.device_id, "readonly", db)
    rows = (await db.execute(
        select(AlertComment, User)
        .join(User, User.id == AlertComment.user_id)
        .where(AlertComment.alert_id == alert_id)
        .order_by(AlertComment.created_at)
    )).all()
    return [
        {
            "id":         str(c.id),
            "body":       c.body,
            "author":     u.username,
            "user_id":    str(c.user_id),
            "created_at": c.created_at.isoformat(),
            "updated_at": c.updated_at.isoformat() if c.updated_at else None,
        }
        for c, u in rows
    ]


@router.post("/alerts/{alert_id}/comments", status_code=status.HTTP_201_CREATED,
             summary="Add a comment to an alert")
async def add_comment(
    alert_id: uuid.UUID,
    body: dict,
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> dict:
    text = (body.get("body") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Comment body cannot be empty")
    alert = await _get_alert(alert_id, principal, db)
    if alert.device_id is not None:
        await assert_device_access(principal, alert.device_id, "operator", db)
    elif not principal.is_platform_admin and not _has_tenant_role(principal, "operator"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Requires operator access")
    current_user = principal.user
    comment = AlertComment(
        alert_id=alert_id,
        tenant_id=principal.active_tenant_id,
        user_id=current_user.id,
        body=text,
    )
    db.add(comment)
    await db.commit()
    await db.refresh(comment)
    return {
        "id":         str(comment.id),
        "body":       comment.body,
        "author":     current_user.username,
        "created_at": comment.created_at.isoformat(),
        "updated_at": None,
    }


@router.patch("/alerts/{alert_id}/comments/{comment_id}",
              summary="Edit a comment on an alert")
async def edit_comment(
    alert_id: uuid.UUID,
    comment_id: uuid.UUID,
    body: dict,
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> dict:
    new_text = (body.get("body") or "").strip()
    if not new_text:
        raise HTTPException(status_code=400, detail="Comment body cannot be empty")
    alert = await _get_alert(alert_id, principal, db)
    comment = (await db.execute(
        select(AlertComment).where(
            AlertComment.id == comment_id,
            AlertComment.alert_id == alert_id,
            AlertComment.tenant_id == principal.active_tenant_id,
        )
    )).scalar_one_or_none()
    if comment is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Comment not found")
    if comment.user_id != principal.user.id and not principal.is_platform_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Can only edit your own comments")
    comment.body = new_text
    comment.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(comment)
    author = (await db.execute(
        select(User.username).where(User.id == comment.user_id)
    )).scalar_one()
    return {
        "id":         str(comment.id),
        "body":       comment.body,
        "author":     author,
        "created_at": comment.created_at.isoformat(),
        "updated_at": comment.updated_at.isoformat() if comment.updated_at else None,
    }


@router.delete("/alerts/{alert_id}/comments/{comment_id}",
               status_code=status.HTTP_204_NO_CONTENT,
               response_model=None,
               summary="Delete a comment on an alert")
async def delete_comment(
    alert_id: uuid.UUID,
    comment_id: uuid.UUID,
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> None:
    await _get_alert(alert_id, principal, db)
    comment = (await db.execute(
        select(AlertComment).where(
            AlertComment.id == comment_id,
            AlertComment.alert_id == alert_id,
            AlertComment.tenant_id == principal.active_tenant_id,
        )
    )).scalar_one_or_none()
    if comment is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Comment not found")
    if comment.user_id != principal.user.id and not principal.is_platform_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Can only delete your own comments")
    await db.delete(comment)
    await db.commit()


# ── Internal helpers ───────────────────────────────────────────────────────────

async def _get_alert(alert_id: uuid.UUID, principal: Principal, db: AsyncSession) -> Alert:
    result = await db.execute(
        select(Alert).where(Alert.id == alert_id, Alert.tenant_id == principal.active_tenant_id)
    )
    alert = result.scalar_one_or_none()
    if alert is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Alert not found")
    return alert


async def _get_rule(rule_id: uuid.UUID, tenant_id: uuid.UUID, db: AsyncSession) -> AlertRule:
    result = await db.execute(
        select(AlertRule).where(AlertRule.id == rule_id, AlertRule.tenant_id == tenant_id)
    )
    rule = result.scalar_one_or_none()
    if rule is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Alert rule not found")
    return rule
