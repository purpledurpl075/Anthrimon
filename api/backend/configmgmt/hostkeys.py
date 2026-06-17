"""TOFU (trust-on-first-use) SSH host-key pinning for hub→device connections.

Previously the hub connected to managed devices with paramiko AutoAddPolicy /
netmiko ssh_strict=False and never recorded host keys, so a machine-in-the-middle
on the device management LAN could impersonate a device and capture the
privileged SSH/enable credentials the hub sends.

This module pins host keys in a single known_hosts file with TOFU semantics:
  * first contact with a device  → its key is LEARNED and persisted (connection succeeds)
  * later contact, key matches    → OK
  * later contact, key CHANGED    → paramiko raises BadHostKeyException → connection REJECTED

Because the file starts empty, the existing fleet is all "first contact" on the
first run after upgrade — nothing is locked out; only a *changed* key (the MITM
signal, or a legitimately re-provisioned device) is rejected thereafter. To
re-learn a device whose key legitimately changed, delete its line from the
known_hosts file.

Set ANTHRIMON_SSH_PINNING=off to fall back to the old (unpinned) behavior.
The known_hosts location is ANTHRIMON_SSH_KNOWN_HOSTS (default below).
"""
from __future__ import annotations

import os
import threading
from contextlib import contextmanager

import paramiko
import structlog

logger = structlog.get_logger(__name__)

KNOWN_HOSTS_PATH = os.environ.get(
    "ANTHRIMON_SSH_KNOWN_HOSTS", "/var/lib/anthrimon/known_hosts"
)
# "tofu" (default) = learn-first, reject-on-mismatch.  "off" = legacy AutoAdd.
PINNING_MODE = os.environ.get("ANTHRIMON_SSH_PINNING", "tofu").lower()

_lock = threading.Lock()


def _enabled() -> bool:
    return PINNING_MODE != "off"


def _ensure_file() -> None:
    d = os.path.dirname(KNOWN_HOSTS_PATH)
    try:
        os.makedirs(d, exist_ok=True)
        if not os.path.exists(KNOWN_HOSTS_PATH):
            with open(KNOWN_HOSTS_PATH, "a"):
                pass
            os.chmod(KNOWN_HOSTS_PATH, 0o600)
    except Exception as exc:  # never let host-key bookkeeping break a connection
        logger.warning("ssh_known_hosts_init_failed", path=KNOWN_HOSTS_PATH, error=str(exc))


def _entry_host(host: str, port: int) -> str:
    """OpenSSH known_hosts host token; non-22 ports use the [host]:port form,
    matching paramiko's own server_hostkey_name convention."""
    return host if int(port) == 22 else f"[{host}]:{int(port)}"


# ── paramiko (ProCurve invoke_shell path) ───────────────────────────────────

def apply_paramiko_policy(client: paramiko.SSHClient) -> None:
    """Load known host keys and set the TOFU policy on a paramiko SSHClient.

    With known keys loaded, paramiko raises BadHostKeyException on a *known*
    host whose key changed (reject); AutoAddPolicy only governs *unknown* hosts
    (learn). Call persist_paramiko() after a successful connect to save new keys.
    """
    if not _enabled():
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        return
    _ensure_file()
    with _lock:
        try:
            client.load_host_keys(KNOWN_HOSTS_PATH)
        except Exception as exc:
            logger.warning("ssh_known_hosts_load_failed", error=str(exc))
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())


def persist_paramiko(client: paramiko.SSHClient) -> None:
    """Persist any host keys learned during connect back to the known_hosts file."""
    if not _enabled():
        return
    with _lock:
        try:
            client.save_host_keys(KNOWN_HOSTS_PATH)
        except Exception as exc:
            logger.warning("ssh_known_hosts_save_failed", error=str(exc))


# ── netmiko (everything else) ───────────────────────────────────────────────

def netmiko_extra_args() -> dict:
    """ConnectHandler kwargs that enable TOFU pinning.

    ssh_strict=False keeps AutoAddPolicy (learn unknown hosts); alt_key_file
    loads the pinned keys so paramiko rejects a changed key on a known host.
    """
    if not _enabled():
        return {}
    _ensure_file()
    return {
        "ssh_strict": False,
        "alt_host_keys": True,
        "alt_key_file": KNOWN_HOSTS_PATH,
    }


def _persist_netmiko(conn) -> None:
    """After a netmiko connect, persist any newly-learned host keys.

    netmiko exposes the underlying paramiko SSHClient as `remote_conn_pre`; its
    HostKeys hold both the keys loaded from alt_key_file and any AutoAddPolicy
    learned this connection. We merge those into the on-disk file (re-reading
    under a lock first) so concurrent collections don't clobber each other.
    """
    if not _enabled():
        return
    client = getattr(conn, "remote_conn_pre", None)
    if client is None:
        return
    try:
        client_keys = client.get_host_keys()
    except Exception:
        return
    try:
        with _lock:
            merged = paramiko.HostKeys(KNOWN_HOSTS_PATH)
            learned = 0
            for hostname, keydict in client_keys.items():
                for ktype, key in keydict.items():
                    if not merged.check(hostname, key):
                        merged.add(hostname, ktype, key)
                        learned += 1
            if learned:
                merged.save(KNOWN_HOSTS_PATH)
                logger.info("ssh_host_key_learned",
                            host=getattr(conn, "host", "?"), new_keys=learned)
    except Exception as exc:
        logger.warning("ssh_known_hosts_persist_failed", error=str(exc))


@contextmanager
def pinned_connect_handler(**conn_params):
    """Drop-in replacement for `with ConnectHandler(**p) as conn:` that applies
    TOFU host-key pinning and persists newly-learned keys.

    A changed host key surfaces as netmiko/paramiko's BadHostKeyException from
    ConnectHandler() — the connection is refused rather than silently trusted.
    """
    from netmiko import ConnectHandler

    params = {**conn_params, **netmiko_extra_args()}
    conn = ConnectHandler(**params)
    try:
        _persist_netmiko(conn)
        yield conn
    finally:
        try:
            conn.disconnect()
        except Exception:
            pass
