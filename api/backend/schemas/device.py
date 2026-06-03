from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, IPvAnyAddress, field_validator


_VALID_VENDORS = frozenset({
    "cisco_ios", "cisco_iosxe", "cisco_iosxr", "cisco_nxos",
    "juniper", "arista", "aruba_cx", "fortios", "procurve", "unknown",
})
_VALID_DEVICE_TYPES = frozenset({
    "router", "switch", "firewall", "load_balancer", "wireless_controller", "unknown",
})


class DeviceCreate(BaseModel):
    hostname: Optional[str] = None
    mgmt_ip: IPvAnyAddress
    vendor: str = "unknown"
    device_type: str = "unknown"

    @field_validator("vendor")
    @classmethod
    def coerce_vendor(cls, v: str) -> str:
        return v if v in _VALID_VENDORS else "unknown"

    @field_validator("device_type")
    @classmethod
    def coerce_device_type(cls, v: str) -> str:
        return v if v in _VALID_DEVICE_TYPES else "unknown"
    platform: Optional[str] = None
    os_version: Optional[str] = None
    serial_number: Optional[str] = None
    collection_method: str = "snmp"
    snmp_version: str = "v2c"
    snmp_port: int = 161
    gnmi_port: int = 57400
    gnmi_tls: bool = True
    polling_interval_s: int = Field(default=15, ge=10, le=86400)
    site_id: Optional[uuid.UUID] = None
    collector_id: Optional[uuid.UUID] = None
    credential_id: Optional[uuid.UUID] = None  # if set, linked atomically on create
    tags: list[str] = []
    notes: Optional[str] = None


class DeviceUpdate(BaseModel):
    """All fields optional — PATCH semantics."""
    hostname: Optional[str] = None
    mgmt_ip: Optional[IPvAnyAddress] = None
    vendor: Optional[str] = None
    device_type: Optional[str] = None
    platform: Optional[str] = None
    os_version: Optional[str] = None
    serial_number: Optional[str] = None
    collection_method: Optional[str] = None
    snmp_version: Optional[str] = None
    snmp_port: Optional[int] = None
    gnmi_port: Optional[int] = None
    gnmi_tls: Optional[bool] = None
    polling_interval_s: Optional[int] = None
    site_id: Optional[uuid.UUID] = None
    collector_id: Optional[uuid.UUID] = None
    tags: Optional[list[str]] = None
    notes: Optional[str] = None
    is_active: Optional[bool] = None
    rest_collection_enabled: Optional[bool] = None


class SiteEmbedded(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    location: Optional[str] = None


class HealthEmbedded(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    collected_at: datetime
    cpu_util_pct: Optional[float] = None
    mem_used_bytes: Optional[int] = None
    mem_total_bytes: Optional[int] = None
    temperatures: list[Any] = []
    uptime_seconds: Optional[int] = None


class DeviceRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tenant_id: uuid.UUID
    hostname: str

    @field_validator("mgmt_ip", mode="before")
    @classmethod
    def coerce_ip(cls, v: object) -> str:
        return str(v).split("/")[0]
    fqdn: Optional[str] = None
    mgmt_ip: str
    vendor: str
    device_type: str
    platform: Optional[str] = None
    os_version: Optional[str] = None
    serial_number: Optional[str] = None
    sys_description: Optional[str] = None
    sys_location: Optional[str] = None
    sys_contact: Optional[str] = None
    collection_method: str
    snmp_version: str
    snmp_port: int
    gnmi_port: int
    gnmi_tls: bool
    polling_interval_s: int
    status: str
    last_seen: Optional[datetime] = None
    last_polled: Optional[datetime] = None
    is_active: bool
    rest_collection_enabled: bool = False
    tags: list[Any] = []
    notes: Optional[str] = None
    alert_exclusions: dict = {}
    site_id: Optional[uuid.UUID] = None
    collector_id: Optional[uuid.UUID] = None
    created_at: datetime
    updated_at: datetime

    # Optionally included when ?include=health
    health: Optional[HealthEmbedded] = None
    site: Optional[SiteEmbedded] = None


class DeviceListRead(BaseModel):
    """Lighter response for list views — no embedded objects."""
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    hostname: str
    fqdn: Optional[str] = None
    mgmt_ip: str

    @field_validator("mgmt_ip", mode="before")
    @classmethod
    def coerce_ip(cls, v: object) -> str:
        return str(v).split("/")[0]
    vendor: str
    device_type: str
    platform: Optional[str] = None
    status: str
    last_seen: Optional[datetime] = None
    site_id: Optional[uuid.UUID] = None
    tags: list[Any] = []
    is_active: bool
