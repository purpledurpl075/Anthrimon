"""Config backup collector.

Runs as a background task inside the FastAPI process.  Every
`interval_s` seconds it iterates all active devices that have an SSH
credential assigned, connects via Netmiko, fetches the running-config,
and stores it if the hash changed.
"""
from __future__ import annotations

import asyncio
import difflib
import hashlib
import json
import logging
import re
from datetime import datetime, timezone
from typing import Optional

import structlog
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import AsyncSessionLocal
from ..models.config import ConfigBackup, ConfigDiff
from ..models.credential import Credential, DeviceCredential
from ..models.device import Device

logger = structlog.get_logger(__name__)

# Netmiko device_type per vendor string
_NETMIKO_TYPE: dict[str, str] = {
    "arista":           "arista_eos",
    "cisco_ios":        "cisco_ios",
    "cisco_iosxe":      "cisco_ios",
    "cisco_iosxr":      "cisco_xr",
    "cisco_nxos":       "cisco_nxos",
    "juniper":          "juniper_junos",
    "procurve":         "hp_procurve",
    "hp_procurve":      "hp_procurve",
    "aruba_cx":         "aruba_aoscx",
    "fortios":          "fortinet",
    "ubiquiti":         "linux",
}

# Command to retrieve running config per vendor
_SHOW_RUN: dict[str, str] = {
    "arista":           "show running-config",
    "cisco_ios":        "show running-config",
    "cisco_iosxe":      "show running-config",
    "cisco_iosxr":      "show running-config all",
    "cisco_nxos":       "show running-config",
    "juniper":          "show configuration | display set",
    "hp_procurve":      "show running-config",
    "aruba_cx":         "show running-config",
    "fortios":          "show full-configuration",
    "ubiquiti":         "cat /tmp/system.cfg",
}

DEFAULT_INTERVAL_S = 3600  # collect every hour


def _vendor_key(device: Device) -> str:
    """Normalise vendor/device-type to a key in the lookup tables."""
    v = (device.vendor or "").lower()
    dt = (device.device_type or "").lower()
    for k in _NETMIKO_TYPE:
        if k in v or k in dt:
            return k
    # EOS / Arista heuristic
    if "eos" in v or "arista" in v:
        return "arista"
    if "ios" in v or "cisco" in v:
        return "cisco_ios"
    return "cisco_ios"  # safe fallback for most gear


_PARAMIKO_VENDORS = {"hp_procurve", "procurve"}  # vendors that need raw paramiko exec_command


def _collect_ssh_paramiko(host: str, port: int, command: str, cred_data: dict) -> str:
    """Use paramiko invoke_shell for devices that don't work with Netmiko's
    interactive session setup (e.g. HP ProCurve which ignores terminal width)."""
    import paramiko, time, socket

    from .hostkeys import apply_paramiko_policy, persist_paramiko

    client = paramiko.SSHClient()
    apply_paramiko_policy(client)
    client.connect(
        hostname=host, port=port,
        username=cred_data.get("username", ""),
        password=cred_data.get("password", ""),
        timeout=30, look_for_keys=False, allow_agent=False,
    )
    persist_paramiko(client)
    try:
        shell = client.invoke_shell(width=200, height=200)
        shell.settimeout(5)

        def _read_until_prompt(timeout: float = 10.0) -> str:
            """Read until we see a shell prompt (ends with # or >)."""
            buf, deadline = "", time.time() + timeout
            while time.time() < deadline:
                try:
                    chunk = shell.recv(4096).decode("utf-8", errors="replace")
                    buf += chunk
                    # HP ProCurve prompt ends with "# " or "> "
                    stripped = buf.rstrip()
                    if stripped.endswith(("#", ">")):
                        break
                except socket.timeout:
                    if buf.rstrip().endswith(("#", ">")):
                        break
            return buf

        # Wait for initial prompt
        _read_until_prompt(15)

        # Disable paging so the full config comes back without -- MORE --
        shell.send("no page\n")
        _read_until_prompt(5)

        # Request config
        shell.send(command + "\n")
        output = _read_until_prompt(30)

        # Strip the command echo and trailing prompt
        lines = output.splitlines()
        # Remove first line (command echo) and last line (prompt)
        if len(lines) > 2:
            lines = lines[1:-1]
        return "\n".join(lines).strip()
    finally:
        client.close()


def _collect_ssh(host: str, port: int, vendor_key: str, cred_data: dict) -> str:
    """Synchronous SSH collection via Netmiko (runs in a thread pool)."""
    if vendor_key in _PARAMIKO_VENDORS:
        command = _SHOW_RUN.get(vendor_key, "show running-config")
        return _collect_ssh_paramiko(host, port, command, cred_data)

    from .hostkeys import pinned_connect_handler

    device_type = _NETMIKO_TYPE.get(vendor_key, "cisco_ios")
    command = _SHOW_RUN.get(vendor_key, "show running-config")

    # ProCurve/ProVision switches are slow to respond during SSH session setup
    is_procurve = vendor_key in {"hp_procurve"}

    conn_params = {
        "device_type":         device_type,
        "host":                host,
        "port":                port,
        "username":            cred_data.get("username", ""),
        "password":            cred_data.get("password", ""),
        "timeout":             60 if is_procurve else 30,
        "conn_timeout":        30 if is_procurve else 15,
        "auth_timeout":        30 if is_procurve else 20,
        "banner_timeout":      30 if is_procurve else 20,
        "fast_cli":            False,
        "global_delay_factor": 4 if is_procurve else 1,
    }
    # Vendors that need privileged EXEC mode to run show running-config
    _NEEDS_ENABLE = {"arista", "cisco_ios", "cisco_iosxe", "cisco_iosxr",
                     "cisco_nxos", "hp_procurve", "aruba_cx"}

    if cred_data.get("enable_secret"):
        conn_params["secret"] = cred_data["enable_secret"]
    elif vendor_key in _NEEDS_ENABLE:
        # Try enable with the login password as the enable secret (common default),
        # then fall back to empty string. Silently ignore failures — some devices
        # have the user already at privilege 15.
        conn_params["secret"] = cred_data.get("password", "")

    with pinned_connect_handler(**conn_params) as conn:
        if vendor_key in _NEEDS_ENABLE:
            try:
                conn.enable()
            except Exception:
                pass  # already privileged, or device doesn't use enable
        output = conn.send_command(command, read_timeout=60)

    # Guard against collecting an error message instead of a config
    if output and ("Invalid input" in output or "% Error" in output) and len(output) < 200:
        raise RuntimeError(f"Device returned an error: {output[:100]}")

    return output.strip()


def _ssh_exec(host: str, port: int, vendor_key: str, cred_data: dict, command: str) -> str:
    """Run a single exec-mode command via SSH and return output. Not config mode."""
    from .hostkeys import pinned_connect_handler

    _NEEDS_ENABLE_EXEC = {"arista", "cisco_ios", "cisco_iosxe", "cisco_iosxr",
                          "cisco_nxos", "hp_procurve", "aruba_cx"}
    device_type = _NETMIKO_TYPE.get(vendor_key, "cisco_ios")
    is_procurve  = vendor_key in {"hp_procurve", "procurve"}
    conn_params = {
        "device_type":         device_type,
        "host":                host,
        "port":                port,
        "username":            cred_data.get("username", ""),
        "password":            cred_data.get("password", ""),
        "timeout":             60 if is_procurve else 30,
        "conn_timeout":        30 if is_procurve else 15,
        "auth_timeout":        30 if is_procurve else 20,
        "banner_timeout":      30 if is_procurve else 20,
        "fast_cli":            False,
        "global_delay_factor": 4 if is_procurve else 1,
    }
    if cred_data.get("enable_secret"):
        conn_params["secret"] = cred_data["enable_secret"]
    elif vendor_key in _NEEDS_ENABLE_EXEC:
        conn_params["secret"] = cred_data.get("password", "")

    with pinned_connect_handler(**conn_params) as conn:
        if vendor_key in _NEEDS_ENABLE_EXEC:
            try:
                conn.enable()
            except Exception:
                pass
        return conn.send_command(command, read_timeout=30)


# Vendor-specific config mode entry/exit commands
_CONFIG_ENTER: dict[str, str] = {
    "arista":     "configure terminal",
    "cisco_ios":  "configure terminal",
    "cisco_iosxe":"configure terminal",
    "cisco_iosxr":"configure terminal",
    "cisco_nxos": "configure terminal",
    "juniper":    "configure",
    "hp_procurve":"configure",
    "procurve":   "configure",
    "aruba_cx":   "configure terminal",
    "fortios":    "",   # FortiOS has no config mode — commands sent directly
    "ubiquiti":   "",
}
_CONFIG_EXIT: dict[str, str] = {
    "juniper":    "commit\nexit",
}
_SAVE_CMD: dict[str, str] = {
    "arista":     "write memory",
    "cisco_ios":  "write memory",
    "cisco_iosxe":"write memory",
    "cisco_iosxr":"commit",
    "cisco_nxos": "copy running-config startup-config",
    "juniper":    "",   # juniper commits on exit
    "hp_procurve":"write memory",
    "procurve":   "write memory",
    "aruba_cx":   "write memory",
    "fortios":    "execute cfg save",
}


def _deploy_ssh(
    host: str, port: int, vendor_key: str, cred_data: dict,
    commands: list[str], save: bool,
) -> str:
    """Push config commands to a device via SSH. Returns combined CLI output."""
    if vendor_key in _PARAMIKO_VENDORS:
        return _deploy_ssh_paramiko(host, port, vendor_key, cred_data, commands, save)

    from .hostkeys import pinned_connect_handler

    device_type = _NETMIKO_TYPE.get(vendor_key, "cisco_ios")
    is_procurve  = vendor_key in {"hp_procurve"}
    _NEEDS_ENABLE_DEPLOY = {"arista", "cisco_ios", "cisco_iosxe", "cisco_iosxr",
                             "cisco_nxos", "hp_procurve", "aruba_cx"}

    conn_params = {
        "device_type":         device_type,
        "host":                host,
        "port":                port,
        "username":            cred_data.get("username", ""),
        "password":            cred_data.get("password", ""),
        "timeout":             60 if is_procurve else 30,
        "conn_timeout":        30 if is_procurve else 15,
        "auth_timeout":        30 if is_procurve else 20,
        "banner_timeout":      30 if is_procurve else 20,
        "fast_cli":            False,
        "global_delay_factor": 4 if is_procurve else 1,
    }
    if cred_data.get("enable_secret"):
        conn_params["secret"] = cred_data["enable_secret"]
    elif vendor_key in _NEEDS_ENABLE_DEPLOY:
        conn_params["secret"] = cred_data.get("password", "")

    output_parts: list[str] = []

    with pinned_connect_handler(**conn_params) as conn:
        if vendor_key in _NEEDS_ENABLE_DEPLOY:
            try:
                conn.enable()
            except Exception:
                pass

        enter_cmd = _CONFIG_ENTER.get(vendor_key, "configure terminal")
        if enter_cmd:
            out = conn.send_command_timing(enter_cmd, delay_factor=2)
            output_parts.append(f"$ {enter_cmd}\n{out}")

        for cmd in commands:
            if not cmd.strip():
                continue
            out = conn.send_command_timing(cmd.strip(), delay_factor=2)
            output_parts.append(f"$ {cmd.strip()}\n{out}")

        # Exit config mode
        exit_cmd = _CONFIG_EXIT.get(vendor_key, "end")
        if exit_cmd:
            for line in exit_cmd.splitlines():
                out = conn.send_command_timing(line, delay_factor=2)
                output_parts.append(f"$ {line}\n{out}")
        else:
            conn.send_command_timing("end", delay_factor=2)

        # Save to startup config
        if save:
            save_cmd = _SAVE_CMD.get(vendor_key, "write memory")
            if save_cmd:
                out = conn.send_command_timing(save_cmd, delay_factor=2)
                output_parts.append(f"$ {save_cmd}\n{out}")

    return "\n".join(output_parts).strip()


def _deploy_ssh_paramiko(
    host: str, port: int, vendor_key: str, cred_data: dict,
    commands: list[str], save: bool,
) -> str:
    """Deploy config via paramiko invoke_shell (for ProCurve)."""
    import paramiko, time, socket

    from .hostkeys import apply_paramiko_policy, persist_paramiko

    client = paramiko.SSHClient()
    apply_paramiko_policy(client)
    client.connect(
        hostname=host, port=port,
        username=cred_data.get("username", ""),
        password=cred_data.get("password", ""),
        timeout=30, look_for_keys=False, allow_agent=False,
    )
    persist_paramiko(client)

    output_parts: list[str] = []

    try:
        shell = client.invoke_shell(width=200, height=200)
        shell.settimeout(5)

        def _read(timeout: float = 8.0) -> str:
            buf, deadline = "", time.time() + timeout
            while time.time() < deadline:
                try:
                    chunk = shell.recv(4096).decode("utf-8", errors="replace")
                    buf += chunk
                    if buf.rstrip().endswith(("#", ">")):
                        break
                except socket.timeout:
                    if buf.rstrip().endswith(("#", ">")):
                        break
            return buf

        _read(12)  # wait for initial prompt

        def _send(cmd: str) -> str:
            shell.send(cmd + "\n")
            out = _read()
            lines = out.splitlines()
            return "\n".join(lines[1:-1]).strip() if len(lines) > 2 else out.strip()

        _send("no page")

        enter_cmd = _CONFIG_ENTER.get(vendor_key, "configure")
        if enter_cmd:
            output_parts.append(f"$ {enter_cmd}\n{_send(enter_cmd)}")

        for cmd in commands:
            if not cmd.strip():
                continue
            out = _send(cmd.strip())
            output_parts.append(f"$ {cmd.strip()}\n{out}")

        exit_cmd = _CONFIG_EXIT.get(vendor_key, "end")
        for line in (exit_cmd.splitlines() if exit_cmd else ["end"]):
            _send(line)

        if save:
            save_cmd = _SAVE_CMD.get(vendor_key, "write memory")
            if save_cmd:
                out = _send(save_cmd)
                output_parts.append(f"$ {save_cmd}\n{out}")

    finally:
        client.close()

    return "\n".join(output_parts).strip()


async def store_config_backup(
    device_id: str,
    config_text: str,
    method: str,
    db: AsyncSession,
) -> bool:
    """Store a config snapshot for *device_id*.

    Hashes the text, diffs against the previous backup, writes to the DB,
    and fires config-change alerts when the config has changed.

    Returns True if the config was new or changed, False if identical to the
    current latest backup (no write performed).
    """
    if not config_text:
        return False

    # Need device metadata for diff labels and alert firing.
    dev = (await db.execute(
        select(Device).where(Device.id == device_id)
    )).scalar_one_or_none()
    if dev is None:
        return False

    config_hash = hashlib.sha256(config_text.encode()).hexdigest()

    # Load current latest backup.
    prev = (await db.execute(
        select(ConfigBackup)
        .where(ConfigBackup.device_id == device_id, ConfigBackup.is_latest == True)  # noqa: E712
    )).scalar_one_or_none()

    # Skip if unchanged.
    if prev and prev.config_hash == config_hash:
        logger.debug("config_store_unchanged", device=dev.hostname)
        return False

    now = datetime.now(timezone.utc)
    lines_added, lines_removed = 0, 0

    # Clear old is_latest BEFORE inserting the new one to avoid the
    # unique partial index constraint firing during autoflush.
    if prev:
        await db.execute(
            update(ConfigBackup)
            .where(ConfigBackup.id == prev.id)
            .values(is_latest=False)
        )
        await db.flush()

    # Create new backup.
    backup = ConfigBackup(
        device_id=device_id,
        collected_at=now,
        config_text=config_text,
        config_hash=config_hash,
        collection_method=method,
        is_latest=True,
    )
    db.add(backup)
    await db.flush()  # get backup.id

    # Generate diff.
    if prev:
        prev_lines = prev.config_text.splitlines(keepends=True)
        curr_lines = config_text.splitlines(keepends=True)
        diff_lines = list(difflib.unified_diff(
            prev_lines, curr_lines,
            fromfile=f"previous ({prev.collected_at.strftime('%Y-%m-%d %H:%M')})",
            tofile=f"current ({now.strftime('%Y-%m-%d %H:%M')})",
            lineterm="",
        ))
        diff_text     = "".join(diff_lines)
        lines_added   = sum(1 for l in diff_lines if l.startswith("+") and not l.startswith("+++"))
        lines_removed = sum(1 for l in diff_lines if l.startswith("-") and not l.startswith("---"))

        diff = ConfigDiff(
            device_id=device_id,
            prev_backup_id=prev.id,
            curr_backup_id=backup.id,
            diff_text=diff_text,
            lines_added=lines_added,
            lines_removed=lines_removed,
        )
        db.add(diff)

    await db.commit()
    logger.info("config_stored", device=dev.hostname, hash=config_hash[:12],
                changed=prev is not None, method=method)

    # Fire change alerts if this was an actual change (not the first backup).
    if prev:
        await _fire_config_change_alerts(
            db=db, dev=dev,
            lines_added=lines_added, lines_removed=lines_removed,
            backup_id=str(backup.id),
        )

    # Run compliance against the new backup — covers both the first snapshot
    # and every subsequent change.  Errors are caught so a bad policy regex
    # never prevents the backup from being stored.
    await _run_compliance(device_id, dev.hostname, db)

    # Score against any matching golden configs.
    await _run_golden_config_drift(device_id, dev.hostname, db)

    # Commit the new config to the tenant's git archive repo.
    await _archive_to_git(
        db, dev, config_text, lines_added, lines_removed, str(backup.id), method, prev is None,
    )

    return True


async def _run_compliance(device_id: str, hostname: str, db: AsyncSession) -> None:
    """Evaluate all enabled compliance policies against the device's latest backup.

    Called automatically after every new backup write.  Never raises — compliance
    failures are logged but must not interrupt the backup storage path.
    """
    try:
        from .compliance import run_compliance_for_device
        results = await run_compliance_for_device(device_id, db)
        if results:
            fail_count = sum(1 for r in results if r.status == "fail")
            logger.info(
                "compliance_auto_run",
                device=hostname,
                policies=len(results),
                failed=fail_count,
            )
    except Exception as exc:
        logger.warning("compliance_auto_run_failed", device=hostname, error=str(exc))


async def _run_golden_config_drift(device_id: str, hostname: str, db: AsyncSession) -> None:
    """Score the device's latest backup against any matching golden configs.

    Called automatically after every new backup write.  Never raises — a bad
    golden template must not prevent the backup from being stored.
    """
    try:
        from .golden_config import run_golden_configs_for_device
        results = await run_golden_configs_for_device(device_id, db)
        if results:
            worst = min(float(r.score) for r in results)
            logger.info(
                "golden_config_auto_run",
                device=hostname,
                count=len(results),
                worst_score=worst,
            )
    except Exception as exc:
        logger.warning("golden_config_auto_run_failed", device=hostname, error=str(exc))


async def _archive_to_git(
    db: AsyncSession,
    dev: Device,
    config_text: str,
    lines_added: int,
    lines_removed: int,
    backup_id: str,
    method: str,
    is_first: bool,
) -> None:
    """Commit the new config to the tenant's git archive repo.

    Called automatically after every new backup write.  Never raises — git
    failures are logged but must not interrupt the backup storage path.
    """
    try:
        from .git_archive import commit_config
        commit_hash = await commit_config(
            db, dev, config_text, lines_added, lines_removed, backup_id, method, is_first,
        )
        if commit_hash:
            logger.info("git_archive_committed", device=dev.hostname, commit=commit_hash[:12])
    except Exception as exc:
        logger.warning("git_archive_failed", device=dev.hostname, error=str(exc))


# Per-vendor command to disable terminal paging before `show running-config`,
# so the delegated SSH capture isn't broken up by "--More--" prompts.
_NO_PAGE: dict[str, str] = {
    "arista":       "terminal length 0",
    "cisco_ios":    "terminal length 0",
    "cisco_iosxe":  "terminal length 0",
    "cisco_iosxr":  "terminal length 0",
    "cisco_nxos":   "terminal length 0",
    "aruba_cx":     "no page",
    "hp_procurve":  "no page",
    "juniper":      "set cli screen-length 0",
}


# A trailing line that is just a device prompt, optionally followed by the
# exit/quit we send to close the session — e.g. "switch# exit" or "rtr>".
_PROMPT_TAIL = re.compile(r"^\S*[#>$]\s*(exit|quit|logout)?\s*$", re.IGNORECASE)
# A line that begins with a device prompt and then echoes text — e.g.
# "ArubaCX9# show running-config" or "ArubaCX9# Invalid input: enable".  Real
# config lines start with a keyword or indentation, never "hostname#  text".
_PROMPT_LINE = re.compile(r"^\S+[#>]\s+\S")
# Shell/login banner noise that some OSes interleave with command output.
# These lines must NOT be stored — they vary between captures (timestamps,
# byte-counts, session metadata) and produce spurious diffs.
_BANNER_NOISE = re.compile(
    r"(^Last login:|has logged in .* in the past|Invalid input:"
    r"|^Building configuration|^Current configuration"
    # Arista EOS / Cisco NX-OS command echo (with or without space after !)
    r"|^[!;#]+\s*Command[\s:]"
    # Cisco IOS/IOS-XE/IOS-XR: timestamp + byte-count headers
    r"|^[!#]+\s*Last configuration change"
    r"|^[!#]+\s*NVRAM config"
    r"|^!!?\s*IOS XR Configuration"
    # Cisco NX-OS: timestamp line emitted on every capture
    r"|^[!#]+\s*Time:\s"
    r"|^[!#]+\s*Startup database"
    # Juniper: timestamp in hierarchical format (display set has no headers)
    r"|^#+\s*Last changed:"
    # HP ProCurve: model/firmware header lines
    r"|^;\s*[A-Z]\w+\s+Configuration Editor"
    r"|^;\s*Ver\s+#"
    # FortiOS: build/version/user embedded in first line
    r"|^#config-version="
    r")",
    re.IGNORECASE,
)


def _extract_show_output(raw: str, command: str) -> str:
    """Pull the config body out of a raw interactive-shell capture: everything
    after the echoed `command` line, minus prompt echoes and login/banner noise.
    Heuristic, but stable for the same device over time (diffs still work) — and
    clean enough that the text can be re-fed to the device as a rollback target."""
    lines = raw.splitlines()
    start = None
    for i, ln in enumerate(lines):
        if ln.rstrip().endswith(command):
            start = i + 1          # last echo of the command wins
    body = lines[start:] if start is not None else lines
    while body and (
        body[-1].strip() == ""
        or body[-1].strip() in ("exit", "quit", "logout")
        or _PROMPT_TAIL.match(body[-1])
    ):
        body.pop()
    body = [ln.rstrip() for ln in body
            if not (_PROMPT_LINE.match(ln) or _BANNER_NOISE.search(ln))]
    return "\n".join(body).strip()


async def _collect_via_collector(db: AsyncSession, dev: Device, vendor: str,
                                 cred_data: dict) -> str:
    """Capture a device's running config through its owning remote collector
    (the hub can't SSH to a device on a remote LAN).  All vendor specifics —
    the show command and paging-disable — are decided here; the collector just
    runs the SSH session."""
    from ..models.site import RemoteCollector
    from . import proxy as _proxy

    col = (await db.execute(
        select(RemoteCollector).where(RemoteCollector.id == dev.collector_id)
    )).scalar_one_or_none()
    if col is None or not col.wg_ip or not col.api_key_hash:
        raise RuntimeError("device's collector is offline or has no WireGuard IP")

    show = _SHOW_RUN.get(vendor, "show running-config")
    steps = []
    if vendor in _NO_PAGE:
        steps.append(_proxy.step(_NO_PAGE[vendor], delay=1.0))

    payload = {
        "operation":          "backup",
        "device_ip":          dev.mgmt_ip_str,
        "ssh_port":           22,
        "vendor":             vendor,
        "username":           cred_data.get("username", ""),
        "password":           cred_data.get("password", ""),
        "enable_secret":      cred_data.get("enable_secret", "") or "",
        "enter_enable":       vendor in _proxy.ENABLE_VENDORS,
        "serve_config":       "",
        "expected_source_ip": "",
        "steps":              steps,
        "final_read_command": show,
    }
    data = await _proxy.config_exec(
        wg_ip=str(col.wg_ip), api_key_hash=col.api_key_hash, payload=payload, timeout=120.0)
    return _extract_show_output(data.get("output", ""), show)


async def collect_device(device_id: str, db: AsyncSession) -> Optional[ConfigBackup]:
    """Collect running config for one device via SSH.

    Returns the new ConfigBackup if a change was detected, else None.
    """
    from .. import crypto

    # Load device
    dev = (await db.execute(
        select(Device).where(Device.id == device_id)
    )).scalar_one_or_none()
    if dev is None or not dev.is_active:
        return None

    # Find SSH credential
    cred_row = (await db.execute(
        select(DeviceCredential, Credential)
        .join(Credential, Credential.id == DeviceCredential.credential_id)
        .where(DeviceCredential.device_id == device_id, Credential.type == "ssh")
        .order_by(DeviceCredential.priority)
    )).first()
    if cred_row is None:
        logger.debug("config_collect_skip_no_ssh", device=str(device_id))
        return None

    _, cred = cred_row
    cred_data = cred.data if isinstance(cred.data, dict) else json.loads(cred.data)

    # Decrypt password
    if cred_data.get("password") and crypto.is_configured():
        try:
            cred_data["password"] = crypto.decrypt(cred_data["password"])
        except Exception:
            pass

    host   = dev.mgmt_ip_str
    port   = 22
    vendor = _vendor_key(dev)

    try:
        if dev.collector_id is not None:
            # Device is on a remote LAN — delegate the SSH to its collector.
            config_text = await _collect_via_collector(db, dev, vendor, cred_data)
        else:
            loop = asyncio.get_running_loop()
            config_text = await loop.run_in_executor(
                None, _collect_ssh, host, port, vendor, cred_data
            )
    except Exception as exc:
        logger.warning("config_collect_failed", device=dev.hostname,
                       via="collector" if dev.collector_id else "hub", error=str(exc))
        return None

    changed = await store_config_backup(device_id, config_text, "ssh_show_run", db)

    if changed:
        return (await db.execute(
            select(ConfigBackup)
            .where(ConfigBackup.device_id == device_id, ConfigBackup.is_latest == True)  # noqa: E712
        )).scalar_one_or_none()

    return None


async def _fire_config_change_alerts(
    db: AsyncSession, dev: Device,
    lines_added: int, lines_removed: int, backup_id: str,
) -> None:
    """Create alert + dispatch notifications for config_change rules matching this device."""
    import uuid as _uuid
    import hashlib as _hashlib
    from ..models.alert import Alert, AlertRule
    from ..alerting.engine import _device_matches_selector, _fingerprint
    from ..alerting import notify

    # Find enabled config_change rules for this tenant
    rules = (await db.execute(
        select(AlertRule).where(
            AlertRule.tenant_id == dev.tenant_id,
            AlertRule.metric == "config_change",
            AlertRule.is_enabled == True,  # noqa: E712
        )
    )).scalars().all()

    if not rules:
        return

    device_dict = {"id": str(dev.id), "vendor": dev.vendor or "", "tags": dev.tags or []}
    now = datetime.now(timezone.utc)

    for rule in rules:
        # Apply device selector filter
        if rule.device_selector and not _device_matches_selector(device_dict, rule.device_selector):
            continue

        fp = _fingerprint(str(rule.id), str(dev.id))
        title = (
            f"{dev.display_name}: "
            f"config changed (+{lines_added} -{lines_removed} lines)"
        )

        alert = Alert(
            id=_uuid.uuid4(),
            tenant_id=rule.tenant_id,
            rule_id=rule.id,
            device_id=dev.id,
            severity=rule.severity,
            status="open",
            title=title,
            message=rule.description,
            context={
                "metric":        "config_change",
                "device_name":   dev.display_name,
                "lines_added":   lines_added,
                "lines_removed": lines_removed,
                "backup_id":     backup_id,
            },
            triggered_at=now,
            fingerprint=fp + f":{backup_id[:8]}",  # unique per change event
            last_notified_at=now,
        )
        db.add(alert)
        await db.commit()

        logger.info("config_change_alert_fired", device=dev.hostname, rule=rule.name,
                    added=lines_added, removed=lines_removed)

        # Dispatch notification
        try:
            await notify.dispatch(alert, rule, resolved=False)
        except Exception as exc:
            logger.error("config_change_notify_failed", error=str(exc))


class ConfigCollector:
    """Background loop that periodically collects configs for all devices."""

    def __init__(self, interval_s: int = DEFAULT_INTERVAL_S):
        self.interval_s = interval_s

    async def run(self) -> None:
        logger.info("config_collector_started", interval_s=self.interval_s)
        # Stagger startup by 60 s to avoid hammering devices on API restart
        await asyncio.sleep(60)
        while True:
            try:
                await self._collect_all()
            except Exception:
                logger.exception("config_collector_error")
            await asyncio.sleep(self.interval_s)

    async def _collect_all(self) -> None:
        async with AsyncSessionLocal() as db:
            device_rows = (await db.execute(
                select(Device.id, Device.hostname)
                .where(
                    Device.is_active == True,        # noqa: E712
                    # Both hub-managed (collector_id NULL) and collector-managed
                    # devices are collected; collect_device() routes each one to
                    # the hub or to its owning collector as appropriate.
                )
            )).all()

        logger.info("config_collect_cycle_start", devices=len(device_rows))
        for row in device_rows:
            try:
                async with AsyncSessionLocal() as db:
                    await collect_device(str(row.id), db)
            except Exception as exc:
                logger.warning("config_collect_device_error",
                               device=row.hostname, error=str(exc))
            # Brief pause between devices to avoid SSH connection storms
            await asyncio.sleep(2)


def start_config_collector(interval_s: int = DEFAULT_INTERVAL_S) -> asyncio.Task:
    collector = ConfigCollector(interval_s=interval_s)
    return asyncio.create_task(collector.run(), name="config-collector")
