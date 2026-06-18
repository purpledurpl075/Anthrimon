"""Remote collector hub API.

Two authentication domains:

  Admin endpoints  — standard JWT (admin/superadmin role)
  Collector endpoints — API key in Authorization: Bearer header,
                        caller IP must be in 10.100.0.0/24 (WireGuard overlay)

Bootstrap is unauthenticated — one-time registration token validates the request.
"""
from __future__ import annotations

import asyncio
import hashlib  # noqa: F401 — used for SHA-256 in binary download + token generation
import io
import ipaddress
import json
import os
import re
import secrets
import subprocess
import time
import uuid
import yaml as _yaml
import zipfile
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import cast, select, text, update
from sqlalchemy.dialects.postgresql import INET as PG_INET
from sqlalchemy.ext.asyncio import AsyncSession

from ...database import AsyncSessionLocal

from ...dependencies import get_current_user, get_db, require_tenant_user
from ...models.api_method import DeviceApiMethod
from ...models.credential import Credential, DeviceCredential
from ...models.device import Device
from ...models.health import DeviceHealthLatest
from ...models.site import RemoteCollector, WgIpPool
from ...models.tenant import User
from ...snmp_probe import detect_vendor, VENDOR_DEVICE_TYPE as _VENDOR_DEVICE_TYPE
from ...alerting.settings import load_platform_defaults
from ...services.urls import ch_url, vm_url

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/collectors", tags=["collectors"])

_WG_IF           = "wg0"
_WG_SUBNET       = ipaddress.ip_network("10.100.0.0/24")
_COLLECTOR_DIST  = Path("/var/lib/anthrimon/downloads")
_VALID_ARCHES    = {"amd64", "arm64"}

# Go toolchain + source root (resolved relative to this file at import time)
_GO_BIN     = Path("/usr/local/go/bin/go")
_REPO_ROOT  = Path(__file__).resolve().parents[4]   # .../api/backend/routers/collectors/ → repo root
_REMOTE_SRC = _REPO_ROOT / "collectors" / "remote"

# Architectures to build: (arch_label, extra_env_overrides)
_BUILD_TARGETS: list[tuple[str, dict]] = [
    ("amd64", {"GOOS": "linux", "GOARCH": "amd64", "CGO_ENABLED": "0"}),
    ("arm64", {"GOOS": "linux", "GOARCH": "arm64", "CGO_ENABLED": "0"}),
]

TOKEN_TTL_HOURS = 24

# ── Bootstrap rate limiter ────────────────────────────────────────────────────
# Sliding-window counter keyed by source IP.  Prevents brute-force token
# enumeration on the only unauthenticated endpoint.
_BOOTSTRAP_WINDOW_S    = 900   # 15-minute window
_BOOTSTRAP_MAX_TRIES   = 10    # attempts allowed per window per IP

# ip → deque of monotonic timestamps within the current window
_bootstrap_attempts: dict[str, deque] = {}


def _real_client_ip(request: Request) -> str:
    """Return the real client IP, looking through X-Forwarded-For when the
    direct connection is from a trusted local proxy (nginx on 127.0.0.1/::1)."""
    client = request.client.host if request.client else "unknown"
    if client in ("127.0.0.1", "::1"):
        forwarded = request.headers.get("X-Forwarded-For", "")
        if forwarded:
            return forwarded.split(",")[0].strip()
    return client


def _check_bootstrap_rate_limit(ip: str) -> None:
    """Raise 429 before token validation if source IP is over the attempt limit."""
    now    = time.monotonic()
    cutoff = now - _BOOTSTRAP_WINDOW_S
    bucket = _bootstrap_attempts.get(ip)
    if bucket is None:
        bucket = deque()
        _bootstrap_attempts[ip] = bucket
    # Evict timestamps that have slid out of the window
    while bucket and bucket[0] < cutoff:
        bucket.popleft()
    if len(bucket) >= _BOOTSTRAP_MAX_TRIES:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=(
                f"Too many bootstrap attempts from this IP. "
                f"Try again in {_BOOTSTRAP_WINDOW_S // 60} minutes."
            ),
            headers={"Retry-After": str(_BOOTSTRAP_WINDOW_S)},
        )
    bucket.append(now)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _control_token(api_key_hash: str) -> str:
    """Time-based HMAC-SHA256 token for hub→collector control requests.

    Uses api_key_hash as the HMAC key and the current UTC minute as the message,
    producing a token that the collector accepts within a ±1-minute window (~3-minute
    lifetime).  This prevents indefinite replay of a captured or DB-leaked credential.
    """
    import hmac as _hmac
    minute = str(int(time.time()) // 60)
    return _hmac.new(api_key_hash.encode(), minute.encode(), hashlib.sha256).hexdigest()


def _generate_token() -> tuple[str, str]:
    """Return (plaintext, sha256_hash) for a new random token."""
    token = secrets.token_hex(32)
    return token, _sha256(token)


def _is_wg_ip(request: Request) -> bool:
    try:
        host = request.client.host
        # Allow loopback so hub-local services (e.g. trap receiver) can call
        # collector endpoints directly without going through WireGuard.
        if host in ("127.0.0.1", "::1"):
            return True
        return ipaddress.ip_address(host) in _WG_SUBNET
    except Exception:
        return False


async def _require_collector(request: Request, db: AsyncSession) -> RemoteCollector:
    """Authenticate a collector request via Bearer API key over WireGuard."""
    if not _is_wg_ip(request):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Collector endpoints only accessible through the WireGuard tunnel (10.100.0.0/24)",
        )
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing API key")
    api_key = auth.removeprefix("Bearer ").strip()
    key_hash = _sha256(api_key)
    collector = (await db.execute(
        select(RemoteCollector).where(
            RemoteCollector.api_key_hash == key_hash,
            RemoteCollector.is_active == True,  # noqa: E712
        )
    )).scalar_one_or_none()
    if collector is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid API key")
    return collector


# ── WireGuard peer management ─────────────────────────────────────────────────

def _wg_hub_pubkey() -> Optional[str]:
    """Return the hub's WireGuard public key, or None if wg0 is not configured."""
    try:
        out = subprocess.check_output(["sudo", "wg", "show", _WG_IF, "public-key"],
                                       stderr=subprocess.DEVNULL, timeout=5)
        return out.decode().strip()
    except Exception:
        return None


def _wg_hub_endpoint(override: str = "") -> Optional[str]:
    """Return the hub's WireGuard endpoint (ip:port) for remote collectors.

    If *override* is non-empty (configured via Administration → Platform →
    "WireGuard public endpoint") it is used instead of auto-detection.  This
    is required when the hub sits behind NAT — the socket trick below would
    return the private LAN address, which an off-site collector cannot reach.

    The override may be:
      • bare IP  (203.0.113.5)       — the WireGuard listen-port is appended
      • IP:port  (203.0.113.5:51820) — used as-is
    """
    import socket
    try:
        out = subprocess.check_output(["sudo", "wg", "show", _WG_IF, "listen-port"],
                                       stderr=subprocess.DEVNULL, timeout=5)
        port = int(out.decode().strip())

        if override.strip():
            host = override.strip()
            # If the caller already included a port, honour it verbatim.
            if ":" in host:
                return host
            return f"{host}:{port}"

        # Best-effort public IP detection (works on non-NAT hosts).
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        pub_ip = s.getsockname()[0]
        s.close()
        return f"{pub_ip}:{port}"
    except Exception:
        return None


def _wg_add_peer(pubkey: str, allowed_ip: str) -> None:
    """Add a WireGuard peer (live + persistent config)."""
    subprocess.run(
        ["sudo", "wg", "set", _WG_IF, "peer", pubkey, "allowed-ips", f"{allowed_ip}/32"],
        check=True, timeout=10,
    )
    # Persist to wg0.conf for reboots
    _wg_save_config()


def _wg_remove_peer(pubkey: str) -> None:
    """Remove a WireGuard peer."""
    try:
        subprocess.run(["sudo", "wg", "set", _WG_IF, "peer", pubkey, "remove"],
                       check=True, timeout=10)
        _wg_save_config()
    except Exception as exc:
        logger.warning("wg_remove_peer_failed", pubkey=pubkey[:16], error=str(exc))


def _wg_save_config() -> None:
    """Persist the current wg0 state to /etc/wireguard/wg0.conf."""
    try:
        subprocess.run(["sudo", "wg-quick", "save", _WG_IF], check=True, timeout=10)
    except Exception as exc:
        logger.warning("wg_save_config_failed", error=str(exc))


async def _allocate_wg_ip(db: AsyncSession) -> Optional[str]:
    """Claim the next free IP from the wg_ip_pool."""
    row = (await db.execute(
        select(WgIpPool)
        .where(WgIpPool.allocated == False)  # noqa: E712
        .order_by(WgIpPool.ip)
        .limit(1)
        .with_for_update(skip_locked=True)
    )).scalar_one_or_none()
    if row is None:
        return None
    row.allocated    = True
    row.allocated_at = datetime.now(timezone.utc)
    await db.flush()
    return str(row.ip)


async def _free_wg_ip(db: AsyncSession, ip: str) -> None:
    await db.execute(
        update(WgIpPool)
        .where(WgIpPool.ip == cast(ip, PG_INET))
        .values(allocated=False, allocated_at=None, assigned_to=None)
    )


# ── CA cert helper ────────────────────────────────────────────────────────────

def _ca_cert_pem() -> Optional[str]:
    try:
        with open("/etc/anthrimon/tls/ca.crt") as f:
            return f.read()
    except Exception:
        return None


# ── Admin CRUD ────────────────────────────────────────────────────────────────

class CollectorCreate(BaseModel):
    name:    str
    site_id: Optional[str] = None


def _collector_out(c: RemoteCollector, token: Optional[str] = None) -> dict:
    out = {
        "id":            str(c.id),
        "name":          c.name,
        "hostname":      c.hostname,
        "site_id":       str(c.site_id) if c.site_id else None,
        "status":        c.status,
        "timezone":      c.timezone or "UTC",
        "wg_ip":         str(c.wg_ip) if c.wg_ip else None,
        "wg_public_key": c.wg_public_key,
        "ip_address":    str(c.ip_address) if c.ip_address else None,
        "version":       c.version,
        "capabilities":  c.capabilities,
        "last_seen":     c.last_seen.isoformat() if c.last_seen else None,
        "registered_at": c.registered_at.isoformat() if c.registered_at else None,
        "is_active":          c.is_active,
        "created_at":         c.created_at.isoformat(),
        "state_interval_s":   c.state_interval_s,
        "counter_interval_s": c.counter_interval_s,
    }
    if token:
        out["registration_token"] = token   # shown only once
        out["ca_cert"]            = _ca_cert_pem()
    return out


@router.get("", summary="List remote collectors")
async def list_collectors(
    current_user: User         = Depends(get_current_user),
    db:           AsyncSession = Depends(get_db),
) -> list[dict]:
    rows = (await db.execute(
        select(RemoteCollector)
        .where(
            RemoteCollector.tenant_id == current_user.tenant_id,
            # Exclude hub-local service accounts (e.g. hub-trap-receiver) which
            # authenticate via direct API key with no WireGuard IP.  Real collectors
            # always acquire a wg_ip during bootstrap before going online.
            ~(
                (RemoteCollector.wg_ip == None) &
                (RemoteCollector.status == "online")
            ),
        )
        .order_by(RemoteCollector.name)
    )).scalars().all()
    # Refresh online/offline status based on last_seen
    now = datetime.now(timezone.utc)
    out = []
    for c in rows:
        if c.registered_at and c.last_seen:
            age = (now - c.last_seen.replace(tzinfo=timezone.utc)).total_seconds()
            computed = "online" if age < 120 else "offline"
            if c.status != computed:
                c.status = computed
        out.append(_collector_out(c))
    await db.commit()
    return out


@router.post("", summary="Create a remote collector (generates registration token)",
             status_code=status.HTTP_201_CREATED)
async def create_collector(
    body:         CollectorCreate,
    current_user: User         = Depends(require_tenant_user("tenant_admin")),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    token, token_hash = _generate_token()
    c = RemoteCollector(
        tenant_id        = current_user.tenant_id,
        site_id          = body.site_id,
        name             = body.name,
        token_hash       = token_hash,
        token_expires_at = datetime.now(timezone.utc) + timedelta(hours=TOKEN_TTL_HOURS),
        status           = "pending",
    )
    db.add(c)
    await db.commit()
    await db.refresh(c)
    logger.info("collector_created", collector=c.name, id=str(c.id))
    return _collector_out(c, token=token)


# ── Binary build management ───────────────────────────────────────────────────
# These routes MUST be registered before /{collector_id} so FastAPI doesn't
# swallow "builds" or "builds/status" as a collector UUID lookup.

def _binary_info(arch: str) -> dict:
    """Return existence + metadata for a built binary."""
    p = _COLLECTOR_DIST / f"anthrimon-remote-collector-linux-{arch}"
    if p.exists():
        st = p.stat()
        return {
            "built":      True,
            "size_bytes": st.st_size,
            "built_at":   datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
        }
    return {"built": False, "size_bytes": None, "built_at": None}


@router.get("/builds/status", summary="Check whether collector binaries have been built")
async def collector_build_status(
    _: User = Depends(require_tenant_user("tenant_admin")),
) -> dict:
    """Return build state for every supported architecture plus toolchain availability."""
    return {
        "arches":         {arch: _binary_info(arch) for arch, _ in _BUILD_TARGETS},
        "go_available":   _GO_BIN.exists(),
        "source_exists":  _REMOTE_SRC.exists(),
    }


@router.post("/builds", summary="Build collector binaries for all supported architectures")
async def build_collector_binaries(
    _: User = Depends(require_tenant_user("tenant_admin")),
) -> dict:
    """Compile linux/amd64 and linux/arm64 collector binaries on the hub.

    Each arch is compiled sequentially (Go parallelises internally).  Returns
    per-arch results; ``all_ok`` is True only when every arch succeeded.
    Typical build time: 20–40 s total.
    """
    if not _GO_BIN.exists():
        raise HTTPException(
            status_code=503,
            detail=f"Go toolchain not found at {_GO_BIN}. "
                   "Install Go 1.22+ to enable on-hub builds.",
        )
    if not _REMOTE_SRC.exists():
        raise HTTPException(
            status_code=503,
            detail=f"Collector source not found at {_REMOTE_SRC}. "
                   "Ensure the Anthrimon repository is intact.",
        )

    _COLLECTOR_DIST.mkdir(parents=True, exist_ok=True)
    loop   = asyncio.get_running_loop()
    results: dict[str, dict] = {}

    # Each entry: (arch, cmd_package, output_filename)
    _BINARIES = [
        ("remote-collector", "./cmd/remote-collector/"),
        ("trap-handler",     "./cmd/trap-handler/"),
    ]

    for arch, extra_env in _BUILD_TARGETS:
        env = {**os.environ, **extra_env}
        arch_ok = True
        arch_sizes: dict[str, int] = {}

        for bin_name, cmd_pkg in _BINARIES:
            out_path = _COLLECTOR_DIST / f"anthrimon-{bin_name}-linux-{arch}"

            def _run(src=str(_REMOTE_SRC), out=str(out_path), e=env, pkg=cmd_pkg):
                return subprocess.run(
                    [str(_GO_BIN), "build", "-trimpath", "-ldflags=-s -w", "-o", out, pkg],
                    cwd=src, env=e,
                    capture_output=True, text=True,
                    timeout=300,
                )

            logger.info("collector_build_start", arch=arch, binary=bin_name)
            try:
                proc = await loop.run_in_executor(None, _run)
                if proc.returncode == 0:
                    out_path.chmod(0o755)
                    arch_sizes[bin_name] = out_path.stat().st_size
                    logger.info("collector_build_ok", arch=arch, binary=bin_name,
                                size=arch_sizes[bin_name])
                else:
                    error = (proc.stderr or proc.stdout or "unknown error").strip()
                    arch_ok = False
                    logger.error("collector_build_failed", arch=arch, binary=bin_name, error=error)
                    results[arch] = {"success": False, "error": f"{bin_name}: {error}"}
                    break
            except subprocess.TimeoutExpired:
                arch_ok = False
                results[arch] = {"success": False, "error": f"{bin_name}: timed out after 300 s"}
                logger.error("collector_build_timeout", arch=arch, binary=bin_name)
                break
            except Exception as exc:
                arch_ok = False
                results[arch] = {"success": False, "error": f"{bin_name}: {exc}"}
                logger.error("collector_build_exception", arch=arch, binary=bin_name, exc=str(exc))
                break

        if arch_ok:
            results[arch] = {"success": True, "size_bytes": arch_sizes}

    all_ok = all(r["success"] for r in results.values())

    # Auto-install the trap-handler for the hub's own architecture so
    # snmptrapd can invoke it immediately — no manual step required.
    import platform as _platform
    import shutil as _shutil
    local_arch = "arm64" if _platform.machine() in ("arm64", "aarch64") else "amd64"
    handler_src = _COLLECTOR_DIST / f"anthrimon-trap-handler-linux-{local_arch}"
    handler_dst = Path("/usr/local/bin/anthrimon-traphandler")
    if handler_src.exists():
        try:
            _shutil.copy2(str(handler_src), str(handler_dst))
            handler_dst.chmod(0o755)
            logger.info("trap_handler_installed", path=str(handler_dst), arch=local_arch)
            results["_hub_trap_handler"] = {"installed": str(handler_dst)}
        except Exception as exc:
            logger.error("trap_handler_install_failed", error=str(exc))
            results["_hub_trap_handler"] = {"installed": False, "error": str(exc)}

    return {"all_ok": all_ok, "arches": results}


# ── Collector-facing routes (no JWT — use API key from WireGuard tunnel) ──────
# These MUST be defined before /{collector_id} to avoid path-param shadowing.

def _serve_binary(name: str, arch: str) -> Response:
    """Read a built binary from _COLLECTOR_DIST and return it as a download response."""
    binary_path = _COLLECTOR_DIST / f"anthrimon-{name}-linux-{arch}"
    if not binary_path.exists():
        raise HTTPException(
            status_code=503,
            detail=f"{name} binary for linux/{arch} not built yet — run POST /collectors/builds first.",
        )
    data = binary_path.read_bytes()
    sha256_hex = hashlib.sha256(data).hexdigest()
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="anthrimon-{name}-linux-{arch}"',
            "X-Binary-SHA256": sha256_hex,
        },
    )


@router.get("/trap-users", summary="Return SNMPv3 USM credentials for the hub trap receiver")
async def get_hub_trap_users(
    request: Request,
    db:      AsyncSession = Depends(get_db),
) -> dict:
    """Called by anthrimon-trap-receiver on startup and periodically to load
    all SNMPv3 credentials so it can decode authPriv traps from any device.
    Authenticated via collector API key (same as trap ingest).
    """
    collector = await _require_collector(request, db)
    users = await _collect_v3_users_for_collector(None, str(collector.tenant_id), db)
    return {"users": users}


class TrapV3UserIn(BaseModel):
    username:   str
    auth_proto: str = "SHA-256"
    auth_key:   str
    priv_proto: str = "AES"
    priv_key:   str
    device_id:  uuid.UUID | None = None  # if set, SSH to device to discover engine_id
    engine_id:  str        | None = None  # manual override; skips SSH discovery


@router.get("/trap-v3-users", summary="List tenant-wide SNMPv3 trap users")
async def list_trap_v3_users(
    current_user: User         = Depends(require_tenant_user("tenant_admin")),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    from ...models.credential import Credential
    rows = (await db.execute(
        select(Credential).where(
            Credential.tenant_id == current_user.tenant_id,
            Credential.type == "snmp_v3",
            Credential.data["trap_only"].as_boolean() == True,  # noqa: E712
        )
    )).scalars().all()
    return {"users": [
        {
            "username":   r.data.get("username", ""),
            "auth_proto": r.data.get("auth_protocol", ""),
            "priv_proto": r.data.get("priv_protocol", ""),
        }
        for r in rows
    ]}


@router.post("/trap-v3-users", summary="Add a tenant-wide SNMPv3 trap user")
async def add_trap_v3_user(
    body:         TrapV3UserIn,
    current_user: User         = Depends(require_tenant_user("tenant_admin")),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    """Store a v3 USM credential for trap decryption only.  Not tied to any
    polled device — use this for devices that send v3 traps but are polled
    via v2c (or not polled at all).

    Pass device_id to auto-discover the engine ID via SSH, or engine_id to
    set it manually.  Both are optional; omitting both stores without an engine ID.
    """
    from ...models.credential import Credential
    from ...models.device import Device

    # ── Resolve engine ID ──────────────────────────────────────────────────
    engine_id: str | None = body.engine_id

    if engine_id is None and body.device_id is not None:
        device = (await db.execute(
            select(Device).where(
                Device.id == body.device_id,
                Device.tenant_id == current_user.tenant_id,
            )
        )).scalar_one_or_none()

        if device is not None:
            from ...models.credential import Credential as _Cred
            from ...models.device_credential import DeviceCredential
            ssh_row = (await db.execute(
                select(_Cred).join(
                    DeviceCredential, DeviceCredential.credential_id == _Cred.id
                ).where(
                    DeviceCredential.device_id == device.id,
                    _Cred.type == "ssh",
                )
            )).scalar_one_or_none()

            if ssh_row is not None:
                from ...configmgmt.collector import _vendor_key
                vendor_key = _vendor_key(device)
                engine_id = await _discover_engine_id(
                    str(device.ip_address), vendor_key, ssh_row.data
                )
                if engine_id:
                    logger.info("engine_id_discovered", device=str(device.id),
                                username=body.username, engine_id=engine_id)
                else:
                    logger.warning("engine_id_not_discovered", device=str(device.id),
                                   username=body.username)

    # ── Upsert credential ──────────────────────────────────────────────────
    existing = (await db.execute(
        select(Credential).where(
            Credential.tenant_id == current_user.tenant_id,
            Credential.type == "snmp_v3",
            Credential.data["trap_only"].as_boolean() == True,  # noqa: E712
            Credential.data["username"].as_string() == body.username,
        )
    )).scalar_one_or_none()

    data: dict = {
        "trap_only":      True,
        "username":       body.username,
        "auth_protocol":  body.auth_proto,
        "auth_key":       body.auth_key,
        "priv_protocol":  body.priv_proto,
        "priv_key":       body.priv_key,
    }
    if engine_id:
        data["engine_id"] = engine_id

    if existing:
        existing.data = data
        await db.commit()
    else:
        cred = Credential(
            tenant_id=current_user.tenant_id,
            type="snmp_v3",
            name=f"trap-only:{body.username}",
            data=data,
        )
        db.add(cred)
        await db.commit()

    asyncio.create_task(_push_trap_config(None, str(current_user.tenant_id)))
    return {"username": body.username, "engine_id": engine_id, "status": "ok"}


class _DiscoverEngineIdIn(BaseModel):
    device_id: uuid.UUID


@router.post("/trap-v3-users/{username}/discover-engine-id",
             summary="SSH to a device and update the stored SNMP engine ID for a trap user")
async def discover_trap_v3_engine_id(
    username:     str,
    body:         _DiscoverEngineIdIn,
    current_user: User         = Depends(require_tenant_user("tenant_admin")),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    """Re-run SSH engine ID discovery for an existing trap-only v3 user.

    Useful when a device is replaced (engine ID changes) or when SSH credentials
    weren't available when the trap user was first created.
    """
    from ...models.credential import Credential
    from ...models.device import Device
    from ...models.device_credential import DeviceCredential

    cred = (await db.execute(
        select(Credential).where(
            Credential.tenant_id == current_user.tenant_id,
            Credential.type == "snmp_v3",
            Credential.data["trap_only"].as_boolean() == True,  # noqa: E712
            Credential.data["username"].as_string() == username,
        )
    )).scalar_one_or_none()
    if not cred:
        raise HTTPException(status_code=404, detail=f"Trap user '{username}' not found")

    device = (await db.execute(
        select(Device).where(
            Device.id == body.device_id,
            Device.tenant_id == current_user.tenant_id,
        )
    )).scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    ssh_row = (await db.execute(
        select(Credential).join(
            DeviceCredential, DeviceCredential.credential_id == Credential.id
        ).where(
            DeviceCredential.device_id == device.id,
            Credential.type == "ssh",
        )
    )).scalar_one_or_none()
    if not ssh_row:
        raise HTTPException(status_code=422, detail="Device has no SSH credential")

    from ...configmgmt.collector import _vendor_key
    vendor_key = _vendor_key(device)
    engine_id = await _discover_engine_id(str(device.ip_address), vendor_key, ssh_row.data)
    if not engine_id:
        raise HTTPException(status_code=422,
                            detail="Could not discover engine ID — check SSH credentials and vendor support")

    updated = dict(cred.data)
    updated["engine_id"] = engine_id
    cred.data = updated
    await db.commit()

    asyncio.create_task(_push_trap_config(None, str(current_user.tenant_id)))
    logger.info("engine_id_updated", username=username, device=str(device.id),
                engine_id=engine_id)
    return {"username": username, "engine_id": engine_id, "status": "ok"}


@router.delete("/trap-v3-users/{username}", status_code=204, response_model=None,
               summary="Remove a tenant-wide SNMPv3 trap user")
async def delete_trap_v3_user(
    username:     str,
    current_user: User         = Depends(require_tenant_user("tenant_admin")),
    db:           AsyncSession = Depends(get_db),
) -> None:
    from ...models.credential import Credential
    row = (await db.execute(
        select(Credential).where(
            Credential.tenant_id == current_user.tenant_id,
            Credential.type == "snmp_v3",
            Credential.data["trap_only"].as_boolean() == True,  # noqa: E712
            Credential.data["username"].as_string() == username,
        )
    )).scalar_one_or_none()
    if row:
        await db.delete(row)
        await db.commit()


@router.get("/binary", summary="Download the collector binary (collector API-key auth)")
async def download_binary_self_update(
    arch:    str     = "amd64",
    request: Request = None,
    db:      AsyncSession = Depends(get_db),
) -> Response:
    """Serve the pre-built remote-collector binary.  Called during self-update."""
    await _require_collector(request, db)
    if arch not in _VALID_ARCHES:
        raise HTTPException(status_code=400,
                            detail=f"arch must be one of: {', '.join(sorted(_VALID_ARCHES))}")
    return _serve_binary("remote-collector", arch)


@router.get("/trap-handler-binary", summary="Download the trap-handler binary (collector API-key auth)")
async def download_trap_handler_binary(
    arch:    str     = "amd64",
    request: Request = None,
    db:      AsyncSession = Depends(get_db),
) -> Response:
    """Serve the pre-built anthrimon-traphandler binary.

    Called by the collector bootstrap/install script to put the handler at
    /usr/local/bin/anthrimon-traphandler so snmptrapd can invoke it.
    """
    await _require_collector(request, db)
    if arch not in _VALID_ARCHES:
        raise HTTPException(status_code=400,
                            detail=f"arch must be one of: {', '.join(sorted(_VALID_ARCHES))}")
    return _serve_binary("trap-handler", arch)


@router.get("/config", summary="Fetch device list and credentials for this collector")
async def collector_config(
    request: Request,
    db:      AsyncSession = Depends(get_db),
) -> dict:
    from ... import crypto as _crypto

    collector = await _require_collector(request, db)

    # Devices assigned to this collector
    device_rows = (await db.execute(
        select(Device)
        .where(
            Device.tenant_id == collector.tenant_id,
            Device.collector_id == collector.id,
            Device.is_active == True,  # noqa: E712
        )
    )).scalars().all()

    device_ids = [dev.id for dev in device_rows]

    # Build set of device IDs that have eAPI enabled and reachable (one query)
    eapi_enabled_ids: set[str] = set()
    if device_ids:
        eapi_rows = (await db.execute(
            select(DeviceApiMethod.device_id)
            .where(
                DeviceApiMethod.device_id.in_(device_ids),
                DeviceApiMethod.method == "arista_eapi",
                DeviceApiMethod.enabled == True,  # noqa: E712
                DeviceApiMethod.reachable == True,  # noqa: E712
            )
        )).all()
        eapi_enabled_ids = {str(r[0]) for r in eapi_rows}

    devices_out = []
    for dev in device_rows:
        # Load credentials
        creds = (await db.execute(
            select(DeviceCredential, Credential)
            .join(Credential, Credential.id == DeviceCredential.credential_id)
            .where(DeviceCredential.device_id == dev.id)
            .order_by(DeviceCredential.priority)
        )).all()

        cred_list = []
        for dc, cred in creds:
            cred_data = cred.data if isinstance(cred.data, dict) else json.loads(cred.data)
            # Decrypt passwords before sending — collector doesn't have the encryption key
            if cred_data.get("password") and _crypto.is_configured():
                try:
                    cred_data = {**cred_data, "password": _crypto.decrypt(cred_data["password"])}
                except Exception as _dec_exc:
                    logger.error(
                        "credential_decrypt_failed",
                        device_id=str(dev.id),
                        credential_type=cred.type,
                        error=str(_dec_exc),
                    )
                    continue  # skip this credential — sending ciphertext would break the collector
            cred_list.append({
                "type":     cred.type,
                "priority": dc.priority,
                "data":     cred_data,
            })

        devices_out.append({
            "id":                      str(dev.id),
            "hostname":                dev.display_name,
            "mgmt_ip":                 dev.mgmt_ip_str,
            "vendor":                  dev.vendor,
            "device_type":             dev.device_type,
            "snmp_port":               dev.snmp_port,
            "polling_interval_s":      dev.polling_interval_s,
            "credentials":             cred_list,
            "rest_collection_enabled": dev.rest_collection_enabled,
            "eapi_enabled":            str(dev.id) in eapi_enabled_ids,
            "config_interval_s":       3600,
        })

    return {
        "collector_id":     str(collector.id),
        "timezone":         collector.timezone or "UTC",
        "state_interval_s": collector.state_interval_s or 15,
        "counter_interval_s": collector.counter_interval_s or 60,
        "devices":          devices_out,
        "generated_at":     datetime.now(timezone.utc).isoformat(),
    }


@router.get("/{collector_id}", summary="Get collector details")
async def get_collector(
    collector_id: str,
    current_user: User         = Depends(get_current_user),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    c = (await db.execute(
        select(RemoteCollector).where(
            RemoteCollector.id == collector_id,
            RemoteCollector.tenant_id == current_user.tenant_id,
        )
    )).scalar_one_or_none()
    if c is None:
        raise HTTPException(status_code=404, detail="Collector not found")
    return _collector_out(c)


class CollectorUpdate(BaseModel):
    timezone:           Optional[str] = None
    name:               Optional[str] = None
    state_interval_s:   Optional[int] = Field(None, ge=5)
    counter_interval_s: Optional[int] = Field(None, ge=5)


@router.patch("/{collector_id}", summary="Update collector settings (timezone, name, poll intervals)")
async def patch_collector(
    collector_id: str,
    body:         CollectorUpdate,
    current_user: User         = Depends(require_tenant_user("tenant_admin")),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    c = (await db.execute(
        select(RemoteCollector).where(
            RemoteCollector.id == collector_id,
            RemoteCollector.tenant_id == current_user.tenant_id,
        )
    )).scalar_one_or_none()
    if c is None:
        raise HTTPException(status_code=404, detail="Collector not found")
    if body.timezone is not None:
        try:
            import zoneinfo
            zoneinfo.ZoneInfo(body.timezone)
        except (KeyError, zoneinfo.ZoneInfoNotFoundError):
            raise HTTPException(status_code=400, detail=f"Unknown timezone: {body.timezone!r}")
        c.timezone = body.timezone
    if body.name is not None:
        c.name = body.name
    # interval fields use sentinel -1 to distinguish "set to null/default" from "not provided"
    if "state_interval_s" in body.model_fields_set:
        c.state_interval_s = body.state_interval_s
    if "counter_interval_s" in body.model_fields_set:
        c.counter_interval_s = body.counter_interval_s
    await db.commit()
    await db.refresh(c)
    return _collector_out(c)


async def _ch_query(query: str) -> list[dict]:
    """Execute a ClickHouse query and return rows as dicts (same pattern as syslog router)."""
    flat = " ".join(query.split()) + " FORMAT JSON"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(ch_url(), content=flat,
                                     headers={"Content-Type": "text/plain"})
        resp.raise_for_status()
        return resp.json().get("data", [])
    except Exception as exc:
        logger.warning("ch_query_failed", error=str(exc))
        return []


@router.get("/{collector_id}/details", summary="Collector details + assigned devices")
async def collector_details(
    collector_id: str,
    current_user: User         = Depends(require_tenant_user("tenant_admin")),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    c = (await db.execute(
        select(RemoteCollector).where(
            RemoteCollector.id == collector_id,
            RemoteCollector.tenant_id == current_user.tenant_id,
        )
    )).scalar_one_or_none()
    if c is None:
        raise HTTPException(status_code=404, detail="Collector not found")

    devices = (await db.execute(
        select(Device).where(
            Device.collector_id == c.id,
            Device.is_active == True,  # noqa: E712
        )
    )).scalars().all()

    return {
        **_collector_out(c),
        "devices": [
            {
                "id":          str(d.id),
                "hostname":    d.display_name,
                "mgmt_ip":     d.mgmt_ip_str if d.mgmt_ip else None,
                "vendor":      d.vendor,
                "device_type": d.device_type,
                "last_polled": d.last_polled.isoformat() if d.last_polled else None,
            }
            for d in devices
        ],
    }


@router.get("/{collector_id}/logs", summary="Recent syslog from collector's assigned devices")
async def collector_logs(
    collector_id: str,
    limit:   int = Query(default=100, ge=1, le=500),
    minutes: int = Query(default=120, ge=1, le=10080),
    current_user: User         = Depends(require_tenant_user("tenant_admin")),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    c = (await db.execute(
        select(RemoteCollector).where(
            RemoteCollector.id == collector_id,
            RemoteCollector.tenant_id == current_user.tenant_id,
        )
    )).scalar_one_or_none()
    if c is None:
        raise HTTPException(status_code=404, detail="Collector not found")

    device_ids = (await db.execute(
        select(Device.id).where(
            Device.collector_id == c.id,
            Device.is_active == True,  # noqa: E712
        )
    )).scalars().all()

    if not device_ids:
        return {"messages": [], "device_count": 0}

    ids_str = ", ".join(f"toUUID('{str(d)}')" for d in device_ids)
    rows = await _ch_query(
        f"SELECT toString(device_id) AS device_id, toString(device_ip) AS device_ip,"
        f" facility, severity, toString(ts) AS ts, hostname, program, message,"
        f" toString(received_at) AS received_at"
        f" FROM syslog_messages"
        f" WHERE device_id IN ({ids_str})"
        f"   AND received_at >= now() - INTERVAL {minutes} MINUTE"
        f" ORDER BY received_at DESC"
        f" LIMIT {limit}"
    )
    return {"messages": rows, "device_count": len(device_ids)}


@router.get("/{collector_id}/collector-logs",
            summary="Recent operational logs from the collector process itself")
async def collector_own_logs(
    collector_id: str,
    limit:   int = Query(default=200, ge=1, le=1000),
    minutes: int = Query(default=120, ge=1, le=10080),
    current_user: User         = Depends(require_tenant_user("tenant_admin")),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    c = (await db.execute(
        select(RemoteCollector).where(
            RemoteCollector.id == collector_id,
            RemoteCollector.tenant_id == current_user.tenant_id,
        )
    )).scalar_one_or_none()
    if c is None:
        raise HTTPException(status_code=404, detail="Collector not found")

    rows = await _ch_query(
        f"SELECT toString(ts) AS log_ts, level, message, fields"
        f" FROM collector_logs"
        f" WHERE toString(collector_id) = '{str(c.id)}'"
        f"   AND ts >= now() - INTERVAL {minutes} MINUTE"
        f" ORDER BY ts DESC"
        f" LIMIT {limit}"
    )
    # Normalise key name for the frontend
    for r in rows:
        r["ts"] = r.pop("log_ts", "")
    return {"logs": rows}


@router.delete("/{collector_id}", status_code=204, response_model=None,
               summary="Revoke (active) or permanently delete (revoked) a collector")
async def delete_collector(
    collector_id: str,
    current_user: User         = Depends(require_tenant_user("tenant_admin")),
    db:           AsyncSession = Depends(get_db),
) -> None:
    c = (await db.execute(
        select(RemoteCollector).where(
            RemoteCollector.id == collector_id,
            RemoteCollector.tenant_id == current_user.tenant_id,
        )
    )).scalar_one_or_none()
    if c is None:
        return

    if not c.is_active:
        # Already revoked — permanently purge the DB record.
        # FK constraints on devices.collector_id and wg_ip_pool.assigned_to
        # are both ON DELETE SET NULL so this is safe.
        await db.delete(c)
        await db.commit()
        logger.info("collector_purged", collector=c.name)
        return

    # Active collector — revoke it first.
    if c.wg_public_key:
        _wg_remove_peer(c.wg_public_key)
    if c.wg_ip:
        await _free_wg_ip(db, str(c.wg_ip))
    # Unassign devices — they fall back to hub polling
    await db.execute(
        update(Device).where(Device.collector_id == c.id).values(collector_id=None)
    )
    c.is_active     = False
    c.status        = "revoked"
    c.api_key_hash  = None
    c.wg_public_key = None
    c.wg_ip         = None
    await db.commit()
    logger.info("collector_revoked", collector=c.name)


@router.post("/{collector_id}/update", summary="Trigger a hot-patch self-update on a remote collector")
async def trigger_collector_update(
    collector_id: str,
    current_user: User         = Depends(require_tenant_user("tenant_admin")),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    """Signal a running collector to download and install the latest built binary.

    The hub sends POST /update to the collector's control server on its
    WireGuard IP (:9090).  The collector responds immediately, then
    asynchronously downloads the binary from GET /collectors/binary, verifies
    the SHA-256, atomically replaces its executable, drains all goroutines, and
    re-execs into the new binary — without tearing down the WireGuard tunnel.

    Prerequisites:
      - The collector must be online (reachable over the WireGuard tunnel).
      - Binaries must have been built first via POST /collectors/builds.

    If the collector is offline the response indicates so.  Trigger again once
    it comes back online — there is no automatic retry.
    """
    c = (await db.execute(
        select(RemoteCollector).where(
            RemoteCollector.id == collector_id,
            RemoteCollector.tenant_id == current_user.tenant_id,
        )
    )).scalar_one_or_none()
    if c is None:
        raise HTTPException(status_code=404, detail="Collector not found")

    if not c.wg_ip:
        raise HTTPException(
            status_code=409,
            detail="Collector has no WireGuard IP — bootstrap it first",
        )

    # Ensure at least one binary exists.
    any_built = any(
        (_COLLECTOR_DIST / f"anthrimon-collector-linux-{arch}").exists()
        for arch, _ in _BUILD_TARGETS
    )
    if not any_built:
        raise HTTPException(
            status_code=503,
            detail="No built binaries found — run POST /collectors/builds first",
        )

    wg_ip_str = str(c.wg_ip).split("/")[0]
    if ipaddress.ip_address(wg_ip_str) not in _WG_SUBNET:
        raise HTTPException(status_code=409, detail="Collector WireGuard IP is outside the expected subnet")
    control_url = f"http://{wg_ip_str}:9090/update"
    try:
        async with httpx.AsyncClient(timeout=10) as hc:
            resp = await hc.post(
                control_url,
                headers={"Authorization": f"Bearer {_control_token(c.api_key_hash)}"},
            )
        if resp.status_code == 200:
            logger.info("collector_update_triggered",
                        collector=c.name, wg_ip=str(c.wg_ip))
            return {
                "status":    "update_triggered",
                "collector": c.name,
                "detail":    "Collector is downloading and installing the latest binary",
            }
        return {
            "status": "error",
            "detail": f"Collector control server returned HTTP {resp.status_code}",
        }
    except httpx.ConnectError:
        return {
            "status": "offline",
            "detail": "Collector unreachable — trigger again once it comes back online",
        }
    except Exception as exc:
        return {"status": "error", "detail": str(exc)}


@router.post("/{collector_id}/refresh", summary="Trigger an immediate device-config refresh on a remote collector")
async def trigger_collector_refresh(
    collector_id: str,
    current_user: User         = Depends(require_tenant_user("tenant_admin")),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    """Tell a running collector to re-fetch its device list from the hub immediately.

    Useful after assigning or removing devices from a collector — rather than
    waiting up to 5 minutes for the collector's periodic config pull, this
    pushes the trigger instantly.

    The hub sends POST /refresh to the collector's control server on its
    WireGuard IP (:9090).  The collector re-fetches GET /collectors/config and
    updates its in-memory device list without restarting.

    If the collector is offline the response indicates so.
    """
    c = (await db.execute(
        select(RemoteCollector).where(
            RemoteCollector.id == collector_id,
            RemoteCollector.tenant_id == current_user.tenant_id,
        )
    )).scalar_one_or_none()
    if c is None:
        raise HTTPException(status_code=404, detail="Collector not found")

    if not c.wg_ip:
        raise HTTPException(
            status_code=409,
            detail="Collector has no WireGuard IP — bootstrap it first",
        )

    wg_ip_str = str(c.wg_ip).split("/")[0]
    if ipaddress.ip_address(wg_ip_str) not in _WG_SUBNET:
        raise HTTPException(status_code=409, detail="Collector WireGuard IP is outside the expected subnet")
    control_url = f"http://{wg_ip_str}:9090/refresh"
    try:
        async with httpx.AsyncClient(timeout=10) as hc:
            resp = await hc.post(
                control_url,
                headers={"Authorization": f"Bearer {_control_token(c.api_key_hash)}"},
            )
        if resp.status_code == 200:
            logger.info("collector_refresh_triggered",
                        collector=c.name, wg_ip=str(c.wg_ip))
            return {
                "status":    "refresh_triggered",
                "collector": c.name,
                "detail":    "Collector is re-fetching its device configuration",
            }
        return {
            "status": "error",
            "detail": f"Collector control server returned HTTP {resp.status_code}",
        }
    except httpx.ConnectError:
        return {
            "status": "offline",
            "detail": "Collector unreachable — trigger again once it comes back online",
        }
    except Exception as exc:
        return {"status": "error", "detail": str(exc)}


class CollectorProbeRequest(BaseModel):
    ip:             str
    port:           int = 161
    credential_ids: list[uuid.UUID]
    timeout_s:      int = 3


class CollectorSweepRequest(BaseModel):
    cidr:           str
    port:           int = 161
    credential_ids: list[uuid.UUID]
    timeout_s:      int = 3
    max_concurrent: int = 50


def _cred_to_spec(cred) -> dict:
    """Translate a Credential row to the CredSpec JSON expected by the collector."""
    if cred.type == "snmp_v3":
        return {
            "version":    "snmp_v3",
            "username":   cred.data.get("username", ""),
            "auth_key":   cred.data.get("auth_key", ""),
            "priv_key":   cred.data.get("priv_key", ""),
            "auth_proto": cred.data.get("auth_protocol", "sha256"),
            "priv_proto": cred.data.get("priv_protocol", "aes"),
        }
    return {
        "version":   "snmp_v2c",
        "community": cred.data.get("community", "public"),
    }


async def _get_collector_for_tenant(collector_id: str, tenant_id: uuid.UUID, db: AsyncSession) -> RemoteCollector:
    c = (await db.execute(
        select(RemoteCollector).where(
            RemoteCollector.id == collector_id,
            RemoteCollector.tenant_id == tenant_id,
        )
    )).scalar_one_or_none()
    if c is None:
        raise HTTPException(status_code=404, detail="Collector not found")
    if not c.wg_ip:
        raise HTTPException(status_code=409, detail="Collector has no WireGuard IP — bootstrap it first")
    wg_ip = str(c.wg_ip).split("/")[0]
    if ipaddress.ip_address(wg_ip) not in _WG_SUBNET:
        raise HTTPException(status_code=409, detail="Collector WireGuard IP is outside the expected subnet")
    return c


@router.post("/{collector_id}/probe", summary="Probe a single device via a remote collector")
async def collector_probe(
    collector_id: str,
    body:         CollectorProbeRequest,
    current_user: User         = Depends(require_tenant_user("tenant_admin")),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    """Forward a single-device SNMP probe to the named collector and return the result.

    The hub translates credential UUIDs to CredSpec objects and POSTs them to
    the collector's /probe control endpoint.  Returns 200 with the ProbeResult
    on success, 404 if the device does not respond.
    """
    c = await _get_collector_for_tenant(collector_id, current_user.tenant_id, db)

    from ...models.credential import Credential
    cred_rows = (await db.execute(
        select(Credential).where(
            Credential.id.in_(body.credential_ids),
            Credential.tenant_id == current_user.tenant_id,
            Credential.type.in_(("snmp_v2c", "snmp_v3")),
        )
    )).scalars().all()
    if not cred_rows:
        raise HTTPException(status_code=404, detail="No valid SNMP credentials found")

    cred_map  = {cr.id: cr for cr in cred_rows}
    cred_specs = [_cred_to_spec(cred_map[cid]) for cid in body.credential_ids if cid in cred_map]

    wg_ip   = str(c.wg_ip).split("/")[0]
    timeout = max(body.timeout_s * len(cred_specs) + 2, 10)
    try:
        async with httpx.AsyncClient(timeout=timeout) as hc:
            resp = await hc.post(
                f"http://{wg_ip}:9090/probe",
                json={"ip": body.ip, "port": body.port, "creds": cred_specs, "timeout_s": body.timeout_s},
                headers={"Authorization": f"Bearer {_control_token(c.api_key_hash)}"},
            )
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Collector unreachable")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail="Device did not respond to SNMP")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Collector returned HTTP {resp.status_code}")
    return resp.json()


@router.post("/{collector_id}/sweep", summary="Run a CIDR discovery sweep via a remote collector")
async def collector_sweep(
    collector_id: str,
    body:         CollectorSweepRequest,
    current_user: User         = Depends(require_tenant_user("tenant_admin")),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    """Forward a CIDR sweep to the named collector and return results when complete.

    Note: this is a synchronous call that blocks until the collector finishes
    scanning the entire CIDR.  For large subnets the hub HTTP client uses a
    generous timeout.  The discovery page's async-job wrapper calls this internally.
    """
    try:
        network = ipaddress.ip_network(body.cidr, strict=False)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid CIDR notation")
    if network.num_addresses > 1024:
        raise HTTPException(status_code=400, detail="CIDR too large — max /22 (1022 hosts)")

    c = await _get_collector_for_tenant(collector_id, current_user.tenant_id, db)

    from ...models.credential import Credential
    cred_rows = (await db.execute(
        select(Credential).where(
            Credential.id.in_(body.credential_ids),
            Credential.tenant_id == current_user.tenant_id,
            Credential.type.in_(("snmp_v2c", "snmp_v3")),
        )
    )).scalars().all()
    if not cred_rows:
        raise HTTPException(status_code=404, detail="No valid SNMP credentials found")

    cred_map   = {cr.id: cr for cr in cred_rows}
    cred_specs = [_cred_to_spec(cred_map[cid]) for cid in body.credential_ids if cid in cred_map]

    wg_ip   = str(c.wg_ip).split("/")[0]
    hosts   = network.num_addresses - 2
    timeout = max(body.timeout_s * hosts / max(body.max_concurrent, 1) * 2 + 30, 60)
    try:
        async with httpx.AsyncClient(timeout=timeout) as hc:
            resp = await hc.post(
                f"http://{wg_ip}:9090/sweep",
                json={
                    "cidr":           body.cidr,
                    "port":           body.port,
                    "creds":          cred_specs,
                    "timeout_s":      body.timeout_s,
                    "max_concurrent": body.max_concurrent,
                },
                headers={"Authorization": f"Bearer {_control_token(c.api_key_hash)}"},
            )
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Collector unreachable")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Collector returned HTTP {resp.status_code}")
    return resp.json()


@router.post("/{collector_id}/token", summary="Regenerate registration token")
async def regenerate_token(
    collector_id: str,
    current_user: User         = Depends(require_tenant_user("tenant_admin")),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    c = (await db.execute(
        select(RemoteCollector).where(
            RemoteCollector.id == collector_id,
            RemoteCollector.tenant_id == current_user.tenant_id,
        )
    )).scalar_one_or_none()
    if c is None:
        raise HTTPException(status_code=404, detail="Collector not found")
    token, token_hash = _generate_token()
    c.token_hash       = token_hash
    c.token_expires_at = datetime.now(timezone.utc) + timedelta(hours=TOKEN_TTL_HOURS)
    await db.commit()
    return {"registration_token": token, "ca_cert": _ca_cert_pem(),
            "expires_at": c.token_expires_at.isoformat()}


# ── Deployment package download ───────────────────────────────────────────────

_COLLECTOR_YAML_STATIC = """\
ca_cert: "/etc/anthrimon/ca.crt"
state_file: "/etc/anthrimon/collector-state.json"

snmp:
  polling_interval_s: 60
  max_concurrent: 20
  timeout_seconds: 10
  retries: 2

flow:
  netflow_addr: ":2055"
  sflow_addr: ":6343"
  buffer_size: 65535

syslog:
  udp_addr: ":514"
  tcp_addr: ":514"

forward:
  batch_size: 500
  flush_interval_s: 10

log:
  level: info
"""

def _build_collector_yaml(hub_url: str, token: str) -> str:
    """Build collector.yaml using yaml.dump for user-supplied fields to prevent injection."""
    dynamic = _yaml.dump(
        {"hub_url": hub_url, "token": token or "REPLACE_WITH_REGISTRATION_TOKEN"},
        default_flow_style=False,
        allow_unicode=True,
    )
    return "# Anthrimon remote collector configuration\n" + dynamic + _COLLECTOR_YAML_STATIC


_INSTALL_SH_TEMPLATE = """\
#!/usr/bin/env bash
# Anthrimon remote collector — one-shot installer
# Generated by hub at {hub_url}
set -euo pipefail

BINARY="anthrimon-collector"
BIN_DST="/usr/local/bin/anthrimon-collector"
CONF_DIR="/etc/anthrimon"
SERVICE_FILE="/etc/systemd/system/anthrimon-collector.service"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root (sudo bash install.sh)"
  exit 1
fi

echo "→ Installing dependencies..."
if command -v apt-get &>/dev/null; then
  apt-get install -y --no-install-recommends wireguard-tools snmp snmptrapd
elif command -v yum &>/dev/null; then
  yum install -y wireguard-tools net-snmp net-snmp-utils
elif command -v dnf &>/dev/null; then
  dnf install -y wireguard-tools net-snmp net-snmp-utils
else
  echo "WARNING: could not detect package manager — install wireguard-tools and snmptrapd manually"
fi

echo "→ Installing binary..."
install -m 755 "${{BINARY}}" "${{BIN_DST}}"

echo "→ Installing config and CA cert..."
mkdir -p "${{CONF_DIR}}"
# ca.crt must be world-readable so the snmptrapd exec handler (Debian-snmp user) can load it
install -m 644 ca.crt         "${{CONF_DIR}}/ca.crt"
install -m 640 collector.yaml "${{CONF_DIR}}/collector.yaml"

echo "→ Configuring snmptrapd capability override..."
mkdir -p /etc/systemd/system/snmptrapd.service.d
cat > /etc/systemd/system/snmptrapd.service.d/override.conf <<'SNMPEOF'
[Service]
AmbientCapabilities=CAP_NET_BIND_SERVICE
SNMPEOF
# On Ubuntu 24.04+, socket activation holds port 162; stop it so snmptrapd can bind directly
systemctl stop snmptrapd.socket snmptrapd 2>/dev/null || true
systemctl disable snmptrapd.socket 2>/dev/null || true
systemctl daemon-reload

echo "→ Writing systemd unit..."
cat > "${{SERVICE_FILE}}" <<'EOF'
[Unit]
Description=Anthrimon Remote Collector
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart={bin_dst} --config /etc/anthrimon/collector.yaml
Restart=on-failure
RestartSec=10
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE CAP_NET_RAW
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_BIND_SERVICE CAP_NET_RAW
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

echo "→ Enabling and starting service..."
systemctl daemon-reload
systemctl enable --now anthrimon-collector

echo ""
echo "✓ anthrimon-collector installed and running."
echo "  Check status: systemctl status anthrimon-collector"
echo "  Logs:         journalctl -u anthrimon-collector -f"
"""


@router.get("/{collector_id}/download",
            summary="Download a ready-to-run deployment package (binary + config + CA cert + installer)")
async def download_collector_package(
    collector_id: str,
    arch:         str = "amd64",
    token:        str = "",
    current_user: User = Depends(require_tenant_user("tenant_admin")),
    db:           AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """Return a zip containing the collector binary, pre-filled collector.yaml,
    the hub CA cert, and an install.sh — everything needed to deploy on a
    remote server in a single command::

        unzip anthrimon-remote-collector-linux-amd64.zip
        sudo bash install.sh
    """
    if arch not in _VALID_ARCHES:
        raise HTTPException(status_code=400,
                            detail=f"arch must be one of: {', '.join(sorted(_VALID_ARCHES))}")

    binary_path = _COLLECTOR_DIST / f"anthrimon-remote-collector-linux-{arch}"
    if not binary_path.exists():
        raise HTTPException(
            status_code=503,
            detail=f"Binary for linux/{arch} not found on this hub. "
                   "Run the installer to build cross-compiled binaries.",
        )

    c = (await db.execute(
        select(RemoteCollector).where(
            RemoteCollector.id == collector_id,
            RemoteCollector.tenant_id == current_user.tenant_id,
        )
    )).scalar_one_or_none()
    if c is None:
        raise HTTPException(status_code=404, detail="Collector not found")

    # Validate the caller-supplied token against this collector's pending token.
    if token and c.token_hash != _sha256(token):
        raise HTTPException(status_code=400, detail="Token does not match this collector's pending registration token")

    platform = await load_platform_defaults(db)
    hub_url   = (platform.get("base_url") or "").rstrip("/")
    ca_cert   = _ca_cert_pem() or ""

    yaml_content = _build_collector_yaml(hub_url, token)
    install_sh = _INSTALL_SH_TEMPLATE.format(
        hub_url=hub_url,
        bin_dst="/usr/local/bin/anthrimon-collector",
    )

    # Build zip in memory.
    # The binary is already a stripped Go executable — high entropy, barely
    # compressible.  Use ZIP_STORED for it to avoid burning several seconds on
    # DEFLATE for ~2% gain.  Text files (config, cert, script) are tiny so
    # DEFLATE them normally.
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        # Binary — store without compression
        binary_data = binary_path.read_bytes()
        info = zipfile.ZipInfo("anthrimon-collector")
        info.external_attr = 0o755 << 16   # rwxr-xr-x
        info.compress_type = zipfile.ZIP_STORED
        zf.writestr(info, binary_data)

        # Config
        zf.writestr("collector.yaml", yaml_content)

        # CA cert
        zf.writestr("ca.crt", ca_cert)

        # Installer script
        inst_info = zipfile.ZipInfo("install.sh")
        inst_info.external_attr = 0o755 << 16
        zf.writestr(inst_info, install_sh)

    buf.seek(0)
    zip_name = f"anthrimon-remote-collector-linux-{arch}.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{zip_name}"'},
    )


# ── Bootstrap (public, no auth) ───────────────────────────────────────────────

class BootstrapRequest(BaseModel):
    token:         str
    wg_public_key: str
    hostname:      Optional[str] = None
    version:       Optional[str] = None
    capabilities:  list = ["snmp", "flow", "syslog"]


@router.post("/bootstrap", summary="Bootstrap a new collector (one-time token)")
async def bootstrap(
    body:    BootstrapRequest,
    request: Request,
    db:      AsyncSession = Depends(get_db),
) -> dict:
    # Rate-limit before any DB work to prevent token enumeration.
    _check_bootstrap_rate_limit(_real_client_ip(request))

    token_hash = _sha256(body.token)
    now        = datetime.now(timezone.utc)

    c = (await db.execute(
        select(RemoteCollector).where(RemoteCollector.token_hash == token_hash)
    )).scalar_one_or_none()

    _invalid = HTTPException(status_code=401, detail="Invalid or expired registration token")
    if c is None:
        raise _invalid
    if c.status == "revoked":
        raise _invalid
    if c.token_expires_at and now > c.token_expires_at.replace(tzinfo=timezone.utc):
        raise _invalid

    # Check WireGuard is available on the hub
    hub_pubkey = _wg_hub_pubkey()
    if hub_pubkey is None:
        raise HTTPException(
            status_code=503,
            detail="WireGuard (wg0) is not configured on the hub. "
                   "Run: sudo bash scripts/setup-wireguard.sh",
        )

    # Capture old WireGuard state BEFORE touching anything — used for cleanup
    # after the DB commit so we never touch WireGuard before the DB is durable.
    old_wg_pubkey = c.wg_public_key
    old_wg_ip     = str(c.wg_ip) if c.wg_ip else None

    # ── Phase 1: all DB work (no WireGuard calls yet) ─────────────────────────

    # Free old WG IP in the pool and null out the ORM fields so the unique
    # partial index doesn't block the new allocation.
    if old_wg_ip:
        await _free_wg_ip(db, old_wg_ip)
        c.wg_ip = None
    if old_wg_pubkey:
        c.wg_public_key = None
    await db.flush()  # push NULLs before allocation to clear the unique index

    # Allocate WireGuard IP
    wg_ip = await _allocate_wg_ip(db)
    if wg_ip is None:
        raise HTTPException(status_code=503, detail="WireGuard IP pool exhausted")

    # Generate API key
    api_key, api_key_hash = _generate_token()

    if not re.fullmatch(r"[A-Za-z0-9+/]{43}=", body.wg_public_key):
        raise HTTPException(status_code=400, detail="Invalid WireGuard public key format")

    # Update collector record
    c.wg_public_key  = body.wg_public_key
    c.wg_ip          = wg_ip
    c.api_key_hash   = api_key_hash
    c.is_active      = True
    c.hostname       = body.hostname
    c.version        = body.version
    c.capabilities   = body.capabilities
    c.ip_address     = request.client.host
    c.status         = "offline"   # will flip to online on first heartbeat
    c.registered_at  = now
    c.token_hash     = _sha256(secrets.token_hex(32))  # invalidate token
    c.token_expires_at = None

    await db.execute(
        update(WgIpPool).where(WgIpPool.ip == cast(wg_ip, PG_INET)).values(assigned_to=c.id)
    )

    # ── Phase 2: commit DB first — if this fails nothing in WireGuard has changed
    await db.commit()

    # ── Phase 3: apply WireGuard changes after DB is durable ─────────────────

    # Remove the old peer (best-effort — it may already be absent).
    # _wg_remove_peer logs a warning on failure and never raises.
    if old_wg_pubkey:
        _wg_remove_peer(old_wg_pubkey)

    # Add the new peer.  If this fails after a successful DB commit we do a
    # compensating transaction to leave the DB consistent (no dangling wg_ip).
    try:
        _wg_add_peer(body.wg_public_key, wg_ip)
    except Exception as exc:
        logger.error("wg_add_peer_failed_after_commit",
                     collector=c.name, wg_ip=wg_ip, error=str(exc))
        async with AsyncSessionLocal() as comp_db:
            await comp_db.execute(
                update(RemoteCollector)
                .where(RemoteCollector.id == c.id)
                .values(wg_public_key=None, wg_ip=None,
                        is_active=False, status="pending")
            )
            await _free_wg_ip(comp_db, wg_ip)
            await comp_db.commit()
        raise HTTPException(status_code=502,
                            detail=f"Failed to add WireGuard peer: {exc}")

    logger.info("collector_bootstrapped", collector=c.name, wg_ip=wg_ip,
                hostname=body.hostname)

    platform = await load_platform_defaults(db)
    wg_endpoint = _wg_hub_endpoint(platform.get("wg_public_endpoint", ""))

    return {
        "collector_id":    str(c.id),
        "api_key":         api_key,          # shown once — collector must store this
        "wg_assigned_ip":  wg_ip,
        "wg_hub_pubkey":   hub_pubkey,
        "wg_hub_endpoint": wg_endpoint,
        "wg_subnet":       "10.100.0.0/24",
        "ca_cert":         _ca_cert_pem(),   # for verifying hub's TLS cert
    }


# ── Collector operational endpoints (API key + WireGuard IP required) ─────────

class HeartbeatRequest(BaseModel):
    version:     Optional[str] = None
    stats:       dict = {}     # arbitrary collector stats (devices polled, errors, etc.)


@router.post("/heartbeat", summary="Collector heartbeat")
async def heartbeat(
    body:    HeartbeatRequest,
    request: Request,
    db:      AsyncSession = Depends(get_db),
) -> dict:
    collector = await _require_collector(request, db)
    collector.last_seen  = datetime.now(timezone.utc)
    collector.status     = "online"
    if body.version:
        collector.version = body.version
    caps = body.stats.get("capabilities")
    if isinstance(caps, list) and caps:
        collector.capabilities = caps
    await db.commit()
    return {"status": "ok", "server_time": datetime.now(timezone.utc).isoformat()}


_DEVICE_ID_RE = re.compile(rb'device_id="([0-9a-f-]{36})"')

# ── Prometheus line parsers for health metrics ────────────────────────────────
# Match: metric_name{...device_id="UUID"...} value [timestamp_ms]
_CPU_RE  = re.compile(rb'anthrimon_device_cpu_util_pct\{[^}]*device_id="([0-9a-f-]{36})"[^}]*\}\s+([\d.]+)')
_MEM_USED_RE  = re.compile(rb'anthrimon_device_mem_used_bytes\{[^}]*device_id="([0-9a-f-]{36})"[^}]*mem_type="ram"[^}]*\}\s+([\d.]+)')
_MEM_TOTAL_RE = re.compile(rb'anthrimon_device_mem_total_bytes\{[^}]*device_id="([0-9a-f-]{36})"[^}]*mem_type="ram"[^}]*\}\s+([\d.]+)')
_UPTIME_RE = re.compile(rb'anthrimon_device_uptime_seconds\{[^}]*device_id="([0-9a-f-]{36})"[^}]*\}\s+([\d.]+)')

# Interface status metrics — emitted by remote collector only.
# Labels are fixed-order: device_id, if_index, if_name, vendor.
_IF_OPER_RE  = re.compile(rb'anthrimon_if_oper_status\{[^}]*device_id="([0-9a-f-]{36})"[^}]*if_index="(\d+)"[^}]*\}\s+([01])')
_IF_ADMIN_RE = re.compile(rb'anthrimon_if_admin_status\{[^}]*device_id="([0-9a-f-]{36})"[^}]*if_index="(\d+)"[^}]*\}\s+([01])')

# STP metrics — emitted by remote collector (BRIDGE-MIB).
# state: 1=disabled,2=blocking,3=listening,4=learning,5=forwarding
# role:  0=unknown,1=disabled,2=root,3=designated,4=alternate,5=backup  (RFC 4188)
_IF_STP_STATE_RE = re.compile(rb'anthrimon_if_stp_state\{[^}]*device_id="([0-9a-f-]{36})"[^}]*if_index="(\d+)"[^}]*\}\s+(\d+)')
_IF_STP_ROLE_RE  = re.compile(rb'anthrimon_if_stp_role\{[^}]*device_id="([0-9a-f-]{36})"[^}]*if_index="(\d+)"[^}]*\}\s+(\d+)')

# Device sysinfo line emitted once per poll cycle by the remote collector.
# Labels: device_id, sysname (hostname from SNMP sysName OID), sysdescr.
_DEVICE_INFO_RE = re.compile(
    rb'anthrimon_device_info\{'
    rb'device_id="([0-9a-f-]{36})",'
    rb'sysname="([^"]*)",'
    rb'sysdescr="((?:[^"\\]|\\.)*)"'
    rb'(?:,sysobjectid="([^"]*)")?'  # optional — absent in older collector builds
    rb'\}'
)

# Active failure report: emitted by remote collector when a device returns 0
# metrics (SNMP timed out / connect failed).  Hub sets status='unreachable'
# immediately, bypassing the passive stale-threshold detection.
_DEVICE_UNREACHABLE_RE = re.compile(
    rb'anthrimon_device_unreachable\{[^}]*device_id="([0-9a-f-]{36})"[^}]*\}'
)


def _parse_health_from_metrics(body: bytes) -> dict[str, dict]:
    """Extract per-device health snapshots from a Prometheus exposition body."""
    health: dict[str, dict] = {}

    def ensure(did: str) -> dict:
        if did not in health:
            health[did] = {"cpu_samples": [], "mem_used": None, "mem_total": None, "uptime": None}
        return health[did]

    for m in _CPU_RE.finditer(body):
        did, val = m.group(1).decode(), float(m.group(2))
        ensure(did)["cpu_samples"].append(val)

    for m in _MEM_USED_RE.finditer(body):
        did, val = m.group(1).decode(), int(m.group(2))
        ensure(did)["mem_used"] = val

    for m in _MEM_TOTAL_RE.finditer(body):
        did, val = m.group(1).decode(), int(m.group(2))
        ensure(did)["mem_total"] = val

    for m in _UPTIME_RE.finditer(body):
        did, val = m.group(1).decode(), int(m.group(2))
        ensure(did)["uptime"] = val

    return health


@router.post("/metrics", summary="Ingest Prometheus metrics from collector → VictoriaMetrics")
async def ingest_metrics(
    request: Request,
    db:      AsyncSession = Depends(get_db),
) -> dict:
    collector = await _require_collector(request, db)
    body = await request.body()
    if not body:
        return {"written": 0}

    # Forward to VictoriaMetrics
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            f"{vm_url()}/api/v1/import/prometheus",
            content=body,
            headers={"Content-Type": "text/plain"},
        )
    if resp.status_code not in (200, 204):
        logger.warning("collector_metrics_ingest_failed",
                       collector=collector.name, status=resp.status_code)

    # Load allowed device IDs for this collector to prevent cross-collector writes.
    allowed_device_ids: set[str] = {
        str(did) for (did,) in (await db.execute(
            select(Device.id).where(
                Device.collector_id == collector.id,
                Device.is_active == True,  # noqa: E712
            )
        )).all()
    }

    # Collect device IDs that the collector actively flagged as unreachable.
    # These must be excluded from the last_polled/status='up' batch and instead
    # have status set to 'unreachable' immediately — no waiting for stale threshold.
    unreachable_ids: set[str] = set()
    for m in _DEVICE_UNREACHABLE_RE.finditer(body):
        did = m.group(1).decode()
        if did in allowed_device_ids:
            unreachable_ids.add(did)

    # Stamp last_polled + status='up' for devices actually assigned to this collector.
    # Devices flagged unreachable are excluded here; they get their own update below.
    device_ids = {m.group(1).decode() for m in _DEVICE_ID_RE.finditer(body)}
    valid_ids: list[uuid.UUID] = []
    for did in device_ids:
        if did not in allowed_device_ids or did in unreachable_ids:
            continue
        try:
            valid_ids.append(uuid.UUID(did))
        except ValueError:
            pass

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    recovered_ids: list[uuid.UUID] = []
    if valid_ids:
        # Capture which devices are about to transition from non-up → up.
        # These get a fast engine pass so device_down doesn't sit around the
        # full poll-interval + engine-cycle waiting to auto-resolve.
        recovered_ids = [
            r[0] for r in (await db.execute(
                select(Device.id).where(
                    Device.id.in_(valid_ids),
                    Device.tenant_id == collector.tenant_id,
                    Device.status != "up",
                )
            )).all()
        ]
        await db.execute(
            update(Device)
            .where(
                Device.id.in_(valid_ids),
                Device.tenant_id == collector.tenant_id,
            )
            .values(status="up", last_polled=now, last_seen=now)
        )

    # Set status='unreachable' for actively-reported failures.
    # last_polled is intentionally NOT updated — keeps it stale as a secondary
    # indicator and avoids resetting the stale clock on a failed poll.
    if unreachable_ids:
        unreachable_uuids: list[uuid.UUID] = []
        for did in unreachable_ids:
            try:
                unreachable_uuids.append(uuid.UUID(did))
            except ValueError:
                pass
        if unreachable_uuids:
            await db.execute(
                update(Device)
                .where(
                    Device.id.in_(unreachable_uuids),
                    Device.tenant_id == collector.tenant_id,
                )
                .values(status="unreachable")
            )

    # Parse and upsert device_health_latest for remote-collector-managed devices.
    # The local SNMP collector writes this table directly; remote collectors must
    # go via this endpoint because they have no direct DB access.
    health_data = _parse_health_from_metrics(body)
    if health_data:
        now_health = datetime.now(timezone.utc).replace(tzinfo=None)
        for did_str, h in health_data.items():
            if did_str not in allowed_device_ids:
                continue
            samples = h["cpu_samples"]
            cpu_pct = round(sum(samples) / len(samples), 2) if samples else None
            mem_used  = h["mem_used"]
            mem_total = h["mem_total"]
            uptime    = h["uptime"]
            if cpu_pct is None and mem_used is None:
                continue
            await db.execute(
                text("""
                INSERT INTO device_health_latest
                    (device_id, collected_at, cpu_util_pct, mem_used_bytes, mem_total_bytes, uptime_seconds, updated_at)
                VALUES
                    (:did, :ts, :cpu, :mem_used, :mem_total, :uptime, :ts)
                ON CONFLICT (device_id) DO UPDATE SET
                    collected_at    = EXCLUDED.collected_at,
                    cpu_util_pct    = EXCLUDED.cpu_util_pct,
                    mem_used_bytes  = EXCLUDED.mem_used_bytes,
                    mem_total_bytes = EXCLUDED.mem_total_bytes,
                    uptime_seconds  = EXCLUDED.uptime_seconds,
                    updated_at      = EXCLUDED.updated_at
                """),
                {
                    "did":      did_str,
                    "ts":       now_health,
                    "cpu":      cpu_pct,
                    "mem_used": mem_used,
                    "mem_total": mem_total,
                    "uptime":   uptime,
                },
            )

    # Parse and batch-update interface oper/admin status in PostgreSQL.
    # The local SNMP collector writes these directly; remote collectors post them
    # as Prometheus metrics and we sync them here so alerting stays accurate.
    if_oper:  dict[tuple[str, int], int] = {}
    if_admin: dict[tuple[str, int], int] = {}

    for m in _IF_OPER_RE.finditer(body):
        did, idx, bit = m.group(1).decode(), int(m.group(2)), int(m.group(3))
        if did in allowed_device_ids:
            if_oper[(did, idx)] = bit

    for m in _IF_ADMIN_RE.finditer(body):
        did, idx, bit = m.group(1).decode(), int(m.group(2)), int(m.group(3))
        if did in allowed_device_ids:
            if_admin[(did, idx)] = bit

    all_iface_keys = set(if_oper.keys()) | set(if_admin.keys())
    if all_iface_keys:
        by_dev: dict[str, dict[int, tuple]] = {}
        for did_str, idx in all_iface_keys:
            oper_bit  = if_oper.get((did_str, idx))
            admin_bit = if_admin.get((did_str, idx))
            oper_val  = "up" if oper_bit  == 1 else ("down" if oper_bit  == 0 else None)
            admin_val = "up" if admin_bit == 1 else ("down" if admin_bit == 0 else None)
            by_dev.setdefault(did_str, {})[idx] = (oper_val, admin_val)

        for did_str, iface_map in by_dev.items():
            idxs   = list(iface_map.keys())
            opers  = [v[0] for v in iface_map.values()]
            admins = [v[1] for v in iface_map.values()]
            await db.execute(
                text("""
                    UPDATE interfaces
                    SET oper_status  = COALESCE(CAST(v.oper  AS if_status), oper_status),
                        admin_status = COALESCE(CAST(v.admin AS if_status), admin_status)
                    FROM (
                        SELECT unnest(CAST(:idxs AS integer[])) AS if_index,
                               unnest(CAST(:opers AS text[]))   AS oper,
                               unnest(CAST(:admins AS text[]))  AS admin
                    ) v
                    WHERE interfaces.device_id = CAST(:did AS uuid)
                      AND interfaces.if_index  = v.if_index
                """),
                {"did": did_str, "idxs": idxs, "opers": opers, "admins": admins},
            )

    # Parse STP state/role from remote-collector BRIDGE-MIB metrics and upsert
    # interface_stp.  Uses interface if_index to resolve interface_id in the DB.
    _STP_STATE = {1: "disabled", 2: "blocking", 3: "listening", 4: "learning", 5: "forwarding"}
    _STP_ROLE  = {0: "unknown", 1: "disabled", 2: "root", 3: "designated", 4: "alternate", 5: "backup"}

    stp_states: dict[tuple[str, int], str] = {}
    stp_roles:  dict[tuple[str, int], str] = {}

    for m in _IF_STP_STATE_RE.finditer(body):
        did, idx, val = m.group(1).decode(), int(m.group(2)), int(m.group(3))
        if did in allowed_device_ids:
            state_str = _STP_STATE.get(val)
            if state_str:
                stp_states[(did, idx)] = state_str

    for m in _IF_STP_ROLE_RE.finditer(body):
        did, idx, val = m.group(1).decode(), int(m.group(2)), int(m.group(3))
        if did in allowed_device_ids:
            stp_roles[(did, idx)] = _STP_ROLE.get(val, "unknown")

    all_stp_keys = set(stp_states.keys()) | set(stp_roles.keys())
    if all_stp_keys:
        stp_by_dev: dict[str, dict[int, tuple[str | None, str | None]]] = {}
        for did_str, idx in all_stp_keys:
            stp_by_dev.setdefault(did_str, {})[idx] = (
                stp_states.get((did_str, idx)),
                stp_roles.get((did_str, idx)),
            )

        for did_str, stp_map in stp_by_dev.items():
            idxs   = list(stp_map.keys())
            states = [v[0] for v in stp_map.values()]
            roles  = [v[1] for v in stp_map.values()]
            await db.execute(
                text("""
                    INSERT INTO interface_stp (interface_id, stp_state, stp_role, updated_at)
                    SELECT i.id,
                           v.state,
                           v.role,
                           NOW()
                    FROM (
                        SELECT unnest(CAST(:idxs AS integer[])) AS if_index,
                               unnest(CAST(:states AS text[]))  AS state,
                               unnest(CAST(:roles AS text[]))   AS role
                    ) v
                    JOIN interfaces i
                      ON i.device_id = CAST(:did AS uuid)
                     AND i.if_index  = v.if_index
                    WHERE v.state IS NOT NULL
                    ON CONFLICT (interface_id) DO UPDATE SET
                        stp_state  = EXCLUDED.stp_state,
                        stp_role   = EXCLUDED.stp_role,
                        updated_at = EXCLUDED.updated_at
                """),
                {"did": did_str, "idxs": idxs, "states": states, "roles": roles},
            )

    # Parse anthrimon_device_info lines and backfill device identity fields.
    # hostname / sys_description: only written when the DB value is blank.
    # vendor / device_type: only written when still 'unknown' (never overwrites user edits).
    for m in _DEVICE_INFO_RE.finditer(body):
        did      = m.group(1).decode()
        sysname  = m.group(2).decode()
        sysdescr = m.group(3).decode().encode('raw_unicode_escape').decode('unicode_escape')
        sysobj   = (m.group(4) or b'').decode()

        if did not in allowed_device_ids:
            continue

        vendor      = detect_vendor(sysobj, sysdescr)
        device_type = _VENDOR_DEVICE_TYPE.get(vendor, "unknown")

        await db.execute(
            text("""
                UPDATE devices
                SET hostname        = CASE WHEN hostname IS NULL OR hostname = ''
                                          THEN :sysname ELSE hostname END,
                    sys_description = :sysdescr,
                    vendor          = CASE WHEN vendor = 'unknown' AND :vendor != 'unknown'
                                          THEN CAST(:vendor AS vendor_type) ELSE vendor END,
                    device_type     = CASE WHEN vendor = 'unknown' AND :vendor != 'unknown'
                                          THEN CAST(:device_type AS device_type) ELSE device_type END
                WHERE id = CAST(:did AS uuid)
                  AND (
                      (hostname IS NULL OR hostname = '')
                      OR (vendor = 'unknown' AND :vendor != 'unknown')
                  )
            """),
            {"did": did, "sysname": sysname, "sysdescr": sysdescr,
             "vendor": vendor, "device_type": device_type},
        )

    await db.commit()

    # If any devices just transitioned non-up → up, kick the alert engine so
    # device_down resolves within one cycle instead of waiting up to the full
    # EVAL_INTERVAL on top of the SNMP poll interval.
    if recovered_ids:
        try:
            from ...alerting.engine import _engine
            _engine.request_immediate_pass(reason=f"device_recovered:{len(recovered_ids)}")
        except Exception as exc:
            logger.debug("alert_engine_wake_failed", error=str(exc))

    lines = body.count(b"\n")
    logger.debug("collector_metrics_ingested", collector=collector.name, lines=lines)
    return {"written": lines}


def _split_ip(addr: str) -> tuple[str, str]:
    """Return (ipv4, ipv6) pair for a ClickHouse TabSeparated row.

    IPv4 address  → ('x.x.x.x',  '::')
    IPv6 address  → ('0.0.0.0', 'x:x:…')
    Empty/invalid → ('0.0.0.0',  '::')
    """
    if not addr:
        return "0.0.0.0", "::"
    try:
        obj = ipaddress.ip_address(addr)
        if isinstance(obj, ipaddress.IPv4Address):
            return str(obj), "::"
        return "0.0.0.0", str(obj)
    except ValueError:
        return "0.0.0.0", "::"


def _tsv_escape(s: str) -> str:
    """Escape special characters for ClickHouse TabSeparated format.

    Backslash must be escaped first to avoid double-escaping.  Tab and
    newline characters in message bodies (common in ArubaOS-CX RFC 5424
    syslog) would otherwise break the column delimiter and row delimiter.
    """
    return (
        s
        .replace("\\", "\\\\")
        .replace("\t",  "\\t")
        .replace("\n",  "\\n")
        .replace("\r",  "\\r")
    )


def _fix_ts(ts: str) -> str:
    """Normalise an RFC3339/ISO8601 timestamp to ClickHouse DateTime64 format.

    ClickHouse TabSeparated DateTime64 expects 'YYYY-MM-DD HH:MM:SS[.mmm]'.
    Strips the 'T' separator, 'Z' suffix, and any '+HH:MM'/'-HH:MM' offset.
    Truncates fractional seconds to 3 digits (milliseconds).
    """
    ts = ts.replace("T", " ")
    # Strip timezone suffix: look past the date portion (10 chars)
    for sep in ("Z", "+", "-"):
        idx = ts.find(sep, 10)
        if idx >= 0:
            ts = ts[:idx]
    # Truncate fractional seconds to 3 digits for DateTime64(3,...)
    if "." in ts:
        dot = ts.index(".")
        ts = ts[: dot + 4]
    return ts.strip()


_FLOWS_INSERT = (
    "INSERT INTO flow_records "
    "(collector_device_id,exporter_ip,flow_type,flow_start,flow_end,"
    "src_ip,dst_ip,src_ip6,dst_ip6,next_hop,"
    "src_port,dst_port,ip_protocol,tcp_flags,"
    "bytes,packets,input_if_index,output_if_index,"
    "src_asn,dst_asn,src_prefix_len,dst_prefix_len,tos,dscp,sampling_rate) "
    "FORMAT TabSeparated"
)

@router.post("/flows", summary="Ingest flow records from collector → ClickHouse")
async def ingest_flows(
    request: Request,
    db:      AsyncSession = Depends(get_db),
) -> dict:
    collector = await _require_collector(request, db)
    records = await request.json()
    if not records:
        return {"written": 0}

    allowed_ids = {
        str(did) for (did,) in (await db.execute(
            select(Device.id).where(
                Device.collector_id == collector.id,
                Device.is_active == True,  # noqa: E712
            )
        )).all()
    }

    rows = []
    for r in records:
        did = r.get("collector_device_id") or ""
        if did and did not in allowed_ids:
            continue
        collector_device_id = did or "00000000-0000-0000-0000-000000000000"
        src4, src6 = _split_ip(r.get("src_ip", "") or "")
        dst4, dst6 = _split_ip(r.get("dst_ip", "") or "")
        exp4, _    = _split_ip(r.get("exporter_ip", "") or "")
        try:
            rows.append(
                f"{collector_device_id}\t"
                f"{exp4}\t"
                f"{_tsv_escape(str(r.get('flow_type', 'unknown') or 'unknown'))}\t"
                f"{_fix_ts(r.get('flow_start','1970-01-01 00:00:00'))}\t"
                f"{_fix_ts(r.get('flow_end','1970-01-01 00:00:00'))}\t"
                f"{src4}\t{dst4}\t"                                # src_ip, dst_ip  (IPv4 only)
                f"{src6}\t{dst6}\t"                                # src_ip6, dst_ip6 (IPv6 only)
                f"0.0.0.0\t"                                       # next_hop
                f"{int(r.get('src_port',0) or 0)}\t{int(r.get('dst_port',0) or 0)}\t"
                f"{int(r.get('ip_protocol',0) or 0)}\t{int(r.get('tcp_flags',0) or 0)}\t"
                f"{int(r.get('bytes',0) or 0)}\t{int(r.get('packets',0) or 0)}\t"
                f"{int(r.get('input_if_index',0) or 0)}\t{int(r.get('output_if_index',0) or 0)}\t"
                f"0\t0\t0\t0\t"                                    # src_asn, dst_asn, src_prefix_len, dst_prefix_len
                f"{int(r.get('tos',0) or 0)}\t{int(r.get('dscp',0) or 0)}\t"
                f"{int(r.get('sampling_rate',1) or 1)}"
            )
        except (ValueError, TypeError):
            continue

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            f"{ch_url()}/?query={_FLOWS_INSERT.replace(' ', '+')}",
            content="\n".join(rows),
            headers={"Content-Type": "text/plain"},
        )
    if resp.status_code not in (200, 204):
        logger.warning("flows_ingest_failed", collector=collector.name,
                       status=resp.status_code, detail=resp.text[:200])

    try:
        from ...alerting.engine import _engine
        _engine.request_immediate_pass(reason="flow_received")
    except Exception:
        pass

    return {"written": len(rows)}


@router.post("/syslog", summary="Ingest syslog records from collector → ClickHouse")
async def ingest_syslog(
    request: Request,
    db:      AsyncSession = Depends(get_db),
) -> dict:
    collector = await _require_collector(request, db)
    records = await request.json()
    if not records:
        return {"written": 0}

    allowed_ids = {
        str(did) for (did,) in (await db.execute(
            select(Device.id).where(
                Device.collector_id == collector.id,
                Device.is_active == True,  # noqa: E712
            )
        )).all()
    }

    rows = []
    for r in records:
        did = r.get('device_id') or ''
        if did and did not in allowed_ids:
            continue
        device_id = did or '00000000-0000-0000-0000-000000000000'
        device_ip4, _ = _split_ip(r.get('device_ip', '') or '')
        rows.append(
            f"{device_id}\t"
            f"{device_ip4}\t"
            f"{int(r.get('facility', 0) or 0)}\t{int(r.get('severity', 6) or 6)}\t"
            f"{_fix_ts(r.get('ts','1970-01-01 00:00:00'))}\t"
            f"{_tsv_escape(str(r.get('hostname','') or ''))}\t"
            f"{_tsv_escape(str(r.get('program','') or ''))}\t"
            f"{_tsv_escape(str(r.get('pid','') or ''))}\t"
            f"{_tsv_escape(str(r.get('message','') or ''))}\t"
            f"{_tsv_escape(str(r.get('raw','') or ''))}"
        )

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            f"{ch_url()}/?query=INSERT+INTO+syslog_messages+"
            "(device_id,device_ip,facility,severity,ts,hostname,program,pid,message,raw)"
            "+FORMAT+TabSeparated",
            content="\n".join(rows),
            headers={"Content-Type": "text/plain"},
        )
    if resp.status_code not in (200, 204):
        logger.warning("syslog_ingest_failed", collector=collector.name,
                       status=resp.status_code, detail=resp.text[:200])

    try:
        from ...alerting.engine import _engine
        _engine.request_immediate_pass(reason="syslog_received")
    except Exception:
        pass

    return {"written": len(rows)}


# ── Config backup ingest ──────────────────────────────────────────────────────

class ConfigBackupIngest(BaseModel):
    device_id:   str
    config_text: str
    method:      str = "ssh_show_run"


@router.post("/config-backup",
             summary="Ingest a config backup collected by the remote collector")
async def ingest_config_backup(
    body:    ConfigBackupIngest,
    request: Request,
    db:      AsyncSession = Depends(get_db),
) -> dict:
    """Accept a device running-config from a remote collector, store it, diff it,
    and fire config-change alerts if applicable.  Device must be assigned to the
    authenticated collector."""
    collector = await _require_collector(request, db)

    # Validate the device is assigned to this collector.
    dev = (await db.execute(
        select(Device).where(
            Device.id == body.device_id,
            Device.collector_id == collector.id,
            Device.is_active == True,  # noqa: E712
        )
    )).scalar_one_or_none()
    if dev is None:
        raise HTTPException(status_code=404,
                            detail="Device not found or not assigned to this collector")

    from ...configmgmt.collector import store_config_backup
    changed = await store_config_backup(body.device_id, body.config_text, body.method, db)

    logger.info("config_backup_ingested", collector=collector.name,
                device=dev.hostname, changed=changed)
    return {"stored": True, "changed": changed}


# ── BGP sessions ingest ───────────────────────────────────────────────────────

@router.post("/bgp-sessions",
             summary="Ingest BGP session state collected by the remote collector")
async def ingest_bgp_sessions(
    request: Request,
    db:      AsyncSession = Depends(get_db),
) -> dict:
    """Accept one device's current BGP session list (possibly empty) from a
    remote collector and write it into bgp_sessions.

    Body shape: {"device_id": "...", "sessions": [...]}. An empty "sessions"
    list means the device currently has zero BGP sessions, and any
    previously-reported sessions for it are marked stale (session_state='idle').

    Each session record must include at minimum: peer_ip, local_asn, state.
    """
    collector = await _require_collector(request, db)
    body = await request.json()
    did  = body.get("device_id")

    allowed = {
        str(did_) for (did_,) in (await db.execute(
            select(Device.id).where(
                Device.collector_id == collector.id,
                Device.is_active == True,  # noqa: E712
            )
        )).all()
    }
    if not did or did not in allowed:
        return {"written": 0}

    import uuid as _uuid
    from ...services.state_writer import write_bgp_sessions

    sessions = [
        {k: v for k, v in r.items() if k != "device_id"}
        for r in (body.get("sessions") or [])
    ]

    try:
        await write_bgp_sessions(_uuid.UUID(did), sessions)
    except Exception as exc:
        logger.warning("bgp_ingest_failed", collector=collector.name,
                       device_id=did, error=str(exc))
        return {"written": 0}

    try:
        from ...alerting.engine import _engine
        _engine.request_immediate_pass(reason="bgp_state_changed")
    except Exception:
        pass

    return {"written": len(sessions)}


# ── OSPF neighbors ingest ─────────────────────────────────────────────────────

@router.post("/collector-logs",
             summary="Ingest operational logs from the collector process → ClickHouse")
async def ingest_collector_logs(
    request: Request,
    db:      AsyncSession = Depends(get_db),
) -> dict:
    """Accept zerolog JSON entries from the remote collector itself and store them
    in ClickHouse collector_logs.  Authenticated by collector API key over WireGuard."""
    collector = await _require_collector(request, db)
    records   = await request.json()
    if not records:
        return {"written": 0}

    rows = []
    for r in records:
        fields = {k: v for k, v in r.items() if k not in ("ts", "level", "message")}
        rows.append(
            f"{str(collector.id)}\t"
            f"{_fix_ts(r.get('ts', '1970-01-01 00:00:00'))}\t"
            f"{_tsv_escape(str(r.get('level', 'info') or 'info'))}\t"
            f"{_tsv_escape(str(r.get('message', '') or ''))}\t"
            f"{_tsv_escape(json.dumps(fields) if fields else '{}')}"
        )

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            f"{ch_url()}/?query=INSERT+INTO+collector_logs+"
            "(collector_id,ts,level,message,fields)"
            "+FORMAT+TabSeparated",
            content="\n".join(rows),
            headers={"Content-Type": "text/plain"},
        )
    if resp.status_code not in (200, 204):
        logger.warning("collector_logs_ingest_failed", collector=collector.name,
                       status=resp.status_code, detail=resp.text[:200])
    return {"written": len(rows)}


@router.post("/ospf-neighbors",
             summary="Ingest OSPF neighbor state collected by the remote collector")
async def ingest_ospf_neighbors(
    request: Request,
    db:      AsyncSession = Depends(get_db),
) -> dict:
    """Accept one device's current OSPF neighbor list (possibly empty) from a
    remote collector and write it into ospf_neighbors.

    Body shape: {"device_id": "...", "neighbors": [...]}. An empty "neighbors"
    list means the device currently has zero OSPF neighbors, and any
    previously-reported neighbors for it are marked down.

    Each neighbor record must include at minimum: router_id, neighbor_ip,
    interface_name, area, state.
    """
    collector = await _require_collector(request, db)
    body = await request.json()
    did  = body.get("device_id")

    allowed = {
        str(did_) for (did_,) in (await db.execute(
            select(Device.id).where(
                Device.collector_id == collector.id,
                Device.is_active == True,  # noqa: E712
            )
        )).all()
    }
    if not did or did not in allowed:
        return {"written": 0}

    import uuid as _uuid
    from ...services.state_writer import write_ospf_neighbors

    neighbors = [
        {k: v for k, v in r.items() if k != "device_id"}
        for r in (body.get("neighbors") or [])
    ]

    try:
        await write_ospf_neighbors(_uuid.UUID(did), neighbors)
    except Exception as exc:
        logger.warning("ospf_ingest_failed", collector=collector.name,
                       device_id=did, error=str(exc))
        return {"written": 0}

    try:
        from ...alerting.engine import _engine
        _engine.request_immediate_pass(reason="ospf_state_changed")
    except Exception:
        pass

    return {"written": len(neighbors)}


# ── Route table ingest ────────────────────────────────────────────────────────

@router.post("/routes",
             summary="Ingest route table entries collected by the remote collector")
async def ingest_routes(
    request: Request,
    db:      AsyncSession = Depends(get_db),
) -> dict:
    """Accept one device's current route table (possibly empty) from a remote
    collector and upsert it into route_entries, removing any rows for that
    device not part of this batch (mark-and-sweep).

    Body shape: {"device_id": "...", "routes": [...]}. An empty "routes" list
    means the device's routing table is currently empty -- all previously
    reported routes for it are purged.

    Each route record must include at minimum: destination, protocol.
    Optional: next_hop, metric, interface_name.
    """
    collector = await _require_collector(request, db)
    body = await request.json()
    did  = body.get("device_id")

    allowed = {
        str(did_) for (did_,) in (await db.execute(
            select(Device.id).where(
                Device.collector_id == collector.id,
                Device.is_active == True,  # noqa: E712
            )
        )).all()
    }
    if not did or did not in allowed:
        return {"written": 0}

    import uuid as _uuid
    from ...services.state_writer import write_routes

    routes = [
        {k: v for k, v in r.items() if k != "device_id"}
        for r in (body.get("routes") or [])
    ]

    try:
        await write_routes(_uuid.UUID(did), routes)
    except Exception as exc:
        logger.warning("routes_ingest_failed", collector=collector.name,
                       device_id=did, error=str(exc))
        return {"written": 0}

    try:
        from ...alerting.engine import _engine
        _engine.request_immediate_pass(reason="routes_changed")
    except Exception:
        pass

    return {"written": len(routes)}


# ── IS-IS neighbors ingest ────────────────────────────────────────────────────

@router.post("/isis-neighbors",
             summary="Ingest IS-IS adjacency state collected by the remote collector")
async def ingest_isis_neighbors(
    request: Request,
    db:      AsyncSession = Depends(get_db),
) -> dict:
    """Accept one device's current IS-IS adjacency list (possibly empty) from a
    remote collector and write it into isis_neighbors.

    Body shape: {"device_id": "...", "neighbors": [...]}. An empty "neighbors"
    list means the device currently has zero adjacencies, and any
    previously-reported adjacencies for it are marked down.

    Each neighbor record must include at minimum: instance, sys_id,
    interface_name, circuit_type, adj_state. Optional: hostname, ipv4_address,
    ipv6_address, uptime_seconds, last_state_change (ISO-8601 string).
    """
    collector = await _require_collector(request, db)
    body = await request.json()
    did  = body.get("device_id")

    allowed = {
        str(did_) for (did_,) in (await db.execute(
            select(Device.id).where(
                Device.collector_id == collector.id,
                Device.is_active == True,  # noqa: E712
            )
        )).all()
    }
    if not did or did not in allowed:
        return {"written": 0}

    import uuid as _uuid
    from datetime import datetime as _dt
    from ...services.state_writer import write_isis_neighbors

    rows = []
    for r in (body.get("neighbors") or []):
        # Coerce last_state_change string → datetime if present
        row = {k: v for k, v in r.items() if k != "device_id"}
        lsc = row.get("last_state_change")
        if isinstance(lsc, str) and lsc:
            try:
                row["last_state_change"] = _dt.fromisoformat(lsc.replace("Z", "+00:00"))
            except ValueError:
                row["last_state_change"] = None
        rows.append(row)

    try:
        await write_isis_neighbors(_uuid.UUID(did), rows)
    except Exception as exc:
        logger.warning("isis_ingest_failed", collector=collector.name,
                       device_id=did, error=str(exc))
        return {"written": 0}

    try:
        from ...alerting.engine import _engine
        _engine.request_immediate_pass(reason="isis_state_changed")
    except Exception:
        pass

    return {"written": len(rows)}


@router.post("/stp-ports",
             summary="Ingest per-interface STP state collected by the remote collector")
async def ingest_stp_ports(
    request: Request,
    db:      AsyncSession = Depends(get_db),
) -> dict:
    """Accept a list of STP port records from a remote collector and upsert them
    into interface_stp.  Each record: device_id, if_index (int), stp_state (str),
    stp_role (str).
    """
    collector = await _require_collector(request, db)
    records   = await request.json()
    if not records:
        return {"written": 0}

    allowed = {
        str(did) for (did,) in (await db.execute(
            select(Device.id).where(
                Device.collector_id == collector.id,
                Device.is_active == True,  # noqa: E712
            )
        )).all()
    }

    by_device: dict[str, list[dict]] = {}
    for r in records:
        did = r.get("device_id")
        if did and did in allowed:
            by_device.setdefault(did, []).append(r)

    written = 0
    for did_str, ports in by_device.items():
        # eAPI records use if_name; SNMP records use if_index.  Handle both.
        by_name  = [p for p in ports if p.get("if_name") and not p.get("if_index")]
        by_index = [p for p in ports if p.get("if_index")]

        if by_name:
            names  = [p["if_name"]      for p in by_name]
            states = [p.get("stp_state") for p in by_name]
            roles  = [p.get("stp_role")  for p in by_name]
            await db.execute(
                text("""
                    INSERT INTO interface_stp (interface_id, stp_state, stp_role, updated_at)
                    SELECT i.id, v.state, v.role, NOW()
                    FROM (
                        SELECT unnest(CAST(:names AS text[])) AS if_name,
                               unnest(CAST(:states AS text[])) AS state,
                               unnest(CAST(:roles AS text[]))  AS role
                    ) v
                    JOIN interfaces i
                      ON i.device_id = CAST(:did AS uuid)
                     AND i.name      = v.if_name
                    WHERE v.state IS NOT NULL
                    ON CONFLICT (interface_id) DO UPDATE SET
                        stp_state  = EXCLUDED.stp_state,
                        stp_role   = EXCLUDED.stp_role,
                        updated_at = EXCLUDED.updated_at
                """),
                {"did": did_str, "names": names, "states": states, "roles": roles},
            )
            written += len(by_name)

        if by_index:
            idxs   = [p["if_index"]      for p in by_index]
            states = [p.get("stp_state") for p in by_index]
            roles  = [p.get("stp_role")  for p in by_index]
            await db.execute(
                text("""
                    INSERT INTO interface_stp (interface_id, stp_state, stp_role, updated_at)
                    SELECT i.id, v.state, v.role, NOW()
                    FROM (
                        SELECT unnest(CAST(:idxs AS integer[])) AS if_index,
                               unnest(CAST(:states AS text[]))  AS state,
                               unnest(CAST(:roles AS text[]))   AS role
                    ) v
                    JOIN interfaces i
                      ON i.device_id = CAST(:did AS uuid)
                     AND i.if_index  = v.if_index
                    WHERE v.state IS NOT NULL
                    ON CONFLICT (interface_id) DO UPDATE SET
                        stp_state  = EXCLUDED.stp_state,
                        stp_role   = EXCLUDED.stp_role,
                        updated_at = EXCLUDED.updated_at
                """),
                {"did": did_str, "idxs": idxs, "states": states, "roles": roles},
            )
            written += len(by_index)

    await db.commit()
    return {"written": written}


@router.post("/vlans",
             summary="Ingest VLANs + interface membership collected by the remote collector")
async def ingest_vlans(
    request: Request,
    db:      AsyncSession = Depends(get_db),
) -> dict:
    """Accept a flat list of VLAN records from a remote collector. Each record is
    either a VLAN definition ({device_id, vlan_id, name}) or a per-interface
    membership ({device_id, vlan_id, if_name, tagged}). VLAN defs are upserted
    into `vlans`; memberships replace the device's `interface_vlans`.
    """
    collector = await _require_collector(request, db)
    records   = await request.json()
    if not records:
        return {"written": 0}

    allowed = {
        str(did) for (did,) in (await db.execute(
            select(Device.id).where(
                Device.collector_id == collector.id,
                Device.is_active == True,  # noqa: E712
            )
        )).all()
    }

    defs_by_device: dict[str, list[dict]] = {}
    mem_by_device:  dict[str, list[dict]] = {}
    for r in records:
        did = r.get("device_id")
        if not did or did not in allowed:
            continue
        if r.get("if_name"):
            mem_by_device.setdefault(did, []).append(r)
        else:
            defs_by_device.setdefault(did, []).append(r)

    written = 0
    # VLAN definitions
    for did_str, defs in defs_by_device.items():
        vids  = [d["vlan_id"] for d in defs]
        names = [d.get("name") for d in defs]
        await db.execute(
            text("""
                INSERT INTO vlans (device_id, vlan_id, name, updated_at)
                SELECT CAST(:did AS uuid), v.vid, v.name, NOW()
                FROM (
                    SELECT unnest(CAST(:vids AS integer[])) AS vid,
                           unnest(CAST(:names AS text[]))   AS name
                ) v
                ON CONFLICT (device_id, vlan_id) DO UPDATE SET
                    name = EXCLUDED.name, updated_at = EXCLUDED.updated_at
            """),
            {"did": did_str, "vids": vids, "names": names},
        )
        written += len(defs)

    # Interface memberships — replace per device (mark-and-sweep).
    for did_str in mem_by_device:
        await db.execute(
            text("""
                DELETE FROM interface_vlans WHERE interface_id IN (
                    SELECT id FROM interfaces WHERE device_id = CAST(:did AS uuid))
            """),
            {"did": did_str},
        )
    for did_str, mems in mem_by_device.items():
        names  = [m["if_name"] for m in mems]
        vids   = [m["vlan_id"] for m in mems]
        tagged = [bool(m.get("tagged")) for m in mems]
        await db.execute(
            text("""
                INSERT INTO interface_vlans (interface_id, vlan_id, tagged)
                SELECT i.id, v.vid, v.tagged
                FROM (
                    SELECT unnest(CAST(:names AS text[]))    AS if_name,
                           unnest(CAST(:vids AS integer[]))  AS vid,
                           unnest(CAST(:tagged AS boolean[])) AS tagged
                ) v
                JOIN interfaces i
                  ON i.device_id = CAST(:did AS uuid) AND i.name = v.if_name
                ON CONFLICT (interface_id, vlan_id) DO UPDATE SET tagged = EXCLUDED.tagged
            """),
            {"did": did_str, "names": names, "vids": vids, "tagged": tagged},
        )
        written += len(mems)

    await db.commit()
    return {"written": written}


@router.post("/addresses",
             summary="Ingest ARP + MAC tables collected by the remote collector")
async def ingest_addresses(
    request: Request,
    db:      AsyncSession = Depends(get_db),
) -> dict:
    """Accept a flat list of address records from a remote collector. Records with
    an `ip_address` are ARP/ND entries → arp_entries; records with only a
    `mac_address` are FDB entries → mac_entries. Both are upserted and stale rows
    (not refreshed this batch) are swept per device.
    """
    collector = await _require_collector(request, db)
    records   = await request.json()
    if not records:
        return {"written": 0}

    allowed = {
        str(did) for (did,) in (await db.execute(
            select(Device.id).where(
                Device.collector_id == collector.id,
                Device.is_active == True,  # noqa: E712
            )
        )).all()
    }

    arp_by_device: dict[str, list[dict]] = {}
    mac_by_device: dict[str, list[dict]] = {}
    for r in records:
        did = r.get("device_id")
        if not did or did not in allowed:
            continue
        if r.get("ip_address"):
            arp_by_device.setdefault(did, []).append(r)
        elif r.get("mac_address"):
            mac_by_device.setdefault(did, []).append(r)

    written = 0
    for did_str, arps in arp_by_device.items():
        ips   = [a["ip_address"] for a in arps]
        macs  = [a["mac_address"] for a in arps]
        ifns  = [a.get("interface_name") for a in arps]
        await db.execute(
            text("""
                INSERT INTO arp_entries (device_id, ip_address, mac_address, interface_name, entry_type, updated_at)
                SELECT CAST(:did AS uuid), v.ip::inet, v.mac::macaddr, v.ifn, 'dynamic', NOW()
                FROM (
                    SELECT unnest(CAST(:ips AS text[]))  AS ip,
                           unnest(CAST(:macs AS text[])) AS mac,
                           unnest(CAST(:ifns AS text[])) AS ifn
                ) v
                ON CONFLICT (device_id, ip_address) DO UPDATE SET
                    mac_address = EXCLUDED.mac_address, interface_name = EXCLUDED.interface_name,
                    entry_type = EXCLUDED.entry_type, updated_at = NOW()
            """),
            {"did": did_str, "ips": ips, "macs": macs, "ifns": ifns},
        )
        await db.execute(
            text("DELETE FROM arp_entries WHERE device_id = CAST(:did AS uuid) AND updated_at < NOW() - INTERVAL '1 minute'"),
            {"did": did_str},
        )
        written += len(arps)

    for did_str, macs in mac_by_device.items():
        addrs = [m["mac_address"] for m in macs]
        ports = [m.get("port_name") or m.get("interface_name") for m in macs]
        vids  = [m.get("vlan_id") for m in macs]
        await db.execute(
            text("""
                INSERT INTO mac_entries (device_id, mac_address, port_name, vlan_id, entry_type, updated_at)
                SELECT CAST(:did AS uuid), v.mac::macaddr, v.port, v.vid, 'dynamic', NOW()
                FROM (
                    SELECT unnest(CAST(:macs AS text[]))    AS mac,
                           unnest(CAST(:ports AS text[]))   AS port,
                           unnest(CAST(:vids AS integer[])) AS vid
                ) v
                ON CONFLICT (device_id, mac_address) DO UPDATE SET
                    port_name = EXCLUDED.port_name, vlan_id = EXCLUDED.vlan_id,
                    entry_type = EXCLUDED.entry_type, updated_at = NOW()
            """),
            {"did": did_str, "macs": addrs, "ports": ports, "vids": vids},
        )
        await db.execute(
            text("DELETE FROM mac_entries WHERE device_id = CAST(:did AS uuid) AND updated_at < NOW() - INTERVAL '1 minute'"),
            {"did": did_str},
        )
        written += len(macs)

    await db.commit()
    return {"written": written}


@router.post("/device-inventory",
             summary="Ingest device inventory (serial number) collected by the remote collector")
async def ingest_device_inventory(
    request: Request,
    db:      AsyncSession = Depends(get_db),
) -> dict:
    """Accept a list of {device_id, serial_number} records and update devices."""
    collector = await _require_collector(request, db)
    records   = await request.json()
    if not records:
        return {"updated": 0}

    updated = 0
    for r in records:
        did    = r.get("device_id")
        serial = r.get("serial_number")
        if not did or not serial:
            continue
        res = await db.execute(
            text("""
                UPDATE devices SET serial_number = :sn
                WHERE id = CAST(:did AS uuid)
                  AND collector_id = :cid
                  AND (serial_number IS DISTINCT FROM :sn)
            """),
            {"did": did, "sn": str(serial), "cid": collector.id},
        )
        updated += res.rowcount or 0

    await db.commit()
    return {"updated": updated}


@router.post("/engine-ids",
             summary="Store SNMP engine IDs discovered by a remote collector")
async def ingest_engine_ids(
    request: Request,
    db:      AsyncSession = Depends(get_db),
) -> dict:
    """Accept a list of {device_id, engine_id} records from a remote collector.
    Updates devices.snmp_engine_id and regenerates snmptrapd.conf for the
    collector if any v3 credentials are affected.
    """
    collector = await _require_collector(request, db)
    records   = await request.json()
    if not records:
        return {"updated": 0}

    allowed = {
        str(did) for (did,) in (await db.execute(
            select(Device.id).where(
                Device.collector_id == collector.id,
                Device.is_active == True,  # noqa: E712
            )
        )).all()
    }

    updated = 0
    for r in records:
        did       = str(r.get("device_id", ""))
        engine_id = str(r.get("engine_id", "")).strip().lower()
        if not did or not engine_id or did not in allowed:
            continue
        device = (await db.execute(
            select(Device).where(Device.id == did)
        )).scalar_one_or_none()
        if device and device.snmp_engine_id != engine_id:
            device.snmp_engine_id = engine_id
            updated += 1

    if updated:
        await db.commit()
        asyncio.create_task(
            _push_trap_config(str(collector.id), str(collector.tenant_id))
        )
        logger.info("engine_ids_updated", collector_id=str(collector.id), count=updated)

    return {"updated": updated}


# ── SNMP trap ingest ──────────────────────────────────────────────────────────

@router.post("/traps", status_code=204, response_model=None,
             summary="Ingest decoded SNMP trap events from a collector")
async def ingest_traps(
    request: Request,
    db:      AsyncSession = Depends(get_db),
) -> None:
    """Accept a batch of decoded SNMP trap events from a remote collector or
    the hub-local trap receiver and write them to trap_events.

    Payload: {"events": [...], "collector_id": "<uuid-optional>"}
    Each event: source_ip, device_id (optional), trap_type, oid, severity,
                varbinds (list of {oid, type, value}), snmp_version, received_at.
    """
    collector = await _require_collector(request, db)
    body      = await request.json()
    events    = body.get("events") or []
    if not events:
        return

    now = datetime.now(timezone.utc)
    rows: list[dict] = []
    for ev in events:
        source_ip = ev.get("source_ip", "")
        if not source_ip:
            continue

        # Resolve device_id: prefer what the collector sent, fall back to IP lookup.
        device_id_str = ev.get("device_id")
        if not device_id_str:
            row = (await db.execute(
                text("SELECT id::text FROM devices WHERE host(mgmt_ip) = :ip LIMIT 1"),
                {"ip": source_ip},
            )).one_or_none()
            if row:
                device_id_str = row[0]

        received_at = now
        if ev.get("received_at"):
            try:
                received_at = datetime.fromisoformat(ev["received_at"].replace("Z", "+00:00"))
            except ValueError:
                pass

        rows.append({
            "id":           str(uuid.uuid4()),
            "device_id":    device_id_str or None,
            "source_ip":    source_ip,
            "trap_type":    str(ev.get("trap_type", "unknown"))[:100],
            "oid":          str(ev.get("oid", ""))[:255],
            "severity":     ev.get("severity", "info") if ev.get("severity") in ("critical", "warning", "info") else "info",
            "varbinds":     json.dumps(ev.get("varbinds") or []).replace('\\u0000', ''),
            "snmp_version": str(ev.get("snmp_version", "v2c"))[:10],
            "collector_id": str(collector.id),
            "received_at":  received_at,
        })

    if not rows:
        return

    await db.execute(text("""
        INSERT INTO trap_events
            (id, device_id, source_ip, trap_type, oid, severity,
             varbinds, snmp_version, collector_id, received_at)
        VALUES
            (:id, CAST(:device_id AS uuid), CAST(:source_ip AS inet), :trap_type, :oid, :severity,
             CAST(:varbinds AS jsonb), :snmp_version, CAST(:collector_id AS uuid), CAST(:received_at AS timestamptz))
    """), rows)
    await db.commit()
    logger.info("traps_ingested", count=len(rows), collector_id=str(collector.id))

    # Fire-and-forget re-poll for qualifying traps (linkDown, coldStart, etc.)
    # so the hub receives fresh metrics immediately after a state change.
    _REPOLL_TRAP_TYPES = frozenset({
        "linkDown", "linkUp", "coldStart", "warmStart",
        "cisco.bgpBackwardTransition", "arista.bgpPeerStateChange",
    })
    repoll_ids = {
        row["device_id"] for row in rows
        if row["device_id"] and row["trap_type"] in _REPOLL_TRAP_TYPES
    }
    if repoll_ids and collector.wg_ip:
        wg_ip = str(collector.wg_ip).split("/")[0]
        if ipaddress.ip_address(wg_ip) in ipaddress.ip_network("10.100.0.0/24"):
            token = _control_token(collector.api_key_hash)
            asyncio.create_task(_trigger_repolls(wg_ip, token, repoll_ids))

    try:
        from ...alerting.engine import _engine
        _engine.request_immediate_pass(reason="trap_received")
    except Exception:
        pass


async def _trigger_repolls(wg_ip: str, token: str, device_ids: set[str]) -> None:
    """POST /poll to the collector for each device that sent a qualifying trap."""
    headers = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient(timeout=5.0) as hc:
        for device_id in device_ids:
            try:
                await hc.post(
                    f"http://{wg_ip}:9090/poll",
                    json={"device_id": device_id},
                    headers=headers,
                )
            except Exception as exc:
                logger.warning("trap_repoll_failed", device_id=device_id, error=str(exc))


# ── snmptrapd v3 credential sync ──────────────────────────────────────────────

_AUTH_PROTO_MAP = {
    "md5": "MD5", "sha": "SHA", "sha128": "SHA",
    "sha224": "SHA-224", "sha256": "SHA-256",
    "sha384": "SHA-384", "sha512": "SHA-512",
}
_PRIV_PROTO_MAP = {
    "des": "DES", "3des": "3DES",
    "aes": "AES", "aes128": "AES",
    "aes192": "AES-192", "aes256": "AES-256",
}
_SNMPTRAPD_CONF_PATH    = os.environ.get("ANTHRIMON_SNMPTRAPD_CONF",    "/etc/snmp/snmptrapd.conf")
_SNMPTRAPD_PERSIST_PATH = os.environ.get("ANTHRIMON_SNMPTRAPD_PERSIST", "/var/lib/snmp/snmptrapd.conf")

# ── SNMP engine ID discovery ──────────────────────────────────────────────────

_ENGINE_ID_CMDS: dict[str, str | None] = {
    "cisco_ios":   "show snmp engineID",
    "cisco_iosxe": "show snmp engineID",
    "cisco_iosxr": "show snmp engineID",
    "cisco_nxos":  "show snmp engineID",
    "arista":      "show snmp engineid",
    "aruba_cx":    "show snmp engine-id",
    "juniper":     "show snmp information",
    "hp_procurve": "show management",
    "procurve":    "show management",
    "fortios":     None,
    "ubiquiti":    None,
}

_ENGINE_ID_RE = re.compile(
    r"engine.?id\s*[:\s=is]+\s*((?:0x)?[0-9a-f][0-9a-f:]{6,})",
    re.IGNORECASE,
)


def _parse_engine_id(output: str) -> str | None:
    m = _ENGINE_ID_RE.search(output)
    if not m:
        return None
    raw = m.group(1)
    if raw.lower().startswith("0x"):
        raw = raw[2:]
    cleaned = raw.lower().replace(":", "").replace(" ", "")
    if len(cleaned) >= 8 and all(c in "0123456789abcdef" for c in cleaned):
        return cleaned
    return None


async def _discover_engine_id(host: str, vendor_key: str, cred_data: dict) -> str | None:
    """SSH to a device and extract its SNMP engine ID. Returns hex string without 0x prefix."""
    from ...configmgmt.collector import _ssh_exec, _vendor_key as _vk  # noqa: F401

    command = _ENGINE_ID_CMDS.get(vendor_key, "show snmp engineID")
    if not command:
        return None
    try:
        output = await asyncio.get_event_loop().run_in_executor(
            None, _ssh_exec, host, 22, vendor_key, cred_data, command
        )
        return _parse_engine_id(output)
    except Exception as exc:
        logger.warning("engine_id_discovery_failed", host=host, vendor=vendor_key, error=str(exc))
        return None


def _build_snmptrapd_conf(users: list[dict]) -> str:
    lines = [
        "# Generated by Anthrimon — do not edit manually",
        "# Regenerate via POST /api/v1/collectors/{id}/trap-config",
        "",
        "disableAuthorization yes",
        "",
        "# Output numeric OIDs so the handler needs no MIB files",
        "outputOption n",
        "",
        "# Route all traps to the Anthrimon handler",
        "traphandle default /usr/local/bin/anthrimon-traphandler",
    ]
    if users:
        lines.append("")
        lines.append("# Authorize v3 users to trigger handlers")
        for u in users:
            lines.append(f"authUser execute,log,net {u['username']}")
        lines.append("")
        lines.append("# SNMPv3 users (plaintext; snmptrapd localizes keys on restart)")
        for u in users:
            username  = u["username"]
            auth_p    = u.get("auth_proto", "")
            auth_k    = u.get("auth_key", "")
            priv_p    = u.get("priv_proto", "")
            priv_k    = u.get("priv_key", "")
            engine_id = u.get("engine_id", "")
            e_flag    = f"-e 0x{engine_id} " if engine_id else ""
            if auth_p and auth_k and priv_p and priv_k:
                lines.append(f'createUser {e_flag}{username} {auth_p} "{auth_k}" {priv_p} "{priv_k}"')
            elif auth_p and auth_k:
                lines.append(f'createUser {e_flag}{username} {auth_p} "{auth_k}"')
            else:
                lines.append(f"createUser {e_flag}{username}")
    lines.append("")
    return "\n".join(lines)


async def _collect_v3_users_for_collector(collector_id: str | None, tenant_id: str, db) -> list[dict]:
    """Return a deduplicated list of SNMPv3 user dicts.

    For the hub (collector_id=None): return ALL v3 credentials in the tenant,
    regardless of device linkage.  Traps arrive at the hub from any device and
    the credential only needs to exist somewhere in the tenant — it does not
    have to be the polling credential for that device.

    For remote collectors: restrict to credentials linked to devices assigned
    to that specific collector.
    """
    from ...models.credential import Credential, DeviceCredential
    from ...models.device import Device
    from sqlalchemy.orm import outerjoin

    if collector_id is None:
        # Hub: all tenant v3 credentials. Left-join to devices via device_credentials
        # to pick up device.snmp_engine_id where the credential is device-linked.
        q = (
            select(Credential, Device.snmp_engine_id)
            .outerjoin(DeviceCredential, DeviceCredential.credential_id == Credential.id)
            .outerjoin(Device, Device.id == DeviceCredential.device_id)
            .where(
                Credential.tenant_id == tenant_id,
                Credential.type == "snmp_v3",
            )
        )
    else:
        q = (
            select(Credential, Device.snmp_engine_id)
            .join(DeviceCredential, DeviceCredential.credential_id == Credential.id)
            .join(Device, Device.id == DeviceCredential.device_id)
            .where(
                Device.tenant_id == tenant_id,
                Device.is_active == True,  # noqa: E712
                Device.collector_id == collector_id,
                Credential.type == "snmp_v3",
            )
        )

    rows = (await db.execute(q)).all()

    seen: set[str] = set()
    users: list[dict] = []
    for cred, device_engine_id in rows:
        cd = cred.data if isinstance(cred.data, dict) else {}
        username = cd.get("username", "")
        if not username or username in seen:
            continue
        seen.add(username)
        # Device record takes precedence; fall back to credential JSON for
        # trap-only credentials that have no device link.
        engine_id = device_engine_id or cd.get("engine_id", "")
        users.append({
            "username":   username,
            "auth_proto": _AUTH_PROTO_MAP.get(cd.get("auth_protocol", "sha256").lower(), "SHA-256"),
            "auth_key":   cd.get("auth_key", ""),
            "priv_proto": _PRIV_PROTO_MAP.get(cd.get("priv_protocol", "aes").lower(), "AES"),
            "priv_key":   cd.get("priv_key", ""),
            "engine_id":  engine_id,
        })
    return users


async def _push_trap_config(collector_id: str | None, tenant_id: str) -> None:
    """Regenerate snmptrapd config for one collector.

    collector_id=None means the hub — write the config directly and restart
    snmptrapd.  For remote collectors, POST to /trap-config on the collector's
    WireGuard control server.
    Errors are logged and swallowed so a credential save is never blocked.
    """
    import subprocess as _sp
    from ...database import AsyncSessionLocal

    async with AsyncSessionLocal() as db:
        users = await _collect_v3_users_for_collector(collector_id, tenant_id, db)

        if collector_id is None:
            conf = _build_snmptrapd_conf(users)
            try:
                with open(_SNMPTRAPD_CONF_PATH, "w") as fh:
                    fh.write(conf)
                try:
                    os.remove(_SNMPTRAPD_PERSIST_PATH)
                except FileNotFoundError:
                    pass
                _sp.run(["systemctl", "restart", "snmptrapd"], check=True, timeout=15)
                logger.info("trap_config_hub_updated", v3_users=len(users))
            except Exception as exc:
                logger.error("trap_config_hub_failed", error=str(exc))
            return

        # Remote collector: look up WG IP and push over WireGuard.
        col = (await db.execute(
            select(RemoteCollector).where(
                RemoteCollector.id == collector_id,
                RemoteCollector.tenant_id == tenant_id,
                RemoteCollector.is_active == True,  # noqa: E712
            )
        )).scalar_one_or_none()

        if col is None or not col.wg_ip:
            return
        wg_ip = str(col.wg_ip).split("/")[0]
        if ipaddress.ip_address(wg_ip) not in ipaddress.ip_network("10.100.0.0/24"):
            return

        token = _control_token(col.api_key_hash)
        try:
            async with httpx.AsyncClient(timeout=15.0) as hc:
                resp = await hc.post(
                    f"http://{wg_ip}:9090/trap-config",
                    json={"users": users},
                    headers={"Authorization": f"Bearer {token}"},
                )
            if resp.status_code >= 400:
                logger.error("trap_config_push_failed",
                             collector_id=collector_id, status=resp.status_code)
            else:
                logger.info("trap_config_pushed",
                            collector_id=collector_id, v3_users=len(users))
        except Exception as exc:
            logger.error("trap_config_push_failed", collector_id=collector_id, error=str(exc))


@router.post("/{collector_id}/trap-config", status_code=204, response_model=None,
             summary="Push updated snmptrapd v3 user config to a remote collector")
async def push_trap_config(
    collector_id: uuid.UUID,
    current_user: User       = Depends(require_tenant_user("tenant_admin")),
    db:           AsyncSession = Depends(get_db),
) -> None:
    col = (await db.execute(
        select(RemoteCollector).where(
            RemoteCollector.id == str(collector_id),
            RemoteCollector.tenant_id == current_user.tenant_id,
        )
    )).scalar_one_or_none()
    if col is None:
        raise HTTPException(status_code=404, detail="Collector not found")
    asyncio.create_task(
        _push_trap_config(str(collector_id), str(current_user.tenant_id))
    )


@router.post("/trap-config/hub", status_code=204, response_model=None,
             summary="Regenerate hub-local snmptrapd config from all tenant credentials")
async def push_trap_config_hub(
    current_user: User       = Depends(require_tenant_user("tenant_admin")),
) -> None:
    asyncio.create_task(
        _push_trap_config(None, str(current_user.tenant_id))
    )
