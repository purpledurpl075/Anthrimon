from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Optional

from sqlalchemy import BigInteger, Boolean, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, MACADDR, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base

if TYPE_CHECKING:
    from .device import Device


class Interface(Base):
    __tablename__ = "interfaces"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    device_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("devices.id", ondelete="CASCADE"), nullable=False)
    if_index: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text)
    if_type: Mapped[Optional[str]] = mapped_column(Text)
    speed_bps: Mapped[Optional[int]] = mapped_column(BigInteger)
    mtu: Mapped[Optional[int]] = mapped_column(Integer)
    mac_address: Mapped[Optional[str]] = mapped_column(MACADDR)

    # Maps to PostgreSQL if_status enum
    admin_status: Mapped[str] = mapped_column(String(20), nullable=False, default="unknown")
    oper_status: Mapped[str] = mapped_column(String(20), nullable=False, default="unknown")

    last_change: Mapped[Optional[datetime]] = mapped_column()
    ip_addresses: Mapped[list] = mapped_column(JSONB, nullable=False, server_default="[]")
    vrf: Mapped[Optional[str]] = mapped_column(Text)
    is_uplink: Mapped[Optional[bool]] = mapped_column(Boolean)

    created_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())

    device: Mapped["Device"] = relationship("Device", back_populates="interfaces", lazy="noload")


class LLDPNeighbor(Base):
    __tablename__ = "lldp_neighbors"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    device_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("devices.id", ondelete="CASCADE"), nullable=False)
    local_port_name: Mapped[str] = mapped_column(Text, nullable=False)
    remote_chassis_id_subtype: Mapped[Optional[str]] = mapped_column(Text)
    remote_chassis_id: Mapped[Optional[str]] = mapped_column(Text)
    remote_port_id_subtype: Mapped[Optional[str]] = mapped_column(Text)
    remote_port_id: Mapped[Optional[str]] = mapped_column(Text)
    remote_port_desc: Mapped[Optional[str]] = mapped_column(Text)
    remote_system_name: Mapped[Optional[str]] = mapped_column(Text)
    remote_mgmt_ip: Mapped[Optional[str]] = mapped_column(Text)
    remote_system_capabilities: Mapped[list] = mapped_column(JSONB, nullable=False, server_default="[]")
    ttl: Mapped[Optional[int]] = mapped_column(Integer)
    updated_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())


class CDPNeighbor(Base):
    __tablename__ = "cdp_neighbors"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    device_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("devices.id", ondelete="CASCADE"), nullable=False)
    local_port_name: Mapped[str] = mapped_column(Text, nullable=False)
    remote_device_id: Mapped[Optional[str]] = mapped_column(Text)
    remote_port_id: Mapped[Optional[str]] = mapped_column(Text)
    remote_mgmt_ip: Mapped[Optional[str]] = mapped_column(Text)
    remote_platform: Mapped[Optional[str]] = mapped_column(Text)
    remote_capabilities: Mapped[list] = mapped_column(JSONB, nullable=False, server_default="[]")
    native_vlan: Mapped[Optional[int]] = mapped_column(Integer)
    duplex: Mapped[Optional[str]] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())


class RouteEntry(Base):
    __tablename__ = "route_entries"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    device_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("devices.id", ondelete="CASCADE"), nullable=False)
    destination: Mapped[str] = mapped_column(Text, nullable=False)
    next_hop: Mapped[str] = mapped_column(Text, nullable=False, default="")
    protocol: Mapped[str] = mapped_column(Text, nullable=False)
    metric: Mapped[Optional[int]] = mapped_column(Integer)
    interface_name: Mapped[Optional[str]] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())


class OSPFNeighbor(Base):
    __tablename__ = "ospf_neighbors"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    device_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("devices.id", ondelete="CASCADE"), nullable=False)
    vrf: Mapped[str] = mapped_column(Text, nullable=False, default="default")
    neighbor_router_id: Mapped[Optional[str]] = mapped_column(Text)
    neighbor_ip: Mapped[Optional[str]] = mapped_column(Text)
    interface_name: Mapped[Optional[str]] = mapped_column(Text)
    area: Mapped[Optional[str]] = mapped_column(Text)
    state: Mapped[str] = mapped_column(Text, nullable=False, default="unknown")
    priority: Mapped[Optional[int]] = mapped_column(Integer)
    uptime_seconds: Mapped[Optional[int]] = mapped_column(BigInteger)
    last_state_change: Mapped[Optional[datetime]] = mapped_column()
    updated_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())


class ISISNeighbor(Base):
    __tablename__ = "isis_neighbors"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    device_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("devices.id", ondelete="CASCADE"), nullable=False)
    instance: Mapped[str] = mapped_column(Text, nullable=False, default="default")
    sys_id: Mapped[str] = mapped_column(Text, nullable=False)
    hostname: Mapped[Optional[str]] = mapped_column(Text)
    interface_name: Mapped[Optional[str]] = mapped_column(Text)
    circuit_type: Mapped[Optional[str]] = mapped_column(Text)
    adjacency_state: Mapped[str] = mapped_column(Text, nullable=False, default="unknown")
    ipv4_address: Mapped[Optional[str]] = mapped_column(Text)
    ipv6_address: Mapped[Optional[str]] = mapped_column(Text)
    uptime_seconds: Mapped[Optional[int]] = mapped_column(BigInteger)
    last_state_change: Mapped[Optional[datetime]] = mapped_column()
    updated_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())


class ISISArea(Base):
    __tablename__ = "isis_areas"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    device_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("devices.id", ondelete="CASCADE"), nullable=False)
    instance: Mapped[str] = mapped_column(Text, nullable=False, default="default")
    area_addr: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())


class ISISCircuitLevel(Base):
    __tablename__ = "isis_circuit_levels"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    device_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("devices.id", ondelete="CASCADE"), nullable=False)
    instance: Mapped[str] = mapped_column(Text, nullable=False, default="default")
    interface_name: Mapped[str] = mapped_column(Text, nullable=False)
    level: Mapped[str] = mapped_column(Text, nullable=False)
    metric: Mapped[Optional[int]] = mapped_column(Integer)
    hello_interval: Mapped[Optional[int]] = mapped_column(Integer)
    hold_timer: Mapped[Optional[int]] = mapped_column(Integer)
    priority: Mapped[Optional[int]] = mapped_column(Integer)
    dis_id: Mapped[Optional[str]] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())


class ISISLsp(Base):
    __tablename__ = "isis_lsps"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    device_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("devices.id", ondelete="CASCADE"), nullable=False)
    instance: Mapped[str] = mapped_column(Text, nullable=False, default="default")
    level: Mapped[str] = mapped_column(Text, nullable=False)
    lsp_id: Mapped[str] = mapped_column(Text, nullable=False)
    sequence_number: Mapped[Optional[int]] = mapped_column(BigInteger)
    checksum: Mapped[Optional[int]] = mapped_column(Integer)
    remaining_lifetime: Mapped[Optional[int]] = mapped_column(Integer)
    pdu_length: Mapped[Optional[int]] = mapped_column(Integer)
    overload_bit: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    attached_bit: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    updated_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())


class ARPEntry(Base):
    __tablename__ = "arp_entries"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    device_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("devices.id", ondelete="CASCADE"), nullable=False)
    ip_address: Mapped[str] = mapped_column(Text, nullable=False)
    mac_address: Mapped[str] = mapped_column(Text, nullable=False)
    interface_name: Mapped[Optional[str]] = mapped_column(Text)
    entry_type: Mapped[str] = mapped_column(Text, nullable=False, default="dynamic")
    updated_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())


class MACEntry(Base):
    __tablename__ = "mac_entries"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    device_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("devices.id", ondelete="CASCADE"), nullable=False)
    mac_address: Mapped[str] = mapped_column(Text, nullable=False)
    port_name: Mapped[Optional[str]] = mapped_column(Text)
    vlan_id: Mapped[Optional[int]] = mapped_column(Integer)
    entry_type: Mapped[str] = mapped_column(Text, nullable=False, default="learned")
    updated_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())


class InterfaceStatusLog(Base):
    """Append-only log of interface up/down transitions; drives flap detection."""
    __tablename__ = "interface_status_log"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    interface_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("interfaces.id", ondelete="CASCADE"), nullable=False)
    device_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("devices.id", ondelete="CASCADE"), nullable=False)
    prev_status: Mapped[Optional[str]] = mapped_column(String(20))
    new_status: Mapped[str] = mapped_column(String(20), nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())
