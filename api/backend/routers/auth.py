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
from ..dependencies import get_current_user, get_db
from ..models.tenant import ApiToken, User

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
    expires_days: Optional[int] = None


class ApiTokenResponse(BaseModel):
    id: uuid.UUID
    name: str
    token: str          # Only returned at creation — never stored in plain text.
    scopes: list
    expires_at: Optional[datetime] = None
    created_at: datetime


class MeResponse(BaseModel):
    id: uuid.UUID
    username: str
    email: str
    full_name: Optional[str]
    role: str
    tenant_id: uuid.UUID


class UpdateMeRequest(BaseModel):
    full_name: Optional[str] = None
    email: Optional[EmailStr] = None
    current_password: Optional[str] = None
    new_password: Optional[str] = None


# ── Helpers ────────────────────────────────────────────────────────────────────

def _create_jwt(user_id: uuid.UUID) -> tuple[str, datetime]:
    expire = datetime.now(timezone.utc) + timedelta(minutes=_settings.jwt_expire_minutes)
    token = _jwt.encode(
        {"sub": str(user_id), "exp": expire},
        _settings.jwt_secret_key,
        algorithm=_settings.jwt_algorithm,
    )
    return token, expire


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

    token, expire = _create_jwt(user.id)

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
async def me(current_user: User = Depends(get_current_user)) -> MeResponse:
    return MeResponse(
        id=current_user.id,
        username=current_user.username,
        email=current_user.email,
        full_name=current_user.full_name,
        role=current_user.role,
        tenant_id=current_user.tenant_id,
    )


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
    return MeResponse(
        id=current_user.id,
        username=current_user.username,
        email=current_user.email,
        full_name=current_user.full_name,
        role=current_user.role,
        tenant_id=current_user.tenant_id,
    )


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

    # Only the owner or an admin may revoke.
    if token.user_id != current_user.id and current_user.role not in ("admin", "superadmin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not permitted")

    await db.delete(token)
    await db.commit()
    logger.info("api_token_revoked", token_id=str(token_id), by_user=str(current_user.id))
