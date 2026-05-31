from __future__ import annotations

import asyncio
import hashlib
import uuid
from datetime import datetime, timezone
from typing import AsyncGenerator, Optional

import structlog
from fastapi import Depends, Header, HTTPException, Query, Request, status
import jwt as _jwt
from jwt.exceptions import InvalidTokenError as JWTError
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .config import get_settings
from .database import AsyncSessionLocal
from .models.tenant import ApiToken, User

logger = structlog.get_logger(__name__)
_settings = get_settings()


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Yield a database session per request."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise


def _hash_token(raw_token: str) -> str:
    """SHA-256 hex digest — matches what was stored at token creation time."""
    return hashlib.sha256(raw_token.encode()).hexdigest()


async def _user_from_jwt(token: str, db: AsyncSession) -> Optional[User]:
    """Decode a JWT and return the matching active User, or None."""
    try:
        payload = _jwt.decode(token, _settings.jwt_secret_key, algorithms=[_settings.jwt_algorithm])
        user_id: str = payload.get("sub")
        if not user_id:
            return None
    except JWTError:
        return None

    result = await db.execute(
        select(User).where(User.id == uuid.UUID(user_id), User.is_active == True)  # noqa: E712
    )
    return result.scalar_one_or_none()


async def _user_from_api_token(raw_token: str, db: AsyncSession) -> Optional[User]:
    """Look up a hashed API token and return its owner, or None."""
    token_hash = _hash_token(raw_token)
    result = await db.execute(
        select(ApiToken).where(ApiToken.token_hash == token_hash)
    )
    api_token = result.scalar_one_or_none()
    if api_token is None:
        return None

    # Expired tokens are rejected.
    if api_token.expires_at and api_token.expires_at < datetime.now(timezone.utc):
        return None

    if api_token.user_id is None:
        # System / collector token — return a synthetic sentinel.
        # Callers that need a real user should check for this case.
        return None

    result = await db.execute(
        select(User).where(
            User.id == api_token.user_id,
            User.tenant_id == api_token.tenant_id,
            User.is_active == True,  # noqa: E712
        )
    )
    user = result.scalar_one_or_none()

    # Touch last_used in a dedicated session so we don't flush other dirty
    # ORM objects that may be pending on the shared request session.
    if user:
        token_id = api_token.id
        async def _touch() -> None:
            async with AsyncSessionLocal() as s:
                await s.execute(
                    update(ApiToken).where(ApiToken.id == token_id)
                    .values(last_used=datetime.now(timezone.utc))
                )
                await s.commit()
        asyncio.create_task(_touch())

    return user


async def get_current_user(
    authorization: Optional[str] = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Authenticate via Bearer JWT or Bearer API token.
    Raises 401 if the token is missing or invalid."""
    credentials_exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or missing authentication credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    if not authorization or not authorization.startswith("Bearer "):
        raise credentials_exc

    raw_token = authorization.removeprefix("Bearer ").strip()

    # Try JWT first (shorter, structured), then API token.
    user = await _user_from_jwt(raw_token, db)
    if user is None:
        user = await _user_from_api_token(raw_token, db)

    if user is None:
        raise credentials_exc

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

    user = await _user_from_jwt(raw_token, db)
    if user is None:
        user = await _user_from_api_token(raw_token, db)
    if user is None:
        raise credentials_exc
    return user


def require_role(*roles: str):
    """Dependency factory: require the current user to have one of the given roles."""
    async def _check(current_user: User = Depends(get_current_user)) -> User:
        if current_user.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Role '{current_user.role}' is not permitted for this action",
            )
        return current_user
    return _check
