from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request, status
import bcrypt as _bcrypt
import jwt as _jwt
from pydantic import BaseModel, EmailStr
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..dependencies import get_current_principal, get_current_user, get_db, Principal
from ..models.tenant import ApiToken, Tenant, User, UserSiteRole, UserTenantAccess
from ..models.site import Site

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])

_settings = get_settings()


def _hash_password(plain: str) -> str:
    return _bcrypt.hashpw(plain.encode(), _bcrypt.gensalt(rounds=12)).decode()


def _verify_password(plain: str, hashed: str) -> bool:
    return _bcrypt.checkpw(plain.encode(), hashed.encode())


# ── Request / response models ──────────────────────────────────────────────────

class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


class CreateApiTokenRequest(BaseModel):
    name: str
    scopes: list[str] = []
    site_ids: list[uuid.UUID] = []
    expires_days: Optional[int] = None


class ApiTokenResponse(BaseModel):
    id: uuid.UUID
    name: str
    token: str          # Only returned at creation — never stored in plain text.
    scopes: list
    site_ids: list[uuid.UUID] = []
    expires_at: Optional[datetime] = None
    created_at: datetime


class SiteMembership(BaseModel):
    site_id: uuid.UUID
    site_name: str
    role: str


class MeResponse(BaseModel):
    id: uuid.UUID
    username: str
    email: str
    full_name: Optional[str]
    role: str
    is_platform_admin: bool = False
    platform_role: Optional[str] = None
    tenant_id: uuid.UUID
    tenant_name: str
    site_memberships: list[SiteMembership] = []


class TenantSummary(BaseModel):
    id: uuid.UUID
    name: str
    slug: str
    is_active: bool


class SwitchTenantRequest(BaseModel):
    tenant_id: uuid.UUID


class UpdateMeRequest(BaseModel):
    full_name: Optional[str] = None
    email: Optional[EmailStr] = None
    current_password: Optional[str] = None
    new_password: Optional[str] = None


# ── Helpers ────────────────────────────────────────────────────────────────────

def _create_jwt(
    user: User,
    active_tenant_id: Optional[uuid.UUID] = None,
) -> tuple[str, datetime]:
    """Issue a JWT with platform/tenant role claims.
    active_tenant_id may differ from user.tenant_id when a platform_admin switches tenants."""
    from ..dependencies import _normalize_tenant_role
    expire = datetime.now(timezone.utc) + timedelta(minutes=_settings.jwt_expire_minutes)
    claims: dict = {
        "sub": str(user.id),
        "exp": expire,
        "tid": str(active_tenant_id or user.tenant_id),
        "tr":  _normalize_tenant_role(user.role),
    }
    if user.platform_role:
        claims["pr"] = user.platform_role
    token = _jwt.encode(claims, _settings.jwt_secret_key, algorithm=_settings.jwt_algorithm)
    return token, expire


# ── Shared response builder ────────────────────────────────────────────────────

async def _me_response(user: User, db: AsyncSession) -> MeResponse:
    """Build a MeResponse including tenant name and site memberships."""
    tenant = (await db.execute(
        select(Tenant).where(Tenant.id == user.tenant_id)
    )).scalar_one()

    membership_rows = (await db.execute(
        select(UserSiteRole.site_id, UserSiteRole.role, Site.name)
        .join(Site, Site.id == UserSiteRole.site_id)
        .where(UserSiteRole.user_id == user.id, UserSiteRole.tenant_id == user.tenant_id)
        .order_by(Site.name)
    )).all()

    return MeResponse(
        id=user.id,
        username=user.username,
        email=user.email,
        full_name=user.full_name,
        role=user.role,
        is_platform_admin=user.is_platform_admin,
        platform_role=user.platform_role,
        tenant_id=user.tenant_id,
        tenant_name=tenant.name,
        site_memberships=[
            SiteMembership(site_id=r.site_id, site_name=r.name, role=r.role)
            for r in membership_rows
        ],
    )


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.post("/login", response_model=TokenResponse, summary="Exchange username+password for a JWT")
async def login(
    body: LoginRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> TokenResponse:
    result = await db.execute(
        select(User).where(User.username == body.username, User.is_active == True)  # noqa: E712
    )
    user = result.scalar_one_or_none()

    _DUMMY_HASH = "$2b$12$GfPd1zRSGE8TbB0ZuBBuDuN6Gu4qMnvRFDJ1D1nLSdKCMJfVDlui2"
    candidate_hash = user.password_hash if user is not None else _DUMMY_HASH
    password_ok = _verify_password(body.password, candidate_hash)

    if user is None or not password_ok:
        logger.warning("login_failed", username=body.username, ip=request.client.host if request.client else "unknown")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    token, expire = _create_jwt(user)

    await db.execute(
        update(User).where(User.id == user.id).values(last_login=datetime.now(timezone.utc))
    )
    await db.commit()

    logger.info("login_success", user_id=str(user.id), username=user.username)
    return TokenResponse(
        access_token=token,
        expires_in=_settings.jwt_expire_minutes * 60,
    )


@router.get("/me", response_model=MeResponse, summary="Return the authenticated user's profile")
async def me(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MeResponse:
    return await _me_response(current_user, db)


@router.patch("/me", response_model=MeResponse, summary="Update the authenticated user's profile")
async def update_me(
    body: UpdateMeRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MeResponse:
    if body.new_password:
        if not body.current_password:
            raise HTTPException(status_code=400, detail="current_password required to set a new password")
        if not _verify_password(body.current_password, current_user.password_hash):
            raise HTTPException(status_code=400, detail="Current password is incorrect")
        if len(body.new_password) < 8:
            raise HTTPException(status_code=400, detail="New password must be at least 8 characters")
        current_user.password_hash = _hash_password(body.new_password)

    if body.full_name is not None:
        current_user.full_name = body.full_name
    if body.email is not None:
        current_user.email = body.email

    await db.commit()
    await db.refresh(current_user)
    logger.info("user_updated", user_id=str(current_user.id))
    return await _me_response(current_user, db)


@router.post("/tokens", response_model=ApiTokenResponse, summary="Create a long-lived API token")
async def create_api_token(
    body: CreateApiTokenRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ApiTokenResponse:
    raw_token = secrets.token_hex(32)
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()

    expires_at = None
    if body.expires_days:
        expires_at = datetime.now(timezone.utc) + timedelta(days=body.expires_days)

    api_token = ApiToken(
        tenant_id=current_user.tenant_id,
        user_id=current_user.id,
        name=body.name,
        token_hash=token_hash,
        scopes=body.scopes,
        site_ids=body.site_ids,
        expires_at=expires_at,
    )
    db.add(api_token)
    await db.commit()
    await db.refresh(api_token)

    logger.info("api_token_created", token_id=str(api_token.id), user_id=str(current_user.id))
    return ApiTokenResponse(
        id=api_token.id,
        name=api_token.name,
        token=raw_token,
        scopes=api_token.scopes,
        site_ids=api_token.site_ids or [],
        expires_at=api_token.expires_at,
        created_at=api_token.created_at,
    )


@router.delete("/tokens/{token_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None, summary="Revoke an API token")
async def revoke_api_token(
    token_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    result = await db.execute(
        select(ApiToken).where(
            ApiToken.id == token_id,
            ApiToken.tenant_id == current_user.tenant_id,
        )
    )
    token = result.scalar_one_or_none()
    if token is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Token not found")

    # Only the owner, a tenant admin, or a platform admin may revoke.
    if token.user_id != current_user.id and current_user.role not in ("admin", "superadmin") and not current_user.is_platform_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not permitted")

    await db.delete(token)
    await db.commit()
    logger.info("api_token_revoked", token_id=str(token_id), by_user=str(current_user.id))


@router.get("/tenants", response_model=list[TenantSummary], summary="List tenants accessible to this user")
async def list_tenants(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[TenantSummary]:
    if current_user.is_platform_admin:
        rows = (await db.execute(select(Tenant).order_by(Tenant.name))).scalars().all()
    else:
        # Home tenant + any explicitly granted additional tenants
        granted_tenant_ids = (await db.execute(
            select(UserTenantAccess.tenant_id).where(UserTenantAccess.user_id == current_user.id)
        )).scalars().all()
        ids = {current_user.tenant_id} | set(granted_tenant_ids)
        rows = (await db.execute(
            select(Tenant).where(Tenant.id.in_(ids)).order_by(Tenant.name)
        )).scalars().all()
    return [TenantSummary(id=t.id, name=t.name, slug=t.slug, is_active=t.is_active) for t in rows]


@router.post("/switch-tenant", response_model=TokenResponse, summary="Switch active tenant")
async def switch_tenant(
    body: SwitchTenantRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TokenResponse:
    # Platform admins can switch to any tenant; regular users need an explicit grant
    if not current_user.is_platform_admin:
        if body.tenant_id != current_user.tenant_id:
            grant = (await db.execute(
                select(UserTenantAccess).where(
                    UserTenantAccess.user_id   == current_user.id,
                    UserTenantAccess.tenant_id == body.tenant_id,
                )
            )).scalar_one_or_none()
            if grant is None:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No access to that tenant")

    target = (await db.execute(
        select(Tenant).where(Tenant.id == body.tenant_id, Tenant.is_active == True)  # noqa: E712
    )).scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found")

    token, expire = _create_jwt(current_user, active_tenant_id=body.tenant_id)
    logger.info("tenant_switched", user_id=str(current_user.id), target_tenant=str(body.tenant_id))
    return TokenResponse(
        access_token=token,
        expires_in=_settings.jwt_expire_minutes * 60,
    )
