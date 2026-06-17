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
    async with AsyncSessionLocal() as db:
        # Snapshot current state BEFORE marking stale below, so the
        # transition log AND the upsert's last_state_change CASE both
        # reflect the true pre-poll state -- otherwise every steady-state
        # session would look like an idle -> <state> transition (and have
        # its last_state_change/uptime reset) on every poll, since by the
        # time the upsert runs, the row's live session_state column has
        # already been overwritten to 'idle' by the mark-stale UPDATE. The
        # mark-stale UPDATE also bumps last_state_change to NOW() for every
        # row it touches (correct for peers that truly went idle), so the
        # CASE's "no real transition" branch must restore THIS snapshotted
        # last_state_change rather than the live column, which mark-stale
        # has already clobbered to NOW() by the time the upsert runs.
        prev_rows = (await db.execute(
            text("SELECT id::text, peer_ip::text, session_state::text, last_state_change FROM bgp_sessions WHERE device_id = :did"),
            {"did": str(device_id)},
        )).all()
        prev = {r[1].split("/")[0]: {"id": r[0], "state": r[2], "last_state_change": r[3]} for r in prev_rows}

        # Mark existing sessions idle first so peers that disappeared from
        # this poll -- including ALL of them, if the device currently has
        # zero BGP sessions -- are treated as down. bgp_session_state has no
        # 'down' value, and eval_bgp_session_down only treats
        # established/unknown as healthy, so 'idle' is the correct
        # stale-marker. admin_status is left untouched. The upsert loop below
        # restores any session still present to its real state.
        await db.execute(text("""
            UPDATE bgp_sessions
               SET session_state = 'idle'::bgp_session_state,
                   last_state_change = NOW(), updated_at = NOW()
             WHERE device_id = :did AND session_state != 'idle'
        """), {"did": str(device_id)})

        for p in peers:
            prev_entry = prev.get(p["peer_ip"], {})
            prev_state = prev_entry.get("state")
            prev_lsc = prev_entry.get("last_state_change")
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
                        WHEN CAST(:prev_state AS bgp_session_state) IS DISTINCT FROM EXCLUDED.session_state THEN NOW()
                        ELSE COALESCE(CAST(:prev_lsc AS timestamptz), NOW())
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
                "prev_state":         prev_state,
                "prev_lsc":           prev_lsc,
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
    async with AsyncSessionLocal() as db:
        # Snapshot current state BEFORE marking down below, so the upsert's
        # last_state_change CASE compares against the true pre-poll state --
        # otherwise every neighbor still present would look like it just
        # transitioned this cycle (and have its last_state_change/uptime
        # reset), since by the time the upsert runs, the row's live state
        # column has already been overwritten to 'down' by the mark-down
        # UPDATE. The mark-down UPDATE also bumps last_state_change to NOW()
        # for every row it touches (correct for neighbors that truly went
        # down), so the CASE's "no real transition" branch must restore THIS
        # snapshotted last_state_change rather than the live column, which
        # mark-down has already clobbered to NOW() by the time the upsert
        # runs.
        prev_rows = (await db.execute(text("""
            SELECT vrf, neighbor_router_id::text, interface_name, state::text, last_state_change
              FROM ospf_neighbors WHERE device_id = :did
        """), {"did": str(device_id)})).all()
        prev = {(r[0], r[1].split("/")[0], r[2]): {"state": r[3], "last_state_change": r[4]} for r in prev_rows}

        # Mark existing rows for this device down first so neighbors that
        # disappeared from this poll -- including ALL of them, if the device
        # currently has zero OSPF neighbors -- are treated as down. The
        # alert evaluator ignores 'unknown', so leaving stale rows in their
        # last-known state would mask a real neighbor-down event. The upsert
        # loop below restores any neighbor still present to its real state.
        await db.execute(text("""
            UPDATE ospf_neighbors
               SET state = 'down'::ospf_neighbor_state,
                   last_state_change = NOW(), updated_at = NOW()
             WHERE device_id = :did AND state != 'down'
        """), {"did": str(device_id)})

        for n in neighbors:
            vrf   = n.get("vrf", "default")
            iface = n.get("interface_name", "")
            prev_entry = prev.get((vrf, n["router_id"].split("/")[0], iface), {})
            prev_state = prev_entry.get("state")
            prev_lsc = prev_entry.get("last_state_change")
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
                        WHEN CAST(:prev_state AS ospf_neighbor_state) IS DISTINCT FROM EXCLUDED.state THEN NOW()
                        ELSE COALESCE(CAST(:prev_lsc AS timestamptz), NOW())
                    END,
                    updated_at = NOW()
            """), {
                "did":         str(device_id),
                "vrf":         vrf,
                "router_id":   n["router_id"],
                "neighbor_ip": n.get("neighbor_ip") or n["router_id"],
                "iface":       iface,
                "area":        n.get("area"),
                "state":       n["state"],
                "prev_state":  prev_state,
                "prev_lsc":    prev_lsc,
            })
        await db.commit()


async def _write_routes(device_id: uuid.UUID, routes: list[dict]) -> None:
    """Upsert route table entries for a device, then purge any rows for that
    device not refreshed in this batch (mark-and-sweep), matching the
    behaviour of the hub-local SNMP collector's route writer.
    """
    async with AsyncSessionLocal() as db:
        for r in routes:
            await db.execute(text("""
                INSERT INTO route_entries
                    (device_id, destination, next_hop, protocol, metric, interface_name, updated_at)
                VALUES
                    (CAST(:did AS uuid), :destination, :next_hop, :protocol, :metric, :iface, NOW())
                ON CONFLICT (device_id, destination, next_hop) DO UPDATE SET
                    protocol       = EXCLUDED.protocol,
                    metric         = EXCLUDED.metric,
                    interface_name = EXCLUDED.interface_name,
                    updated_at     = EXCLUDED.updated_at
            """), {
                "did":         str(device_id),
                "destination": r["destination"],
                "next_hop":    r.get("next_hop") or "",
                "protocol":    r.get("protocol", "other"),
                "metric":      r.get("metric"),
                "iface":       r.get("interface_name"),
            })

        # Purge withdrawn routes: any row not refreshed this cycle is gone
        # from the device's routing table. NOW() is stable for the duration
        # of the transaction, so it excludes the rows just upserted above.
        await db.execute(text("""
            DELETE FROM route_entries
             WHERE device_id = CAST(:did AS uuid) AND updated_at < NOW()
        """), {"did": str(device_id)})

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

# ── VLAN collection (AOS-CX REST) ─────────────────────────────────────────────

def _vlan_ids_from(value) -> list[int]:
    """Extract VLAN id(s) from an AOS-CX attribute that may be an int, a numeric
    string, a {"<id>": "<uri>"} reference map, or a list of those."""
    out: list[int] = []
    if value is None:
        return out
    if isinstance(value, bool):
        return out
    if isinstance(value, int):
        out.append(value)
    elif isinstance(value, str):
        if value.isdigit():
            out.append(int(value))
    elif isinstance(value, dict):
        for k in value:
            try:
                out.append(int(k))
            except (TypeError, ValueError):
                continue
    elif isinstance(value, list):
        for v in value:
            out.extend(_vlan_ids_from(v))
    return out


async def _collect_vlans(client: "ArubaRestClient") -> tuple[list[dict], list[dict]]:
    """Collect VLANs and per-interface membership from AOS-CX REST.

    Returns (vlans, ifvlans):
      vlans   = [{"vlan_id": int, "name": str|None}]
      ifvlans = [{"if_name": str, "vlan_id": int, "tagged": bool}]
    ArubaOS-CX does not expose Q-BRIDGE-MIB via SNMP, so this REST path is the
    only source of VLAN data for CX switches.
    """
    vlans: list[dict] = []
    raw = await client.get("/system/vlans", depth=2)
    if isinstance(raw, dict):
        for key, obj in raw.items():
            vid = None
            name = None
            if isinstance(obj, dict):
                vid = obj.get("id")
                name = obj.get("name")
            if vid is None:
                try:
                    vid = int(key)
                except (TypeError, ValueError):
                    continue
            vlans.append({"vlan_id": int(vid), "name": name})

    ifvlans: list[dict] = []
    ports = await client.get("/system/interfaces", depth=2)
    if isinstance(ports, dict):
        for name, o in ports.items():
            if not isinstance(o, dict):
                continue
            # Access / native (untagged) VLAN
            access = o.get("vlan_tag")
            if access is None:
                access = o.get("applied_vlan_tag")
            for vid in _vlan_ids_from(access):
                ifvlans.append({"if_name": name, "vlan_id": vid, "tagged": False})
            # Trunk (tagged) VLANs
            trunks = o.get("vlan_trunks") or o.get("applied_vlan_trunks")
            for vid in _vlan_ids_from(trunks):
                ifvlans.append({"if_name": name, "vlan_id": vid, "tagged": True})
    return vlans, ifvlans


# ── STP collection (AOS-CX REST) ──────────────────────────────────────────────

def _norm_stp_state(v) -> str:
    m = {
        "forwarding": "forwarding", "blocking": "blocking", "blocked": "blocking",
        "discarding": "blocking", "learning": "learning", "listening": "listening",
        "disabled": "disabled",
    }
    return m.get(str(v).strip().lower(), "disabled") if v else "disabled"


def _norm_stp_role(v) -> str:
    s = str(v or "").strip().lower()
    if "root" in s:
        return "root"
    if "designated" in s:
        return "designated"
    if "alternate" in s:
        return "alternate"
    if "backup" in s:
        return "backup"
    return "unknown"


async def _collect_stp(client: "ArubaRestClient") -> list[dict]:
    """Collect per-port STP state from AOS-CX REST (CIST / instance 0).

    Returns [{"if_name": str, "stp_state": str, "stp_role": str}]. Empty when
    spanning tree is disabled or no ports are participating.
    """
    out: list[dict] = []
    raw = await client.get("/system/stp_instances", depth=3)
    if not isinstance(raw, dict):
        return out
    for _key, inst in raw.items():
        if not isinstance(inst, dict):
            continue
        # Only the Common Internal Spanning Tree (instance 0) maps to per-port state.
        if inst.get("stp_instance_id") not in (0, None):
            continue
        ports = inst.get("stp_instance_ports")
        if not isinstance(ports, dict):
            continue
        for pname, pobj in ports.items():
            if not isinstance(pobj, dict):
                continue
            state = pobj.get("port_state") or pobj.get("oper_port_state")
            role = pobj.get("port_role") or pobj.get("oper_port_role")
            out.append({
                "if_name": pname,
                "stp_state": _norm_stp_state(state),
                "stp_role": _norm_stp_role(role),
            })
    return out


async def _write_vlans(device_id: uuid.UUID, vlans: list[dict], ifvlans: list[dict]) -> None:
    async with AsyncSessionLocal() as db:
        for v in vlans:
            await db.execute(text("""
                INSERT INTO vlans (device_id, vlan_id, name, updated_at)
                VALUES (CAST(:did AS uuid), :vid, :name, NOW())
                ON CONFLICT (device_id, vlan_id) DO UPDATE SET
                    name = EXCLUDED.name, updated_at = NOW()
            """), {"did": str(device_id), "vid": v["vlan_id"], "name": v.get("name")})
        # Replace this device's interface_vlans atomically (mark-and-sweep).
        await db.execute(text("""
            DELETE FROM interface_vlans WHERE interface_id IN (
                SELECT id FROM interfaces WHERE device_id = CAST(:did AS uuid))
        """), {"did": str(device_id)})
        for iv in ifvlans:
            await db.execute(text("""
                INSERT INTO interface_vlans (interface_id, vlan_id, tagged)
                SELECT id, :vid, :tagged FROM interfaces
                WHERE device_id = CAST(:did AS uuid) AND name = :ifname
                ON CONFLICT (interface_id, vlan_id) DO UPDATE SET tagged = EXCLUDED.tagged
            """), {"did": str(device_id), "vid": iv["vlan_id"],
                   "tagged": iv["tagged"], "ifname": iv["if_name"]})
        await db.commit()


async def _write_stp(device_id: uuid.UUID, ports: list[dict]) -> None:
    if not ports:
        return
    async with AsyncSessionLocal() as db:
        for p in ports:
            await db.execute(text("""
                INSERT INTO interface_stp (interface_id, stp_state, stp_role, updated_at)
                SELECT id, :state, :role, NOW() FROM interfaces
                WHERE device_id = CAST(:did AS uuid) AND name = :ifname
                ON CONFLICT (interface_id) DO UPDATE SET
                    stp_state = EXCLUDED.stp_state, stp_role = EXCLUDED.stp_role, updated_at = NOW()
            """), {"did": str(device_id), "state": p["stp_state"],
                   "role": p["stp_role"], "ifname": p["if_name"]})
        await db.commit()


# ── MAC / ARP collection (AOS-CX REST) ────────────────────────────────────────

def _ref_name(value) -> Optional[str]:
    """Resolve an AOS-CX reference attribute to a name. Ports/interfaces come
    back either as a plain name string or a {"<name>": "/rest/.../<name>"} map."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for k in value:  # the key is the resource name (e.g. "1/1/1")
            return str(k)
    return None


async def _collect_addresses(client: "ArubaRestClient") -> tuple[list[dict], list[dict]]:
    """Collect ARP/ND neighbors and the MAC forwarding table from AOS-CX REST.

    Returns (arp, mac):
      arp = [{"ip": str, "mac": str, "if_name": str|None}]
      mac = [{"mac": str, "if_name": str|None, "vlan_id": int|None}]
    Field names are matched tolerantly across firmware variants. The remote
    collector does not poll ipNetToMedia/FDB, so REST is the only address-table
    source for collector-managed CX.
    """
    arp: list[dict] = []
    for vrf in ("default", "mgmt"):
        try:
            nbrs = await client.get(f"/system/vrfs/{vrf}/neighbors", depth=2)
        except Exception:
            continue
        if not isinstance(nbrs, dict):
            continue
        for key, obj in nbrs.items():
            o = obj if isinstance(obj, dict) else {}
            ip = o.get("ip_address") or o.get("ip") or (key.split(",")[0] if isinstance(key, str) else None)
            mac = o.get("mac") or o.get("mac_addr") or o.get("mac_address")
            if not ip or not mac:
                continue
            arp.append({
                "ip": str(ip),
                "mac": str(mac),
                "if_name": _ref_name(o.get("port") or o.get("mac_port") or o.get("interface")),
            })

    mac: list[dict] = []
    vlan_raw = await client.get("/system/vlans", depth=1)
    vlan_ids = list(vlan_raw.keys()) if isinstance(vlan_raw, dict) else []
    for vid in vlan_ids:
        try:
            macs = await client.get(f"/system/vlans/{vid}/macs", depth=2)
        except Exception:
            continue
        if not isinstance(macs, dict):
            continue
        try:
            vlan_id = int(vid)
        except (TypeError, ValueError):
            vlan_id = None
        for key, obj in macs.items():
            o = obj if isinstance(obj, dict) else {}
            mac_addr = o.get("mac_addr") or o.get("mac") or o.get("mac_address")
            if not mac_addr and isinstance(key, str):
                # entries are sometimes keyed by "<selector>,<mac>" or "<mac>"
                mac_addr = key.split(",")[-1]
            if not mac_addr or ":" not in str(mac_addr):
                continue
            mac.append({
                "mac": str(mac_addr),
                "if_name": _ref_name(o.get("port") or o.get("mac_port") or o.get("interface")),
                "vlan_id": vlan_id,
            })
    return arp, mac


async def _collect_inventory(client: "ArubaRestClient") -> Optional[str]:
    """Return the device serial number from AOS-CX subsystem product_info."""
    subs = await client.get("/system/subsystems", depth=2)
    if not isinstance(subs, dict):
        return None
    # Prefer the chassis subsystem; fall back to the first with a serial.
    ordered = sorted(subs.items(), key=lambda kv: 0 if str(kv[0]).startswith("chassis") else 1)
    for _key, obj in ordered:
        if not isinstance(obj, dict):
            continue
        pi = obj.get("product_info") or {}
        serial = pi.get("serial_number")
        if serial:
            return str(serial)
    return None


async def _write_addresses(device_id: uuid.UUID, arp: list[dict], mac: list[dict]) -> None:
    async with AsyncSessionLocal() as db:
        # ARP — upsert keyed by (device_id, ip), then sweep stale rows.
        for e in arp:
            await db.execute(text("""
                INSERT INTO arp_entries (device_id, ip_address, mac_address, interface_name, entry_type, updated_at)
                VALUES (CAST(:did AS uuid), CAST(:ip AS inet), CAST(:mac AS macaddr), :ifn, 'dynamic', NOW())
                ON CONFLICT (device_id, ip_address) DO UPDATE SET
                    mac_address = EXCLUDED.mac_address, interface_name = EXCLUDED.interface_name,
                    entry_type = EXCLUDED.entry_type, updated_at = NOW()
            """), {"did": str(device_id), "ip": e["ip"], "mac": e["mac"], "ifn": e.get("if_name")})
        if arp:
            await db.execute(text("""
                DELETE FROM arp_entries WHERE device_id = CAST(:did AS uuid)
                  AND updated_at < NOW() - INTERVAL '1 minute'
            """), {"did": str(device_id)})

        # MAC — upsert keyed by (device_id, mac), then sweep stale rows.
        for e in mac:
            await db.execute(text("""
                INSERT INTO mac_entries (device_id, mac_address, port_name, vlan_id, entry_type, updated_at)
                VALUES (CAST(:did AS uuid), CAST(:mac AS macaddr), :port, :vid, 'dynamic', NOW())
                ON CONFLICT (device_id, mac_address) DO UPDATE SET
                    port_name = EXCLUDED.port_name, vlan_id = EXCLUDED.vlan_id,
                    entry_type = EXCLUDED.entry_type, updated_at = NOW()
            """), {"did": str(device_id), "mac": e["mac"], "port": e.get("if_name"), "vid": e.get("vlan_id")})
        if mac:
            await db.execute(text("""
                DELETE FROM mac_entries WHERE device_id = CAST(:did AS uuid)
                  AND updated_at < NOW() - INTERVAL '1 minute'
            """), {"did": str(device_id)})
        await db.commit()


async def _write_inventory(device_id: uuid.UUID, serial: Optional[str]) -> None:
    if not serial:
        return
    async with AsyncSessionLocal() as db:
        await db.execute(text("""
            UPDATE devices SET serial_number = :sn
            WHERE id = CAST(:did AS uuid)
              AND (serial_number IS DISTINCT FROM :sn)
        """), {"did": str(device_id), "sn": serial})
        await db.commit()


async def _load_rest_target(device_id: uuid.UUID):
    """Return (host, username, password, hostname) for a hub-managed REST device,
    or None if it can't / shouldn't be collected by the hub."""
    from .. import crypto

    async with AsyncSessionLocal() as db:
        dev = (await db.execute(
            select(Device).where(Device.id == device_id, Device.is_active == True)  # noqa
        )).scalar_one_or_none()
        if dev is None:
            return None
        if not dev.rest_collection_enabled:
            return None
        if dev.collector_id is not None:
            # Device is assigned to a remote collector which handles REST
            # collection itself — the hub must not attempt to reach it directly.
            return None

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
            return None

        _, cred = cred_row
        cred_data = cred.data if isinstance(cred.data, dict) else json.loads(cred.data)
        if cred_data.get("password") and crypto.is_configured():
            try:
                cred_data["password"] = crypto.decrypt(cred_data["password"])
            except Exception:
                pass

    return (
        dev.mgmt_ip_str,
        cred_data.get("username", "admin"),
        cred_data.get("password", ""),
        dev.hostname,
    )


async def collect_device_rest_state(device_id: uuid.UUID) -> None:
    """Collect BGP + OSPF + VLAN + STP + MAC/ARP + serial for one device via REST."""
    target = await _load_rest_target(device_id)
    if target is None:
        return
    host, username, password, hostname = target
    dev = type("D", (), {"hostname": hostname})()  # minimal shim for log fields

    try:
        async with ArubaRestClient(host, username, password) as client:
            bgp_peers, ospf_nbrs, vlan_res, stp_ports, addr_res, serial = await asyncio.gather(
                _collect_bgp(client, device_id),
                _collect_ospf(client, device_id),
                _collect_vlans(client),
                _collect_stp(client),
                _collect_addresses(client),
                _collect_inventory(client),
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

        if isinstance(vlan_res, tuple):
            vlans, ifvlans = vlan_res
            if vlans:
                await _write_vlans(device_id, vlans, ifvlans)
                logger.info("rest_vlans_collected", device=dev.hostname,
                            vlans=len(vlans), memberships=len(ifvlans))

        if isinstance(stp_ports, list) and stp_ports:
            await _write_stp(device_id, stp_ports)
            logger.info("rest_stp_collected", device=dev.hostname, ports=len(stp_ports))

        if isinstance(addr_res, tuple):
            arp, mac = addr_res
            if arp or mac:
                await _write_addresses(device_id, arp, mac)
                logger.info("rest_addresses_collected", device=dev.hostname,
                            arp=len(arp), mac=len(mac))

        if isinstance(serial, str) and serial:
            await _write_inventory(device_id, serial)
            logger.info("rest_inventory_collected", device=dev.hostname, serial=serial)

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


def start_rest_state_collector(interval_s: int = 60) -> asyncio.Task:
    return asyncio.create_task(_rest_state_loop(interval_s), name="rest-routing-state")
