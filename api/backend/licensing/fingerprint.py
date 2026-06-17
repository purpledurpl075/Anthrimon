"""Stable machine fingerprint for node-locked licensing.

The fingerprint binds a license to one host. We prefer identifiers that survive
reboots and NIC changes, and hash them so the stored/transmitted value is opaque:

  1. /etc/machine-id            (systemd — stable, survives NIC swaps)  [preferred]
  2. DMI product_uuid           (SMBIOS hardware UUID)                  [fallback]
  3. first non-virtual MAC      (last resort)                          [fragile]

The result is "sha256:<hex>" over a salted identity. The salt is a fixed package
constant — it only makes the value opaque, it is not a secret.
"""
from __future__ import annotations

import glob
import hashlib
import os

# Fixed salt — opacity only, not a secret. Do not change once licenses are issued.
_SALT = b"anthrimon-license-fingerprint-v1"

_VIRTUAL_IF_PREFIXES = (
    "lo", "docker", "veth", "br-", "virbr", "vnet", "wg", "tun", "tap",
    "cni", "flannel", "cali", "kube", "ovs", "dummy", "bond0.",
)


def _machine_id() -> str | None:
    for path in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
        try:
            with open(path) as f:
                v = f.read().strip()
            if v:
                return "mid:" + v
        except OSError:
            continue
    return None


def _product_uuid() -> str | None:
    try:
        with open("/sys/class/dmi/id/product_uuid") as f:
            v = f.read().strip()
        if v and v.lower() not in ("", "none", "00000000-0000-0000-0000-000000000000"):
            return "duid:" + v
    except OSError:
        pass
    return None


def _first_physical_mac() -> str | None:
    best: str | None = None
    for path in sorted(glob.glob("/sys/class/net/*/address")):
        ifname = path.split("/")[-2]
        if ifname.startswith(_VIRTUAL_IF_PREFIXES):
            continue
        try:
            with open(path) as f:
                mac = f.read().strip()
        except OSError:
            continue
        if not mac or mac == "00:00:00:00:00:00":
            continue
        # Skip locally-administered/random MACs (2nd-least-significant bit of byte 0).
        try:
            if int(mac.split(":")[0], 16) & 0x02:
                continue
        except ValueError:
            continue
        best = "mac:" + mac
        break
    return best


def raw_identity() -> str:
    """Return the chosen stable identity (pre-hash), with its source prefix."""
    return _machine_id() or _product_uuid() or _first_physical_mac() or "unknown:none"


def machine_fingerprint() -> str:
    """Return the salted, hashed machine fingerprint as 'sha256:<hex>'."""
    ident = raw_identity().encode()
    digest = hashlib.sha256(_SALT + b"|" + ident).hexdigest()
    return "sha256:" + digest
