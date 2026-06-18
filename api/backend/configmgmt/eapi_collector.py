"""
Arista eAPI IS-IS collector.

Queries 'show isis neighbors' and 'show isis summary' via the Arista
eAPI JSON-RPC endpoint for devices that have arista_eapi enabled and
reachable, writing results into the isis_neighbors table used by the
SNMP path so the existing UI and alerting work unchanged.
"""
from __future__ import annotations

import asyncio
import time
import uuid
from datetime import datetime, timezone
from typing import Optional

import httpx
import structlog
from sqlalchemy import text

from ..database import AsyncSessionLocal

logger = structlog.get_logger(__name__)


# ── eAPI client ───────────────────────────────────────────────────────────────

async def _eapi_call(host: str, username: str, password: str,
                     commands: list[str]) -> list[dict]:
    """Run eAPI JSON-RPC commands. Returns the result list."""
    payload = {
        "jsonrpc": "2.0",
        "method":  "runCmds",
        "params":  {"format": "json", "cmds": commands, "version": 1},
        "id":      "1",
    }
    async with httpx.AsyncClient(verify=False, timeout=15) as client:
        for scheme in ("https", "http"):
            try:
                r = await client.post(
                    f"{scheme}://{host}/command-api",
                    json=payload,
                    auth=(username, password),
                )
                r.raise_for_status()
                data = r.json()
                if "error" in data:
                    raise RuntimeError(f"eAPI error: {data['error']}")
                return data["result"]
            except (httpx.ConnectError, httpx.ConnectTimeout):
                continue
    raise RuntimeError(f"eAPI unreachable on {host}")


# ── Normalisers ───────────────────────────────────────────────────────────────

def _isis_adj_state(raw: str) -> str:
    return {"up": "up", "down": "down", "init": "initializing",
            "initializing": "initializing", "failed": "failed"}.get(raw.lower(), "unknown")


def _isis_level(raw: str) -> str:
    return {"level-1": "level-1", "level-2": "level-2",
            "level-1-2": "level-1-2"}.get(raw.lower(), raw.lower())


# ── Parse eAPI response ───────────────────────────────────────────────────────

def _parse_isis_neighbors(device_id: uuid.UUID, result: list[dict]) -> list[dict]:
    """
    Parse [show isis neighbors, show isis summary] eAPI results into
    flat dicts ready for upsert into isis_neighbors.
    """
    rows: list[dict] = []
    now_ts = time.time()

    neighbors_result = result[0] if result else {}

    for _vrf, vrf_data in neighbors_result.get("vrfs", {}).items():
        for instance, inst_data in vrf_data.get("isisInstances", {}).items():
            for sys_id, nbr_data in inst_data.get("neighbors", {}).items():
                for adj in nbr_data.get("adjacencies", []):
                    details   = adj.get("details", {})
                    state_raw = adj.get("state", "unknown")
                    state     = _isis_adj_state(state_raw)

                    state_changed = details.get("stateChanged")
                    uptime = int(now_ts - state_changed) if state == "up" and state_changed else None
                    last_change = (datetime.fromtimestamp(state_changed, tz=timezone.utc)
                                   if state_changed else None)

                    ipv4 = details.get("ip4Address") or None
                    ipv6 = details.get("ip6Address") or None

                    rows.append({
                        "device_id":      device_id,
                        "instance":       instance,
                        "sys_id":         sys_id,
                        "hostname":       adj.get("hostname"),
                        "interface_name": adj.get("interfaceName"),
                        "circuit_type":   _isis_level(adj.get("level", "")),
                        "adj_state":      state,
                        "ipv4_address":   ipv4,
                        "ipv6_address":   ipv6,
                        "uptime_seconds": uptime,
                        "last_state_change": last_change,
                    })

    return rows


# ── DB writer ─────────────────────────────────────────────────────────────────

async def _write_isis_neighbors(device_id: uuid.UUID, rows: list[dict]) -> None:
    now = datetime.now(timezone.utc)

    async with AsyncSessionLocal() as db:
        # Snapshot current state so orphan-marking knows which adjacencies
        # were previously up.
        prev_rows = (await db.execute(text("""
            SELECT instance, sys_id, interface_name, adjacency_state::text
              FROM isis_neighbors WHERE device_id = :did
        """), {"did": str(device_id)})).all()
        prev = {(r[0], r[1], r[2]): r[3] for r in prev_rows}

        # Upsert active adjacencies FIRST so they are at their real state
        # before orphan-marking runs — eliminates the race window.
        for r in rows:
            await db.execute(text("""
                INSERT INTO isis_neighbors
                    (device_id, instance, sys_id, hostname, interface_name,
                     circuit_type, adjacency_state, ipv4_address, ipv6_address,
                     uptime_seconds, last_state_change, updated_at)
                VALUES
                    (:device_id, :instance, :sys_id, :hostname, :interface_name,
                     :circuit_type, CAST(:adj_state AS isis_adj_state),
                     CAST(:ipv4 AS inet), CAST(:ipv6 AS inet),
                     :uptime, :last_change, :now)
                ON CONFLICT (device_id, instance, sys_id, interface_name) DO UPDATE SET
                    hostname          = EXCLUDED.hostname,
                    circuit_type      = EXCLUDED.circuit_type,
                    adjacency_state   = EXCLUDED.adjacency_state,
                    ipv4_address      = EXCLUDED.ipv4_address,
                    ipv6_address      = EXCLUDED.ipv6_address,
                    uptime_seconds    = EXCLUDED.uptime_seconds,
                    last_state_change = EXCLUDED.last_state_change,
                    updated_at        = EXCLUDED.updated_at
            """), {
                "device_id":     str(device_id),
                "instance":      r["instance"],
                "sys_id":        r["sys_id"],
                "hostname":      r["hostname"],
                "interface_name": r["interface_name"] or "",
                "circuit_type":  r["circuit_type"],
                "adj_state":     r["adj_state"],
                "ipv4":          r["ipv4_address"],
                "ipv6":          r["ipv6_address"],
                "uptime":        r["uptime_seconds"],
                "last_change":   r["last_state_change"],
                "now":           now,
            })

        # Mark adjacencies absent from this poll as down. Runs after the
        # upsert so active adjacencies are already at their correct state.
        seen_keys = {(r["instance"], r["sys_id"], r["interface_name"] or "") for r in rows}
        for (instance, sys_id, iface), state in prev.items():
            if (instance, sys_id, iface) not in seen_keys and state != "down":
                await db.execute(text("""
                    UPDATE isis_neighbors
                       SET adjacency_state = 'down',
                           last_state_change = :now, updated_at = :now
                     WHERE device_id = :did
                       AND instance = :instance
                       AND sys_id = :sys_id
                       AND interface_name = :iface
                       AND adjacency_state != 'down'
                """), {"did": str(device_id), "instance": instance,
                       "sys_id": sys_id, "iface": iface, "now": now})

        await db.commit()


# ── Per-device collection ─────────────────────────────────────────────────────

async def collect_device_eapi_isis(device_id: uuid.UUID, host: str,
                                   username: str, password: str) -> int:
    """Collect IS-IS neighbors for one device. Returns number of adjacencies."""
    try:
        result = await _eapi_call(host, username, password,
                                  ["show isis neighbors", "show isis summary"])
        rows = _parse_isis_neighbors(device_id, result)
        await _write_isis_neighbors(device_id, rows)
        logger.info("eapi_isis_collected", device_id=str(device_id),
                    host=host, adjacencies=len(rows))
        return len(rows)
    except Exception as exc:
        logger.warning("eapi_isis_failed", device_id=str(device_id),
                       host=host, error=str(exc))
        return 0


# ── Sweep all eligible Arista devices ────────────────────────────────────────

async def _collect_eapi_isis_all() -> None:
    """
    Find all Arista devices with arista_eapi reachable, load their SSH
    credentials (used for eAPI basic auth), and collect IS-IS.
    """
    from .. import crypto
    import json as _json

    async with AsyncSessionLocal() as db:
        rows = (await db.execute(text("""
            SELECT
                d.id::text         AS device_id,
                d.mgmt_ip::text    AS mgmt_ip,
                c.data             AS cred_data
            FROM devices d
            JOIN device_api_methods dam ON dam.device_id = d.id
            JOIN device_credentials dc  ON dc.device_id  = d.id
            JOIN credentials c          ON c.id = dc.credential_id
            WHERE d.is_active     = true
              AND d.vendor        = 'arista'
              AND dam.method      = 'arista_eapi'
              AND dam.enabled     = true
              AND dam.reachable   = true
              AND c.type          = 'ssh'
              AND d.collector_id IS NULL
            ORDER BY dc.priority
        """))).all()

    seen: set[str] = set()
    tasks = []
    for row in rows:
        did = row[0]
        if did in seen:
            continue
        seen.add(did)

        host = row[1].split("/")[0]
        cred_raw = row[2]
        cred = cred_raw if isinstance(cred_raw, dict) else _json.loads(cred_raw)
        if cred.get("password") and crypto.is_configured():
            try:
                cred["password"] = crypto.decrypt(cred["password"])
            except Exception:
                pass

        tasks.append(collect_device_eapi_isis(
            uuid.UUID(did), host, cred.get("username", ""), cred.get("password", "")
        ))

    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


# ── Background loop ───────────────────────────────────────────────────────────

async def _eapi_isis_loop(interval_s: int) -> None:
    while True:
        try:
            await _collect_eapi_isis_all()
        except Exception:
            logger.exception("eapi_isis_loop_error")
        await asyncio.sleep(interval_s)


def start_eapi_isis_collector(interval_s: int = 60) -> asyncio.Task:
    return asyncio.create_task(_eapi_isis_loop(interval_s), name="eapi-isis-collector")
