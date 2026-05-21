"""Remote collector hub API.

Two authentication domains:

  Admin endpoints  — standard JWT (admin/superadmin role)
  Collector endpoints — API key in Authorization: Bearer header,
                        caller IP must be in 10.100.0.0/24 (WireGuard overlay)

Bootstrap is unauthenticated — one-time registration token validates the request.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import secrets
import subprocess
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_current_user, get_db, require_role
from ..models.credential import Credential, DeviceCredential
from ..models.device import Device
from ..models.site import RemoteCollector, WgIpPool
from ..models.tenant import User

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/collectors", tags=["collectors"])

_CH_URL    = "http://localhost:8123"
_VM_URL    = "http://localhost:8428"
_WG_IF     = "wg0"
_WG_SUBNET = ipaddress.ip_network("10.100.0.0/24")

TOKEN_TTL_HOURS = 24


# ── Helpers ───────────────────────────────────────────────────────────────────

def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


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
        out = subprocess.check_output(["wg", "show", _WG_IF, "public-key"],
                                       stderr=subprocess.DEVNULL, timeout=5)
        return out.decode().strip()
    except Exception:
        return None


def _wg_hub_endpoint() -> Optional[str]:
    """Return the hub's public IP:port for WireGuard (reads from wg0 listen-port)."""
    import socket
    try:
        out = subprocess.check_output(["wg", "show", _WG_IF, "listen-port"],
                                       stderr=subprocess.DEVNULL, timeout=5)
        port = int(out.decode().strip())
        # Best-effort public IP detection
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
        ["wg", "set", _WG_IF, "peer", pubkey, "allowed-ips", f"{allowed_ip}/32"],
        check=True, timeout=10,
    )
    # Persist to wg0.conf for reboots
    _wg_save_config()


def _wg_remove_peer(pubkey: str) -> None:
    """Remove a WireGuard peer."""
    try:
        subprocess.run(["wg", "set", _WG_IF, "peer", pubkey, "remove"],
                       check=True, timeout=10)
        _wg_save_config()
    except Exception as exc:
        logger.warning("wg_remove_peer_failed", pubkey=pubkey[:16], error=str(exc))


def _wg_save_config() -> None:
    """Persist the current wg0 state to /etc/wireguard/wg0.conf."""
    try:
        subprocess.run(["wg-quick", "save", _WG_IF], check=True, timeout=10)
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
        .where(WgIpPool.ip == ip)
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
    current_user: User         = Depends(require_role("admin", "superadmin")),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    token, token_hash = _generate_token()
    c = RemoteCollector(
        tenant_id        = current_user.tenant_id,
        site_id          = body.site_id,
        name             = body.name,
        token_hash       = token_hash,
        token_expires_at = datetime.utcnow() + timedelta(hours=TOKEN_TTL_HOURS),
        status           = "pending",
    )
    db.add(c)
    await db.commit()
    await db.refresh(c)
    logger.info("collector_created", collector=c.name, id=str(c.id))
    return _collector_out(c, token=token)


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


@router.delete("/{collector_id}", status_code=204, response_model=None,
               summary="Revoke a collector")
async def delete_collector(
    collector_id: str,
    current_user: User         = Depends(require_role("admin", "superadmin")),
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
    # Remove WireGuard peer if registered
    if c.wg_public_key:
        _wg_remove_peer(c.wg_public_key)
    if c.wg_ip:
        await _free_wg_ip(db, str(c.wg_ip))
    c.is_active   = False
    c.status      = "revoked"
    c.api_key_hash = None
    await db.commit()
    logger.info("collector_revoked", collector=c.name)


@router.post("/{collector_id}/token", summary="Regenerate registration token")
async def regenerate_token(
    collector_id: str,
    current_user: User         = Depends(require_role("admin", "superadmin")),
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
    c.token_expires_at = datetime.utcnow() + timedelta(hours=TOKEN_TTL_HOURS)
    await db.commit()
    return {"registration_token": token, "ca_cert": _ca_cert_pem(),
            "expires_at": c.token_expires_at.isoformat()}


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
    token_hash = _sha256(body.token)
    now        = datetime.now(timezone.utc)

    c = (await db.execute(
        select(RemoteCollector).where(RemoteCollector.token_hash == token_hash)
    )).scalar_one_or_none()

    if c is None:
        raise HTTPException(status_code=401, detail="Invalid registration token")
    if not c.is_active:
        raise HTTPException(status_code=401, detail="Collector has been revoked")
    if c.token_expires_at and now > c.token_expires_at.replace(tzinfo=timezone.utc):
        raise HTTPException(status_code=401, detail="Registration token has expired")

    # Check WireGuard is available on the hub
    hub_pubkey = _wg_hub_pubkey()
    if hub_pubkey is None:
        raise HTTPException(
            status_code=503,
            detail="WireGuard (wg0) is not configured on the hub. "
                   "Run: sudo bash scripts/setup-wireguard.sh",
        )

    # Allocate WireGuard IP
    wg_ip = await _allocate_wg_ip(db)
    if wg_ip is None:
        raise HTTPException(status_code=503, detail="WireGuard IP pool exhausted")

    # Generate API key
    api_key, api_key_hash = _generate_token()

    # Add WireGuard peer
    try:
        _wg_add_peer(body.wg_public_key, wg_ip)
    except Exception as exc:
        await _free_wg_ip(db, wg_ip)
        raise HTTPException(status_code=502, detail=f"Failed to add WireGuard peer: {exc}")

    # Update collector record
    c.wg_public_key  = body.wg_public_key
    c.wg_ip          = wg_ip
    c.api_key_hash   = api_key_hash
    c.hostname       = body.hostname
    c.version        = body.version
    c.capabilities   = body.capabilities
    c.ip_address     = request.client.host
    c.status         = "offline"   # will flip to online on first heartbeat
    c.registered_at  = now
    c.token_hash     = _sha256(secrets.token_hex(32))  # invalidate token
    c.token_expires_at = None

    # Update wg_ip_pool assigned_to
    await db.execute(
        update(WgIpPool).where(WgIpPool.ip == wg_ip).values(assigned_to=c.id)
    )
    await db.commit()

    logger.info("collector_bootstrapped", collector=c.name, wg_ip=wg_ip,
                hostname=body.hostname)

    return {
        "collector_id":    str(c.id),
        "api_key":         api_key,          # shown once — collector must store this
        "wg_assigned_ip":  wg_ip,
        "wg_hub_pubkey":   hub_pubkey,
        "wg_hub_endpoint": _wg_hub_endpoint(),
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
                except Exception:
                    pass
            cred_list.append({
                "type":     cred.type,
                "priority": dc.priority,
                "data":     cred_data,
            })

        devices_out.append({
            "id":                str(dev.id),
            "hostname":          dev.fqdn or dev.hostname,
            "mgmt_ip":           str(dev.mgmt_ip).split("/")[0],
            "vendor":            dev.vendor,
            "device_type":       dev.device_type,
            "snmp_port":         dev.snmp_port,
            "polling_interval_s":dev.polling_interval_s,
            "credentials":       cred_list,
        })

    return {
        "collector_id": str(collector.id),
        "devices":      devices_out,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


@router.post("/metrics", summary="Ingest Prometheus metrics from collector → VictoriaMetrics")
async def ingest_metrics(
    request: Request,
    db:      AsyncSession = Depends(get_db),
) -> dict:
    collector = await _require_collector(request, db)
    body = await request.body()
    if not body:
        return {"written": 0}
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            f"{_VM_URL}/api/v1/import/prometheus",
            content=body,
            headers={"Content-Type": "text/plain"},
        )
    if resp.status_code not in (200, 204):
        logger.warning("collector_metrics_ingest_failed",
                       collector=collector.name, status=resp.status_code)
    lines = body.count(b"\n")
    logger.debug("collector_metrics_ingested", collector=collector.name, lines=lines)
    return {"written": lines}


@router.post("/flows", summary="Ingest flow records from collector → ClickHouse")
async def ingest_flows(
    request: Request,
    db:      AsyncSession = Depends(get_db),
) -> dict:
    collector = await _require_collector(request, db)
    records = await request.json()
    if not records:
        return {"written": 0}

    # Batch insert into flow_records via ClickHouse HTTP
    rows = []
    for r in records:
        rows.append(
            f"{r.get('collector_device_id','00000000-0000-0000-0000-000000000000')}\t"
            f"{r.get('exporter_ip','0.0.0.0')}\t{r.get('flow_type','unknown')}\t"
            f"{r.get('flow_start','')}\t{r.get('flow_end','')}\t"
            f"{r.get('src_ip','0.0.0.0')}\t{r.get('dst_ip','0.0.0.0')}\t"
            f"0.0.0.0\t::\t::\t0.0.0.0\t"
            f"{r.get('src_port',0)}\t{r.get('dst_port',0)}\t"
            f"{r.get('ip_protocol',0)}\t{r.get('tcp_flags',0)}\t"
            f"{r.get('bytes',0)}\t{r.get('packets',0)}\t"
            f"{r.get('input_if_index',0)}\t{r.get('output_if_index',0)}\t"
            f"0\t0\t0\t0\t{r.get('tos',0)}\t{r.get('dscp',0)}\t"
            f"{r.get('sampling_rate',1)}"
        )

    async with httpx.AsyncClient(timeout=15) as client:
        await client.post(
            f"{_CH_URL}/?query=INSERT+INTO+flow_records+FORMAT+TabSeparated",
            content="\n".join(rows),
            headers={"Content-Type": "text/plain"},
        )
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

    rows = []
    for r in records:
        rows.append(
            f"{r.get('device_id','00000000-0000-0000-0000-000000000000')}\t"
            f"{r.get('device_ip','0.0.0.0')}\t"
            f"{r.get('facility',0)}\t{r.get('severity',6)}\t"
            f"{r.get('ts','1970-01-01 00:00:00')}\t"
            f"{r.get('hostname','')}\t{r.get('program','')}\t"
            f"{r.get('pid','')}\t{r.get('message','')}\t{r.get('raw','')}"
        )

    async with httpx.AsyncClient(timeout=15) as client:
        await client.post(
            f"{_CH_URL}/?query=INSERT+INTO+syslog_messages+"
            "(device_id,device_ip,facility,severity,ts,hostname,program,pid,message,raw)"
            "+FORMAT+TabSeparated",
            content="\n".join(rows),
            headers={"Content-Type": "text/plain"},
        )
    return {"written": len(rows)}
