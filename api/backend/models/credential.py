from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from typing import Optional

from sqlalchemy import ForeignKey, Integer, PrimaryKeyConstraint, Text, func
from sqlalchemy.dialects.postgresql import ENUM as PgEnum, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base

if TYPE_CHECKING:
    from .device import Device


class Credential(Base):
    """Encrypted credential set (SNMP community, gNMI TLS certs, SSH keys).
    Shared across many devices; encrypted by the application before storage."""
    __tablename__ = "credentials"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    site_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("sites.id", ondelete="SET NULL"))
    name: Mapped[str] = mapped_column(Text, nullable=False)
    type: Mapped[str] = mapped_column(
        PgEnum("snmp_v2c", "snmp_v3", "gnmi_tls", "ssh", "api_token", "netconf",
               name="credential_type", create_type=False),
        nullable=False,
    )
    data: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default="{}")
    created_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())


class DeviceCredential(Base):
    """Ordered credential set to try per device (priority 0 = try first)."""
    __tablename__ = "device_credentials"
    __table_args__ = (PrimaryKeyConstraint("device_id", "credential_id"),)

    device_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("devices.id", ondelete="CASCADE"))
    credential_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("credentials.id", ondelete="CASCADE"))
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
