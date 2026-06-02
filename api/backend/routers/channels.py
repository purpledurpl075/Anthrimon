from __future__ import annotations

import uuid
from typing import Optional

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..alerting.notify import (
    _build_test_email, _load_smtp, _send_smtp,
    _test_slack, _test_webhook, _test_pagerduty, _test_teams,
    _log_send,
)
from ..dependencies import get_current_user, get_db, require_role
from ..models.alert import NotificationChannel, NotificationSendLog
from ..models.tenant import User
from ..schemas.alert import (
    NotificationChannelCreate, NotificationChannelRead, NotificationChannelUpdate,
    NotificationSendLogRead,
)
from ..schemas.common import PaginatedResponse

logger = structlog.get_logger(__name__)
router = APIRouter(tags=["notification-channels"])


@router.get("/notification-channels", response_model=PaginatedResponse[NotificationChannelRead])
async def list_channels(
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PaginatedResponse[NotificationChannelRead]:
    from sqlalchemy import func
    q = select(NotificationChannel).where(NotificationChannel.tenant_id == current_user.tenant_id)
    total = (await db.execute(select(func.count()).select_from(q.subquery()))).scalar_one()
    items = (await db.execute(q.order_by(NotificationChannel.name).limit(limit).offset(offset))).scalars().all()
    return PaginatedResponse(total=total, limit=limit, offset=offset,
                             items=[NotificationChannelRead.model_validate(c) for c in items])


@router.post("/notification-channels", response_model=NotificationChannelRead,
             status_code=status.HTTP_201_CREATED)
async def create_channel(
    body: NotificationChannelCreate,
    current_user: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> NotificationChannelRead:
    valid_types = {"email", "slack", "webhook", "pagerduty", "teams"}
    if body.type not in valid_types:
        raise HTTPException(status_code=400, detail=f"type must be one of: {', '.join(sorted(valid_types))}")

    channel = NotificationChannel(tenant_id=current_user.tenant_id, **body.model_dump())
    db.add(channel)
    await db.commit()
    await db.refresh(channel)
    logger.info("notification_channel_created", channel_id=str(channel.id), type=channel.type)
    return NotificationChannelRead.model_validate(channel)


@router.get("/notification-channels/{channel_id}", response_model=NotificationChannelRead)
async def get_channel(
    channel_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> NotificationChannelRead:
    return NotificationChannelRead.model_validate(await _get(channel_id, current_user.tenant_id, db))


@router.patch("/notification-channels/{channel_id}", response_model=NotificationChannelRead)
async def update_channel(
    channel_id: uuid.UUID,
    body: NotificationChannelUpdate,
    current_user: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> NotificationChannelRead:
    channel = await _get(channel_id, current_user.tenant_id, db)
    for field, value in body.model_dump(exclude_none=True).items():
        setattr(channel, field, value)
    await db.commit()
    await db.refresh(channel)
    return NotificationChannelRead.model_validate(channel)


@router.delete("/notification-channels/{channel_id}", status_code=status.HTTP_204_NO_CONTENT,
               response_model=None)
async def delete_channel(
    channel_id: uuid.UUID,
    current_user: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> None:
    channel = await _get(channel_id, current_user.tenant_id, db)
    await db.delete(channel)
    await db.commit()
    logger.info("notification_channel_deleted", channel_id=str(channel_id))


@router.post("/notification-channels/{channel_id}/test", status_code=status.HTTP_204_NO_CONTENT,
             response_model=None, summary="Send a test notification")
async def test_channel(
    channel_id: uuid.UUID,
    current_user: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> None:
    import asyncio

    channel = await _get(channel_id, current_user.tenant_id, db)
    if not channel.is_enabled:
        raise HTTPException(status_code=400, detail="Channel is disabled")

    from sqlalchemy import select as _select
    from ..models.settings import SystemSetting as _SS
    prow = (await db.execute(_select(_SS).where(_SS.key == "platform"))).scalar_one_or_none()
    platform_name: str = (prow.value.get("platform_name", "Anthrimon") if prow else "Anthrimon")

    try:
        if channel.type == "email":
            smtp = await _load_smtp(db)
            if smtp is None:
                raise HTTPException(status_code=400,
                    detail="SMTP server is not configured — set it in Administration > SMTP Server")
            recipients: list[str] = channel.config.get("to", [])
            if not recipients:
                raise HTTPException(status_code=400, detail="Channel has no recipients configured")
            subject, body = _build_test_email()
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, _send_smtp, smtp, recipients, subject, body)

        elif channel.type == "slack":
            webhook_url = channel.config.get("webhook_url", "")
            if not webhook_url:
                raise HTTPException(status_code=400, detail="Slack webhook URL is not configured")
            await _test_slack(webhook_url, platform_name)

        elif channel.type == "webhook":
            url = channel.config.get("url", "")
            if not url:
                raise HTTPException(status_code=400, detail="Webhook URL is not configured")
            await _test_webhook(url, channel.config.get("secret"), platform_name)

        elif channel.type == "pagerduty":
            key = channel.config.get("integration_key", "")
            if not key:
                raise HTTPException(status_code=400, detail="PagerDuty integration key is not configured")
            await _test_pagerduty(key, platform_name)

        elif channel.type == "teams":
            webhook_url = channel.config.get("webhook_url", "")
            if not webhook_url:
                raise HTTPException(status_code=400, detail="Teams webhook URL is not configured")
            await _test_teams(webhook_url, platform_name)

        else:
            raise HTTPException(status_code=400, detail=f"Test not supported for type '{channel.type}'")

        await _log_send(channel.id, channel.tenant_id, None, "test", "success", None, 1)

    except HTTPException:
        raise
    except Exception as exc:
        await _log_send(channel.id, channel.tenant_id, None, "test", "failure", str(exc), 1)
        raise HTTPException(status_code=502, detail=f"Test failed: {exc}") from exc


@router.get("/notification-channels/{channel_id}/send-log",
            response_model=list[NotificationSendLogRead])
async def get_channel_send_log(
    channel_id: uuid.UUID,
    limit: int = Query(default=50, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[NotificationSendLogRead]:
    await _get(channel_id, current_user.tenant_id, db)
    from sqlalchemy import desc
    rows = (await db.execute(
        select(NotificationSendLog)
        .where(NotificationSendLog.channel_id == channel_id)
        .order_by(desc(NotificationSendLog.sent_at))
        .limit(limit)
    )).scalars().all()
    return [NotificationSendLogRead.model_validate(r) for r in rows]


async def _get(channel_id: uuid.UUID, tenant_id: uuid.UUID, db: AsyncSession) -> NotificationChannel:
    result = await db.execute(
        select(NotificationChannel).where(
            NotificationChannel.id == channel_id,
            NotificationChannel.tenant_id == tenant_id,
        )
    )
    channel = result.scalar_one_or_none()
    if channel is None:
        raise HTTPException(status_code=404, detail="Notification channel not found")
    return channel
