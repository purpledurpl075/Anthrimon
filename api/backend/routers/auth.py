from __future__ import annotations

import hashlib
import secrets
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import structlog
import pyotp
from fastapi import APIRouter, Depends, HTTPException, Request, status
import bcrypt as _bcrypt
import jwt as _jwt
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..dependencies import get_current_principal, get_current_user, get_db, Principal
from ..models.tenant import ApiToken, Tenant, User, UserSiteRole, UserTenantAccess
from ..models.site import Site

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])

# ── Rate limiting ──────────────────────────────────────────────────────────────
# Simple in-process IP-based rate limiter.
# {ip: [timestamp, ...]} — we prune timestamps older than the window on access.
_rate_windows: dict[str, list[float]] = {}
_cleanup_counter = 0


def _check_rate_limit(request: Request, max_calls: int, window_seconds: int) -> None:
    """Raise 429 if the request IP has exceeded max_calls in window_seconds."""
    global _cleanup_counter
    ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    window_start = now - window_seconds
    calls = [t for t in _rate_windows.get(ip, []) if t > window_start]
    if len(calls) >= max_calls:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many requests — please slow down",
            headers={"Retry-After": str(window_seconds)},
        )
    calls.append(now)
    _rate_windows[ip] = calls

    _cleanup_counter += 1
    if _cleanup_counter >= 100:
        _cleanup_counter = 0
        stale_cutoff = now - window_seconds * 2
        stale_ips = [k for k, v in _rate_windows.items() if not v or v[-1] < stale_cutoff]
        for k in stale_ips:
            del _rate_windows[k]

# ── TOTP replay / session-invalidation stores ─────────────────────────────────
# In-process dicts are sufficient for single-process deployments.
# Each entry expires naturally when the TTL window passes; we prune on access.

# Consumed TOTP pending session tokens: sha256(token) → expiry epoch
_consumed_totp_sessions: dict[str, float] = {}

# Recently-used TOTP codes per user: user_id_str → (code, used_at_epoch)
_used_totp_codes: dict[str, tuple[str, float]] = {}

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
    # Set when TOTP is required; client must POST to /auth/totp/challenge to get full token.
    totp_required: bool = False
    totp_session: Optional[str] = None


class CreateApiTokenRequest(BaseModel):
    name: str
    scopes: list[str] = Field(default=[], max_length=50)
    site_ids: list[uuid.UUID] = Field(default=[], max_length=50)
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
    totp_enabled: bool = False


# ── TOTP request / response models ────────────────────────────────────────────

class TotpChallengeRequest(BaseModel):
    totp_session: str
    code: Optional[str] = None
    backup_code: Optional[str] = None


class TotpSetupResponse(BaseModel):
    secret: str
    provisioning_uri: str


class TotpConfirmRequest(BaseModel):
    code: str


class TotpConfirmResponse(BaseModel):
    backup_codes: list[str]


class TotpDisableRequest(BaseModel):
    code: str


class TotpBackupCodesRequest(BaseModel):
    code: str


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
    claims["gen"] = user.token_generation
    token = _jwt.encode(claims, _settings.jwt_secret_key, algorithm=_settings.jwt_algorithm)
    return token, expire


# ── TOTP helpers ──────────────────────────────────────────────────────────────

def _create_totp_pending_jwt(user: User) -> str:
    """Short-lived (5 min) JWT that carries only the TOTP challenge context.
    This token grants NO API access — _principal_from_jwt rejects scope=totp_pending."""
    expire = datetime.now(timezone.utc) + timedelta(minutes=5)
    return _jwt.encode(
        {"sub": str(user.id), "tid": str(user.tenant_id),
         "scope": "totp_pending", "exp": expire},
        _settings.jwt_secret_key, algorithm=_settings.jwt_algorithm,
    )


def _decode_totp_pending_jwt(token: str) -> Optional[dict]:
    try:
        payload = _jwt.decode(token, _settings.jwt_secret_key, algorithms=[_settings.jwt_algorithm])
        if payload.get("scope") != "totp_pending":
            return None
        return payload
    except Exception:
        return None


def _totp_session_consumed(token: str) -> bool:
    """Return True if this TOTP pending token has already been used."""
    h = hashlib.sha256(token.encode()).hexdigest()
    now = time.monotonic()
    # Prune expired entries (older than 6 min; sessions expire in 5 min)
    for k in list(_consumed_totp_sessions):
        if _consumed_totp_sessions[k] < now:
            del _consumed_totp_sessions[k]
    return h in _consumed_totp_sessions


def _mark_totp_session_consumed(token: str) -> None:
    """Record that this TOTP pending token has been consumed."""
    h = hashlib.sha256(token.encode()).hexdigest()
    _consumed_totp_sessions[h] = time.monotonic() + 360  # prune after 6 min


def _generate_backup_codes() -> tuple[list[str], list[str]]:
    """Generate 10 backup codes. Returns (plaintext_list, bcrypt_hashed_list)."""
    plain = [secrets.token_urlsafe(6)[:8].upper() for _ in range(10)]
    hashed = [_bcrypt.hashpw(c.encode(), _bcrypt.gensalt(rounds=10)).decode() for c in plain]
    return plain, hashed


def _verify_totp_code(user: User, code: str) -> bool:
    if not user.totp_secret:
        return False
    if not pyotp.TOTP(user.totp_secret).verify(code, valid_window=1):
        return False
    # Prevent replay within the ±1 window (90-second window)
    key = str(user.id)
    now = time.monotonic()
    if key in _used_totp_codes:
        used_code, used_at = _used_totp_codes[key]
        if used_code == code and now - used_at < 90:
            return False
    _used_totp_codes[key] = (code, now)
    return True


def _verify_and_consume_backup_code(user: User, code: str) -> bool:
    """Check backup code and remove it if valid. Returns True on match."""
    if not user.totp_backup_codes:
        return False
    code_upper = code.upper()
    for i, hashed in enumerate(user.totp_backup_codes):
        try:
            if _bcrypt.checkpw(code_upper.encode(), hashed.encode()):
                remaining = list(user.totp_backup_codes)
                remaining.pop(i)
                user.totp_backup_codes = remaining if remaining else None
                return True
        except Exception:
            continue
    return False


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
        totp_enabled=bool(user.totp_enabled),
    )


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.post("/login", response_model=TokenResponse, summary="Exchange username+password for a JWT")
async def login(
    body: LoginRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> TokenResponse:
    _check_rate_limit(request, max_calls=10, window_seconds=60)
    result = await db.execute(
        select(User).where(User.username == body.username, User.is_active == True)  # noqa: E712
    )
    user = result.scalar_one_or_none()

    _DUMMY_HASH = "$2b$12$GfPd1zRSGE8TbB0ZuBBuDuN6Gu4qMnvRFDJ1D1nLSdKCMJfVDlui2"
    candidate_hash = user.password_hash if user is not None else _DUMMY_HASH
    password_ok = _verify_password(body.password, candidate_hash)

    if user is None or not password_ok:
        logger.warning("login_failed", username=body.username, ip=request.client.host if request.client else "unknown")
        # Record failed login attempt for audit.  No user FK because the
        # username may not match any account.
        from ..audit import audit as _audit
        await _audit(db, action="login_failed", resource_type="user",
                     new_value={"username": body.username, "name": body.username},
                     request=request)
        await db.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    # If TOTP is enabled, return a short-lived pending token instead of the full JWT.
    if user.totp_enabled:
        pending = _create_totp_pending_jwt(user)
        logger.info("login_totp_required", user_id=str(user.id), username=user.username)
        return TokenResponse(
            access_token="",
            expires_in=0,
            totp_required=True,
            totp_session=pending,
        )

    token, expire = _create_jwt(user)

    await db.execute(
        update(User).where(User.id == user.id).values(last_login=datetime.now(timezone.utc))
    )

    from ..audit import audit as _audit
    await _audit(db, action="login", resource_type="user", resource_id=user.id,
                 new_value={"username": user.username, "name": user.username},
                 user=user, request=request)
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
        current_user.token_generation += 1

    if body.full_name is not None:
        current_user.full_name = body.full_name
    if body.email is not None:
        current_user.email = body.email

    await db.commit()
    await db.refresh(current_user)
    logger.info("user_updated", user_id=str(current_user.id))
    return await _me_response(current_user, db)


@router.post("/auth/revoke-sessions", summary="Revoke all active sessions for the current user")
async def revoke_sessions(
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> dict:
    user = principal.user
    user.token_generation += 1
    await db.commit()
    logger.info("sessions_revoked", user_id=str(user.id), new_generation=user.token_generation)
    return {"detail": "All sessions revoked"}


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


# ── TOTP endpoints ─────────────────────────────────────────────────────────────

@router.post("/totp/challenge", response_model=TokenResponse,
             summary="Complete login when TOTP is required")
async def totp_challenge(
    body: TotpChallengeRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> TokenResponse:
    """Exchange a TOTP-pending session token + 6-digit code (or backup code) for a full JWT."""
    _check_rate_limit(request, max_calls=5, window_seconds=60)
    payload = _decode_totp_pending_jwt(body.totp_session)
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="TOTP session expired or invalid")

    # H5: prevent session token replay after a successful challenge
    if _totp_session_consumed(body.totp_session):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="TOTP session already used")

    # H3: lock the user row so concurrent requests can't both consume the same backup code
    user = (await db.execute(
        select(User)
        .where(User.id == uuid.UUID(payload["sub"]), User.is_active == True)  # noqa: E712
        .with_for_update()
    )).scalar_one_or_none()
    if user is None or not user.totp_enabled:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid session")

    valid = False
    used_backup = False
    if body.code:
        valid = _verify_totp_code(user, body.code)
    elif body.backup_code:
        valid = _verify_and_consume_backup_code(user, body.backup_code)
        used_backup = valid

    from ..audit import audit as _audit
    if not valid:
        await _audit(db, action="totp_challenge_failed", resource_type="user",
                     resource_id=user.id, new_value={"username": user.username, "name": user.username},
                     user=user, request=request)
        await db.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="Invalid authentication code")

    # H5: mark session as consumed so it can't be replayed
    _mark_totp_session_consumed(body.totp_session)

    update_vals: dict = {"last_login": datetime.now(timezone.utc)}
    if used_backup:
        # H3: persist the consumed backup code list in the same transaction as the row lock
        update_vals["totp_backup_codes"] = user.totp_backup_codes
    await db.execute(update(User).where(User.id == user.id).values(**update_vals))

    token, _ = _create_jwt(user)
    await _audit(db, action="totp_challenge_ok", resource_type="user", resource_id=user.id,
                 new_value={"username": user.username, "name": user.username,
                            "used_backup": used_backup},
                 user=user, request=request)
    await db.commit()
    logger.info("totp_challenge_ok", user_id=str(user.id), used_backup=used_backup)
    return TokenResponse(access_token=token, expires_in=_settings.jwt_expire_minutes * 60)


@router.post("/totp/setup", response_model=TotpSetupResponse,
             summary="Begin TOTP setup — generates a new secret and provisioning URI")
async def totp_setup(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TotpSetupResponse:
    """Generate a TOTP secret and store it (not yet active).
    Call /totp/confirm with a valid code to activate."""
    secret = pyotp.random_base32()
    totp = pyotp.TOTP(secret)
    issuer = "Anthrimon"
    uri = totp.provisioning_uri(name=current_user.username, issuer_name=issuer)

    await db.execute(
        update(User).where(User.id == current_user.id)
        .values(totp_secret=secret, totp_enabled=False)
    )
    await db.commit()
    logger.info("totp_setup_initiated", user_id=str(current_user.id))
    return TotpSetupResponse(secret=secret, provisioning_uri=uri)


@router.post("/totp/confirm", response_model=TotpConfirmResponse,
             summary="Confirm TOTP setup with a valid code — enables 2FA and returns backup codes")
async def totp_confirm(
    body: TotpConfirmRequest,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TotpConfirmResponse:
    if not current_user.totp_secret:
        raise HTTPException(status_code=400, detail="Call /totp/setup first")
    if not _verify_totp_code(current_user, body.code):
        raise HTTPException(status_code=400, detail="Invalid code — check your authenticator app")

    plain_codes, hashed_codes = _generate_backup_codes()
    await db.execute(
        update(User).where(User.id == current_user.id)
        .values(totp_enabled=True, totp_backup_codes=hashed_codes)
    )
    from ..audit import audit as _audit
    await _audit(db, action="totp_enabled", resource_type="user", resource_id=current_user.id,
                 new_value={"username": current_user.username, "name": current_user.username},
                 user=current_user, request=request)
    await db.commit()
    logger.info("totp_enabled", user_id=str(current_user.id))
    return TotpConfirmResponse(backup_codes=plain_codes)


@router.post("/totp/disable", status_code=status.HTTP_204_NO_CONTENT, response_model=None,
             summary="Disable TOTP — requires current TOTP code to confirm")
async def totp_disable(
    body: TotpDisableRequest,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    if not current_user.totp_enabled:
        raise HTTPException(status_code=400, detail="TOTP is not enabled")
    if not _verify_totp_code(current_user, body.code):
        raise HTTPException(status_code=400, detail="Invalid code")

    await db.execute(
        update(User).where(User.id == current_user.id)
        .values(totp_enabled=False, totp_secret=None, totp_backup_codes=None)
    )
    from ..audit import audit as _audit
    await _audit(db, action="totp_disabled", resource_type="user", resource_id=current_user.id,
                 new_value={"username": current_user.username, "name": current_user.username},
                 user=current_user, request=request)
    await db.commit()
    logger.info("totp_disabled", user_id=str(current_user.id))


@router.post("/totp/backup-codes", response_model=TotpConfirmResponse,
             summary="Regenerate TOTP backup codes — requires current TOTP code")
async def totp_backup_codes(
    body: TotpBackupCodesRequest,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TotpConfirmResponse:
    if not current_user.totp_enabled:
        raise HTTPException(status_code=400, detail="TOTP is not enabled")
    if not _verify_totp_code(current_user, body.code):
        raise HTTPException(status_code=400, detail="Invalid code")

    plain_codes, hashed_codes = _generate_backup_codes()
    await db.execute(
        update(User).where(User.id == current_user.id)
        .values(totp_backup_codes=hashed_codes)
    )
    from ..audit import audit as _audit
    await _audit(db, action="totp_backup_codes_regenerated", resource_type="user",
                 resource_id=current_user.id,
                 new_value={"username": current_user.username, "name": current_user.username},
                 user=current_user, request=request)
    await db.commit()
    logger.info("totp_backup_codes_regenerated", user_id=str(current_user.id))
    return TotpConfirmResponse(backup_codes=plain_codes)


# ── Short-lived WebSocket token ──────────────────────────────────────────────

@router.post("/ws-token", summary="Issue a short-lived token for WebSocket connections")
async def ws_token(
    principal: Principal = Depends(get_current_principal),
) -> dict:
    """Issue a 60-second JWT scoped to WebSocket auth only.
    This avoids putting the long-lived main JWT in WebSocket URLs
    where it could appear in server logs and browser history."""
    expire = datetime.now(timezone.utc) + timedelta(seconds=60)
    from ..dependencies import _normalize_tenant_role
    claims: dict = {
        "sub":   str(principal.user.id),
        "exp":   expire,
        "tid":   str(principal.active_tenant_id),
        "tr":    _normalize_tenant_role(principal.user.role),
        "scope": "ws",
    }
    if principal.user.platform_role:
        claims["pr"] = principal.user.platform_role
    token = _jwt.encode(claims, _settings.jwt_secret_key, algorithm=_settings.jwt_algorithm)
    return {"token": token}
