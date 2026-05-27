from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, Text, func
from sqlalchemy.dialects.postgresql import ENUM as PgEnum, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base


class ConfigBackup(Base):
    __tablename__ = "config_backups"

    id:               Mapped[uuid.UUID]         = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    device_id:        Mapped[uuid.UUID]         = mapped_column(UUID(as_uuid=True), ForeignKey("devices.id", ondelete="CASCADE"), nullable=False)
    collected_at:     Mapped[datetime]          = mapped_column(DateTime(timezone=True), nullable=False)
    config_text:      Mapped[str]               = mapped_column(Text, nullable=False)
    config_hash:      Mapped[str]               = mapped_column(Text, nullable=False)
    collection_method:Mapped[str]               = mapped_column(Text, nullable=False)
    is_latest:        Mapped[bool]              = mapped_column(Boolean, nullable=False, default=False)
    created_at:       Mapped[datetime]          = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class ConfigDiff(Base):
    __tablename__ = "config_diffs"

    id:             Mapped[uuid.UUID]           = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    device_id:      Mapped[uuid.UUID]           = mapped_column(UUID(as_uuid=True), ForeignKey("devices.id", ondelete="CASCADE"), nullable=False)
    prev_backup_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("config_backups.id", ondelete="SET NULL"), nullable=True)
    curr_backup_id: Mapped[uuid.UUID]           = mapped_column(UUID(as_uuid=True), ForeignKey("config_backups.id", ondelete="CASCADE"), nullable=False)
    diff_text:      Mapped[str]                 = mapped_column(Text, nullable=False)
    lines_added:    Mapped[int]                 = mapped_column(Integer, nullable=False, default=0)
    lines_removed:  Mapped[int]                 = mapped_column(Integer, nullable=False, default=0)
    created_at:     Mapped[datetime]            = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class CompliancePolicy(Base):
    __tablename__ = "compliance_policies"

    id:              Mapped[uuid.UUID]          = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id:       Mapped[uuid.UUID]          = mapped_column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="RESTRICT"), nullable=False)
    name:            Mapped[str]               = mapped_column(Text, nullable=False)
    description:     Mapped[Optional[str]]     = mapped_column(Text)
    is_enabled:      Mapped[bool]              = mapped_column(Boolean, nullable=False, default=True)
    device_selector: Mapped[Optional[dict]]    = mapped_column(JSONB)
    rules:           Mapped[list]              = mapped_column(JSONB, nullable=False, default=list)
    severity:        Mapped[str]               = mapped_column(
        PgEnum("critical", "major", "minor", "warning", "info",
               name="alert_severity", create_type=False),
        nullable=False, default="warning",
    )
    created_at:      Mapped[datetime]          = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at:      Mapped[datetime]          = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class ComplianceResult(Base):
    __tablename__ = "compliance_results"

    id:         Mapped[uuid.UUID]          = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    device_id:  Mapped[uuid.UUID]          = mapped_column(UUID(as_uuid=True), ForeignKey("devices.id", ondelete="CASCADE"), nullable=False)
    policy_id:  Mapped[uuid.UUID]          = mapped_column(UUID(as_uuid=True), ForeignKey("compliance_policies.id", ondelete="CASCADE"), nullable=False)
    backup_id:  Mapped[Optional[uuid.UUID]]= mapped_column(UUID(as_uuid=True), ForeignKey("config_backups.id", ondelete="SET NULL"), nullable=True)
    checked_at: Mapped[datetime]           = mapped_column(DateTime(timezone=True), nullable=False)
    status:     Mapped[str]               = mapped_column(Text, nullable=False)  # pass / fail / error
    findings:   Mapped[list]              = mapped_column(JSONB, nullable=False, default=list)
    created_at: Mapped[datetime]          = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
