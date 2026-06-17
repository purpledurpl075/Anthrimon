"""Saved views — per-user (optionally tenant-shared) bookmarks of a page's
filter state, stored as a raw URL query string."""
from __future__ import annotations

import uuid
from typing import Optional

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import Principal, get_current_principal, get_db
from ..models.saved_view import SavedView
from ..models.tenant import User
from ..schemas.saved_view import SavedViewCreate, SavedViewRead

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/saved-views", tags=["saved-views"])

_SHARE_ROLES = {"tenant_admin", "operator"}


@router.get("", response_model=list[SavedViewRead], summary="List saved views for a page")
async def list_saved_views(
    page: str = Query(...),
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> list[SavedViewRead]:
    rows = (await db.execute(
        select(SavedView).where(
            SavedView.tenant_id == principal.active_tenant_id,
            SavedView.page == page,
            or_(SavedView.user_id == principal.user.id, SavedView.is_shared.is_(True)),
        ).order_by(SavedView.name)
    )).scalars().all()

    owner_ids = {r.user_id for r in rows}
    owner_names: dict[uuid.UUID, str] = {}
    if owner_ids:
        users = (await db.execute(
            select(User.id, User.username).where(User.id.in_(owner_ids))
        )).all()
        owner_names = {u.id: u.username for u in users}

    out = []
    for r in rows:
        read = SavedViewRead.model_validate(r)
        read.owner_name = owner_names.get(r.user_id)
        out.append(read)
    return out


@router.post("", response_model=SavedViewRead, status_code=status.HTTP_201_CREATED,
              summary="Save the current filter state as a named view")
async def create_saved_view(
    body: SavedViewCreate,
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> SavedViewRead:
    if body.is_shared and principal.tenant_role not in _SHARE_ROLES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only operators and tenant admins can share views with the tenant",
        )

    view = SavedView(
        tenant_id=principal.active_tenant_id,
        user_id=principal.user.id,
        page=body.page,
        name=body.name,
        query=body.query,
        is_shared=body.is_shared,
    )
    db.add(view)
    try:
        await db.commit()
    except Exception as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A saved view named '{body.name}' already exists for this page",
        ) from exc

    read = SavedViewRead.model_validate(view)
    read.owner_name = principal.user.username
    return read


@router.delete("/{view_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None, summary="Delete a saved view")
async def delete_saved_view(
    view_id: uuid.UUID,
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> None:
    view: Optional[SavedView] = (await db.execute(
        select(SavedView).where(
            SavedView.id == view_id,
            SavedView.tenant_id == principal.active_tenant_id,
            SavedView.user_id == principal.user.id,
        )
    )).scalar_one_or_none()
    if view is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Saved view not found")

    await db.delete(view)
    await db.commit()
