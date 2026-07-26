"""Shared SNMP probe helpers used by both discovery sweeps and single-device probing."""
from __future__ import annotations

import asyncio
import re
from typing import Optional

VENDOR_DEVICE_TYPE: dict[str, str] = {
    "arista":       "switch",
    "aruba_cx":     "switch",
    "procurve":     "switch",
    "cisco_nxos":   "switch",
    "cisco_ios":    "router",
    "cisco_iosxe":  "router",
    "cisco_iosxr":  "router",
    "juniper":      "router",
    "fortios":      "firewall",
}

# Juniper spans switches (EX), routers (MX/M/T/PTX/ACX), and firewalls (SRX)
# under one vendor string — VENDOR_DEVICE_TYPE's flat per-vendor default can't
# tell them apart, so refine from sysDescr for this vendor only.
_JUNIPER_DEVICE_TYPE_PATTERNS: list[tuple[str, str]] = [
    (r"\bSRX\b", "firewall"),
    (r"Ethernet Switch|\bEX\d", "switch"),
]


def detect_device_type(vendor: str, sys_descr: str) -> str:
    """Return the device_type for a probed device, refining VENDOR_DEVICE_TYPE's
    flat per-vendor default using sysDescr where one vendor spans hardware
    classes (currently just Juniper)."""
    if vendor == "juniper":
        for pattern, device_type in _JUNIPER_DEVICE_TYPE_PATTERNS:
            if re.search(pattern, sys_descr, re.IGNORECASE):
                return device_type
    return VENDOR_DEVICE_TYPE.get(vendor, "unknown")


# Extracts the model token from a vendor's sysDescr, e.g. "ex3300-48p" from
# "Juniper Networks, Inc. ex3300-48p Ethernet Switch, kernel JUNOS ...".
_PLATFORM_PATTERNS: dict[str, str] = {
    "juniper": r"Juniper Networks,\s*Inc\.\s+(\S+)",
}


def detect_platform(vendor: str, sys_descr: str) -> str:
    """Return the hardware model string extracted from sysDescr, or ''."""
    pattern = _PLATFORM_PATTERNS.get(vendor)
    if not pattern:
        return ""
    m = re.search(pattern, sys_descr)
    return m.group(1) if m else ""

from .schemas.discovery import DiscoveredDevice

_VENDOR_PREFIXES: list[tuple[str, str]] = [
    ("1.3.6.1.4.1.2636.",   "juniper"),
    ("1.3.6.1.4.1.30065.",  "arista"),
    ("1.3.6.1.4.1.12356.",  "fortios"),
    ("1.3.6.1.4.1.47196.",  "aruba_cx"),
    ("1.3.6.1.4.1.11.",     "procurve"),
    ("1.3.6.1.4.1.9.12.",   "cisco_nxos"),
    ("1.3.6.1.4.1.9.6.",    "cisco_iosxe"),
    ("1.3.6.1.4.1.9.1.",    "cisco_ios"),
    ("1.3.6.1.4.1.9.",      "cisco_ios"),
]
_SYSDESCR_OVERRIDES: list[tuple[str, str, str]] = [
    ("cisco_ios", r"NX-OS",  "cisco_nxos"),
    ("cisco_ios", r"IOS-XR", "cisco_iosxr"),
]

_AUTH_PROTO_MAP = {
    "md5":    "usmHMACMD5AuthProtocol",
    "sha":    "usmHMACSHAAuthProtocol",
    "sha256": "usmHMAC192SHA256AuthProtocol",
    "sha512": "usmHMAC384SHA512AuthProtocol",
}
_PRIV_PROTO_MAP = {
    "des":    "usmDESPrivProtocol",
    "aes":    "usmAesCfb128Protocol",
    "aes192": "usmAesCfb192Protocol",
    "aes256": "usmAesCfb256Protocol",
}

_SYS_DESCR     = "1.3.6.1.2.1.1.1.0"
_SYS_OBJECT_ID = "1.3.6.1.2.1.1.2.0"
_SYS_NAME      = "1.3.6.1.2.1.1.5.0"


def detect_vendor(sys_object_id: str, sys_descr: str) -> str:
    vendor = "unknown"
    for prefix, v in _VENDOR_PREFIXES:
        if sys_object_id.startswith(prefix):
            vendor = v
            break
    for oid_vendor, pattern, corrected in _SYSDESCR_OVERRIDES:
        if vendor == oid_vendor and re.search(pattern, sys_descr, re.IGNORECASE):
            vendor = corrected
            break
    return vendor


async def probe_v2c(ip: str, community: str, port: int, timeout: int) -> Optional[DiscoveredDevice]:
    from pysnmp.hlapi.v3arch.asyncio import (
        CommunityData, ContextData, ObjectIdentity, ObjectType,
        SnmpEngine, UdpTransportTarget, get_cmd,
    )
    engine = SnmpEngine()
    try:
        transport = await UdpTransportTarget.create((ip, port), timeout=timeout, retries=0)
        err_indication, err_status, _, var_binds = await get_cmd(
            engine, CommunityData(community, mpModel=1), transport, ContextData(),
            ObjectType(ObjectIdentity(_SYS_DESCR)),
            ObjectType(ObjectIdentity(_SYS_OBJECT_ID)),
            ObjectType(ObjectIdentity(_SYS_NAME)),
        )
        if err_indication or err_status:
            return None
        sys_descr = str(var_binds[0][1]) if len(var_binds) > 0 else ""
        sys_oid   = str(var_binds[1][1]) if len(var_binds) > 1 else ""
        sys_name  = str(var_binds[2][1]) if len(var_binds) > 2 else ip
        return DiscoveredDevice(
            ip=ip, hostname=sys_name, vendor=detect_vendor(sys_oid, sys_descr),
            sys_descr=sys_descr, sys_object_id=sys_oid, already_in_db=False,
        )
    except asyncio.CancelledError:
        raise
    except Exception:
        return None


async def probe_v3(ip: str, cred_data: dict, port: int, timeout: int) -> Optional[DiscoveredDevice]:
    from pysnmp.hlapi.v3arch.asyncio import (
        ContextData, ObjectIdentity, ObjectType, SnmpEngine,
        UdpTransportTarget, UsmUserData, get_cmd,
    )
    import pysnmp.hlapi.v3arch.asyncio as hlapi
    auth_proto = getattr(hlapi, _AUTH_PROTO_MAP.get(
        cred_data.get("auth_protocol", "sha256").lower(), "usmHMAC192SHA256AuthProtocol"))
    priv_proto = getattr(hlapi, _PRIV_PROTO_MAP.get(
        cred_data.get("priv_protocol", "aes").lower(), "usmAesCfb128Protocol"))
    engine = SnmpEngine()
    try:
        transport = await UdpTransportTarget.create((ip, port), timeout=timeout, retries=0)
        err_indication, err_status, _, var_binds = await get_cmd(
            engine,
            UsmUserData(cred_data["username"], authKey=cred_data.get("auth_key", ""),
                        privKey=cred_data.get("priv_key", ""),
                        authProtocol=auth_proto, privProtocol=priv_proto),
            transport, ContextData(),
            ObjectType(ObjectIdentity(_SYS_DESCR)),
            ObjectType(ObjectIdentity(_SYS_OBJECT_ID)),
            ObjectType(ObjectIdentity(_SYS_NAME)),
        )
        if err_indication or err_status:
            return None
        sys_descr = str(var_binds[0][1]) if len(var_binds) > 0 else ""
        sys_oid   = str(var_binds[1][1]) if len(var_binds) > 1 else ""
        sys_name  = str(var_binds[2][1]) if len(var_binds) > 2 else ip
        return DiscoveredDevice(
            ip=ip, hostname=sys_name, vendor=detect_vendor(sys_oid, sys_descr),
            sys_descr=sys_descr, sys_object_id=sys_oid, already_in_db=False,
        )
    except asyncio.CancelledError:
        raise
    except Exception:
        return None
