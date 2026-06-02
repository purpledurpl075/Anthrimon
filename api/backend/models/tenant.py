from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import ARRAY, CITEXT, ENUM, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base

if TYPE_CHECKING:
    from .device import Device
    from .alert import Alert, AlertRule


class Tenant(Base):
    __tablename__ = "tenants"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    slug: Mapped[str] = mapped_column(CITEXT, nullable=False, unique=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    settings: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default="{}")
    created_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())

    users: Mapped[list["User"]] = relationship("User", back_populates="tenant", lazy="noload")
    devices: Mapped[list["Device"]] = relationship("Device", back_populates="tenant", lazy="noload")


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    username: Mapped[str] = mapped_column(CITEXT, nullable=False)
    email: Mapped[str] = mapped_column(CITEXT, nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    full_name: Mapped[Optional[str]] = mapped_column(Text)
    role: Mapped[str] = mapped_column(
        ENUM('superadmin', 'admin', 'operator', 'readonly', name='user_role', create_type=False),
        nullable=False, default="readonly",
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # Platform-plane fields (Phase A)
    is_platform_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    platform_role: Mapped[Optional[str]] = mapped_column(Text)  # 'platform_admin' | 'platform_support' | None
    last_login: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())

    tenant: Mapped["Tenant"] = relationship("Tenant", back_populates="users", lazy="noload")
    api_tokens: Mapped[list["ApiToken"]] = relationship("ApiToken", back_populates="user", lazy="noload")
    site_roles: Mapped[list["UserSiteRole"]] = relationship("UserSiteRole", back_populates="user", lazy="noload")


class ApiToken(Base):
    """Long-lived tokens for collector and dashboard API access (pre-Keycloak)."""
    __tablename__ = "api_tokens"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    user_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    name: Mapped[str] = mapped_column(Text, nullable=False)
    token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    scopes: Mapped[list] = mapped_column(JSONB, nullable=False, server_default="[]")
    # site_ids: empty list means full-tenant scope; non-empty restricts the token to those sites
    site_ids: Mapped[list] = mapped_column(ARRAY(UUID(as_uuid=True)), nullable=False, server_default="{}")
    last_used: Mapped[Optional[datetime]] = mapped_column()
    expires_at: Mapped[Optional[datetime]] = mapped_column()
    created_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())

    user: Mapped[Optional["User"]] = relationship("User", back_populates="api_tokens", lazy="noload")


class UserSiteRole(Base):
    """Site-scoped RBAC grant.  Absence of a row → tenant-level role applies."""
    __tablename__ = "user_site_roles"

    user_id:    Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id",   ondelete="CASCADE"), primary_key=True)
    site_id:    Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("sites.id",   ondelete="CASCADE"), primary_key=True)
    tenant_id:  Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    role:       Mapped[str]       = mapped_column(Text, nullable=False)  # 'readonly' | 'operator' | 'admin'
    created_at: Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    user: Mapped["User"] = relationship("User", back_populates="site_roles", lazy="noload")


class UserTenantAccess(Base):
    """Cross-tenant access grant managed by platform admins.
    Home tenant (users.tenant_id) is always accessible without a row here."""
    __tablename__ = "user_tenant_access"

    user_id:    Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id",   ondelete="CASCADE"), primary_key=True)
    tenant_id:  Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), primary_key=True)
    role:       Mapped[str]       = mapped_column(Text, nullable=False, default="readonly")
    granted_at: Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
