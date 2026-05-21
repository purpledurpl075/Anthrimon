from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, ForeignKey, Integer, Text, func
from sqlalchemy.dialects.postgresql import INET, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base


class BGPSession(Base):
    __tablename__ = "bgp_sessions"

    id:                  Mapped[uuid.UUID]          = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    device_id:           Mapped[uuid.UUID]          = mapped_column(UUID(as_uuid=True), ForeignKey("devices.id", ondelete="CASCADE"), nullable=False)
    vrf:                 Mapped[str]                = mapped_column(Text, nullable=False, default="default")
    peer_ip:             Mapped[str]                = mapped_column(INET, nullable=False)
    peer_asn:            Mapped[Optional[int]]      = mapped_column(BigInteger)
    local_asn:           Mapped[int]                = mapped_column(BigInteger, nullable=False)
    peer_router_id:      Mapped[Optional[str]]      = mapped_column(Text)
    peer_description:    Mapped[Optional[str]]      = mapped_column(Text)
    admin_status:        Mapped[str]                = mapped_column(Text, nullable=False, server_default="start")
    address_families:    Mapped[list]               = mapped_column(JSONB, nullable=False, server_default="[]")
    session_state:       Mapped[str]                = mapped_column(Text, nullable=False, default="unknown")
    prefixes_received:   Mapped[Optional[int]]      = mapped_column(Integer)
    prefixes_advertised: Mapped[Optional[int]]      = mapped_column(Integer)
    uptime_seconds:      Mapped[Optional[int]]      = mapped_column(BigInteger)
    in_updates:          Mapped[int]                = mapped_column(BigInteger, nullable=False, server_default="0")
    out_updates:         Mapped[int]                = mapped_column(BigInteger, nullable=False, server_default="0")
    flap_count:          Mapped[int]                = mapped_column(Integer, nullable=False, server_default="0")
    last_state_change:   Mapped[Optional[datetime]] = mapped_column()
    updated_at:          Mapped[datetime]           = mapped_column(nullable=False, server_default=func.now())


class BGPSessionEvent(Base):
    __tablename__ = "bgp_session_events"

    id:          Mapped[uuid.UUID]  = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id:  Mapped[uuid.UUID]  = mapped_column(UUID(as_uuid=True), ForeignKey("bgp_sessions.id", ondelete="CASCADE"), nullable=False)
    device_id:   Mapped[uuid.UUID]  = mapped_column(UUID(as_uuid=True), ForeignKey("devices.id", ondelete="CASCADE"), nullable=False)
    peer_ip:     Mapped[str]        = mapped_column(INET, nullable=False)
    prev_state:  Mapped[str]        = mapped_column(Text, nullable=False)
    new_state:   Mapped[str]        = mapped_column(Text, nullable=False)
    recorded_at: Mapped[datetime]   = mapped_column(nullable=False, server_default=func.now())
