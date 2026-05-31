"""
REST-based BGP and OSPF state collection for ArubaOS-CX.

ArubaOS-CX doesn't implement standard OSPF-MIB / BGP4-MIB via SNMP.
This collector uses the native AOS-CX REST API (v10.x) instead, writing
into the same bgp_sessions and ospf_neighbors tables used by the SNMP
path so the existing UI, alerting and BGP event log all work unchanged.

REST API must be enabled on the switch:
    conf t
    https-server vrf mgmt
    end
    wr mem

Collection is enabled per-device via a toggle in the device settings UI.
The device must have either:
  - An SSH credential assigned (username/password used for basic auth)
  - An api_token credential assigned (used as bearer token)
"""
from __future__ import annotations

import asyncio
import json
import urllib.parse
import uuid
from typing import Optional

import httpx
import structlog
from sqlalchemy import select, text

from ..database import AsyncSessionLocal
from ..models.credential import Credential, DeviceCredential
from ..models.device import Device

logger = structlog.get_logger(__name__)

_REST_API_VERSION = "v10.16"   # falls back to v10.13 if 404


# ── State normalisers ─────────────────────────────────────────────────────────

def _bgp_state(raw: str) -> str:
    mapping = {
        "established":  "established",
        "active":       "active",
        "idle":         "idle",
        "connect":      "connect",
        "opensent":     "opensent",
        "openconfirm":  "openconfirm",
        "openconfirmed":"openconfirm",
    }
    return mapping.get(raw.lower(), "unknown")


def _ospf_state(raw: str) -> str:
    mapping = {
        "full":      "full",
        "two_way":   "two_way",
        "2-way":     "two_way",
        "init":      "init",
        "exstart":   "exstart",
        "exchange":  "exchange",
        "loading":   "loading",
        "down":      "down",
        "attempt":   "attempt",
    }
    return mapping.get(raw.lower(), "unknown")


# ── ArubaOS-CX REST client ────────────────────────────────────────────────────

class ArubaRestClient:
    def __init__(self, host: str, username: str, password: str,
                 version: str = _REST_API_VERSION):
        self.base = f"https://{host}/rest/{version}"
        self.host = host
        self.username = username
        self.password = password
        self._cookie: dict = {}
        self._client: Optional[httpx.AsyncClient] = None

    async def __aenter__(self):
        self._client = httpx.AsyncClient(
            verify=False, timeout=15,
            limits=httpx.Limits(max_connections=5),
        )
        await self._login()
        return self

    async def __aexit__(self, *_):
        try:
            await self._client.post(f"{self.base}/logout", cookies=self._cookie)
        except Exception:
            pass
        await self._client.aclose()

    async def _login(self):
        resp = await self._client.post(
            f"{self.base}/login",
            data={"username": self.username, "password": self.password},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        resp.raise_for_status()
        self._cookie = dict(resp.cookies)

    async def get(self, path: str, **params) -> dict | list:
        resp = await self._client.get(
            f"{self.base}{path}",
            cookies=self._cookie,
            params=params,
        )
        if resp.status_code == 404:
            return {}
        resp.raise_for_status()
        return resp.json()


# ── BGP collection ────────────────────────────────────────────────────────────

async def _collect_bgp(client: ArubaRestClient, device_id: uuid.UUID) -> list[dict]:
    vrfs = await client.get("/system/vrfs")
    peers = []

    for vrf_name in vrfs:
        routers = await client.get(f"/system/vrfs/{vrf_name}/bgp_routers")
        for asn_str in routers:
            local_asn = int(asn_str)
            neighbors = await client.get(
                f"/system/vrfs/{vrf_name}/bgp_routers/{asn_str}/bgp_neighbors",
                depth=2,
            )
            if not isinstance(neighbors, dict):
                continue

            for peer_ip, data in neighbors.items():
                if not isinstance(data, dict):
                    continue
                status     = data.get("status", {}) or {}
                stats      = data.get("statistics", {}) or {}
                state_raw  = status.get("bgp_peer_state", "unknown")

                # Sum received and sent prefixes across all AFI/SAFI families
                # e.g. status.prefix_statistics["ipv4-unicast"]["received" | "sent"]
                prefixes_rx = 0
                prefixes_tx = 0
                pfx_stats = status.get("prefix_statistics") or {}
                for afi_data in pfx_stats.values():
                    if isinstance(afi_data, dict):
                        prefixes_rx += int(afi_data.get("received") or 0)
                        prefixes_tx += int(afi_data.get("sent") or 0)

                peers.append({
                    "vrf":                  vrf_name,
                    "peer_ip":              peer_ip,
                    "peer_asn":             data.get("remote_as"),
                    "local_asn":            local_asn,
                    "description":          data.get("description"),
                    "state":                _bgp_state(state_raw),
                    "uptime_s":             stats.get("bgp_peer_uptime") or 0,
                    "flap_count":           stats.get("bgp_peer_established_count") or 0,
                    "in_updates":           stats.get("bgp_peer_update_in_count") or 0,
                    "out_updates":          stats.get("bgp_peer_update_out_count") or 0,
                    "prefixes_received":    prefixes_rx,
                    "prefixes_advertised":  prefixes_tx,
                })
    return peers


# ── OSPF collection ───────────────────────────────────────────────────────────

async def _collect_ospf(client: ArubaRestClient, device_id: uuid.UUID) -> list[dict]:
    """
    Walk VRFs → OSPF routers → areas → interfaces → neighbors.
    The API returns URL strings at each level; we explicitly GET each one.
    Only ospf_neighbors supports ?depth=2 to embed objects directly.
    """
    vrfs = await client.get("/system/vrfs")
    neighbors = []

    for vrf_name in vrfs:
        # Step 1: get OSPF routers (shallow — just need tags)
        routers = await client.get(f"/system/vrfs/{vrf_name}/ospf_routers")
        if not isinstance(routers, dict):
            continue

        for tag in routers:
            # Step 2: get areas (shallow)
            areas = await client.get(
                f"/system/vrfs/{vrf_name}/ospf_routers/{tag}/areas"
            )
            if not isinstance(areas, dict):
                continue

            for area_id in areas:
                # Step 3: get ospf_interfaces — returns {iface_name: url_string}
                ifaces = await client.get(
                    f"/system/vrfs/{vrf_name}/ospf_routers/{tag}/areas/{area_id}/ospf_interfaces"
                )
                if not isinstance(ifaces, dict):
                    continue

                for iface_name in ifaces:
                    iface_enc = urllib.parse.quote(iface_name, safe="")
                    # Step 4: get neighbors with depth=2 to embed objects
                    nbrs = await client.get(
                        f"/system/vrfs/{vrf_name}/ospf_routers/{tag}"
                        f"/areas/{area_id}/ospf_interfaces/{iface_enc}/ospf_neighbors",
                        depth=2,
                    )
                    if not isinstance(nbrs, dict):
                        continue

                    for router_id, nbr in nbrs.items():
                        if not isinstance(nbr, dict):
                            continue
                        neighbors.append({
                            "vrf":            vrf_name,
                            "router_id":      nbr.get("nbr_router_id") or router_id,
                            "neighbor_ip":    nbr.get("nbr_if_addr") or router_id,
                            "interface_name": iface_name,
                            "area":           area_id,
                            "state":          _ospf_state(nbr.get("nfsm_state", "unknown")),
                        })
    return neighbors


# ── DB writers ────────────────────────────────────────────────────────────────

async def _write_bgp(device_id: uuid.UUID, peers: list[dict]) -> None:
    if not peers:
        return
    async with AsyncSessionLocal() as db:
        # Snapshot current state for transition detection
        prev_rows = (await db.execute(
            text("SELECT id::text, peer_ip::text, session_state::text FROM bgp_sessions WHERE device_id = :did"),
            {"did": str(device_id)},
        )).all()
        prev = {r[1].split("/")[0]: {"id": r[0], "state": r[2]} for r in prev_rows}

        for p in peers:
            await db.execute(text("""
                INSERT INTO bgp_sessions
                    (device_id, vrf, peer_ip, local_asn, peer_asn,
                     peer_description, session_state, admin_status,
                     uptime_seconds, in_updates, out_updates, flap_count,
                     prefixes_received, prefixes_advertised, updated_at)
                VALUES
                    (CAST(:did AS uuid), :vrf, CAST(:peer_ip AS inet),
                     :local_asn, :peer_asn,
                     :description, CAST(:state AS bgp_session_state), 'start',
                     :uptime_s, :in_updates, :out_updates, :flap_count,
                     :prefixes_received, :prefixes_advertised, NOW())
                ON CONFLICT (device_id, vrf, peer_ip) DO UPDATE SET
                    local_asn            = EXCLUDED.local_asn,
                    peer_asn             = EXCLUDED.peer_asn,
                    peer_description     = EXCLUDED.peer_description,
                    session_state        = EXCLUDED.session_state,
                    uptime_seconds       = EXCLUDED.uptime_seconds,
                    in_updates           = EXCLUDED.in_updates,
                    out_updates          = EXCLUDED.out_updates,
                    flap_count           = EXCLUDED.flap_count,
                    prefixes_received    = EXCLUDED.prefixes_received,
                    prefixes_advertised  = COALESCE(EXCLUDED.prefixes_advertised, bgp_sessions.prefixes_advertised),
                    last_state_change = CASE
                        WHEN bgp_sessions.session_state != EXCLUDED.session_state THEN NOW()
                        ELSE bgp_sessions.last_state_change
                    END,
                    updated_at = NOW()
            """), {
                "did":                str(device_id),
                "vrf":                p.get("vrf", "default"),
                "peer_ip":            p["peer_ip"],
                "local_asn":          p["local_asn"],
                "peer_asn":           p.get("peer_asn"),
                "description":        p.get("description"),
                "state":              p["state"],
                "uptime_s":           p.get("uptime_s", 0),
                "in_updates":         p.get("in_updates", 0),
                "out_updates":        p.get("out_updates", 0),
                "flap_count":         p.get("flap_count", 0),
                "prefixes_received":  p.get("prefixes_received", 0),
                "prefixes_advertised": p.get("prefixes_advertised"),
            })

        # Log transitions
        for p in peers:
            old = prev.get(p["peer_ip"])
            if old and old["state"] != p["state"]:
                await db.execute(text("""
                    INSERT INTO bgp_session_events
                        (session_id, device_id, peer_ip, prev_state, new_state, recorded_at)
                    SELECT id, CAST(:did AS uuid), CAST(:peer_ip AS inet),
                           :prev, :new, NOW()
                    FROM bgp_sessions
                    WHERE device_id = CAST(:did AS uuid)
                      AND peer_ip   = CAST(:peer_ip AS inet) LIMIT 1
                """), {
                    "did": str(device_id), "peer_ip": p["peer_ip"],
                    "prev": old["state"], "new": p["state"],
                })
                logger.info("bgp_state_transition_rest",
                            device_id=str(device_id),
                            peer_ip=p["peer_ip"],
                            prev=old["state"], new=p["state"])

        await db.commit()

    # ── Push to VictoriaMetrics ───────────────────────────────────────────────
    await _push_bgp_to_vm(device_id, peers)


async def _push_bgp_to_vm(device_id: uuid.UUID, peers: list[dict]) -> None:
    """Push BGP metrics to VictoriaMetrics in Prometheus text format."""
    import time as _time
    did = str(device_id)
    ts_ms = int(_time.time() * 1000)
    lines: list[str] = []

    for p in peers:
        peer_ip   = p["peer_ip"].replace('"', '')
        peer_asn  = int(p.get("peer_asn") or 0)
        local_asn = int(p.get("local_asn") or 0)
        labels = (
            f'device_id="{did}",'
            f'peer_ip="{peer_ip}",'
            f'peer_asn="{peer_asn}",'
            f'local_asn="{local_asn}"'
        )
        lines.append(f'anthrimon_bgp_prefixes_received{{{labels}}} {p.get("prefixes_received", 0)} {ts_ms}')
        lines.append(f'anthrimon_bgp_in_updates_total{{{labels}}} {p.get("in_updates", 0)} {ts_ms}')
        lines.append(f'anthrimon_bgp_out_updates_total{{{labels}}} {p.get("out_updates", 0)} {ts_ms}')
        lines.append(f'anthrimon_bgp_flap_count_total{{{labels}}} {p.get("flap_count", 0)} {ts_ms}')

    if not lines:
        return

    body = "\n".join(lines) + "\n"
    try:
        async with httpx.AsyncClient(timeout=5) as hc:
            resp = await hc.post(
                "http://localhost:8428/api/v1/import/prometheus",
                content=body.encode(),
                headers={"Content-Type": "text/plain"},
            )
            if resp.status_code not in (200, 204):
                logger.warning("bgp_vm_push_failed",
                               device_id=did, status=resp.status_code)
    except Exception as exc:
        logger.warning("bgp_vm_push_error", device_id=did, error=str(exc))


async def _write_ospf(device_id: uuid.UUID, neighbors: list[dict]) -> None:
    if not neighbors:
        return
    async with AsyncSessionLocal() as db:
        for n in neighbors:
            await db.execute(text("""
                INSERT INTO ospf_neighbors
                    (device_id, vrf, neighbor_router_id, neighbor_ip,
                     interface_name, area, state, updated_at)
                VALUES
                    (CAST(:did AS uuid), :vrf, CAST(:router_id AS inet),
                     CAST(:neighbor_ip AS inet),
                     :iface, :area,
                     CAST(:state AS ospf_neighbor_state), NOW())
                ON CONFLICT (device_id, vrf, neighbor_router_id, interface_name)
                DO UPDATE SET
                    neighbor_ip    = EXCLUDED.neighbor_ip,
                    area           = EXCLUDED.area,
                    state          = EXCLUDED.state,
                    last_state_change = CASE
                        WHEN ospf_neighbors.state != EXCLUDED.state THEN NOW()
                        ELSE ospf_neighbors.last_state_change
                    END,
                    updated_at = NOW()
            """), {
                "did":         str(device_id),
                "vrf":         n.get("vrf", "default"),
                "router_id":   n["router_id"],
                "neighbor_ip": n.get("neighbor_ip") or n["router_id"],
                "iface":       n.get("interface_name", ""),
                "area":        n.get("area"),
                "state":       n["state"],
            })
        await db.commit()


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _disable_rest(device_id: uuid.UUID, reason: str) -> None:
    """Set rest_collection_enabled=False — requires manual re-enable.

    Skipped for devices assigned to a remote collector: the hub can't reach
    those devices directly, so unreachability is expected and should not
    disable collection for the remote collector.
    """
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            text("""
                UPDATE devices
                   SET rest_collection_enabled = FALSE
                 WHERE id = CAST(:did AS uuid)
                   AND collector_id IS NULL
            """),
            {"did": str(device_id)},
        )
        if result.rowcount == 0:
            logger.debug("rest_collection_disable_skipped_remote",
                         device_id=str(device_id), reason=reason)
            return
        await db.commit()
    logger.warning("rest_collection_disabled", device_id=str(device_id), reason=reason)


async def _auto_enable_aruba_cx() -> None:
    """Enable REST collection for any ArubaOS-CX devices not yet enabled.

    Applies to ALL Aruba CX devices regardless of whether they are managed by
    the hub or a remote collector — remote collectors read this flag from the
    /config endpoint and handle REST collection themselves.

    Runs at the start of each loop cycle to pick up newly discovered devices.
    """
    async with AsyncSessionLocal() as db:
        result = await db.execute(text("""
            UPDATE devices SET rest_collection_enabled = TRUE
            WHERE vendor::text = 'aruba_cx'
              AND rest_collection_enabled = FALSE
            RETURNING id::text, hostname
        """))
        enabled = result.all()
        if enabled:
            await db.commit()
            for row in enabled:
                logger.info("rest_collection_auto_enabled",
                            device_id=row[0], hostname=row[1])


# ── Per-device collector ──────────────────────────────────────────────────────

async def collect_device_rest_state(device_id: uuid.UUID) -> None:
    """Collect BGP + OSPF for one device via REST API."""
    from .. import crypto

    async with AsyncSessionLocal() as db:
        dev = (await db.execute(
            select(Device).where(Device.id == device_id, Device.is_active == True)  # noqa
        )).scalar_one_or_none()
        if dev is None:
            return
        if not dev.rest_collection_enabled:
            return
        if dev.collector_id is not None:
            # Device is assigned to a remote collector which handles REST
            # collection itself — the hub must not attempt to reach it directly.
            return

        # Prefer api_token credential, fall back to ssh credential
        cred_row = (await db.execute(
            select(DeviceCredential, Credential)
            .join(Credential, Credential.id == DeviceCredential.credential_id)
            .where(
                DeviceCredential.device_id == device_id,
                Credential.type.in_(["api_token", "ssh"]),
            )
            .order_by(
                # api_token first
                text("CASE credentials.type WHEN 'api_token' THEN 0 ELSE 1 END"),
                DeviceCredential.priority,
            )
        )).first()
        if cred_row is None:
            return

        _, cred = cred_row
        cred_data = cred.data if isinstance(cred.data, dict) else json.loads(cred.data)
        if cred_data.get("password") and crypto.is_configured():
            try:
                cred_data["password"] = crypto.decrypt(cred_data["password"])
            except Exception:
                pass

    host     = dev.mgmt_ip_str
    username = cred_data.get("username", "admin")
    password = cred_data.get("password", "")

    try:
        async with ArubaRestClient(host, username, password) as client:
            bgp_peers, ospf_nbrs = await asyncio.gather(
                _collect_bgp(client, device_id),
                _collect_ospf(client, device_id),
                return_exceptions=True,
            )

        if isinstance(bgp_peers, list) and bgp_peers:
            await _write_bgp(device_id, bgp_peers)
            logger.info("rest_bgp_collected",
                        device=dev.hostname, peers=len(bgp_peers))

        if isinstance(ospf_nbrs, list) and ospf_nbrs:
            await _write_ospf(device_id, ospf_nbrs)
            logger.info("rest_ospf_collected",
                        device=dev.hostname, neighbors=len(ospf_nbrs))

    except httpx.HTTPStatusError as exc:
        code = exc.response.status_code
        if code in (401, 403):
            # Auth failure — disable and require manual re-enable
            await _disable_rest(device_id,
                                f"REST API returned {code} — check credentials")
            logger.warning("rest_collection_auth_failed",
                           device=dev.hostname, status=code,
                           action="rest_collection_enabled set to False — re-enable manually")
        else:
            logger.warning("rest_collection_http_error",
                           device=dev.hostname, status=code)
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.TimeoutException) as exc:
        # Unreachable — disable and require manual re-enable
        await _disable_rest(device_id,
                            f"REST API unreachable: {exc}")
        logger.warning("rest_collection_unreachable",
                       device=dev.hostname, error=str(exc),
                       action="rest_collection_enabled set to False — re-enable manually")
    except Exception as exc:
        logger.warning("rest_collection_failed",
                       device=dev.hostname, error=str(exc))


# ── Background loop ───────────────────────────────────────────────────────────

async def _rest_state_loop(interval_s: int) -> None:
    while True:
        await asyncio.sleep(interval_s)
        try:
            # Auto-enable any newly discovered ArubaOS-CX devices
            await _auto_enable_aruba_cx()

            async with AsyncSessionLocal() as db:
                device_ids = (await db.execute(
                    text("""
                        SELECT d.id::text FROM devices d
                        WHERE d.is_active = true
                          AND d.rest_collection_enabled = true
                          AND d.collector_id IS NULL
                    """)
                )).scalars().all()

            if device_ids:
                await asyncio.gather(
                    *[collect_device_rest_state(uuid.UUID(did)) for did in device_ids],
                    return_exceptions=True,
                )
                logger.debug("rest_state_cycle_complete", devices=len(device_ids))
        except Exception:
            logger.exception("rest_state_loop_error")


def start_rest_state_collector(interval_s: int = 300) -> asyncio.Task:
    return asyncio.create_task(_rest_state_loop(interval_s), name="rest-routing-state")
