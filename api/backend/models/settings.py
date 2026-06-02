from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import ForeignKey, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base


class SystemSetting(Base):
    """Deprecated: global key/value store.  Kept for backward-compat reads during
    Phase A.  New code should read from TenantSetting or PlatformSetting."""
    __tablename__ = "system_settings"

    key: Mapped[str] = mapped_column(Text, primary_key=True)
    value: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default="{}")
    updated_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())


class PlatformSetting(Base):
    """Truly global (cross-tenant) settings.  Only platform_admin may write."""
    __tablename__ = "platform_settings"

    key: Mapped[str] = mapped_column(Text, primary_key=True)
    value: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default="{}")
    updated_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())


class TenantSetting(Base):
    """Per-tenant settings.  One row per tenant; settings JSONB bag."""
    __tablename__ = "tenant_settings"

    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), primary_key=True
    )
    settings: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default="{}")
    updated_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())


class TenantEmailTemplate(Base):
    """Per-tenant per-metric email template override.
    metric='default' is the tenant-wide fallback.  Look-up order:
    tenant+metric → tenant+default → global system_settings fallback."""
    __tablename__ = "tenant_email_templates"

    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), primary_key=True
    )
    metric: Mapped[str] = mapped_column(Text, primary_key=True)
    subject: Mapped[Optional[str]] = mapped_column(Text)
    html: Mapped[Optional[str]] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())
