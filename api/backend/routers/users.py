from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

import bcrypt as _bcrypt
import structlog
from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, EmailStr
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_db, require_tenant_user
from ..models.site import Site
from ..models.tenant import User, UserSiteRole

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/users", tags=["users"])

VALID_ROLES      = {"readonly", "operator", "admin"}
SITE_VALID_ROLES = {"readonly", "operator", "admin"}


def _hash(plain: str) -> str:
    return _bcrypt.hashpw(plain.encode(), _bcrypt.gensalt(rounds=12)).decode()


# ── Schemas ────────────────────────────────────────────────────────────────────

class UserRead(BaseModel):
    model_config = {"from_attributes": True}

    id:                uuid.UUID
    username:          str
    email:             str
    full_name:         Optional[str]
    role:              str
    is_active:         bool
    is_platform_admin: bool
    last_login:        Optional[datetime]
    created_at:        datetime


class UserCreate(BaseModel):
    username:  str
    email:     EmailStr
    password:  str
    full_name: Optional[str] = None
    role:      str = "readonly"


class UserUpdate(BaseModel):
    email:     Optional[EmailStr] = None
    full_name: Optional[str]      = None
    role:      Optional[str]      = None
    is_active: Optional[bool]     = None


class PasswordReset(BaseModel):
    new_password: str


class SiteRoleEntry(BaseModel):
    site_id: uuid.UUID
    role:    str


class UserSiteRoleRead(BaseModel):
    site_id:   uuid.UUID
    site_name: str
    role:      str


# ── Helpers ────────────────────────────────────────────────────────────────────

async def _get_user(user_id: uuid.UUID, tenant_id: uuid.UUID, db: AsyncSession) -> User:
    user = (await db.execute(
        select(User).where(User.id == user_id, User.tenant_id == tenant_id)
    )).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


async def _last_admin_check(tenant_id: uuid.UUID, exclude_id: uuid.UUID, db: AsyncSession) -> None:
    """Raise 400 if removing/demoting exclude_id would leave no active admins in the tenant."""
    count = (await db.execute(
        select(func.count()).where(
            User.tenant_id == tenant_id,
            User.role.in_(["admin", "superadmin"]),
            User.is_active == True,  # noqa: E712
            User.id != exclude_id,
        )
    )).scalar_one()
    if count == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot remove the last admin from this tenant",
        )


async def _fetch_site_roles(user_id: uuid.UUID, tenant_id: uuid.UUID, db: AsyncSession) -> list[UserSiteRoleRead]:
    rows = (await db.execute(
        select(UserSiteRole.site_id, UserSiteRole.role, Site.name)
        .join(Site, UserSiteRole.site_id == Site.id)
        .where(UserSiteRole.user_id == user_id, UserSiteRole.tenant_id == tenant_id)
        .order_by(Site.name)
    )).all()
    return [UserSiteRoleRead(site_id=r.site_id, site_name=r.name, role=r.role) for r in rows]


# ── User CRUD ──────────────────────────────────────────────────────────────────

@router.get("", response_model=list[UserRead], summary="List users in tenant")
async def list_users(
    current_user: User = Depends(require_tenant_user("tenant_admin")),
    db: AsyncSession = Depends(get_db),
) -> list[UserRead]:
    result = await db.execute(
        select(User).where(User.tenant_id == current_user.tenant_id).order_by(User.username)
    )
    return [UserRead.model_validate(u) for u in result.scalars().all()]


@router.post("", response_model=UserRead, status_code=201, summary="Create a user")
async def create_user(
    body: UserCreate,
    current_user: User = Depends(require_tenant_user("tenant_admin")),
    db: AsyncSession = Depends(get_db),
) -> UserRead:
    if body.role not in VALID_ROLES:
        raise HTTPException(status_code=422, detail=f"Role must be one of: {sorted(VALID_ROLES)}")
    if len(body.password) < 8:
        raise HTTPException(status_code=422, detail="Password must be at least 8 characters")
    if (await db.execute(
        select(User).where(User.tenant_id == current_user.tenant_id, User.username == body.username)
    )).scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Username already exists in this tenant")

    user = User(
        tenant_id=current_user.tenant_id,
        username=body.username,
        email=body.email,
        password_hash=_hash(body.password),
        full_name=body.full_name,
        role=body.role,
        is_active=True,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    logger.info("user_created", username=body.username, role=body.role, by=str(current_user.id))
    return UserRead.model_validate(user)


@router.get("/{user_id}", response_model=UserRead, summary="Get a user")
async def get_user(
    user_id: uuid.UUID,
    current_user: User = Depends(require_tenant_user("tenant_admin")),
    db: AsyncSession = Depends(get_db),
) -> UserRead:
    return UserRead.model_validate(await _get_user(user_id, current_user.tenant_id, db))


@router.patch("/{user_id}", response_model=UserRead, summary="Update a user")
async def update_user(
    user_id: uuid.UUID,
    body: UserUpdate,
    current_user: User = Depends(require_tenant_user("tenant_admin")),
    db: AsyncSession = Depends(get_db),
) -> UserRead:
    user = await _get_user(user_id, current_user.tenant_id, db)

    if body.role is not None:
        if user.id == current_user.id:
            raise HTTPException(status_code=403, detail="Cannot change your own role")
        if body.role not in VALID_ROLES:
            raise HTTPException(status_code=422, detail=f"Role must be one of: {sorted(VALID_ROLES)}")
        # Demoting last admin guard
        if user.role in ("admin", "superadmin") and body.role not in ("admin", "superadmin"):
            await _last_admin_check(current_user.tenant_id, user_id, db)
        user.role = body.role

    if body.is_active is not None:
        if user.id == current_user.id and not body.is_active:
            raise HTTPException(status_code=403, detail="Cannot deactivate your own account")
        if not body.is_active and user.role in ("admin", "superadmin"):
            await _last_admin_check(current_user.tenant_id, user_id, db)
        user.is_active = body.is_active

    if body.email is not None:
        user.email = body.email
    if body.full_name is not None:
        user.full_name = body.full_name

    await db.commit()
    await db.refresh(user)
    logger.info("user_updated", target_user=str(user_id), by=str(current_user.id))
    return UserRead.model_validate(user)


@router.delete("/{user_id}", status_code=204, response_model=None, summary="Delete a user")
async def delete_user(
    user_id: uuid.UUID,
    current_user: User = Depends(require_tenant_user("tenant_admin")),
    db: AsyncSession = Depends(get_db),
) -> Response:
    if user_id == current_user.id:
        raise HTTPException(status_code=403, detail="Cannot delete your own account")
    user = await _get_user(user_id, current_user.tenant_id, db)
    if user.role in ("admin", "superadmin"):
        await _last_admin_check(current_user.tenant_id, user_id, db)
    await db.delete(user)
    await db.commit()
    logger.info("user_deleted", target_user=str(user_id), by=str(current_user.id))
    return Response(status_code=204)


@router.post("/{user_id}/reset-password", status_code=204, response_model=None, summary="Reset a user's password")
async def reset_password(
    user_id: uuid.UUID,
    body: PasswordReset,
    current_user: User = Depends(require_tenant_user("tenant_admin")),
    db: AsyncSession = Depends(get_db),
) -> Response:
    user = await _get_user(user_id, current_user.tenant_id, db)
    if len(body.new_password) < 8:
        raise HTTPException(status_code=422, detail="Password must be at least 8 characters")
    user.password_hash = _hash(body.new_password)
    await db.commit()
    logger.info("password_reset", target_user=str(user_id), by=str(current_user.id))
    return Response(status_code=204)


# ── Site-role management ───────────────────────────────────────────────────────

@router.get("/{user_id}/site-roles", response_model=list[UserSiteRoleRead], summary="Get site-role grants for a user")
async def get_user_site_roles(
    user_id: uuid.UUID,
    current_user: User = Depends(require_tenant_user("tenant_admin")),
    db: AsyncSession = Depends(get_db),
) -> list[UserSiteRoleRead]:
    await _get_user(user_id, current_user.tenant_id, db)
    return await _fetch_site_roles(user_id, current_user.tenant_id, db)


@router.put("/{user_id}/site-roles", response_model=list[UserSiteRoleRead], summary="Replace all site-role grants for a user")
async def set_user_site_roles(
    user_id: uuid.UUID,
    body: list[SiteRoleEntry],
    current_user: User = Depends(require_tenant_user("tenant_admin")),
    db: AsyncSession = Depends(get_db),
) -> list[UserSiteRoleRead]:
    await _get_user(user_id, current_user.tenant_id, db)

    for entry in body:
        if entry.role not in SITE_VALID_ROLES:
            raise HTTPException(status_code=422, detail=f"Invalid site role '{entry.role}'")
        if not (await db.execute(
            select(Site).where(Site.id == entry.site_id, Site.tenant_id == current_user.tenant_id)
        )).scalar_one_or_none():
            raise HTTPException(status_code=404, detail=f"Site {entry.site_id} not found in this tenant")

    await db.execute(
        delete(UserSiteRole).where(
            UserSiteRole.user_id == user_id,
            UserSiteRole.tenant_id == current_user.tenant_id,
        )
    )
    for entry in body:
        db.add(UserSiteRole(
            user_id=user_id, site_id=entry.site_id,
            tenant_id=current_user.tenant_id, role=entry.role,
        ))
    await db.commit()
    return await _fetch_site_roles(user_id, current_user.tenant_id, db)
