from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

import bcrypt as _bcrypt
import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, EmailStr
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import Principal, get_db, require_platform
from ..models.settings import PlatformSetting
from ..models.tenant import Tenant, User, UserTenantAccess

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/platform", tags=["platform"])

_PLATFORM_ADMIN = require_platform("platform_admin")

_VALID_ROLES          = {"readonly", "operator", "admin"}
_VALID_PLATFORM_ROLES = {"platform_admin", "platform_support"}


def _hash(plain: str) -> str:
    return _bcrypt.hashpw(plain.encode(), _bcrypt.gensalt(rounds=12)).decode()


# ── Platform settings ──────────────────────────────────────────────────────────

_PLATFORM_GLOBAL_DEFAULTS: dict = {
    "wg_public_endpoint":    "",
    "session_timeout_hours": 24,
}


class PlatformGlobalSettingsRead(BaseModel):
    wg_public_endpoint:    str = ""
    session_timeout_hours: int = 24


class PlatformGlobalSettingsWrite(BaseModel):
    wg_public_endpoint:    str = ""
    session_timeout_hours: int = 24


async def _load_platform_global(db: AsyncSession) -> dict:
    rows = (await db.execute(
        select(PlatformSetting).where(
            PlatformSetting.key.in_(list(_PLATFORM_GLOBAL_DEFAULTS.keys()))
        )
    )).scalars().all()
    stored = {r.key: r.value for r in rows}
    result = dict(_PLATFORM_GLOBAL_DEFAULTS)
    for k in result:
        if k in stored:
            v = stored[k]
            result[k] = v if not isinstance(v, dict) else v.get("value", result[k])
    return result


@router.get("/settings", response_model=PlatformGlobalSettingsRead,
            summary="Get platform-level global settings")
async def get_platform_global_settings(
    _: Principal = Depends(_PLATFORM_ADMIN),
    db: AsyncSession = Depends(get_db),
) -> PlatformGlobalSettingsRead:
    cfg = await _load_platform_global(db)
    return PlatformGlobalSettingsRead(**cfg)


@router.put("/settings", response_model=PlatformGlobalSettingsRead,
            summary="Update platform-level global settings")
async def update_platform_global_settings(
    body: PlatformGlobalSettingsWrite,
    _: Principal = Depends(_PLATFORM_ADMIN),
    db: AsyncSession = Depends(get_db),
) -> PlatformGlobalSettingsRead:
    updates = {
        "wg_public_endpoint":    body.wg_public_endpoint,
        "session_timeout_hours": body.session_timeout_hours,
    }
    for key, val in updates.items():
        row = (await db.execute(
            select(PlatformSetting).where(PlatformSetting.key == key)
        )).scalar_one_or_none()
        if row:
            row.value = val
            row.updated_at = datetime.now(timezone.utc)
        else:
            db.add(PlatformSetting(key=key, value=val))
    await db.commit()
    logger.info("platform_global_settings_updated")
    return PlatformGlobalSettingsRead(**updates)


# ── Tenant management ──────────────────────────────────────────────────────────

class TenantRead(BaseModel):
    id:            uuid.UUID
    name:          str
    slug:          str
    is_active:     bool
    user_count:    int = 0
    created_at:    Optional[datetime] = None


class TenantCreate(BaseModel):
    name:     str
    slug:     str
    is_active: bool = True


class TenantUpdate(BaseModel):
    name:     Optional[str] = None
    is_active: Optional[bool] = None


@router.get("/tenants", response_model=list[TenantRead], summary="List all tenants")
async def list_tenants(
    _: Principal = Depends(_PLATFORM_ADMIN),
    db: AsyncSession = Depends(get_db),
) -> list[TenantRead]:
    rows = (await db.execute(
        select(
            Tenant.id, Tenant.name, Tenant.slug, Tenant.is_active, Tenant.created_at,
            func.count(User.id).label("user_count"),
        )
        .outerjoin(User, User.tenant_id == Tenant.id)
        .group_by(Tenant.id)
        .order_by(Tenant.name)
    )).all()
    return [TenantRead(id=r.id, name=r.name, slug=r.slug, is_active=r.is_active,
                       user_count=r.user_count, created_at=r.created_at) for r in rows]


@router.post("/tenants", response_model=TenantRead, status_code=201, summary="Create a tenant")
async def create_tenant(
    body: TenantCreate,
    _: Principal = Depends(_PLATFORM_ADMIN),
    db: AsyncSession = Depends(get_db),
) -> TenantRead:
    existing = (await db.execute(
        select(Tenant).where(Tenant.slug == body.slug.strip().lower())
    )).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="Slug already in use")
    tenant = Tenant(
        name=body.name.strip(),
        slug=body.slug.strip().lower(),
        is_active=body.is_active,
    )
    db.add(tenant)
    await db.commit()
    await db.refresh(tenant)
    logger.info("tenant_created", tenant_id=str(tenant.id), slug=tenant.slug)
    return TenantRead(id=tenant.id, name=tenant.name, slug=tenant.slug,
                      is_active=tenant.is_active, user_count=0, created_at=tenant.created_at)


@router.get("/tenants/{tenant_id}", response_model=TenantRead, summary="Get a tenant")
async def get_tenant(
    tenant_id: uuid.UUID,
    _: Principal = Depends(_PLATFORM_ADMIN),
    db: AsyncSession = Depends(get_db),
) -> TenantRead:
    row = (await db.execute(
        select(
            Tenant.id, Tenant.name, Tenant.slug, Tenant.is_active, Tenant.created_at,
            func.count(User.id).label("user_count"),
        )
        .outerjoin(User, User.tenant_id == Tenant.id)
        .where(Tenant.id == tenant_id)
        .group_by(Tenant.id)
    )).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    return TenantRead(id=row.id, name=row.name, slug=row.slug, is_active=row.is_active,
                      user_count=row.user_count, created_at=row.created_at)


@router.patch("/tenants/{tenant_id}", response_model=TenantRead, summary="Update a tenant")
async def update_tenant(
    tenant_id: uuid.UUID,
    body: TenantUpdate,
    _: Principal = Depends(_PLATFORM_ADMIN),
    db: AsyncSession = Depends(get_db),
) -> TenantRead:
    tenant = (await db.execute(
        select(Tenant).where(Tenant.id == tenant_id)
    )).scalar_one_or_none()
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    if body.name is not None:
        tenant.name = body.name.strip()
    if body.is_active is not None:
        tenant.is_active = body.is_active
    await db.commit()
    await db.refresh(tenant)
    user_count = (await db.execute(
        select(func.count(User.id)).where(User.tenant_id == tenant.id)
    )).scalar_one()
    logger.info("tenant_updated", tenant_id=str(tenant.id))
    return TenantRead(id=tenant.id, name=tenant.name, slug=tenant.slug,
                      is_active=tenant.is_active, user_count=user_count,
                      created_at=tenant.created_at)


# ── Platform users ─────────────────────────────────────────────────────────────

class PlatformUserRead(BaseModel):
    id:               uuid.UUID
    username:         str
    email:            str
    full_name:        Optional[str] = None
    role:             str
    is_platform_admin: bool
    platform_role:    Optional[str] = None
    tenant_id:        uuid.UUID
    tenant_name:      str
    is_active:        bool
    last_login:       Optional[datetime] = None


@router.get("/users", response_model=list[PlatformUserRead], summary="List all platform users")
async def list_platform_users(
    tenant_id: Optional[uuid.UUID] = Query(default=None, description="Filter by tenant"),
    platform_only: bool = Query(default=False, description="Only platform-role users"),
    _: Principal = Depends(_PLATFORM_ADMIN),
    db: AsyncSession = Depends(get_db),
) -> list[PlatformUserRead]:
    q = (
        select(User, Tenant.name.label("tenant_name"))
        .join(Tenant, Tenant.id == User.tenant_id)
        .order_by(Tenant.name, User.username)
    )
    if tenant_id:
        q = q.where(User.tenant_id == tenant_id)
    if platform_only:
        q = q.where(User.is_platform_admin == True)  # noqa: E712

    rows = (await db.execute(q)).all()
    return [
        PlatformUserRead(
            id=r.User.id,
            username=r.User.username,
            email=r.User.email,
            full_name=r.User.full_name,
            role=r.User.role,
            is_platform_admin=r.User.is_platform_admin,
            platform_role=r.User.platform_role,
            tenant_id=r.User.tenant_id,
            tenant_name=r.tenant_name,
            is_active=r.User.is_active,
            last_login=r.User.last_login,
        )
        for r in rows
    ]


class PlatformUserCreate(BaseModel):
    tenant_id:         uuid.UUID
    username:          str
    email:             EmailStr
    password:          str
    full_name:         Optional[str] = None
    role:              str = "readonly"
    is_platform_admin: bool = False
    platform_role:     Optional[str] = None


class PlatformUserUpdate(BaseModel):
    email:             Optional[EmailStr] = None
    full_name:         Optional[str]      = None
    role:              Optional[str]      = None
    is_active:         Optional[bool]     = None
    is_platform_admin: Optional[bool]     = None
    platform_role:     Optional[str]      = None


class PlatformPasswordReset(BaseModel):
    new_password: str


async def _get_platform_user(user_id: uuid.UUID, db: AsyncSession) -> tuple[User, str]:
    """Return (user, tenant_name) or raise 404."""
    row = (await db.execute(
        select(User, Tenant.name.label("tenant_name"))
        .join(Tenant, Tenant.id == User.tenant_id)
        .where(User.id == user_id)
    )).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="User not found")
    return row.User, row.tenant_name


def _to_platform_user_read(user: User, tenant_name: str) -> PlatformUserRead:
    return PlatformUserRead(
        id=user.id, username=user.username, email=user.email,
        full_name=user.full_name, role=user.role,
        is_platform_admin=user.is_platform_admin, platform_role=user.platform_role,
        tenant_id=user.tenant_id, tenant_name=tenant_name,
        is_active=user.is_active, last_login=user.last_login,
    )


@router.post("/users", response_model=PlatformUserRead, status_code=201, summary="Create a user in any tenant")
async def create_platform_user(
    body: PlatformUserCreate,
    _: Principal = Depends(_PLATFORM_ADMIN),
    db: AsyncSession = Depends(get_db),
) -> PlatformUserRead:
    if not (await db.execute(select(Tenant).where(Tenant.id == body.tenant_id))).scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Tenant not found")
    if body.role not in _VALID_ROLES:
        raise HTTPException(status_code=422, detail=f"Role must be one of: {sorted(_VALID_ROLES)}")
    if body.platform_role and body.platform_role not in _VALID_PLATFORM_ROLES:
        raise HTTPException(status_code=422, detail=f"platform_role must be one of: {sorted(_VALID_PLATFORM_ROLES)}")
    if len(body.password) < 8:
        raise HTTPException(status_code=422, detail="Password must be at least 8 characters")
    if (await db.execute(
        select(User).where(User.tenant_id == body.tenant_id, User.username == body.username)
    )).scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Username already exists in that tenant")

    user = User(
        tenant_id=body.tenant_id,
        username=body.username,
        email=body.email,
        password_hash=_hash(body.password),
        full_name=body.full_name,
        role=body.role,
        is_active=True,
        is_platform_admin=body.is_platform_admin,
        platform_role=body.platform_role if body.is_platform_admin else None,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    tenant_name = (await db.execute(select(Tenant.name).where(Tenant.id == body.tenant_id))).scalar_one()
    logger.info("platform_user_created", username=body.username, tenant_id=str(body.tenant_id))
    return _to_platform_user_read(user, tenant_name)


@router.get("/users/{user_id}", response_model=PlatformUserRead, summary="Get a user")
async def get_platform_user(
    user_id: uuid.UUID,
    _: Principal = Depends(_PLATFORM_ADMIN),
    db: AsyncSession = Depends(get_db),
) -> PlatformUserRead:
    user, tenant_name = await _get_platform_user(user_id, db)
    return _to_platform_user_read(user, tenant_name)


@router.patch("/users/{user_id}", response_model=PlatformUserRead, summary="Update a user")
async def update_platform_user(
    user_id: uuid.UUID,
    body: PlatformUserUpdate,
    _: Principal = Depends(_PLATFORM_ADMIN),
    db: AsyncSession = Depends(get_db),
) -> PlatformUserRead:
    user, tenant_name = await _get_platform_user(user_id, db)

    if body.role is not None:
        if body.role not in _VALID_ROLES:
            raise HTTPException(status_code=422, detail=f"Role must be one of: {sorted(_VALID_ROLES)}")
        user.role = body.role
    if body.is_active is not None:
        user.is_active = body.is_active
    if body.email is not None:
        user.email = body.email
    if body.full_name is not None:
        user.full_name = body.full_name
    if body.is_platform_admin is not None:
        user.is_platform_admin = body.is_platform_admin
        if not body.is_platform_admin:
            user.platform_role = None
    if body.platform_role is not None:
        if body.platform_role not in _VALID_PLATFORM_ROLES:
            raise HTTPException(status_code=422, detail=f"platform_role must be one of: {sorted(_VALID_PLATFORM_ROLES)}")
        user.platform_role = body.platform_role

    await db.commit()
    await db.refresh(user)
    logger.info("platform_user_updated", user_id=str(user_id))
    return _to_platform_user_read(user, tenant_name)


@router.delete("/users/{user_id}", status_code=204, response_model=None, summary="Delete a user")
async def delete_platform_user(
    user_id: uuid.UUID,
    principal: Principal = Depends(_PLATFORM_ADMIN),
    db: AsyncSession = Depends(get_db),
) -> Response:
    if user_id == principal.user.id:
        raise HTTPException(status_code=403, detail="Cannot delete your own account")
    user, _ = await _get_platform_user(user_id, db)
    await db.delete(user)
    await db.commit()
    logger.info("platform_user_deleted", user_id=str(user_id))
    return Response(status_code=204)


@router.post("/users/{user_id}/reset-password", status_code=204, response_model=None, summary="Reset a user's password")
async def reset_platform_user_password(
    user_id: uuid.UUID,
    body: PlatformPasswordReset,
    _: Principal = Depends(_PLATFORM_ADMIN),
    db: AsyncSession = Depends(get_db),
) -> Response:
    user, _ = await _get_platform_user(user_id, db)
    if len(body.new_password) < 8:
        raise HTTPException(status_code=422, detail="Password must be at least 8 characters")
    user.password_hash = _hash(body.new_password)
    await db.commit()
    logger.info("platform_password_reset", user_id=str(user_id))
    return Response(status_code=204)


# ── User tenant-access management ─────────────────────────────────────────────

class TenantAccessEntry(BaseModel):
    tenant_id:   uuid.UUID
    tenant_name: str
    role:        str
    is_home:     bool = False


@router.get("/users/{user_id}/tenant-access",
            response_model=list[TenantAccessEntry],
            summary="List tenants a user can access")
async def get_user_tenant_access(
    user_id: uuid.UUID,
    _: Principal = Depends(_PLATFORM_ADMIN),
    db: AsyncSession = Depends(get_db),
) -> list[TenantAccessEntry]:
    user, home_tenant_name = await _get_platform_user(user_id, db)

    grants = (await db.execute(
        select(UserTenantAccess, Tenant.name.label("tenant_name"))
        .join(Tenant, Tenant.id == UserTenantAccess.tenant_id)
        .where(UserTenantAccess.user_id == user_id)
        .order_by(Tenant.name)
    )).all()

    result = [TenantAccessEntry(
        tenant_id=user.tenant_id,
        tenant_name=home_tenant_name,
        role=user.role,
        is_home=True,
    )]
    for g, tname in grants:
        result.append(TenantAccessEntry(
            tenant_id=g.tenant_id,
            tenant_name=tname,
            role=g.role,
            is_home=False,
        ))
    return result


class TenantAccessWrite(BaseModel):
    tenant_id: uuid.UUID
    role:      str


@router.put("/users/{user_id}/tenant-access",
            response_model=list[TenantAccessEntry],
            summary="Replace a user's additional tenant grants")
async def set_user_tenant_access(
    user_id: uuid.UUID,
    body: list[TenantAccessWrite],
    _: Principal = Depends(_PLATFORM_ADMIN),
    db: AsyncSession = Depends(get_db),
) -> list[TenantAccessEntry]:
    user, home_tenant_name = await _get_platform_user(user_id, db)

    for entry in body:
        if entry.role not in _VALID_ROLES:
            raise HTTPException(status_code=422, detail=f"Role must be one of: {sorted(_VALID_ROLES)}")
        if entry.tenant_id == user.tenant_id:
            raise HTTPException(status_code=422, detail="Home tenant access is implicit; do not include it in grants")
        tenant = (await db.execute(
            select(Tenant).where(Tenant.id == entry.tenant_id)
        )).scalar_one_or_none()
        if tenant is None:
            raise HTTPException(status_code=404, detail=f"Tenant {entry.tenant_id} not found")

    # Replace all existing grants
    await db.execute(
        UserTenantAccess.__table__.delete().where(UserTenantAccess.user_id == user_id)
    )
    for entry in body:
        db.add(UserTenantAccess(user_id=user_id, tenant_id=entry.tenant_id, role=entry.role))

    await db.commit()
    logger.info("user_tenant_access_updated", user_id=str(user_id), grant_count=len(body))

    # Return the full list (home + new grants)
    grants = (await db.execute(
        select(UserTenantAccess, Tenant.name.label("tenant_name"))
        .join(Tenant, Tenant.id == UserTenantAccess.tenant_id)
        .where(UserTenantAccess.user_id == user_id)
        .order_by(Tenant.name)
    )).all()

    result = [TenantAccessEntry(
        tenant_id=user.tenant_id,
        tenant_name=home_tenant_name,
        role=user.role,
        is_home=True,
    )]
    for g, tname in grants:
        result.append(TenantAccessEntry(
            tenant_id=g.tenant_id,
            tenant_name=tname,
            role=g.role,
            is_home=False,
        ))
    return result
