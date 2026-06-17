from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, Numeric, Text, func
from sqlalchemy.dialects.postgresql import INET, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base

if TYPE_CHECKING:
    from .device import Device


class Site(Base):
    __tablename__ = "sites"

    id:          Mapped[uuid.UUID]      = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id:   Mapped[uuid.UUID]      = mapped_column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    name:        Mapped[str]            = mapped_column(Text, nullable=False)
    description: Mapped[Optional[str]]  = mapped_column(Text)
    location:    Mapped[Optional[str]]  = mapped_column(Text)
    latitude:    Mapped[Optional[float]]= mapped_column(Numeric(9, 6))
    longitude:   Mapped[Optional[float]]= mapped_column(Numeric(9, 6))
    tags:        Mapped[list]           = mapped_column(JSONB, nullable=False, server_default="[]")
    created_at:  Mapped[datetime]       = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at:  Mapped[datetime]       = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    devices:    Mapped[list["Device"]]         = relationship("Device",          back_populates="site",       lazy="noload")
    collectors: Mapped[list["RemoteCollector"]] = relationship("RemoteCollector", back_populates="site",       lazy="noload")


class RemoteCollector(Base):
    """Branch-site collector that phones home over a WireGuard VPN tunnel."""
    __tablename__ = "remote_collectors"

    # ── Identity ──────────────────────────────────────────────────────────────
    id:        Mapped[uuid.UUID]     = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID]     = mapped_column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    site_id:   Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("sites.id"))
    name:      Mapped[str]           = mapped_column(Text, nullable=False)
    hostname:  Mapped[Optional[str]] = mapped_column(Text)

    # ── Bootstrap authentication ──────────────────────────────────────────────
    # One-time registration token — hashed before storage.
    # Set at creation, cleared after successful bootstrap.
    token_hash:       Mapped[str]              = mapped_column(Text, nullable=False, unique=True)
    token_expires_at: Mapped[Optional[datetime]]= mapped_column(DateTime(timezone=True))

    # ── Ongoing API authentication ────────────────────────────────────────────
    # Returned to the collector at bootstrap; used for all subsequent requests.
    api_key_hash: Mapped[Optional[str]] = mapped_column(Text, unique=True)

    # ── WireGuard ─────────────────────────────────────────────────────────────
    wg_public_key: Mapped[Optional[str]] = mapped_column(Text)          # Curve25519 base64
    wg_ip:         Mapped[Optional[str]] = mapped_column(INET, unique=True)  # e.g. 10.100.0.2

    # ── Runtime state ─────────────────────────────────────────────────────────
    status:        Mapped[str]              = mapped_column(Text, nullable=False, default="pending")
    # pending → bootstrapped but never seen
    # online  → heartbeat within last 2 minutes
    # offline → heartbeat overdue
    ip_address:    Mapped[Optional[str]]    = mapped_column(INET)        # public IP seen at bootstrap
    version:       Mapped[Optional[str]]    = mapped_column(Text)        # collector binary version
    capabilities:  Mapped[list]             = mapped_column(JSONB, nullable=False, server_default='["snmp","flow","syslog"]')
    last_seen:     Mapped[Optional[datetime]]= mapped_column(DateTime(timezone=True))
    registered_at: Mapped[Optional[datetime]]= mapped_column(DateTime(timezone=True))

    # ── Configuration ─────────────────────────────────────────────────────────
    # IANA timezone for devices at this collector's site — used to interpret
    # RFC 3164 syslog timestamps, which carry no timezone info.
    timezone: Mapped[str] = mapped_column(Text, nullable=False, server_default="UTC")

    # Per-collector poll cadence overrides (NULL = platform defaults: 15s state, 60s counter).
    state_interval_s:   Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    counter_interval_s: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # ── Lifecycle ─────────────────────────────────────────────────────────────
    is_active:  Mapped[bool]     = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    site: Mapped[Optional["Site"]] = relationship("Site", back_populates="collectors", lazy="noload")


class WgIpPool(Base):
    """WireGuard overlay IP allocation pool (10.100.0.0/24)."""
    __tablename__ = "wg_ip_pool"

    ip:           Mapped[str]              = mapped_column(INET, primary_key=True)
    assigned_to:  Mapped[Optional[uuid.UUID]]= mapped_column(UUID(as_uuid=True), ForeignKey("remote_collectors.id", ondelete="SET NULL"))
    allocated:    Mapped[bool]             = mapped_column(Boolean, nullable=False, default=False)
    allocated_at: Mapped[Optional[datetime]]= mapped_column(DateTime(timezone=True))
