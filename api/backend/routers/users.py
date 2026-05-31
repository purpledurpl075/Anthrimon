from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

import bcrypt as _bcrypt
import structlog
from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, EmailStr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_current_user, get_db, require_role
from ..models.tenant import User

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/users", tags=["users"])

VALID_ROLES = {"readonly", "operator", "admin", "superadmin"}


def _hash(plain: str) -> str:
    return _bcrypt.hashpw(plain.encode(), _bcrypt.gensalt(rounds=12)).decode()


# ── Schemas ────────────────────────────────────────────────────────────────────

class UserRead(BaseModel):
    model_config = {"from_attributes": True}

    id:         uuid.UUID
    username:   str
    email:      str
    full_name:  Optional[str]
    role:       str
    is_active:  bool
    last_login: Optional[datetime]
    created_at: datetime


class UserCreate(BaseModel):
    username:   str
    email:      EmailStr
    password:   str
    full_name:  Optional[str] = None
    role:       str = "readonly"


class UserUpdate(BaseModel):
    email:      Optional[EmailStr] = None
    full_name:  Optional[str]  = None
    role:       Optional[str]  = None
    is_active:  Optional[bool] = None


class PasswordReset(BaseModel):
    new_password: str


# ── Helpers ────────────────────────────────────────────────────────────────────

async def _get_user(user_id: uuid.UUID, tenant_id: uuid.UUID, db: AsyncSession) -> User:
    result = await db.execute(
        select(User).where(User.id == user_id, User.tenant_id == tenant_id)
    )
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return user


def _check_role_escalation(actor: User, target_role: str) -> None:
    """Prevent non-superadmins from assigning the superadmin role."""
    if target_role == "superadmin" and actor.role != "superadmin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only superadmins can assign the superadmin role")
    if target_role not in VALID_ROLES:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"Invalid role '{target_role}'")


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("", response_model=list[UserRead], summary="List users in tenant")
async def list_users(
    current_user: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> list[UserRead]:
    result = await db.execute(
        select(User)
        .where(User.tenant_id == current_user.tenant_id)
        .order_by(User.username)
    )
    return [UserRead.model_validate(u) for u in result.scalars().all()]


@router.post("", response_model=UserRead, status_code=status.HTTP_201_CREATED, summary="Create a user")
async def create_user(
    body: UserCreate,
    current_user: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> UserRead:
    _check_role_escalation(current_user, body.role)

    if len(body.password) < 8:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Password must be at least 8 characters")

    # Check username uniqueness within tenant
    existing = await db.execute(
        select(User).where(User.tenant_id == current_user.tenant_id, User.username == body.username)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username already exists")

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


@router.patch("/{user_id}", response_model=UserRead, summary="Update a user")
async def update_user(
    user_id: uuid.UUID,
    body: UserUpdate,
    current_user: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> UserRead:
    user = await _get_user(user_id, current_user.tenant_id, db)

    if body.role is not None:
        if user.id == current_user.id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cannot change your own role")
        _check_role_escalation(current_user, body.role)
        user.role = body.role

    if body.is_active is not None:
        if user.id == current_user.id and not body.is_active:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cannot deactivate your own account")
        user.is_active = body.is_active

    if body.email is not None:
        user.email = body.email
    if body.full_name is not None:
        user.full_name = body.full_name

    await db.commit()
    await db.refresh(user)
    logger.info("user_updated", target_user=str(user_id), by=str(current_user.id))
    return UserRead.model_validate(user)


@router.post("/{user_id}/reset-password", summary="Reset a user's password")
async def reset_password(
    user_id: uuid.UUID,
    body: PasswordReset,
    current_user: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> Response:
    user = await _get_user(user_id, current_user.tenant_id, db)

    if len(body.new_password) < 8:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Password must be at least 8 characters")

    # Non-superadmin can't reset a superadmin's password
    if user.role == "superadmin" and current_user.role != "superadmin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cannot reset a superadmin's password")

    user.password_hash = _hash(body.new_password)
    await db.commit()
    logger.info("password_reset", target_user=str(user_id), by=str(current_user.id))
    return Response(status_code=204)
