from __future__ import annotations

import math
from datetime import datetime, timezone, timedelta
from typing import Optional
from dataclasses import dataclass, field

import httpx
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

_VM_URL = "http://localhost:8428"


@dataclass
class Breach:
    """Represents a single metric breach for one device/interface."""
    device_id: str
    device_name: str
    interface_id: Optional[str] = None
    interface_name: Optional[str] = None
    value: Optional[float] = None       # current metric value
    extra: dict = field(default_factory=dict)


# ── Device selector ────────────────────────────────────────────────────────────

async def resolve_devices(db: AsyncSession, tenant_id: str, selector: Optional[dict]) -> list[dict]:
    """Return rows of {id, hostname, vendor, tags, polling_interval_s} matching the selector."""
    base = """
        SELECT id::text, hostname, vendor::text, tags, polling_interval_s,
               host(mgmt_ip) AS mgmt_ip, alert_exclusions
        FROM devices
        WHERE tenant_id = :tid AND is_active = true
    """
    params: dict = {"tid": tenant_id}

    if not selector:
        rows = (await db.execute(text(base), params)).mappings().all()
        return [dict(r) for r in rows]

    clauses, idx = [], 0

    if "device_ids" in selector and selector["device_ids"]:
        ids = selector["device_ids"]
        placeholders = ", ".join(f":did{i}" for i in range(len(ids)))
        clauses.append(f"id::text IN ({placeholders})")
        for i, did in enumerate(ids):
            params[f"did{i}"] = did

    if "vendors" in selector and selector["vendors"]:
        vs = selector["vendors"]
        placeholders = ", ".join(f":v{i}" for i in range(len(vs)))
        clauses.append(f"vendor::text IN ({placeholders})")
        for i, v in enumerate(vs):
            params[f"v{i}"] = v

    if "tags" in selector and selector["tags"]:
        # Use individual ? checks — asyncpg can't infer element type for ?| with a list param.
        tag_conds = []
        for tag in selector["tags"]:
            pname = f"tag_{len(params)}"
            tag_conds.append(f"tags ? :{pname}")
            params[pname] = tag
        clauses.append("(" + " OR ".join(tag_conds) + ")")

    where = " AND (" + " OR ".join(clauses) + ")" if clauses else ""
    rows = (await db.execute(text(base + where), params)).mappings().all()
    return [dict(r) for r in rows]


# ── Metric evaluators ──────────────────────────────────────────────────────────

async def eval_cpu(db: AsyncSession, device: dict, condition: str, threshold: float) -> Optional[Breach]:
    row = (await db.execute(
        text("SELECT cpu_util_pct FROM device_health_latest WHERE device_id = :did"),
        {"did": device["id"]},
    )).mappings().first()
    if not row or row["cpu_util_pct"] is None:
        return None
    val = float(row["cpu_util_pct"])
    if _check(val, condition, threshold):
        return Breach(device["id"], device["hostname"], value=val)
    return None


async def eval_mem(db: AsyncSession, device: dict, condition: str, threshold: float) -> Optional[Breach]:
    row = (await db.execute(
        text("SELECT mem_used_bytes, mem_total_bytes FROM device_health_latest WHERE device_id = :did"),
        {"did": device["id"]},
    )).mappings().first()
    if not row or not row["mem_total_bytes"]:
        return None
    pct = float(row["mem_used_bytes"] or 0) / float(row["mem_total_bytes"]) * 100
    if _check(pct, condition, threshold):
        return Breach(device["id"], device["hostname"], value=round(pct, 1))
    return None


async def eval_device_down(db: AsyncSession, device: dict) -> Optional[Breach]:
    """Fire if the device status is not 'up' or last_polled is stale.

    Stale threshold = 2.5× the device's own poll interval (minimum 90s).
    This prevents false positives on devices with longer poll intervals.
    """
    row = (await db.execute(
        text("SELECT status, last_polled FROM devices WHERE id = :did"),
        {"did": device["id"]},
    )).mappings().first()
    if not row:
        return None
    status = row["status"]
    last_polled = row["last_polled"]
    poll_interval = int(device.get("polling_interval_s") or 15)
    stale_seconds = max(90, int(poll_interval * 2.5))
    stale = (
        last_polled is None or
        (datetime.now(timezone.utc) - last_polled).total_seconds() > stale_seconds
    )
    if status != "up" or stale:
        return Breach(device["id"], device["hostname"], extra={"status": status, "stale": stale})
    return None


async def eval_interface_down(db: AsyncSession, device: dict) -> list[Breach]:
    """Return one breach per interface that is admin-up but oper-down."""
    rows = (await db.execute(
        text("""
            SELECT id::text, name, oper_status, admin_status
            FROM interfaces
            WHERE device_id = :did
              AND admin_status = 'up'
              AND oper_status = 'down'
        """),
        {"did": device["id"]},
    )).mappings().all()
    return [
        Breach(device["id"], device["hostname"], interface_id=r["id"], interface_name=r["name"])
        for r in rows
    ]


async def eval_uptime(db: AsyncSession, device: dict, condition: str, threshold: float) -> Optional[Breach]:
    """Alert when uptime is below threshold seconds (device recently rebooted)."""
    row = (await db.execute(
        text("SELECT uptime_seconds FROM device_health_latest WHERE device_id = :did"),
        {"did": device["id"]},
    )).mappings().first()
    if not row or row["uptime_seconds"] is None:
        return None
    val = float(row["uptime_seconds"])
    if _check(val, condition, threshold):
        hours = round(val / 3600, 1)
        return Breach(device["id"], device["hostname"], value=val,
                      extra={"uptime_hours": hours})
    return None


async def eval_temperature(db: AsyncSession, device: dict, threshold: float) -> Optional[Breach]:
    """Alert when any temperature sensor exceeds threshold °C."""
    row = (await db.execute(
        text("SELECT temperatures FROM device_health_latest WHERE device_id = :did"),
        {"did": device["id"]},
    )).mappings().first()
    if not row or not row["temperatures"]:
        return None
    temps = row["temperatures"]
    if isinstance(temps, str):
        import json
        try: temps = json.loads(temps)
        except Exception: return None
    hottest = max((t.get("celsius", 0) for t in temps), default=0)
    if hottest > threshold:
        return Breach(device["id"], device["hostname"], value=hottest,
                      extra={"threshold": threshold})
    return None


async def eval_interface_errors(db: AsyncSession, device: dict, threshold: float) -> list[Breach]:
    """Alert on interfaces accumulating errors faster than threshold per 5-minute window.

    Error counters are stored in VictoriaMetrics (anthrimon_if_in/out_errors_total).
    Uses increase() over 5m so a counter reset (reboot) doesn't create false positives.
    """
    device_id = device["id"]
    query = (
        f'increase(anthrimon_if_in_errors_total{{device_id="{device_id}"}}[5m])'
        f' + increase(anthrimon_if_out_errors_total{{device_id="{device_id}"}}[5m])'
    )
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{_VM_URL}/api/v1/query", params={"query": query})
            resp.raise_for_status()
            results = resp.json().get("data", {}).get("result", [])
    except Exception:
        return []

    breaches: list[Breach] = []
    for r in results:
        val = float(r.get("value", [0, 0])[1] or 0)
        if val <= threshold:
            continue
        if_name = r["metric"].get("if_name", "")
        # Look up the interface row for its UUID
        iface_row = (await db.execute(
            text("SELECT id::text FROM interfaces WHERE device_id = :did AND name = :name LIMIT 1"),
            {"did": device_id, "name": if_name},
        )).first()
        breaches.append(Breach(
            device_id, device["hostname"],
            interface_id=iface_row[0] if iface_row else None,
            interface_name=if_name,
            value=val,
        ))
    return breaches


async def eval_interface_util(db: AsyncSession, device: dict, threshold: float) -> list[Breach]:
    """Alert when any interface's bandwidth utilisation (in OR out) exceeds threshold %.

    Uses VictoriaMetrics rate(octets[5m]) * 8 / speed_bps * 100 per interface.
    Falls back gracefully — returns [] if VM is unreachable or device has no speed data.
    """
    device_id = device["id"]
    # Compute utilisation % = (rate of octets * 8 bits) / link_speed * 100
    # Use max(in, out) so a single threshold covers both directions.
    # Only evaluate interfaces that have a known non-zero speed (> 0).
    # Dividing by a zero-speed interface produces Infinity which causes false positives.
    speed_filter = f'anthrimon_if_speed_bps{{device_id="{device_id}"}} > 0'
    query = (
        f'max by (if_index, if_name) ('
        f'  clamp_min(rate(anthrimon_if_in_octets_total{{device_id="{device_id}"}}[5m]) * 8'
        f'    / on(if_index) group_left() ({speed_filter}) * 100, 0)'
        f') or max by (if_index, if_name) ('
        f'  clamp_min(rate(anthrimon_if_out_octets_total{{device_id="{device_id}"}}[5m]) * 8'
        f'    / on(if_index) group_left() ({speed_filter}) * 100, 0)'
        f')'
    )
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{_VM_URL}/api/v1/query", params={"query": query})
            resp.raise_for_status()
            results = resp.json().get("data", {}).get("result", [])
    except Exception:
        return []

    breaches: list[Breach] = []
    seen_if_indexes: set[str] = set()
    for r in results:
        val = float(r.get("value", [0, 0])[1] or 0)
        if not math.isfinite(val) or val < threshold:
            continue
        if_index = r["metric"].get("if_index", "")
        # Deduplicate — the `or` can produce two rows per interface
        if if_index in seen_if_indexes:
            continue
        seen_if_indexes.add(if_index)
        if_name = r["metric"].get("if_name", "")
        iface_row = (await db.execute(
            text("SELECT id::text FROM interfaces WHERE device_id = :did AND name = :name LIMIT 1"),
            {"did": device_id, "name": if_name},
        )).first()
        breaches.append(Breach(
            device_id, device["hostname"],
            interface_id=iface_row[0] if iface_row else None,
            interface_name=if_name,
            value=round(val, 1),
            extra={"threshold_pct": threshold},
        ))
    return breaches


async def eval_custom_oid(db: AsyncSession, device: dict, oid: str,
                           condition: str, threshold: float) -> Optional[Breach]:
    """Query an arbitrary SNMP OID and compare its value to the threshold."""
    # Fetch the device's primary SNMP credential
    cred_row = (await db.execute(
        text("""
            SELECT c.type::text, c.data::text
            FROM device_credentials dc
            JOIN credentials c ON c.id = dc.credential_id
            WHERE dc.device_id = :did
              AND c.type IN ('snmp_v2c','snmp_v3')
            ORDER BY dc.priority ASC
            LIMIT 1
        """),
        {"did": device["id"]},
    )).mappings().first()
    if not cred_row:
        return None

    import json as _json
    cred_data = _json.loads(cred_row["data"])
    cred_type = cred_row["type"]

    try:
        if cred_type == "snmp_v2c":
            from pysnmp.hlapi.v3arch.asyncio import (
                CommunityData, ContextData, ObjectIdentity, ObjectType,
                SnmpEngine, UdpTransportTarget, get_cmd,
            )
            engine = SnmpEngine()
            transport = await UdpTransportTarget.create(
                (device["mgmt_ip"] if "mgmt_ip" in device else device["id"], 161),
                timeout=5, retries=0,
            )
            it = get_cmd(engine, CommunityData(cred_data.get("community", "public"), mpModel=1),
                         transport, ContextData(), ObjectType(ObjectIdentity(oid)))
        else:
            from pysnmp.hlapi.v3arch.asyncio import (
                ContextData, ObjectIdentity, ObjectType, SnmpEngine,
                UdpTransportTarget, UsmUserData, get_cmd,
            )
            import pysnmp.hlapi.v3arch.asyncio as hlapi
            _AUTH = {"md5": "usmHMACMD5AuthProtocol", "sha": "usmHMACSHAAuthProtocol",
                     "sha256": "usmHMAC192SHA256AuthProtocol", "sha512": "usmHMAC384SHA512AuthProtocol"}
            _PRIV = {"des": "usmDESPrivProtocol", "aes": "usmAesCfb128Protocol",
                     "aes192": "usmAesCfb192Protocol", "aes256": "usmAesCfb256Protocol"}
            auth_proto = getattr(hlapi, _AUTH.get(cred_data.get("auth_protocol","sha256").lower(), "usmHMAC192SHA256AuthProtocol"))
            priv_proto = getattr(hlapi, _PRIV.get(cred_data.get("priv_protocol","aes").lower(), "usmAesCfb128Protocol"))
            engine = SnmpEngine()
            transport = await UdpTransportTarget.create(
                (device.get("mgmt_ip", device["id"]), 161), timeout=5, retries=0,
            )
            it = get_cmd(engine,
                         UsmUserData(cred_data["username"],
                                     authKey=cred_data.get("auth_key",""),
                                     privKey=cred_data.get("priv_key",""),
                                     authProtocol=auth_proto, privProtocol=priv_proto),
                         transport, ContextData(), ObjectType(ObjectIdentity(oid)))

        err_ind, err_status, _, vbs = await it
        if err_ind or err_status or not vbs:
            return None
        raw = str(vbs[0][1])
        try:
            val = float(raw)
        except ValueError:
            return None
        if _check(val, condition, threshold):
            return Breach(device["id"], device["hostname"], value=val,
                          extra={"oid": oid, "raw": raw})
    except Exception:
        pass
    return None


async def eval_interface_flap(db: AsyncSession, device: dict, threshold: float, window_seconds: int) -> list[Breach]:
    """Return one breach per interface with > threshold state changes in the last window_seconds."""
    rows = (await db.execute(
        text("""
            SELECT i.id::text, i.name, COUNT(*) AS changes
            FROM interface_status_log l
            JOIN interfaces i ON i.id = l.interface_id
            WHERE i.device_id = :did
              AND l.recorded_at >= NOW() - INTERVAL '1 second' * :window
            GROUP BY i.id, i.name
            HAVING COUNT(*) > :thresh
        """),
        {"did": device["id"], "window": window_seconds, "thresh": int(threshold)},
    )).mappings().all()
    return [
        Breach(device["id"], device["hostname"],
               interface_id=r["id"], interface_name=r["name"],
               value=float(r["changes"]))
        for r in rows
    ]


async def eval_ospf_state(db: AsyncSession, device: dict) -> Optional[Breach]:
    """Fire if any OSPF neighbor is not in full state.

    States that trigger: down, attempt, init, two_way, exstart, exchange, loading.
    'unknown' is ignored (no data yet). 'full' is the only healthy state.
    """
    row = (await db.execute(
        text("""
            SELECT neighbor_router_id::text, neighbor_ip::text, state
            FROM ospf_neighbors
            WHERE device_id = :did
              AND state NOT IN ('full', 'unknown')
            ORDER BY
                CASE state
                    WHEN 'down'     THEN 1
                    WHEN 'init'     THEN 2
                    WHEN 'attempt'  THEN 3
                    WHEN 'exstart'  THEN 4
                    WHEN 'exchange' THEN 5
                    WHEN 'loading'  THEN 6
                    WHEN 'two_way'  THEN 7
                    ELSE 8
                END
            LIMIT 1
        """),
        {"did": device["id"]},
    )).mappings().first()
    if not row:
        return None
    neighbor = row["neighbor_router_id"] or row["neighbor_ip"] or "unknown"
    return Breach(
        device["id"], device["hostname"],
        extra={"neighbor": neighbor, "ospf_state": row["state"]},
    )


async def eval_flow_bandwidth(
    device: dict, custom_oid: str, threshold: float
) -> Optional[Breach]:
    """Alert when flow bandwidth for a device (optionally filtered by src/dst IP or protocol)
    exceeds threshold bytes/s, averaged over the last 5 minutes."""
    import json as _json
    import httpx as _httpx

    try:
        filt = _json.loads(custom_oid) if custom_oid else {}
    except Exception:
        filt = {}

    device_id = device["id"]
    clauses = [
        f"collector_device_id = toUUID('{device_id}')",
        "minute >= now() - INTERVAL 5 MINUTE",
    ]
    if filt.get("src_ip"):
        clauses.append(f"src_ip = toIPv4('{filt['src_ip']}')")
    if filt.get("dst_ip"):
        clauses.append(f"dst_ip = toIPv4('{filt['dst_ip']}')")
    if filt.get("protocol"):
        clauses.append(f"ip_protocol = {int(filt['protocol'])}")

    query = (
        f"SELECT sum(bytes_total) / (5 * 60) AS bps "
        f"FROM flow_agg_1min WHERE {' AND '.join(clauses)}"
    )
    try:
        async with _httpx.AsyncClient(timeout=5) as client:
            resp = await client.post(
                "http://localhost:8123",
                content=query + " FORMAT JSON",
                headers={"Content-Type": "text/plain"},
            )
        rows = resp.json().get("data", [])
        bps = float(rows[0]["bps"]) if rows else 0.0
    except Exception:
        return None

    if bps <= threshold:
        return None

    desc_parts = []
    if filt.get("src_ip"): desc_parts.append(f"src {filt['src_ip']}")
    if filt.get("dst_ip"): desc_parts.append(f"dst {filt['dst_ip']}")
    if filt.get("protocol"): desc_parts.append(f"proto {filt['protocol']}")
    extra: dict = {"flow_filter": " ".join(desc_parts) if desc_parts else "all traffic"}
    return Breach(device["id"], device["hostname"], value=bps, extra=extra)


async def eval_syslog_match(
    device: dict, custom_oid: str, threshold: float, duration_seconds: int
) -> Optional[Breach]:
    """Alert when syslog messages matching a regex pattern exceed a count threshold."""
    import json as _json
    import httpx as _httpx

    try:
        filt = _json.loads(custom_oid) if custom_oid else {}
    except Exception:
        filt = {}

    pattern = filt.get("pattern", "").strip()
    if not pattern:
        return None

    minutes  = max(1, duration_seconds // 60)
    did      = device["id"]
    esc_pat  = pattern.replace("'", "\\'")

    clauses = [
        f"device_id = toUUID('{did}')",
        f"ts >= now() - INTERVAL {minutes} MINUTE",
        f"match(message, '{esc_pat}')",
    ]
    if filt.get("program"):
        clauses.append(f"program = '{filt['program']}'")
    if filt.get("severity_max") is not None:
        clauses.append(f"severity <= {int(filt['severity_max'])}")

    where = " AND ".join(clauses)

    try:
        async with _httpx.AsyncClient(timeout=5) as client:
            # Count
            cnt_resp = await client.post(
                "http://localhost:8123",
                content=f"SELECT count() AS n FROM syslog_messages WHERE {where} FORMAT JSON",
                headers={"Content-Type": "text/plain"},
            )
            cnt_data = cnt_resp.json().get("data", [])
            count = int(cnt_data[0]["n"]) if cnt_data else 0

            if count < threshold:
                return None

            # Grab the most recent matching message for the alert title/context
            msg_resp = await client.post(
                "http://localhost:8123",
                content=(
                    f"SELECT program, message FROM syslog_messages "
                    f"WHERE {where} ORDER BY ts DESC LIMIT 1 FORMAT JSON"
                ),
                headers={"Content-Type": "text/plain"},
            )
            msg_rows = msg_resp.json().get("data", [])
            latest   = msg_rows[0] if msg_rows else {}
    except Exception:
        return None

    return Breach(
        device["id"], device["hostname"],
        value=float(count),
        extra={
            "syslog_pattern": pattern,
            "syslog_program": latest.get("program", ""),
            "syslog_message": latest.get("message", "")[:200],
        },
    )


async def fetch_syslog_context(device_id: str, count: int = 5) -> list[dict]:
    """Fetch the most recent syslog messages for a device to annotate an alert."""
    import httpx as _httpx
    try:
        async with _httpx.AsyncClient(timeout=3) as client:
            resp = await client.post(
                "http://localhost:8123",
                content=(
                    f"SELECT toUnixTimestamp(ts)*1000 AS ts_ms, severity, program, message "
                    f"FROM syslog_messages "
                    f"WHERE device_id = toUUID('{device_id}') "
                    f"  AND ts >= now() - INTERVAL 10 MINUTE "
                    f"ORDER BY ts DESC LIMIT {count} FORMAT JSON"
                ),
                headers={"Content-Type": "text/plain"},
            )
        rows = resp.json().get("data", [])
        return [
            {
                "ts_ms":    int(r["ts_ms"]),
                "severity": int(r["severity"]),
                "program":  r["program"],
                "message":  r["message"],
            }
            for r in rows
        ]
    except Exception:
        return []


async def eval_bgp_session_down(db: AsyncSession, device: dict) -> list[Breach]:
    """Alert when any BGP session with admin_status=start is not established."""
    rows = (await db.execute(
        text(
            "SELECT peer_ip::text, peer_asn, local_asn, session_state "
            "FROM bgp_sessions "
            "WHERE device_id = :did "
            "  AND admin_status = 'start' "
            "  AND session_state != 'established' "
            "  AND session_state != 'unknown'"
        ),
        {"did": device["id"]},
    )).mappings().all()

    return [
        Breach(device["id"], device["hostname"], extra={
            "peer_ip":       row["peer_ip"],
            "peer_asn":      row["peer_asn"],
            "local_asn":     row["local_asn"],
            "session_state": row["session_state"],
        })
        for row in rows
    ]


async def eval_bgp_session_flapping(
    db: AsyncSession, device: dict, threshold: int = 3, window_minutes: int = 60
) -> list[Breach]:
    """Alert when a BGP session has flapped >= threshold times in the last window_minutes."""
    rows = (await db.execute(
        text("""
            SELECT s.peer_ip::text, s.peer_asn, s.local_asn, s.session_state,
                   COUNT(e.id) AS flap_count
            FROM bgp_sessions s
            JOIN bgp_session_events e ON e.session_id = s.id
            WHERE s.device_id = :did
              AND e.recorded_at >= NOW() - INTERVAL ':window minutes'
            GROUP BY s.id, s.peer_ip, s.peer_asn, s.local_asn, s.session_state
            HAVING COUNT(e.id) >= :threshold
        """),
        {"did": device["id"], "window": window_minutes, "threshold": threshold},
    )).mappings().all()

    return [
        Breach(device["id"], device["hostname"], extra={
            "peer_ip":       row["peer_ip"],
            "peer_asn":      row["peer_asn"],
            "session_state": row["session_state"],
            "flap_count":    int(row["flap_count"]),
            "window_minutes": window_minutes,
        })
        for row in rows
    ]


async def eval_route_missing(db: AsyncSession, device: dict, prefix: str) -> list[Breach]:
    """Alert when a specific route prefix is absent from route_entries for this device."""
    result = await db.execute(
        text("SELECT id FROM route_entries WHERE device_id = :did AND destination = :prefix LIMIT 1"),
        {"did": device["id"], "prefix": prefix},
    )
    if result.first() is None:
        return [Breach(device["id"], device["hostname"], extra={"prefix": prefix})]
    return []


# ── Helpers ────────────────────────────────────────────────────────────────────

def _check(value: float, condition: str, threshold: float) -> bool:
    if condition == "gt":
        return value > threshold
    if condition == "lt":
        return value < threshold
    if condition == "gte":
        return value >= threshold
    if condition == "lte":
        return value <= threshold
    return False
