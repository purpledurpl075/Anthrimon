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
from pydantic import BaseModel
from sqlalchemy import cast, select, text, update
from sqlalchemy.dialects.postgresql import INET as PG_INET
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import AsyncSessionLocal

from ..dependencies import get_current_user, get_db, require_tenant_user
from ..models.api_method import DeviceApiMethod
from ..models.credential import Credential, DeviceCredential
from ..models.device import Device
from ..models.health import DeviceHealthLatest
from ..models.site import RemoteCollector, WgIpPool
from ..models.tenant import User
from .admin import load_platform_settings

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/collectors", tags=["collectors"])

_CH_URL          = "http://localhost:8123"
_VM_URL          = "http://localhost:8428"
_WG_IF           = "wg0"
_WG_SUBNET       = ipaddress.ip_network("10.100.0.0/24")
_COLLECTOR_DIST  = Path("/var/lib/anthrimon/downloads")
_VALID_ARCHES    = {"amd64", "arm64"}

# Go toolchain + source root (resolved relative to this file at import time)
_GO_BIN     = Path("/usr/local/go/bin/go")
_REPO_ROOT  = Path(__file__).resolve().parents[3]   # .../api/backend/routers/ → repo root
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
        return ipaddress.ip_address(request.client.host) in _WG_SUBNET
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
        "is_active":     c.is_active,
        "created_at":    c.created_at.isoformat(),
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
        .where(RemoteCollector.tenant_id == current_user.tenant_id)
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
    p = _COLLECTOR_DIST / f"anthrimon-collector-linux-{arch}"
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

    for arch, extra_env in _BUILD_TARGETS:
        out_path = _COLLECTOR_DIST / f"anthrimon-collector-linux-{arch}"
        env = {**os.environ, **extra_env}

        def _run(src=str(_REMOTE_SRC), out=str(out_path), e=env):
            return subprocess.run(
                [
                    str(_GO_BIN), "build",
                    "-trimpath", "-ldflags=-s -w",
                    "-o", out,
                    "./cmd/remote-collector/",
                ],
                cwd=src, env=e,
                capture_output=True, text=True,
                timeout=300,
            )

        logger.info("collector_build_start", arch=arch)
        try:
            proc = await loop.run_in_executor(None, _run)
            if proc.returncode == 0:
                out_path.chmod(0o755)
                size = out_path.stat().st_size
                results[arch] = {"success": True, "size_bytes": size}
                logger.info("collector_build_ok", arch=arch, size=size)
            else:
                error = (proc.stderr or proc.stdout or "unknown error").strip()
                results[arch] = {"success": False, "error": error}
                logger.error("collector_build_failed", arch=arch, error=error)
        except subprocess.TimeoutExpired:
            results[arch] = {"success": False, "error": "Build timed out after 300 s"}
            logger.error("collector_build_timeout", arch=arch)
        except Exception as exc:
            results[arch] = {"success": False, "error": str(exc)}
            logger.error("collector_build_exception", arch=arch, exc=str(exc))

    all_ok = all(r["success"] for r in results.values())
    return {"all_ok": all_ok, "arches": results}


# ── Collector-facing routes (no JWT — use API key from WireGuard tunnel) ──────
# These MUST be defined before /{collector_id} to avoid path-param shadowing.

@router.get("/binary", summary="Download the collector binary (collector API-key auth)")
async def download_binary_self_update(
    arch:    str     = "amd64",
    request: Request = None,
    db:      AsyncSession = Depends(get_db),
) -> Response:
    """Serve the pre-built collector binary for the given architecture.

    Called by the collector itself during a hub-triggered self-update.
    Requires a valid collector API key over the WireGuard tunnel.
    Sets X-Binary-SHA256 so the collector can verify integrity before replacing
    its own binary on disk.
    """
    await _require_collector(request, db)

    if arch not in _VALID_ARCHES:
        raise HTTPException(status_code=400,
                            detail=f"arch must be one of: {', '.join(sorted(_VALID_ARCHES))}")

    binary_path = _COLLECTOR_DIST / f"anthrimon-collector-linux-{arch}"
    if not binary_path.exists():
        raise HTTPException(
            status_code=503,
            detail=f"Binary for linux/{arch} not built yet. "
                   "Run POST /collectors/builds on the hub first.",
        )

    data = binary_path.read_bytes()
    sha256_hex = hashlib.sha256(data).hexdigest()

    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="anthrimon-collector-linux-{arch}"',
            "X-Binary-SHA256": sha256_hex,
        },
    )


@router.get("/config", summary="Fetch device list and credentials for this collector")
async def collector_config(
    request: Request,
    db:      AsyncSession = Depends(get_db),
) -> dict:
    from .. import crypto as _crypto

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
        "collector_id": str(collector.id),
        "timezone":     collector.timezone or "UTC",
        "devices":      devices_out,
        "generated_at": datetime.now(timezone.utc).isoformat(),
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
    timezone: Optional[str] = None
    name:     Optional[str] = None


@router.patch("/{collector_id}", summary="Update collector settings (timezone, name)")
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
    await db.commit()
    await db.refresh(c)
    return _collector_out(c)


async def _ch_query(query: str) -> list[dict]:
    """Execute a ClickHouse query and return rows as dicts (same pattern as syslog router)."""
    flat = " ".join(query.split()) + " FORMAT JSON"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(_CH_URL, content=flat,
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

echo "→ Installing dependencies (wireguard-tools)..."
if command -v apt-get &>/dev/null; then
  apt-get install -y --no-install-recommends wireguard-tools
elif command -v yum &>/dev/null; then
  yum install -y wireguard-tools
elif command -v dnf &>/dev/null; then
  dnf install -y wireguard-tools
else
  echo "WARNING: could not detect package manager — install wireguard-tools manually"
fi

echo "→ Installing binary..."
install -m 755 "${{BINARY}}" "${{BIN_DST}}"

echo "→ Installing config and CA cert..."
mkdir -p "${{CONF_DIR}}"
install -m 640 ca.crt         "${{CONF_DIR}}/ca.crt"
install -m 640 collector.yaml "${{CONF_DIR}}/collector.yaml"

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

        unzip anthrimon-collector-linux-amd64.zip
        sudo bash install.sh
    """
    if arch not in _VALID_ARCHES:
        raise HTTPException(status_code=400,
                            detail=f"arch must be one of: {', '.join(sorted(_VALID_ARCHES))}")

    binary_path = _COLLECTOR_DIST / f"anthrimon-collector-linux-{arch}"
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

    platform = await load_platform_settings(db)
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
    zip_name = f"anthrimon-collector-linux-{arch}.zip"
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

    platform = await load_platform_settings(db)
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
    await db.commit()
    return {"status": "ok", "server_time": datetime.now(timezone.utc).isoformat()}


_DEVICE_ID_RE = re.compile(rb'device_id="([0-9a-f-]{36})"')

# ── Prometheus line parsers for health metrics ────────────────────────────────
# Match: metric_name{...device_id="UUID"...} value [timestamp_ms]
_CPU_RE  = re.compile(rb'anthrimon_device_cpu_util_pct\{[^}]*device_id="([0-9a-f-]{36})"[^}]*\}\s+([\d.]+)')
_MEM_USED_RE  = re.compile(rb'anthrimon_device_mem_used_bytes\{[^}]*device_id="([0-9a-f-]{36})"[^}]*mem_type="ram"[^}]*\}\s+([\d.]+)')
_MEM_TOTAL_RE = re.compile(rb'anthrimon_device_mem_total_bytes\{[^}]*device_id="([0-9a-f-]{36})"[^}]*mem_type="ram"[^}]*\}\s+([\d.]+)')
_UPTIME_RE = re.compile(rb'anthrimon_uptime_seconds\{[^}]*device_id="([0-9a-f-]{36})"[^}]*\}\s+([\d.]+)')

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
    rb'anthrimon_device_info\{[^}]*device_id="([0-9a-f-]{36})"[^}]*'
    rb'sysdescr="((?:[^"\\]|\\.)*)"[^}]*sysname="([^"]*)"'
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
            f"{_VM_URL}/api/v1/import/prometheus",
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
    if valid_ids:
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

    # Parse anthrimon_device_info lines and backfill hostname / sys_description
    # for devices where the hub has no hostname yet (e.g. newly-registered vEOS nodes).
    # Only updates when the DB hostname is blank — never overwrites a user-set value.
    for m in _DEVICE_INFO_RE.finditer(body):
        did      = m.group(1).decode()
        sysdescr = m.group(2).decode().encode('raw_unicode_escape').decode('unicode_escape')
        sysname  = m.group(3).decode()
        if did not in allowed_device_ids or not sysname:
            continue
        await db.execute(
            text("""
                UPDATE devices
                SET hostname        = :sysname,
                    sys_description = :sysdescr
                WHERE id = CAST(:did AS uuid)
                  AND (hostname IS NULL OR hostname = '')
            """),
            {"did": did, "sysname": sysname, "sysdescr": sysdescr},
        )

    await db.commit()

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
            f"{_CH_URL}/?query={_FLOWS_INSERT.replace(' ', '+')}",
            content="\n".join(rows),
            headers={"Content-Type": "text/plain"},
        )
    if resp.status_code not in (200, 204):
        logger.warning("flows_ingest_failed", collector=collector.name,
                       status=resp.status_code, detail=resp.text[:200])
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
            f"{_CH_URL}/?query=INSERT+INTO+syslog_messages+"
            "(device_id,device_ip,facility,severity,ts,hostname,program,pid,message,raw)"
            "+FORMAT+TabSeparated",
            content="\n".join(rows),
            headers={"Content-Type": "text/plain"},
        )
    if resp.status_code not in (200, 204):
        logger.warning("syslog_ingest_failed", collector=collector.name,
                       status=resp.status_code, detail=resp.text[:200])
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

    from ..configmgmt.collector import store_config_backup
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
    """Accept a list of BGP session records (each with a device_id field) from a
    remote collector and upsert them into bgp_sessions.

    Each record must include at minimum: device_id, vrf, peer_ip, local_asn, state.
    """
    collector = await _require_collector(request, db)
    records   = await request.json()
    if not records:
        return {"written": 0}

    import uuid as _uuid
    from ..configmgmt.rest_state import _write_bgp

    # Gather allowed device IDs for this collector.
    allowed = {
        str(did) for (did,) in (await db.execute(
            select(Device.id).where(
                Device.collector_id == collector.id,
                Device.is_active == True,  # noqa: E712
            )
        )).all()
    }

    # Group records by device_id.
    by_device: dict[str, list] = {}
    for r in records:
        did = r.get("device_id")
        if did and did in allowed:
            r_clean = {k: v for k, v in r.items() if k != "device_id"}
            by_device.setdefault(did, []).append(r_clean)

    written = 0
    for did, peers in by_device.items():
        try:
            await _write_bgp(_uuid.UUID(did), peers)
            written += len(peers)
        except Exception as exc:
            logger.warning("bgp_ingest_failed", collector=collector.name,
                           device_id=did, error=str(exc))

    return {"written": written}


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
            f"{_CH_URL}/?query=INSERT+INTO+collector_logs+"
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
    """Accept a list of OSPF neighbor records (each with a device_id field) from a
    remote collector and upsert them into ospf_neighbors.

    Each record must include at minimum: device_id, vrf, router_id, neighbor_ip,
    interface_name, area, state.
    """
    collector = await _require_collector(request, db)
    records   = await request.json()
    if not records:
        return {"written": 0}

    import uuid as _uuid
    from ..configmgmt.rest_state import _write_ospf

    allowed = {
        str(did) for (did,) in (await db.execute(
            select(Device.id).where(
                Device.collector_id == collector.id,
                Device.is_active == True,  # noqa: E712
            )
        )).all()
    }

    by_device: dict[str, list] = {}
    for r in records:
        did = r.get("device_id")
        if did and did in allowed:
            r_clean = {k: v for k, v in r.items() if k != "device_id"}
            by_device.setdefault(did, []).append(r_clean)

    written = 0
    for did, nbrs in by_device.items():
        try:
            await _write_ospf(_uuid.UUID(did), nbrs)
            written += len(nbrs)
        except Exception as exc:
            logger.warning("ospf_ingest_failed", collector=collector.name,
                           device_id=did, error=str(exc))

    return {"written": written}


# ── IS-IS neighbors ingest ────────────────────────────────────────────────────

@router.post("/isis-neighbors",
             summary="Ingest IS-IS adjacency state collected by the remote collector")
async def ingest_isis_neighbors(
    request: Request,
    db:      AsyncSession = Depends(get_db),
) -> dict:
    """Accept a list of IS-IS adjacency records (each with a device_id field) from a
    remote collector and upsert them into isis_neighbors.

    Each record must include at minimum: device_id, instance, sys_id, interface_name,
    circuit_type, adj_state.  Optional: hostname, ipv4_address, ipv6_address,
    uptime_seconds, last_state_change (ISO-8601 string).
    """
    collector = await _require_collector(request, db)
    records   = await request.json()
    if not records:
        return {"written": 0}

    import uuid as _uuid
    from datetime import datetime as _dt
    from ..configmgmt.eapi_collector import _write_isis_neighbors

    allowed = {
        str(did) for (did,) in (await db.execute(
            select(Device.id).where(
                Device.collector_id == collector.id,
                Device.is_active == True,  # noqa: E712
            )
        )).all()
    }

    by_device: dict[str, list] = {}
    for r in records:
        did = r.get("device_id")
        if did and did in allowed:
            # Coerce last_state_change string → datetime if present
            row = {k: v for k, v in r.items() if k != "device_id"}
            lsc = row.get("last_state_change")
            if isinstance(lsc, str) and lsc:
                try:
                    row["last_state_change"] = _dt.fromisoformat(lsc.replace("Z", "+00:00"))
                except ValueError:
                    row["last_state_change"] = None
            by_device.setdefault(did, []).append(row)

    written = 0
    for did, adjs in by_device.items():
        try:
            await _write_isis_neighbors(_uuid.UUID(did), adjs)
            written += len(adjs)
        except Exception as exc:
            logger.warning("isis_ingest_failed", collector=collector.name,
                           device_id=did, error=str(exc))

    return {"written": written}


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
