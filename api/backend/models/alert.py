from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Optional

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import ARRAY, ENUM as PgEnum, INET, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base

if TYPE_CHECKING:
    from .device import Device
    from .interface import Interface
    from .tenant import User


class NotificationChannel(Base):
    __tablename__ = "notification_channels"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    site_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("sites.id", ondelete="SET NULL"))
    name: Mapped[str] = mapped_column(Text, nullable=False)
    type: Mapped[str] = mapped_column(
        PgEnum("email", "slack", "webhook", "pagerduty", "teams",
               name="notification_type", create_type=False),
        nullable=False,
    )
    config: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default="{}")
    is_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())


class MaintenanceWindow(Base):
    __tablename__ = "maintenance_windows"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    site_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("sites.id", ondelete="SET NULL"))
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text)
    device_selector: Mapped[Optional[dict]] = mapped_column(JSONB)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    is_recurring: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    recurrence_cron: Mapped[Optional[str]] = mapped_column(Text)
    created_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())


class AlertPolicy(Base):
    __tablename__ = "alert_policies"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text)
    is_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_builtin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    device_selector: Mapped[Optional[dict]] = mapped_column(JSONB)
    site_ids: Mapped[Optional[list]] = mapped_column(ARRAY(UUID(as_uuid=True)))
    created_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())

    rules: Mapped[list["AlertRule"]] = relationship("AlertRule", back_populates="policy", lazy="noload")


class AlertRule(Base):
    __tablename__ = "alert_rules"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    policy_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("alert_policies.id"))
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text)
    is_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    device_selector: Mapped[Optional[dict]] = mapped_column(JSONB)
    metric: Mapped[str] = mapped_column(Text, nullable=False)
    condition: Mapped[str] = mapped_column(String(10), nullable=False)
    threshold: Mapped[Optional[float]] = mapped_column()
    duration_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    renotify_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=3600)
    severity: Mapped[str] = mapped_column(
        PgEnum("critical", "major", "minor", "warning", "info",
               name="alert_severity", create_type=False),
        nullable=False, default="warning",
    )
    # Escalation
    escalation_severity: Mapped[Optional[str]] = mapped_column(
        PgEnum("critical", "major", "minor", "warning", "info",
               name="alert_severity", create_type=False),
    )
    escalation_seconds: Mapped[Optional[int]] = mapped_column(Integer)
    # Flap suppression
    stable_for_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Correlated suppression
    suppress_if_parent_down: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    parent_device_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("devices.id"))
    # Baseline deviation
    baseline_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    baseline_deviation_pct: Mapped[Optional[float]] = mapped_column()
    # Multi-condition AND
    extra_conditions: Mapped[list] = mapped_column(JSONB, nullable=False, server_default="[]")
    # Site scoping (NULL = tenant-wide)
    site_ids: Mapped[Optional[list]] = mapped_column(ARRAY(UUID(as_uuid=True)))
    # Notifications
    notify_on_resolve: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    custom_oid: Mapped[Optional[str]] = mapped_column(Text)
    channel_ids: Mapped[list] = mapped_column(JSONB, nullable=False, server_default="[]")
    maintenance_window_ids: Mapped[list] = mapped_column(JSONB, nullable=False, server_default="[]")
    created_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())

    policy: Mapped[Optional["AlertPolicy"]] = relationship("AlertPolicy", back_populates="rules", lazy="noload")
    alerts: Mapped[list["Alert"]] = relationship("Alert", back_populates="rule", lazy="noload")


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    rule_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("alert_rules.id"))
    device_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("devices.id", ondelete="CASCADE"))
    interface_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("interfaces.id"))
    severity: Mapped[str] = mapped_column(
        PgEnum("critical", "major", "minor", "warning", "info",
               name="alert_severity", create_type=False),
        nullable=False,
    )
    status: Mapped[str] = mapped_column(
        PgEnum("open", "acknowledged", "resolved", "suppressed", "expired",
               name="alert_status", create_type=False),
        nullable=False, default="open",
    )
    title: Mapped[str] = mapped_column(Text, nullable=False)
    message: Mapped[Optional[str]] = mapped_column(Text)
    context: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default="{}")
    triggered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    acknowledged_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    acknowledged_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    resolved_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    correlation_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True))
    fingerprint: Mapped[Optional[str]] = mapped_column(Text)
    last_notified_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())

    device: Mapped[Optional["Device"]] = relationship("Device", back_populates="alerts", lazy="noload")
    rule: Mapped[Optional["AlertRule"]] = relationship("AlertRule", back_populates="alerts", lazy="noload")


class AlertComment(Base):
    __tablename__ = "alert_comments"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    alert_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("alerts.id", ondelete="CASCADE"), nullable=False)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())


class NotificationSendLog(Base):
    __tablename__ = "notification_send_log"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    channel_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("notification_channels.id", ondelete="CASCADE"), nullable=False)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    alert_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("alerts.id", ondelete="SET NULL"))
    event: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    error: Mapped[Optional[str]] = mapped_column(Text)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class AuditLog(Base):
    """Append-only audit trail. Use BIGSERIAL for fast sequential inserts."""
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("tenants.id"))
    user_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    # Maps to PostgreSQL audit_action enum
    action: Mapped[str] = mapped_column(String(30), nullable=False)
    resource_type: Mapped[Optional[str]] = mapped_column(Text)
    resource_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True))
    old_value: Mapped[Optional[dict]] = mapped_column(JSONB)
    new_value: Mapped[Optional[dict]] = mapped_column(JSONB)
    ip_address: Mapped[Optional[str]] = mapped_column(INET)
    user_agent: Mapped[Optional[str]] = mapped_column(Text)
    # Site context and acting-as support (Phase A)
    site_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("sites.id", ondelete="SET NULL"))
    acted_as_tenant_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())
