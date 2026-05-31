"""
API Method Orchestrator — probe, enable, and auto-configure per-device API endpoints.

Supported methods:
  snmp         — SNMP v2c/v3; always active if credentials exist; not HTTP-probed
  arista_eapi  — Arista EOS command-api; probed via HTTP(S); configured via SSH
  aruba_cx_rest — ArubaOS-CX REST API; probed via HTTPS; configured via SSH
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Optional

import httpx
import structlog
from sqlalchemy import select, text

from ..database import AsyncSessionLocal
from ..models.api_method import DeviceApiMethod
from ..models.credential import Credential, DeviceCredential
from ..models.device import Device

logger = structlog.get_logger(__name__)

# ── Vendor metadata ───────────────────────────────────────────────────────────

# Methods supported per vendor — used when seeding rows for new devices
VENDOR_METHODS: dict[str, list[str]] = {
    "arista":   ["snmp", "arista_eapi"],
    "aruba_cx": ["snmp", "aruba_cx_rest"],
    "procurve": ["snmp"],
    "cisco":    ["snmp"],
    "juniper":  ["snmp"],
    "fortios":  ["snmp"],
    "unknown":  ["snmp"],
}

# Human-readable labels
METHOD_LABELS: dict[str, str] = {
    "snmp":          "SNMP",
    "arista_eapi":   "Arista eAPI",
    "aruba_cx_rest": "ArubaOS-CX REST",
    "gnmi":          "gNMI",
}

# Probe URLs per method. {ip} is substituted at runtime.
# Each list is tried in order; first success wins.
_PROBE_URLS: dict[str, list[str]] = {
    "arista_eapi": [
        "http://{ip}/command-api",
        "https://{ip}/command-api",
    ],
    "aruba_cx_rest": [
        "https://{ip}/rest/v10.04/",
        "https://{ip}/rest/v10.08/",
    ],
}

# SSH configure commands per vendor → method.
# Both Arista eAPI and ArubaOS-CX REST commands are built dynamically after
# VRF detection — see _build_arista_eapi_commands / _build_cx_rest_commands.
_CONFIGURE_COMMANDS: dict[str, dict[str, list[str]]] = {}  # all methods now dynamic


def _build_arista_eapi_commands(vrf: str) -> list[str]:
    return [
        "management api http-commands",
        "protocol http",
        "no shutdown",
        f"vrf {vrf}",
        "no shutdown",
    ]


def _build_cx_rest_commands(vrf: str) -> list[str]:
    return [f"https-server vrf {vrf}"]


# VRF line patterns per vendor (regex group 1 = VRF name).
# Each pattern is tried against a stripped interface sub-line.
_VRF_IFACE_PATTERNS: dict[str, list[str]] = {
    "arista":   [r"vrf\s+(?:forwarding\s+)?(\S+)"],
    "aruba_cx": [r"vrf\s+attach\s+(\S+)", r"vrf\s+(\S+)"],
}

# Existing API-config block markers — used as a secondary hint when the
# interface-IP lookup is inconclusive (e.g. DHCP management address).
_API_BLOCK_PATTERNS: dict[str, tuple[str, str]] = {
    # vendor → (block_header, vrf_line_regex)
    "arista":   ("management api http-commands", r"\s+vrf\s+(\S+)"),
    "aruba_cx": ("", r"^https-server\s+vrf\s+(\S+)"),   # top-level, no block
}


def _parse_mgmt_vrf_from_config(config_text: str, mgmt_ip: str = "", vendor: str = "arista") -> Optional[str]:
    """
    Determine the management VRF from a stored running-config.

    Priority:
      1. Find the interface whose IP matches mgmt_ip → return its VRF
         (or "default" if the interface has no VRF assignment).
      2. Read the VRF from an existing API-config block (eAPI / https-server).
      3. Return None — caller will SSH for a live answer.
    """
    import re

    mgmt_ip_bare = mgmt_ip.split("/")[0] if mgmt_ip else ""
    vrf_patterns = _VRF_IFACE_PATTERNS.get(vendor, _VRF_IFACE_PATTERNS["arista"])

    # ── Pass 1: interface → IP → VRF ─────────────────────────────────────────
    if mgmt_ip_bare:
        current_iface: Optional[str] = None
        iface_vrf:     dict[str, Optional[str]] = {}
        iface_ips:     dict[str, list[str]]     = {}

        for line in config_text.splitlines():
            iface_m = re.match(r"^interface\s+(\S+)", line)
            if iface_m:
                current_iface = iface_m.group(1)
                iface_vrf.setdefault(current_iface, None)
                continue

            if current_iface:
                if line and not line[0].isspace() and not line.startswith("!"):
                    current_iface = None
                    continue
                stripped = line.strip()
                for pat in vrf_patterns:
                    vrf_m = re.match(pat, stripped)
                    if vrf_m:
                        iface_vrf[current_iface] = vrf_m.group(1)
                        break
                ip_m = re.match(r"ip\s+address\s+(\S+)", stripped)
                if ip_m:
                    iface_ips.setdefault(current_iface, []).append(ip_m.group(1).split("/")[0])

        for iface, ips in iface_ips.items():
            if mgmt_ip_bare in ips:
                vrf = iface_vrf.get(iface)
                logger.debug("mgmt_vrf_from_interface", vendor=vendor, iface=iface,
                             ip=mgmt_ip_bare, vrf=vrf or "default")
                return vrf if vrf else "default"

    # ── Pass 2: existing API config block / top-level directive ──────────────
    block_header, vrf_line_re = _API_BLOCK_PATTERNS.get(vendor, ("", ""))
    if vrf_line_re:
        in_block = not block_header  # top-level directives are always "in block"
        for line in config_text.splitlines():
            if block_header and line.strip() == block_header:
                in_block = True
                continue
            if in_block and block_header and line and not line[0].isspace():
                break
            if in_block:
                m = re.search(vrf_line_re, line)
                if m:
                    return m.group(1)

    return None


async def _detect_mgmt_vrf(vendor: str, device_id: str, host: str, cred_data: dict) -> str:
    """
    Determine the management VRF for a device.
    1. Parse the latest stored config backup (no SSH, fast).
    2. Fall back to live SSH 'show vrf' if no backup or IP not found.
    """
    from ..models.config import ConfigBackup
    from sqlalchemy import select as sa_select

    vendor_key = "aruba_cx" if "aruba" in vendor.lower() or "cx" in vendor.lower() else "arista"

    # ── Step 1: stored config ─────────────────────────────────────────────────
    try:
        async with AsyncSessionLocal() as db:
            config_text = (await db.execute(
                sa_select(ConfigBackup.config_text)
                .where(ConfigBackup.device_id == device_id, ConfigBackup.is_latest == True)  # noqa
            )).scalar_one_or_none()

        if config_text is not None:
            vrf = _parse_mgmt_vrf_from_config(config_text, mgmt_ip=host, vendor=vendor_key)
            if vrf is not None:
                logger.info("mgmt_vrf_from_config", vendor=vendor_key, device_id=device_id, vrf=vrf)
                return vrf
            logger.debug("mgmt_vrf_config_inconclusive", vendor=vendor_key, device_id=device_id)
    except Exception as exc:
        logger.warning("mgmt_vrf_config_lookup_failed", vendor=vendor_key, device_id=device_id, error=str(exc))

    # ── Step 2: live SSH 'show vrf' fallback ─────────────────────────────────
    from .collector import _ssh_exec
    loop = asyncio.get_event_loop()
    try:
        output = await loop.run_in_executor(
            None, _ssh_exec, host, 22, vendor_key, cred_data, "show vrf"
        )
        vrfs: dict[str, str] = {}
        for line in output.splitlines():
            parts = line.split()
            if parts and not parts[0].startswith("-") and parts[0] not in ("VRF", "Name"):
                vrfs[parts[0].lower()] = parts[0]
        logger.info("mgmt_vrf_from_ssh", vendor=vendor_key, device_id=device_id, vrfs=list(vrfs.values()))
        for candidate in ("management", "mgmt"):
            if candidate in vrfs:
                return vrfs[candidate]
    except Exception as exc:
        logger.warning("mgmt_vrf_ssh_failed", vendor=vendor_key, device_id=device_id, host=host, error=str(exc))

    return "default"


# ── Probe ─────────────────────────────────────────────────────────────────────

async def probe_method(ip: str, method: str) -> tuple[bool, Optional[str]]:
    """Return (reachable, error_msg). Any HTTP response means reachable."""
    if method == "snmp":
        return True, None  # SNMP not probed via HTTP

    urls = _PROBE_URLS.get(method, [])
    if not urls:
        return False, "no probe URL defined for method"

    last_err: Optional[str] = None
    async with httpx.AsyncClient(verify=False, timeout=5) as client:
        for url in urls:
            target = url.format(ip=ip)
            try:
                resp = await client.get(target)
                # Any response (401, 403, 200, 405…) means the service is listening
                return True, None
            except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
                last_err = f"{target}: {exc}"
            except httpx.TimeoutException as exc:
                last_err = f"{target}: timeout"
            except Exception as exc:
                last_err = f"{target}: {exc}"

    return False, last_err


async def probe_and_save(device_id: str, method: str, ip: str) -> dict:
    """Run probe and update device_api_methods row. Returns updated row dict."""
    reachable, error = await probe_method(ip, method)
    now = datetime.now(timezone.utc)

    async with AsyncSessionLocal() as db:
        await db.execute(text("""
            UPDATE device_api_methods
               SET reachable      = :reachable,
                   last_probe_at  = :now,
                   probe_error    = :error,
                   updated_at     = :now
             WHERE device_id = CAST(:did AS uuid)
               AND method    = :method
        """), {
            "did": device_id, "method": method,
            "reachable": reachable, "error": error, "now": now,
        })
        await db.commit()

    return {"reachable": reachable, "probe_error": error, "last_probe_at": now.isoformat()}


# ── Configure ─────────────────────────────────────────────────────────────────

async def configure_method(device_id: str, method: str) -> dict:
    """
    SSH into the device and push the API-enable commands.
    Returns {"status": "success"|"failed", "output": str}.
    """
    from .collector import _deploy_ssh, _vendor_key
    from .. import crypto

    async with AsyncSessionLocal() as db:
        dev = (await db.execute(
            select(Device).where(Device.id == device_id)
        )).scalar_one_or_none()
        if dev is None:
            return {"status": "failed", "output": "device not found"}

        vendor = str(dev.vendor or "").lower()

        # Load SSH credential
        cred_row = (await db.execute(
            select(Credential)
            .join(DeviceCredential, DeviceCredential.credential_id == Credential.id)
            .where(
                DeviceCredential.device_id == device_id,
                Credential.type == "ssh",
            )
            .order_by(DeviceCredential.priority)
        )).scalar_one_or_none()

        if cred_row is None:
            return {"status": "failed", "output": "no SSH credential assigned to this device"}

        cred_data: dict = cred_row.data if isinstance(cred_row.data, dict) else json.loads(cred_row.data)
        if cred_data.get("password") and crypto.is_configured():
            try:
                cred_data["password"] = crypto.decrypt(cred_data["password"])
            except Exception:
                pass

    host = dev.mgmt_ip_str
    vkey = _vendor_key(dev)

    # Build commands — detect management VRF from stored config / SSH
    if method == "arista_eapi":
        mgmt_vrf = await _detect_mgmt_vrf(vendor, device_id, host, cred_data)
        commands = _build_arista_eapi_commands(mgmt_vrf)
    elif method == "aruba_cx_rest":
        mgmt_vrf = await _detect_mgmt_vrf(vendor, device_id, host, cred_data)
        commands = _build_cx_rest_commands(mgmt_vrf)
    else:
        return {
            "status": "failed",
            "output": f"no auto-configure commands defined for vendor={vendor} method={method}",
        }

    # Mark as running
    now = datetime.now(timezone.utc)
    async with AsyncSessionLocal() as db:
        await db.execute(text("""
            UPDATE device_api_methods
               SET configure_status = 'running', configure_at = :now, updated_at = :now
             WHERE device_id = CAST(:did AS uuid) AND method = :method
        """), {"did": device_id, "method": method, "now": now})
        await db.commit()

    # Run SSH configure in thread pool (synchronous Netmiko)
    loop = asyncio.get_event_loop()
    try:
        output = await loop.run_in_executor(
            None, _deploy_ssh, host, 22, vkey, cred_data, commands, True
        )
        status = "success"
        logger.info("api_method_configured",
                    device_id=device_id, method=method, vendor=vkey)
    except Exception as exc:
        output = str(exc)
        status = "failed"
        logger.warning("api_method_configure_failed",
                       device_id=device_id, method=method, error=str(exc))

    # Save result
    now = datetime.now(timezone.utc)
    async with AsyncSessionLocal() as db:
        await db.execute(text("""
            UPDATE device_api_methods
               SET configure_status  = :status,
                   configure_output  = :output,
                   configure_at      = :now,
                   updated_at        = :now
             WHERE device_id = CAST(:did AS uuid) AND method = :method
        """), {"did": device_id, "method": method,
               "status": status, "output": output, "now": now})
        # If successful, enable the method
        if status == "success":
            await db.execute(text("""
                UPDATE device_api_methods SET enabled = true, updated_at = :now
                WHERE device_id = CAST(:did AS uuid) AND method = :method
            """), {"did": device_id, "method": method, "now": now})
            # Mirror to rest_collection_enabled for backward compat
            if method == "aruba_cx_rest":
                await db.execute(text("""
                    UPDATE devices SET rest_collection_enabled = true
                    WHERE id = CAST(:did AS uuid)
                """), {"did": device_id})
        await db.commit()

    # Re-probe now that config is pushed
    if status == "success":
        ip = dev.mgmt_ip_str
        probe_result = await probe_and_save(device_id, method, ip)
        return {"status": status, "output": output, **probe_result}

    return {"status": status, "output": output}


# ── Seed rows for a newly discovered device ───────────────────────────────────

async def seed_device_methods(device_id: str, vendor: str) -> None:
    """Insert device_api_methods rows for a newly added device based on vendor."""
    methods = VENDOR_METHODS.get(vendor.lower(), ["snmp"])
    now = datetime.now(timezone.utc)

    async with AsyncSessionLocal() as db:
        for method in methods:
            enabled = method == "snmp" or (method == "aruba_cx_rest" and vendor == "aruba_cx")
            await db.execute(text("""
                INSERT INTO device_api_methods (device_id, method, enabled, updated_at)
                VALUES (CAST(:did AS uuid), :method, :enabled, :now)
                ON CONFLICT (device_id, method) DO NOTHING
            """), {"did": device_id, "method": method, "enabled": enabled, "now": now})
        await db.commit()


# ── Background probe sweep ────────────────────────────────────────────────────

async def _probe_sweep() -> None:
    """Probe all non-SNMP API method rows and update reachability."""
    async with AsyncSessionLocal() as db:
        rows = (await db.execute(text("""
            SELECT dam.device_id::text, dam.method, d.mgmt_ip::text
            FROM device_api_methods dam
            JOIN devices d ON d.id = dam.device_id
            WHERE dam.method != 'snmp'
              AND d.is_active = true
              AND d.collector_id IS NULL
        """))).all()

    if not rows:
        return

    tasks = [probe_and_save(row[0], row[1], row[2].split("/")[0]) for row in rows]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    errors = [r for r in results if isinstance(r, Exception)]
    if errors:
        logger.warning("probe_sweep_errors", count=len(errors))
    else:
        logger.debug("probe_sweep_complete", probed=len(rows))


async def _probe_loop(interval_s: int) -> None:
    while True:
        await asyncio.sleep(interval_s)
        try:
            await _probe_sweep()
        except Exception:
            logger.exception("probe_loop_error")


def start_api_probe_loop(interval_s: int = 300) -> asyncio.Task:
    return asyncio.create_task(_probe_loop(interval_s), name="api-probe-sweep")
