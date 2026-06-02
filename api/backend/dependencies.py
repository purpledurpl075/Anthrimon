from __future__ import annotations

import asyncio
import hashlib
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import AsyncGenerator, Optional

import structlog
from fastapi import Depends, Header, HTTPException, Query, Request, status
import jwt as _jwt
from jwt.exceptions import InvalidTokenError as JWTError
from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from .config import get_settings
from .database import AsyncSessionLocal
from .models.tenant import ApiToken, User, UserSiteRole

logger = structlog.get_logger(__name__)
_settings = get_settings()


# ── Principal ──────────────────────────────────────────────────────────────────

@dataclass
class Principal:
    """Hydrated auth context for the current request.
    Carries user identity, active tenant, platform/tenant roles, and site grants.
    New site-aware endpoints should depend on get_current_principal; existing
    endpoints continue to use get_current_user unchanged."""
    user: User
    active_tenant_id: uuid.UUID
    is_platform_admin: bool
    platform_role: Optional[str]            # 'platform_admin' | 'platform_support' | None
    tenant_role: str                        # 'tenant_admin' | 'operator' | 'readonly'
    site_role_map: dict[uuid.UUID, str] = field(default_factory=dict)  # {site_id: role}
    token_site_ids: list[uuid.UUID] = field(default_factory=list)      # non-empty → token-scoped
    scopes: list[str] = field(default_factory=list)


# ── Role hierarchy ─────────────────────────────────────────────────────────────

_PLATFORM_LEVELS: dict[str, int] = {"platform_support": 1, "platform_admin": 2}
_TENANT_LEVELS: dict[str, int] = {"readonly": 1, "operator": 2, "tenant_admin": 3}


def _normalize_tenant_role(role: str) -> str:
    """Map legacy user_role enum values to the new tenant-role vocabulary."""
    if role in ("superadmin", "admin"):
        return "tenant_admin"
    return role  # 'operator' and 'readonly' pass through unchanged


def _has_platform_role(principal: Principal, min_role: str) -> bool:
    have = _PLATFORM_LEVELS.get(principal.platform_role or "", 0)
    need = _PLATFORM_LEVELS.get(min_role, 99)
    return have >= need


def _has_tenant_role(principal: Principal, min_role: str) -> bool:
    have = _TENANT_LEVELS.get(principal.tenant_role, 0)
    need = _TENANT_LEVELS.get(min_role, 99)
    return have >= need


def _has_site_role(principal: Principal, site_id: uuid.UUID, min_role: str) -> bool:
    role = principal.site_role_map.get(site_id, "")
    have = _TENANT_LEVELS.get(role, 0)
    need = _TENANT_LEVELS.get(min_role, 99)
    return have >= need


# ── DB helpers ─────────────────────────────────────────────────────────────────

async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Yield a database session per request."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise


def _hash_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode()).hexdigest()


async def _load_site_role_map(
    user_id: uuid.UUID, tenant_id: uuid.UUID, db: AsyncSession
) -> dict[uuid.UUID, str]:
    rows = (await db.execute(
        select(UserSiteRole.site_id, UserSiteRole.role).where(
            UserSiteRole.user_id == user_id,
            UserSiteRole.tenant_id == tenant_id,
        )
    )).all()
    return {row.site_id: row.role for row in rows}


async def _build_principal(
    user: User,
    db: AsyncSession,
    *,
    active_tenant_id: Optional[uuid.UUID] = None,
    platform_role_override: Optional[str] = None,
    tenant_role_override: Optional[str] = None,
    token_site_ids: Optional[list[uuid.UUID]] = None,
    scopes: Optional[list[str]] = None,
) -> Principal:
    tid = active_tenant_id or user.tenant_id
    pr  = platform_role_override if platform_role_override is not None else user.platform_role
    tr  = tenant_role_override or _normalize_tenant_role(user.role)
    site_map = await _load_site_role_map(user.id, tid, db)
    return Principal(
        user=user,
        active_tenant_id=tid,
        is_platform_admin=user.is_platform_admin,
        platform_role=pr,
        tenant_role=tr,
        site_role_map=site_map,
        token_site_ids=token_site_ids or [],
        scopes=scopes or [],
    )


async def _principal_from_jwt(token: str, db: AsyncSession) -> Optional[Principal]:
    try:
        payload = _jwt.decode(token, _settings.jwt_secret_key, algorithms=[_settings.jwt_algorithm])
        user_id_str: str = payload.get("sub")
        if not user_id_str:
            return None
    except JWTError:
        return None

    result = await db.execute(
        select(User).where(User.id == uuid.UUID(user_id_str), User.is_active == True)  # noqa: E712
    )
    user = result.scalar_one_or_none()
    if user is None:
        return None

    # Parse extended claims (absent in tokens issued before Phase B — fall back gracefully)
    tid_str = payload.get("tid")
    active_tid = uuid.UUID(tid_str) if tid_str else None
    return await _build_principal(
        user, db,
        active_tenant_id=active_tid,
        platform_role_override=payload.get("pr"),   # None if old token
        tenant_role_override=payload.get("tr"),     # None if old token
    )


async def _principal_from_api_token(raw_token: str, db: AsyncSession) -> Optional[Principal]:
    token_hash = _hash_token(raw_token)
    result = await db.execute(select(ApiToken).where(ApiToken.token_hash == token_hash))
    api_token = result.scalar_one_or_none()
    if api_token is None:
        return None

    if api_token.expires_at and api_token.expires_at < datetime.now(timezone.utc):
        return None

    if api_token.user_id is None:
        return None

    result = await db.execute(
        select(User).where(
            User.id == api_token.user_id,
            User.tenant_id == api_token.tenant_id,
            User.is_active == True,  # noqa: E712
        )
    )
    user = result.scalar_one_or_none()
    if user is None:
        return None

    token_id = api_token.id

    async def _touch() -> None:
        async with AsyncSessionLocal() as s:
            await s.execute(
                update(ApiToken).where(ApiToken.id == token_id)
                .values(last_used=datetime.now(timezone.utc))
            )
            await s.commit()

    asyncio.create_task(_touch())

    return await _build_principal(
        user, db,
        token_site_ids=list(api_token.site_ids or []),
        scopes=list(api_token.scopes or []),
    )


# ── Public dependencies ────────────────────────────────────────────────────────

async def get_current_principal(
    authorization: Optional[str] = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> Principal:
    """Return the hydrated Principal for the current request.
    Accepts Bearer JWT (with optional tid/pr/tr claims) or Bearer API token."""
    credentials_exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or missing authentication credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if not authorization or not authorization.startswith("Bearer "):
        raise credentials_exc

    raw_token = authorization.removeprefix("Bearer ").strip()

    principal = await _principal_from_jwt(raw_token, db)
    if principal is None:
        principal = await _principal_from_api_token(raw_token, db)
    if principal is None:
        raise credentials_exc
    return principal


async def get_current_user(
    principal: Principal = Depends(get_current_principal),
) -> User:
    """Thin shim — returns the User from the current Principal.
    Patches tenant_id to active_tenant_id so acting-as scenarios work across all
    existing routers without touching their code."""
    user = principal.user
    if principal.active_tenant_id != user.tenant_id:
        set_committed_value(user, "tenant_id", principal.active_tenant_id)
    return user


async def get_current_user_sse(
    request: Request,
    token_param: Optional[str] = Query(default=None, alias="token"),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Like get_current_user but also accepts ?token= for SSE / EventSource clients
    that cannot set the Authorization header."""
    credentials_exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or missing authentication credentials",
    )
    raw_token: Optional[str] = None
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        raw_token = auth_header.removeprefix("Bearer ").strip()
    elif token_param:
        raw_token = token_param.strip()

    if not raw_token:
        raise credentials_exc

    principal = await _principal_from_jwt(raw_token, db)
    if principal is None:
        principal = await _principal_from_api_token(raw_token, db)
    if principal is None:
        raise credentials_exc
    return principal.user


# ── Permission dependency factories ───────────────────────────────────────────

def require_role(*roles: str):
    """Deprecated shim — kept for all existing routers during migration.
    Prefer require_tenant() / require_platform() for new endpoints."""
    async def _check(current_user: User = Depends(get_current_user)) -> User:
        if current_user.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Role '{current_user.role}' is not permitted for this action",
            )
        return current_user
    return _check


def require_platform(min_role: str = "platform_admin"):
    """Require the caller to hold a platform role ≥ min_role.
    Use for endpoints in the future /platform/* router."""
    async def _check(principal: Principal = Depends(get_current_principal)) -> Principal:
        if not _has_platform_role(principal, min_role):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Platform access required",
            )
        return principal
    return _check


def require_tenant(min_role: str = "readonly"):
    """Require tenant-level access ≥ min_role.  Platform admins always pass."""
    async def _check(principal: Principal = Depends(get_current_principal)) -> Principal:
        if principal.is_platform_admin:
            return principal
        if not _has_tenant_role(principal, min_role):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Requires tenant role '{min_role}' or higher",
            )
        return principal
    return _check


def require_tenant_user(min_role: str = "tenant_admin"):
    """Like require_tenant but returns the User instead of the Principal.
    Drop-in replacement for require_role() in existing admin.py patterns."""
    async def _check(principal: Principal = Depends(get_current_principal)) -> User:
        if not principal.is_platform_admin and not _has_tenant_role(principal, min_role):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Requires tenant role '{min_role}' or higher",
            )
        return principal.user
    return _check


# ── Assertion helpers (called inside endpoint bodies) ─────────────────────────

async def assert_site_access(
    principal: Principal,
    site_id: uuid.UUID,
    min_role: str,
    db: AsyncSession,
) -> None:
    """Raise 403 if the principal cannot access site_id at min_role level.
    Platform admins and tenant_admins bypass the site check.
    Also enforces token-level site restriction."""
    if principal.is_platform_admin:
        return
    if _has_tenant_role(principal, "tenant_admin"):
        if not principal.token_site_ids or site_id in principal.token_site_ids:
            return
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Token not scoped to this site")

    if _has_site_role(principal, site_id, min_role):
        if not principal.token_site_ids or site_id in principal.token_site_ids:
            return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=f"Requires '{min_role}' access to this site",
    )


async def assert_device_access(
    principal: Principal,
    device_id: uuid.UUID,
    min_role: str,
    db: AsyncSession,
) -> None:
    """Raise 403/404 if the principal cannot access device_id at min_role level.
    Looks up the device's site_id and delegates to assert_site_access.
    Devices with site_id IS NULL (tenant-wide / orphaned) fall back to tenant role."""
    if principal.is_platform_admin:
        return
    if _has_tenant_role(principal, "tenant_admin"):
        return

    from .models.device import Device  # local import to avoid circular dependency

    result = await db.execute(
        select(Device.site_id).where(
            Device.id == device_id,
            Device.tenant_id == principal.active_tenant_id,
        )
    )
    row = result.one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")

    site_id: Optional[uuid.UUID] = row[0]
    if site_id is None:
        # Orphaned / tenant-wide device — require the requested tenant-level role
        if not _has_tenant_role(principal, min_role):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
        return

    await assert_site_access(principal, site_id, min_role, db)


# ── Scoped query helper ────────────────────────────────────────────────────────

def accessible_device_ids_subquery(principal: Principal):
    """Return a SQLAlchemy select(Device.id) subquery scoped to the principal.

    Usage in a router query:
        .where(Device.id.in_(accessible_device_ids_subquery(principal)))

    Platform admins and tenant_admins see the full tenant device list (subject to
    token_site_ids if the request came via a site-restricted API token).
    Site-role users see only devices in their accessible sites plus orphaned devices.
    """
    from .models.device import Device  # local import to avoid circular dependency

    base = select(Device.id).where(Device.tenant_id == principal.active_tenant_id)

    if principal.is_platform_admin or _has_tenant_role(principal, "tenant_admin"):
        if principal.token_site_ids:
            return base.where(
                or_(Device.site_id.in_(principal.token_site_ids), Device.site_id.is_(None))
            )
        return base

    # Site-role user — intersect accessible sites with any token restriction
    accessible_sites = set(principal.site_role_map.keys())
    if principal.token_site_ids:
        accessible_sites &= set(principal.token_site_ids)

    return base.where(
        or_(Device.site_id.in_(accessible_sites), Device.site_id.is_(None))
    )
