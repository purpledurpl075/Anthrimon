from __future__ import annotations

import ipaddress
from typing import Optional

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import (
    get_db, get_current_principal, Principal,
    _tenant_device_ids, _assert_device_in_tenant,
)
from ..models.device import Device
from ..models.interface import Interface
from ..alerting.settings import load_platform_defaults
from ..intel import enrich_ips, get_intel, is_private

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/flow", tags=["flow"])

from ..services.urls import ch_url

PROTO_NAMES: dict[int, str] = {
    1: "ICMP", 2: "IGMP", 6: "TCP", 17: "UDP", 41: "IPv6",
    47: "GRE", 50: "ESP", 51: "AH", 58: "ICMPv6", 89: "OSPF",
    103: "PIM", 112: "VRRP", 132: "SCTP",
}


# ── ClickHouse helper ─────────────────────────────────────────────────────────

async def _ch(query: str) -> list[dict]:
    """Execute a ClickHouse query via HTTP and return rows as dicts."""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                ch_url(),
                content=query + " FORMAT JSON",
                headers={"Content-Type": "text/plain"},
            )
        resp.raise_for_status()
        return resp.json().get("data", [])
    except Exception as exc:
        logger.error("clickhouse_query_failed", error=str(exc), query=query[:200])
        raise HTTPException(status_code=503, detail="Flow data unavailable") from exc


# ── Tenant device helpers ─────────────────────────────────────────────────────

def _device_filter(device_ids: list[str], alias: str = "") -> str:
    """Build a ClickHouse WHERE clause fragment for device ID filtering.
    Each ID is parsed through uuid.UUID() before interpolation, so malformed
    strings raise ValueError before they can reach the query string."""
    import uuid as _uuid
    col = f"{alias}.collector_device_id" if alias else "collector_device_id"
    ids = ", ".join(f"toUUID('{_uuid.UUID(d)}')" for d in device_ids)
    return f"{col} IN ({ids})"


def _ip_version(ip: str) -> int:
    """Return 4 or 6, or raise 400 for invalid input."""
    try:
        return ipaddress.ip_address(ip).version
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid IP address: {ip}")


def _ip_filter(prefix: str, ip: str) -> str:
    """Return a WHERE clause fragment filtering on src or dst IP (v4 or v6).

    prefix must be 'src' or 'dst'.
    """
    ver = _ip_version(ip)
    if ver == 4:
        return f"{prefix}_ip = toIPv4('{ip}')"
    return f"{prefix}_ip6 = toIPv6('{ip}')"


def _ip_display(v4_col: str, v6_col: str) -> str:
    """ClickHouse expression: return IPv6 string when present, else IPv4 string."""
    return f"if({v6_col} != '::', IPv6NumToString({v6_col}), IPv4NumToString({v4_col}))"


# IPv4 and IPv6 private / non-routable ranges used by direction_summary.
_PRIVATE_RANGES_V4 = [
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
    "127.0.0.0/8", "169.254.0.0/16", "100.64.0.0/10",
]
_PRIVATE_RANGES_V6 = [
    "::1/128",     # loopback
    "fe80::/10",   # link-local
    "fc00::/7",    # unique local (ULA)
    "ff00::/8",    # multicast
]


def _private_clause(v4_col: str, v6_col: str | None = None) -> str:
    """Return a ClickHouse expression that is true when the address is private/internal.

    Handles both the IPv4 column and, when a v6_col is supplied, the IPv6 column.
    """
    v4_parts = " OR ".join(
        f"isIPAddressInRange(IPv4NumToString({v4_col}), '{r}')"
        for r in _PRIVATE_RANGES_V4
    )
    if v6_col is None:
        return f"({v4_parts})"
    v6_parts = " OR ".join(
        f"isIPAddressInRange(IPv6NumToString({v6_col}), '{r}')"
        for r in _PRIVATE_RANGES_V6
    )
    return f"(({v4_parts}) OR ({v6_parts}))"


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/summary", summary="Flow totals for the selected window")
async def flow_summary(
    device_id:      Optional[str] = Query(default=None),
    minutes:        int           = Query(default=60, ge=1, le=10080),
    principal:       Principal     = Depends(get_current_principal),
    db:             AsyncSession  = Depends(get_db),
) -> dict:
    if device_id:
        await _assert_device_in_tenant(device_id, principal, db)
        device_ids = [device_id]
    else:
        device_ids = await _tenant_device_ids(principal, db)

    if not device_ids:
        return {"bytes_total": 0, "packets_total": 0, "flows_total": 0,
                "unique_src_ips": 0, "unique_dst_ips": 0, "active_exporters": 0}

    rows = await _ch(f"""
        SELECT
            sum(bytes_total)          AS bytes_total,
            sum(packets_total)        AS packets_total,
            sum(flow_count)           AS flows_total,
            uniq(src_addr)            AS unique_src_ips,
            uniq(dst_addr)            AS unique_dst_ips,
            uniq(collector_device_id) AS active_exporters
        FROM (
            SELECT collector_device_id,
                   IPv4NumToString(src_ip) AS src_addr,
                   IPv4NumToString(dst_ip) AS dst_addr,
                   bytes_total, packets_total, flow_count
            FROM flow_agg_1min
            WHERE {_device_filter(device_ids)}
              AND minute >= now() - INTERVAL {minutes} MINUTE
            UNION ALL
            SELECT collector_device_id,
                   IPv6NumToString(src_ip6) AS src_addr,
                   IPv6NumToString(dst_ip6) AS dst_addr,
                   bytes_total, packets_total, flow_count
            FROM flow_agg6_1min
            WHERE {_device_filter(device_ids)}
              AND minute >= now() - INTERVAL {minutes} MINUTE
        )
    """)
    if not rows:
        return {"bytes_total": 0, "packets_total": 0, "flows_total": 0,
                "unique_src_ips": 0, "unique_dst_ips": 0, "active_exporters": 0}
    r = rows[0]
    return {
        "bytes_total":      int(r.get("bytes_total", 0)),
        "packets_total":    int(r.get("packets_total", 0)),
        "flows_total":      int(r.get("flows_total", 0)),
        "unique_src_ips":   int(r.get("unique_src_ips", 0)),
        "unique_dst_ips":   int(r.get("unique_dst_ips", 0)),
        "active_exporters": int(r.get("active_exporters", 0)),
    }


@router.get("/top-talkers", summary="Top src/dst IP pairs by bytes")
async def top_talkers(
    device_id:      Optional[str] = Query(default=None),
    minutes:        int           = Query(default=60,  ge=1, le=10080),
    limit:          int           = Query(default=20,  ge=1, le=100),
    protocol:       Optional[int] = Query(default=None, description="IANA protocol number"),
    principal:       Principal     = Depends(get_current_principal),
    db:             AsyncSession  = Depends(get_db),
) -> list[dict]:
    if device_id:
        await _assert_device_in_tenant(device_id, principal, db)
        device_ids = [device_id]
    else:
        device_ids = await _tenant_device_ids(principal, db)

    if not device_ids:
        return []

    proto_clause = f"AND ip_protocol = {protocol}" if protocol is not None else ""
    dev_filter   = _device_filter(device_ids)

    rows = await _ch(f"""
        SELECT
            src_addr        AS src_ip,
            dst_addr        AS dst_ip,
            ip_protocol,
            sum(bytes_total)   AS bytes_total,
            sum(packets_total) AS packets_total,
            sum(flow_count)    AS flow_count
        FROM (
            SELECT IPv4NumToString(src_ip) AS src_addr,
                   IPv4NumToString(dst_ip) AS dst_addr,
                   ip_protocol, bytes_total, packets_total, flow_count
            FROM flow_agg_1min
            WHERE {dev_filter}
              AND minute >= now() - INTERVAL {minutes} MINUTE
              {proto_clause}
            UNION ALL
            SELECT IPv6NumToString(src_ip6) AS src_addr,
                   IPv6NumToString(dst_ip6) AS dst_addr,
                   ip_protocol, bytes_total, packets_total, flow_count
            FROM flow_agg6_1min
            WHERE {dev_filter}
              AND minute >= now() - INTERVAL {minutes} MINUTE
              {proto_clause}
        )
        GROUP BY src_addr, dst_addr, ip_protocol
        ORDER BY bytes_total DESC
        LIMIT {limit}
    """)

    return [
        {
            "src_ip":       r["src_ip"],
            "dst_ip":       r["dst_ip"],
            "protocol":     int(r["ip_protocol"]),
            "protocol_name": PROTO_NAMES.get(int(r["ip_protocol"]), str(r["ip_protocol"])),
            "bytes_total":  int(r["bytes_total"]),
            "packets_total": int(r["packets_total"]),
            "flow_count":   int(r["flow_count"]),
        }
        for r in rows
    ]


@router.get("/top-ports", summary="Top destination ports by bytes")
async def top_ports(
    device_id:      Optional[str] = Query(default=None),
    minutes:        int           = Query(default=60,  ge=1, le=10080),
    limit:          int           = Query(default=20,  ge=1, le=100),
    principal:       Principal     = Depends(get_current_principal),
    db:             AsyncSession  = Depends(get_db),
) -> list[dict]:
    if device_id:
        await _assert_device_in_tenant(device_id, principal, db)
        device_ids = [device_id]
    else:
        device_ids = await _tenant_device_ids(principal, db)

    if not device_ids:
        return []

    rows = await _ch(f"""
        SELECT
            dst_port,
            ip_protocol,
            sum(bytes)    AS bytes_total,
            sum(packets)  AS packets_total,
            count()       AS flow_count
        FROM flow_records
        WHERE {_device_filter(device_ids)}
          AND flow_start >= now() - INTERVAL {minutes} MINUTE
          AND dst_port > 0
          AND ip_protocol IN (6, 17)
        GROUP BY dst_port, ip_protocol
        ORDER BY bytes_total DESC
        LIMIT {limit}
    """)

    return [
        {
            "dst_port":     int(r["dst_port"]),
            "protocol":     int(r["ip_protocol"]),
            "protocol_name": PROTO_NAMES.get(int(r["ip_protocol"]), str(r["ip_protocol"])),
            "bytes_total":  int(r["bytes_total"]),
            "packets_total": int(r["packets_total"]),
            "flow_count":   int(r["flow_count"]),
        }
        for r in rows
    ]


@router.get("/protocol-breakdown", summary="Bytes per protocol over time")
async def protocol_breakdown(
    device_id:      Optional[str] = Query(default=None),
    minutes:        int           = Query(default=60, ge=5, le=10080),
    principal:       Principal     = Depends(get_current_principal),
    db:             AsyncSession  = Depends(get_db),
) -> list[dict]:
    if device_id:
        await _assert_device_in_tenant(device_id, principal, db)
        device_ids = [device_id]
    else:
        device_ids = await _tenant_device_ids(principal, db)

    if not device_ids:
        return []

    rows = await _ch(f"""
        SELECT
            toUnixTimestamp(bucket) * 1000  AS ts_ms,
            ip_protocol,
            sum(bytes_total)           AS bytes_total,
            sum(packets_total)         AS packets_total
        FROM flow_agg_proto_5min
        WHERE {_device_filter(device_ids)}
          AND bucket >= now() - INTERVAL {minutes} MINUTE
        GROUP BY bucket, ip_protocol
        ORDER BY bucket ASC, bytes_total DESC
    """)

    return [
        {
            "ts_ms":        int(r["ts_ms"]),
            "protocol":     int(r["ip_protocol"]),
            "protocol_name": PROTO_NAMES.get(int(r["ip_protocol"]), str(r["ip_protocol"])),
            "bytes_total":  int(r["bytes_total"]),
            "packets_total": int(r["packets_total"]),
        }
        for r in rows
    ]


@router.get("/interface-breakdown", summary="Per-interface flow bytes for a device")
async def interface_breakdown(
    device_id:      str           = Query(...),
    hours:          int           = Query(default=24, ge=1, le=720),
    principal:       Principal     = Depends(get_current_principal),
    db:             AsyncSession  = Depends(get_db),
) -> list[dict]:
    await _assert_device_in_tenant(device_id, principal, db)

    rows = await _ch(f"""
        SELECT
            input_if_index,
            output_if_index,
            sum(bytes_total)   AS bytes_total,
            sum(packets_total) AS packets_total,
            sum(flow_count)    AS flow_count
        FROM flow_agg_iface_1hr
        WHERE collector_device_id = toUUID('{device_id}')
          AND hour >= now() - INTERVAL {hours} HOUR
        GROUP BY input_if_index, output_if_index
        ORDER BY bytes_total DESC
        LIMIT 50
    """)

    # Enrich with interface names from PostgreSQL
    iface_rows = (await db.execute(
        select(Interface.if_index, Interface.name)
        .where(Interface.device_id == device_id)
    )).all()
    iface_name: dict[int, str] = {r.if_index: r.name for r in iface_rows}

    return [
        {
            "input_if_index":  int(r["input_if_index"]),
            "input_if_name":   iface_name.get(int(r["input_if_index"]), ""),
            "output_if_index": int(r["output_if_index"]),
            "output_if_name":  iface_name.get(int(r["output_if_index"]), ""),
            "bytes_total":     int(r["bytes_total"]),
            "packets_total":   int(r["packets_total"]),
            "flow_count":      int(r["flow_count"]),
        }
        for r in rows
    ]


@router.get("/top-devices", summary="Devices ranked by total flow bytes")
async def top_devices(
    minutes:        int  = Query(default=60, ge=1, le=10080),
    limit:          int  = Query(default=10, ge=1, le=50),
    principal:       Principal     = Depends(get_current_principal),
    db:             AsyncSession = Depends(get_db),
) -> list[dict]:
    device_ids = await _tenant_device_ids(principal, db)
    if not device_ids:
        return []

    rows = await _ch(f"""
        SELECT
            toString(collector_device_id)  AS device_uuid,
            sum(bytes_total)          AS bytes_total,
            sum(packets_total)        AS packets_total,
            sum(flow_count)           AS flow_count
        FROM flow_agg_1min
        WHERE {_device_filter(device_ids)}
          AND minute >= now() - INTERVAL {minutes} MINUTE
        GROUP BY collector_device_id
        ORDER BY bytes_total DESC
        LIMIT {limit}
    """)

    # Enrich with device names from PostgreSQL
    dev_rows = (await db.execute(
        select(Device.id, Device.hostname, Device.fqdn, Device.device_type)
        .where(Device.tenant_id == principal.active_tenant_id, Device.is_active == True)  # noqa: E712
    )).all()
    dev_info = {str(r.id): {"hostname": r.fqdn or r.hostname, "device_type": r.device_type} for r in dev_rows}

    return [
        {
            "device_id":    r["device_uuid"],
            "device_name":  dev_info.get(r["device_uuid"], {}).get("hostname", r["device_uuid"][:8]),
            "device_type":  dev_info.get(r["device_uuid"], {}).get("device_type", "unknown"),
            "bytes_total":  int(r["bytes_total"]),
            "packets_total": int(r["packets_total"]),
            "flow_count":   int(r["flow_count"]),
        }
        for r in rows
    ]


@router.get("/search", summary="Search raw flow records")
async def search_flows(
    device_id:      Optional[str] = Query(default=None),
    src_ip:         Optional[str] = Query(default=None),
    dst_ip:         Optional[str] = Query(default=None),
    protocol:       Optional[int] = Query(default=None),
    src_port:       Optional[int] = Query(default=None),
    dst_port:       Optional[int] = Query(default=None),
    minutes:        int           = Query(default=10, ge=1, le=1440),
    limit:          int           = Query(default=200, ge=1, le=1000),
    principal:       Principal     = Depends(get_current_principal),
    db:             AsyncSession  = Depends(get_db),
) -> list[dict]:
    if device_id:
        await _assert_device_in_tenant(device_id, principal, db)
        device_ids = [device_id]
    else:
        device_ids = await _tenant_device_ids(principal, db)

    if not device_ids:
        return []

    clauses = [
        _device_filter(device_ids),
        f"flow_start >= now() - INTERVAL {minutes} MINUTE",
    ]
    if src_ip:              clauses.append(_ip_filter("src", src_ip))
    if dst_ip:              clauses.append(_ip_filter("dst", dst_ip))
    if protocol is not None: clauses.append(f"ip_protocol = {protocol}")
    if src_port is not None: clauses.append(f"src_port = {src_port}")
    if dst_port is not None: clauses.append(f"dst_port = {dst_port}")

    where = " AND ".join(clauses)

    rows = await _ch(f"""
        SELECT
            toString(collector_device_id)                       AS device_uuid,
            IPv4NumToString(exporter_ip)                        AS exporter_ip,
            flow_type,
            toUnixTimestamp(flow_start) * 1000                  AS flow_start_ms,
            toUnixTimestamp(flow_end)   * 1000                  AS flow_end_ms,
            {_ip_display('src_ip', 'src_ip6')}                  AS src_ip,
            {_ip_display('dst_ip', 'dst_ip6')}                  AS dst_ip,
            src_port,
            dst_port,
            ip_protocol,
            tcp_flags,
            bytes,
            packets,
            input_if_index,
            output_if_index,
            src_asn,
            dst_asn,
            sampling_rate
        FROM flow_records
        WHERE {where}
        ORDER BY flow_start DESC
        LIMIT {limit}
    """)

    return [
        {
            "device_id":      r["device_uuid"],
            "exporter_ip":    r["exporter_ip"],
            "flow_type":      r["flow_type"],
            "flow_start_ms":  int(r["flow_start_ms"]),
            "flow_end_ms":    int(r["flow_end_ms"]),
            "src_ip":         r["src_ip"],
            "dst_ip":         r["dst_ip"],
            "src_port":       int(r["src_port"]),
            "dst_port":       int(r["dst_port"]),
            "protocol":       int(r["ip_protocol"]),
            "protocol_name":  PROTO_NAMES.get(int(r["ip_protocol"]), str(r["ip_protocol"])),
            "tcp_flags":      int(r["tcp_flags"]),
            "bytes":          int(r["bytes"]),
            "packets":        int(r["packets"]),
            "input_if_index":  int(r["input_if_index"]),
            "output_if_index": int(r["output_if_index"]),
            "src_asn":        int(r["src_asn"]),
            "dst_asn":        int(r["dst_asn"]),
            "sampling_rate":  int(r["sampling_rate"]),
        }
        for r in rows
    ]


@router.get("/timeseries", summary="Bytes/packets time series for a device or pair")
async def flow_timeseries(
    device_id:      Optional[str] = Query(default=None),
    src_ip:         Optional[str] = Query(default=None),
    dst_ip:         Optional[str] = Query(default=None),
    minutes:        int           = Query(default=60, ge=5, le=10080),
    principal:       Principal     = Depends(get_current_principal),
    db:             AsyncSession  = Depends(get_db),
) -> list[dict]:
    if device_id:
        await _assert_device_in_tenant(device_id, principal, db)
        device_ids = [device_id]
    else:
        device_ids = await _tenant_device_ids(principal, db)

    if not device_ids:
        return []

    dev_filter = _device_filter(device_ids)
    time_clause = f"minute >= now() - INTERVAL {minutes} MINUTE"

    # Build optional IP filters for each address family.
    v4_extra = v6_extra = ""
    if src_ip:
        v4_extra += f" AND {_ip_filter('src', src_ip)}" if _ip_version(src_ip) == 4 else " AND 1=0"
        v6_extra += f" AND {_ip_filter('src', src_ip)}" if _ip_version(src_ip) == 6 else " AND 1=0"
    if dst_ip:
        v4_extra += f" AND {_ip_filter('dst', dst_ip)}" if _ip_version(dst_ip) == 4 else " AND 1=0"
        v6_extra += f" AND {_ip_filter('dst', dst_ip)}" if _ip_version(dst_ip) == 6 else " AND 1=0"

    rows = await _ch(f"""
        SELECT
            toUnixTimestamp(minute) * 1000  AS ts_ms,
            sum(bytes_total)           AS bytes_total,
            sum(packets_total)         AS packets_total,
            sum(flow_count)            AS flow_count
        FROM (
            SELECT minute, bytes_total, packets_total, flow_count
            FROM flow_agg_1min
            WHERE {dev_filter} AND {time_clause} {v4_extra}
            UNION ALL
            SELECT minute, bytes_total, packets_total, flow_count
            FROM flow_agg6_1min
            WHERE {dev_filter} AND {time_clause} {v6_extra}
        )
        GROUP BY minute
        ORDER BY minute ASC
    """)

    return [
        {
            "ts_ms":        int(r["ts_ms"]),
            "bytes_total":  int(r["bytes_total"]),
            "packets_total": int(r["packets_total"]),
            "flow_count":   int(r["flow_count"]),
        }
        for r in rows
    ]


@router.get("/interface-timeseries", summary="Per-minute flow bytes for a specific interface")
async def interface_flow_timeseries(
    device_id:      str           = Query(...),
    if_index:       int           = Query(...),
    minutes:        int           = Query(default=60, ge=5, le=10080),
    principal:       Principal     = Depends(get_current_principal),
    db:             AsyncSession  = Depends(get_db),
) -> list[dict]:
    await _assert_device_in_tenant(device_id, principal, db)

    rows = await _ch(f"""
        SELECT
            toUnixTimestamp(toStartOfMinute(flow_start)) * 1000  AS ts_ms,
            sum(if(input_if_index  = {if_index}, bytes, 0))      AS bytes_in,
            sum(if(output_if_index = {if_index}, bytes, 0))      AS bytes_out,
            sum(packets)                                          AS packets_total,
            count()                                               AS flow_count
        FROM flow_records
        WHERE collector_device_id = toUUID('{device_id}')
          AND (input_if_index = {if_index} OR output_if_index = {if_index})
          AND flow_start >= now() - INTERVAL {minutes} MINUTE
        GROUP BY ts_ms
        ORDER BY ts_ms ASC
    """)

    return [
        {
            "ts_ms":         int(r["ts_ms"]),
            "bytes_in":      int(r["bytes_in"]),
            "bytes_out":     int(r["bytes_out"]),
            "packets_total": int(r["packets_total"]),
            "flow_count":    int(r["flow_count"]),
        }
        for r in rows
    ]


@router.get("/interface-top-talkers", summary="Top talkers through a specific interface")
async def interface_top_talkers(
    device_id:      str           = Query(...),
    if_index:       int           = Query(...),
    minutes:        int           = Query(default=60, ge=5, le=10080),
    limit:          int           = Query(default=10, ge=1, le=50),
    principal:       Principal     = Depends(get_current_principal),
    db:             AsyncSession  = Depends(get_db),
) -> list[dict]:
    await _assert_device_in_tenant(device_id, principal, db)

    rows = await _ch(f"""
        SELECT
            {_ip_display('src_ip', 'src_ip6')}  AS src_ip,
            {_ip_display('dst_ip', 'dst_ip6')}  AS dst_ip,
            ip_protocol,
            sum(bytes)               AS bytes_total,
            sum(packets)             AS packets_total,
            count()                  AS flow_count
        FROM flow_records
        WHERE collector_device_id = toUUID('{device_id}')
          AND (input_if_index = {if_index} OR output_if_index = {if_index})
          AND flow_start >= now() - INTERVAL {minutes} MINUTE
        GROUP BY src_ip, src_ip6, dst_ip, dst_ip6, ip_protocol
        ORDER BY bytes_total DESC
        LIMIT {limit}
    """)

    return [
        {
            "src_ip":        r["src_ip"],
            "dst_ip":        r["dst_ip"],
            "protocol":      int(r["ip_protocol"]),
            "protocol_name": PROTO_NAMES.get(int(r["ip_protocol"]), str(r["ip_protocol"])),
            "bytes_total":   int(r["bytes_total"]),
            "packets_total": int(r["packets_total"]),
            "flow_count":    int(r["flow_count"]),
        }
        for r in rows
    ]


@router.get("/ip-detail", summary="Drill-down stats for a single IP address")
async def ip_detail(
    ip:             str           = Query(...),
    minutes:        int           = Query(default=60, ge=1, le=10080),
    device_id:      Optional[str] = Query(default=None),
    principal:       Principal     = Depends(get_current_principal),
    db:             AsyncSession  = Depends(get_db),
) -> dict:
    ver = _ip_version(ip)  # validate and get address family

    if device_id:
        await _assert_device_in_tenant(device_id, principal, db)
        device_ids = [device_id]
    else:
        device_ids = await _tenant_device_ids(principal, db)

    if not device_ids:
        return {}

    dev_clause  = _device_filter(device_ids)
    src_filt    = _ip_filter("src", ip)
    dst_filt    = _ip_filter("dst", ip)
    time_agg    = f"minute >= now() - INTERVAL {minutes} MINUTE"
    time_raw    = f"flow_start >= now() - INTERVAL {minutes} MINUTE"

    # Choose the right aggregate table and display expression.
    if ver == 4:
        agg_table   = "flow_agg_1min"
        ip_col_s    = "src_ip"
        ip_col_d    = "dst_ip"
        qip         = f"toIPv4('{ip}')"
        disp_dst    = "IPv4NumToString(dst_ip)"
        disp_src    = "IPv4NumToString(src_ip)"
    else:
        agg_table   = "flow_agg6_1min"
        ip_col_s    = "src_ip6"
        ip_col_d    = "dst_ip6"
        qip         = f"toIPv6('{ip}')"
        disp_dst    = "IPv6NumToString(dst_ip6)"
        disp_src    = "IPv6NumToString(src_ip6)"

    # ── Totals + connection profile ───────────────────────────────────────────
    totals = await _ch(f"""
        SELECT
            sum(if({ip_col_s} = {qip}, bytes_total,   0)) AS bytes_as_src,
            sum(if({ip_col_d} = {qip}, bytes_total,   0)) AS bytes_as_dst,
            sum(if({ip_col_s} = {qip}, packets_total, 0)) AS pkts_as_src,
            sum(if({ip_col_d} = {qip}, packets_total, 0)) AS pkts_as_dst,
            sum(flow_count)                                AS flows_total,
            uniqIf({ip_col_d}, {ip_col_s} = {qip})        AS unique_destinations,
            uniqIf({ip_col_s}, {ip_col_d} = {qip})        AS unique_sources
        FROM {agg_table}
        WHERE {dev_clause}
          AND ({ip_col_s} = {qip} OR {ip_col_d} = {qip})
          AND {time_agg}
    """)

    # ── Connection profile from raw records ───────────────────────────────────
    profile = await _ch(f"""
        SELECT
            avg(dateDiff('second', flow_start, flow_end))       AS avg_duration_s,
            avg(bytes)                                           AS avg_bytes_per_flow,
            avg(bytes / greatest(packets, 1))                    AS avg_bytes_per_packet,
            max(bytes * sampling_rate)                           AS max_flow_bytes,
            countIf(ip_protocol = 6)                            AS tcp_flows,
            countIf(ip_protocol = 17)                           AS udp_flows,
            countIf(ip_protocol = 1)                            AS icmp_flows,
            uniqIf(dst_port, {src_filt} AND ip_protocol IN (6,17)) AS unique_dst_ports,
            uniqIf(src_port, {dst_filt} AND ip_protocol IN (6,17)) AS unique_src_ports,
            count()                                              AS total_raw_flows
        FROM flow_records
        WHERE {dev_clause}
          AND ({src_filt} OR {dst_filt})
          AND {time_raw}
    """)

    # ── Top peers ─────────────────────────────────────────────────────────────
    peers = await _ch(f"""
        SELECT
            if({ip_col_s} = {qip}, {disp_dst}, {disp_src})     AS peer_ip,
            sum(if({ip_col_s} = {qip}, bytes_total, 0))         AS bytes_sent,
            sum(if({ip_col_d} = {qip}, bytes_total, 0))         AS bytes_received
        FROM {agg_table}
        WHERE {dev_clause}
          AND ({ip_col_s} = {qip} OR {ip_col_d} = {qip})
          AND {time_agg}
        GROUP BY peer_ip
        ORDER BY bytes_sent + bytes_received DESC
        LIMIT 15
    """)

    # ── Top destination ports used by this IP as source ───────────────────────
    ports = await _ch(f"""
        SELECT
            dst_port,
            ip_protocol,
            sum(bytes)   AS bytes_total,
            sum(packets) AS packets_total,
            count()      AS flow_count
        FROM flow_records
        WHERE {dev_clause}
          AND {src_filt}
          AND {time_raw}
          AND dst_port > 0
          AND ip_protocol IN (6, 17)
        GROUP BY dst_port, ip_protocol
        ORDER BY bytes_total DESC
        LIMIT 10
    """)

    # ── Per-minute time series (both directions) ──────────────────────────────
    ts = await _ch(f"""
        SELECT
            toUnixTimestamp(minute) * 1000                      AS ts_ms,
            sum(if({ip_col_s} = {qip}, bytes_total, 0))         AS bytes_out,
            sum(if({ip_col_d} = {qip}, bytes_total, 0))         AS bytes_in
        FROM {agg_table}
        WHERE {dev_clause}
          AND ({ip_col_s} = {qip} OR {ip_col_d} = {qip})
          AND {time_agg}
        GROUP BY minute
        ORDER BY minute ASC
    """)

    t = totals[0] if totals else {}
    p = profile[0] if profile else {}
    return {
        "ip":                  ip,
        "bytes_as_src":        int(t.get("bytes_as_src", 0)),
        "bytes_as_dst":        int(t.get("bytes_as_dst", 0)),
        "pkts_as_src":         int(t.get("pkts_as_src",  0)),
        "pkts_as_dst":         int(t.get("pkts_as_dst",  0)),
        "flows_total":         int(t.get("flows_total",   0)),
        "unique_destinations": int(t.get("unique_destinations", 0)),
        "unique_sources":      int(t.get("unique_sources",      0)),
        "profile": {
            "avg_duration_s":     round(float(p.get("avg_duration_s", 0) or 0), 1),
            "avg_bytes_per_flow": round(float(p.get("avg_bytes_per_flow", 0) or 0)),
            "avg_bytes_per_pkt":  round(float(p.get("avg_bytes_per_packet", 0) or 0), 1),
            "max_flow_bytes":     int(p.get("max_flow_bytes", 0) or 0),
            "tcp_flows":          int(p.get("tcp_flows", 0) or 0),
            "udp_flows":          int(p.get("udp_flows", 0) or 0),
            "icmp_flows":         int(p.get("icmp_flows", 0) or 0),
            "unique_dst_ports":   int(p.get("unique_dst_ports", 0) or 0),
            "unique_src_ports":   int(p.get("unique_src_ports", 0) or 0),
        },
        "top_peers": [
            {
                "peer_ip":        r["peer_ip"],
                "bytes_sent":     int(r["bytes_sent"]),
                "bytes_received": int(r["bytes_received"]),
            }
            for r in peers
        ],
        "top_ports": [
            {
                "dst_port":      int(r["dst_port"]),
                "protocol":      int(r["ip_protocol"]),
                "protocol_name": PROTO_NAMES.get(int(r["ip_protocol"]), str(r["ip_protocol"])),
                "bytes_total":   int(r["bytes_total"]),
            }
            for r in ports
        ],
        "timeseries": [
            {
                "ts_ms":     int(r["ts_ms"]),
                "bytes_out": int(r["bytes_out"]),
                "bytes_in":  int(r["bytes_in"]),
            }
            for r in ts
        ],
    }


# ── Service / application mapping ─────────────────────────────────────────────

_PORT_SERVICE: dict[int, str] = {
    80: "HTTP",       443: "HTTPS",      8080: "HTTP-Alt",  8443: "HTTPS-Alt",
    8000: "HTTP-Alt", 3000: "HTTP-Alt",  8888: "HTTP-Alt",
    53: "DNS",        5353: "mDNS",
    25: "SMTP",       587: "SMTP/TLS",   465: "SMTPS",
    110: "POP3",      995: "POP3S",      143: "IMAP",       993: "IMAPS",
    22: "SSH",        23: "Telnet",      3389: "RDP",       5900: "VNC",
    21: "FTP",        20: "FTP-Data",    69: "TFTP",
    445: "SMB",       139: "NetBIOS",    2049: "NFS",
    3306: "MySQL",    5432: "PostgreSQL",1433: "MSSQL",     1521: "Oracle",
    6379: "Redis",    27017: "MongoDB",  5984: "CouchDB",
    67: "DHCP",       68: "DHCP",        123: "NTP",
    161: "SNMP",      162: "SNMP-Trap",
    179: "BGP",       520: "RIP",        521: "RIPng",
    389: "LDAP",      636: "LDAPS",      88: "Kerberos",
    1935: "RTMP",     554: "RTSP",       5004: "RTP",
    500: "IKE",       4500: "NAT-T",     1194: "OpenVPN",
    1701: "L2TP",     1723: "PPTP",      51820: "WireGuard",
    6881: "BitTorrent",3724: "WoW",      25565: "Minecraft",
}

_SERVICE_CATEGORY: dict[str, str] = {
    "HTTP": "Web",       "HTTPS": "Web",     "HTTP-Alt": "Web",  "HTTPS-Alt": "Web",
    "DNS": "DNS",        "mDNS": "DNS",
    "SMTP": "Email",     "SMTP/TLS": "Email","SMTPS": "Email",
    "POP3": "Email",     "POP3S": "Email",   "IMAP": "Email",    "IMAPS": "Email",
    "SSH": "Remote",     "Telnet": "Remote", "RDP": "Remote",    "VNC": "Remote",
    "FTP": "File",       "FTP-Data": "File", "TFTP": "File",     "SMB": "File",
    "NetBIOS": "File",   "NFS": "File",
    "MySQL": "Database", "PostgreSQL": "Database","MSSQL": "Database","Oracle": "Database",
    "Redis": "Database", "MongoDB": "Database","CouchDB": "Database",
    "DHCP": "Network",   "NTP": "Network",   "SNMP": "Network",  "SNMP-Trap": "Network",
    "BGP": "Network",    "RIP": "Network",   "RIPng": "Network",
    "LDAP": "Network",   "LDAPS": "Network", "Kerberos": "Network",
    "RTMP": "Streaming", "RTSP": "Streaming","RTP": "Streaming",
    "IKE": "VPN",        "NAT-T": "VPN",     "OpenVPN": "VPN",
    "L2TP": "VPN",       "PPTP": "VPN",      "WireGuard": "VPN",
    "BitTorrent": "P2P", "WoW": "Gaming",    "Minecraft": "Gaming",
}

# ── Deep analytics endpoints ───────────────────────────────────────────────────

@router.get("/asn-summary", summary="Traffic volume by Autonomous System")
async def asn_summary(
    device_id:    Optional[str] = Query(default=None),
    minutes:      int           = Query(default=60, ge=1, le=10080),
    direction:    str           = Query(default="src", description="src | dst | both"),
    limit:        int           = Query(default=25, ge=1, le=100),
    principal:       Principal     = Depends(get_current_principal),
    db:           AsyncSession  = Depends(get_db),
) -> list[dict]:
    if device_id:
        await _assert_device_in_tenant(device_id, principal, db)
        device_ids = [device_id]
    else:
        device_ids = await _tenant_device_ids(principal, db)
    if not device_ids:
        return []

    dev_filter = _device_filter(device_ids)
    ip_col = "src_ip" if direction != "dst" else "dst_ip"
    from sqlalchemy import text as sq_text

    # Try native ASN fields from flow records first (populated when exporter
    # provides BGP peer data). Fall back to ip_intel GeoIP lookup when the
    # exporter sets asn=0 (common with sFlow and many NetFlow configurations).
    asn_col = "src_asn" if direction != "dst" else "dst_asn"
    native_check = await _ch(f"""
        SELECT countIf({asn_col} > 0) AS has_asn
        FROM flow_agg_asn_5min
        WHERE {dev_filter}
          AND bucket >= now() - INTERVAL {minutes} MINUTE
        LIMIT 1
    """)
    use_native = native_check and int(native_check[0].get("has_asn", 0)) > 0

    if use_native:
        rows = await _ch(f"""
            SELECT
                {asn_col}             AS asn,
                sum(bytes_total)      AS bytes_total,
                sum(flow_count)       AS flow_count
            FROM flow_agg_asn_5min
            WHERE {dev_filter}
              AND bucket >= now() - INTERVAL {minutes} MINUTE
              AND {asn_col} > 0
            GROUP BY asn
            ORDER BY bytes_total DESC
            LIMIT {limit}
        """)
        asn_nums = [int(r["asn"]) for r in rows if r["asn"]]
        asn_names: dict[int, str] = {}
        if asn_nums:
            name_rows = (await db.execute(
                sq_text("SELECT DISTINCT ON (asn) asn, asn_org FROM ip_intel WHERE asn = ANY(:asns) AND asn_org IS NOT NULL"),
                {"asns": asn_nums},
            )).all()
            asn_names = {r.asn: r.asn_org for r in name_rows}
        total_bytes = sum(int(r["bytes_total"]) for r in rows) or 1
        return [
            {
                "asn":         int(r["asn"]),
                "asn_name":    asn_names.get(int(r["asn"]), f"AS{r['asn']}"),
                "bytes_total": int(r["bytes_total"]),
                "flow_count":  int(r["flow_count"]),
                "pct":         round(int(r["bytes_total"]) / total_bytes * 100, 1),
            }
            for r in rows
        ]

    # --- Fallback: derive ASN from ip_intel GeoIP cache ---
    # Get top IPs by bytes from both v4 and v6 aggregates.
    v4_col  = "src_ip"  if direction != "dst" else "dst_ip"
    v6_col  = "src_ip6" if direction != "dst" else "dst_ip6"
    top_ips = await _ch(f"""
        SELECT ip, sum(bytes_total) AS bytes_total, sum(flow_count) AS flow_count
        FROM (
            SELECT IPv4NumToString({v4_col}) AS ip, bytes_total, flow_count
            FROM flow_agg_1min
            WHERE {dev_filter}
              AND minute >= now() - INTERVAL {minutes} MINUTE
            UNION ALL
            SELECT IPv6NumToString({v6_col}) AS ip, bytes_total, flow_count
            FROM flow_agg6_1min
            WHERE {dev_filter}
              AND minute >= now() - INTERVAL {minutes} MINUTE
        )
        GROUP BY ip
        ORDER BY bytes_total DESC
        LIMIT 500
    """)

    if not top_ips:
        return []

    ips = [r["ip"] for r in top_ips if not is_private(r["ip"])]
    if not ips:
        return []

    # Look up ASNs from ip_intel for all these IPs, trigger background enrichment
    intel = await get_intel(ips)
    import asyncio as _asyncio
    _asyncio.create_task(enrich_ips(ips))

    # Aggregate bytes by ASN
    asn_totals: dict[int, dict] = {}
    for r in top_ips:
        ip = r["ip"]
        entry = intel.get(ip, {})
        asn = entry.get("asn")
        if not asn:
            continue
        name = entry.get("asn_org") or f"AS{asn}"
        b = int(r["bytes_total"])
        if asn not in asn_totals:
            asn_totals[asn] = {"asn": asn, "asn_name": name, "bytes_total": 0, "flow_count": 0}
        asn_totals[asn]["bytes_total"] += b
        asn_totals[asn]["flow_count"]  += int(r["flow_count"])

    results = sorted(asn_totals.values(), key=lambda x: x["bytes_total"], reverse=True)[:limit]
    total_bytes = sum(r["bytes_total"] for r in results) or 1
    for r in results:
        r["pct"] = round(r["bytes_total"] / total_bytes * 100, 1)
    return results



@router.get("/application-summary", summary="Traffic grouped by application/service")
async def application_summary(
    device_id:    Optional[str] = Query(default=None),
    minutes:      int           = Query(default=60, ge=1, le=10080),
    limit:        int           = Query(default=30, ge=1, le=100),
    principal:       Principal     = Depends(get_current_principal),
    db:           AsyncSession  = Depends(get_db),
) -> list[dict]:
    if device_id:
        await _assert_device_in_tenant(device_id, principal, db)
        device_ids = [device_id]
    else:
        device_ids = await _tenant_device_ids(principal, db)
    if not device_ids:
        return []

    rows = await _ch(f"""
        SELECT
            dst_port,
            ip_protocol,
            sum(bytes)    AS bytes_total,
            sum(packets)  AS packets_total,
            count()       AS flow_count,
            uniq(src_ip)  AS unique_src,
            uniq(dst_ip)  AS unique_dst
        FROM flow_records
        WHERE {_device_filter(device_ids)}
          AND flow_start >= now() - INTERVAL {minutes} MINUTE
          AND ip_protocol IN (6, 17)
          AND dst_port > 0
        GROUP BY dst_port, ip_protocol
        ORDER BY bytes_total DESC
        LIMIT {limit}
    """)

    # Aggregate by service category
    category_totals: dict[str, dict] = {}
    port_details = []

    for r in rows:
        port  = int(r["dst_port"])
        proto = int(r["ip_protocol"])
        svc   = _PORT_SERVICE.get(port, f"port/{port}")
        cat   = _SERVICE_CATEGORY.get(svc, "Other")
        b     = int(r["bytes_total"])

        if cat not in category_totals:
            category_totals[cat] = {"bytes_total": 0, "flow_count": 0, "services": set()}
        category_totals[cat]["bytes_total"] += b
        category_totals[cat]["flow_count"]  += int(r["flow_count"])
        category_totals[cat]["services"].add(svc)

        port_details.append({
            "port":        port,
            "protocol":    PROTO_NAMES.get(proto, str(proto)),
            "service":     svc,
            "category":    cat,
            "bytes_total": b,
            "flow_count":  int(r["flow_count"]),
            "unique_src":  int(r["unique_src"]),
            "unique_dst":  int(r["unique_dst"]),
        })

    total_bytes = sum(v["bytes_total"] for v in category_totals.values()) or 1
    categories = sorted(
        [
            {
                "category":    cat,
                "bytes_total": v["bytes_total"],
                "flow_count":  v["flow_count"],
                "pct":         round(v["bytes_total"] / total_bytes * 100, 1),
                "services":    sorted(v["services"]),
            }
            for cat, v in category_totals.items()
        ],
        key=lambda x: x["bytes_total"], reverse=True,
    )

    return [{"type": "category", **c} for c in categories] + \
           [{"type": "port",     **p} for p in port_details]


@router.get("/direction-summary", summary="Inbound / Outbound / Internal / Transit traffic split")
async def direction_summary(
    device_id:    Optional[str] = Query(default=None),
    minutes:      int           = Query(default=60, ge=1, le=10080),
    principal:       Principal     = Depends(get_current_principal),
    db:           AsyncSession  = Depends(get_db),
) -> dict:
    if device_id:
        await _assert_device_in_tenant(device_id, principal, db)
        device_ids = [device_id]
    else:
        device_ids = await _tenant_device_ids(principal, db)
    if not device_ids:
        return {}

    priv_src = _private_clause("src_ip", "src_ip6")
    priv_dst = _private_clause("dst_ip", "dst_ip6")
    dev_filter = _device_filter(device_ids)
    time_clause = f"flow_start >= now() - INTERVAL {minutes} MINUTE"

    rows = await _ch(f"""
        SELECT
            multiIf(
                ({priv_src}) AND ({priv_dst}), 'internal',
                ({priv_src}) AND NOT ({priv_dst}), 'outbound',
                NOT ({priv_src}) AND ({priv_dst}), 'inbound',
                'transit'
            )                                               AS direction,
            sum(bytes * sampling_rate)                      AS bytes_total,
            sum(packets)                                    AS packets_total,
            count()                                         AS flow_count,
            uniq({_ip_display('src_ip', 'src_ip6')})        AS unique_src,
            uniq({_ip_display('dst_ip', 'dst_ip6')})        AS unique_dst
        FROM flow_records
        WHERE {dev_filter}
          AND {time_clause}
        GROUP BY direction
    """)

    result: dict[str, dict] = {
        d: {"bytes_total": 0, "packets_total": 0, "flow_count": 0,
            "unique_src": 0, "unique_dst": 0}
        for d in ("inbound", "outbound", "internal", "transit")
    }
    total_bytes = 0
    for r in rows:
        d = r["direction"]
        b = int(r["bytes_total"])
        result[d] = {
            "bytes_total":  b,
            "packets_total":int(r["packets_total"]),
            "flow_count":   int(r["flow_count"]),
            "unique_src":   int(r["unique_src"]),
            "unique_dst":   int(r["unique_dst"]),
        }
        total_bytes += b

    for d in result:
        result[d]["pct"] = round(result[d]["bytes_total"] / max(total_bytes, 1) * 100, 1)

    # Top inbound sources (external IPs sending the most to internal)
    inbound_top = await _ch(f"""
        SELECT
            {_ip_display('src_ip', 'src_ip6')}  AS ip,
            sum(bytes * sampling_rate)           AS bytes_total,
            count()                              AS flow_count
        FROM flow_records
        WHERE {dev_filter}
          AND {time_clause}
          AND NOT ({priv_src})
          AND ({priv_dst})
        GROUP BY src_ip, src_ip6
        ORDER BY bytes_total DESC
        LIMIT 10
    """)

    # Top outbound destinations (internal IPs sending to external)
    outbound_top = await _ch(f"""
        SELECT
            {_ip_display('dst_ip', 'dst_ip6')}  AS ip,
            sum(bytes * sampling_rate)           AS bytes_total,
            count()                              AS flow_count
        FROM flow_records
        WHERE {dev_filter}
          AND {time_clause}
          AND ({priv_src})
          AND NOT ({priv_dst})
        GROUP BY dst_ip, dst_ip6
        ORDER BY bytes_total DESC
        LIMIT 10
    """)

    return {
        "summary": result,
        "top_inbound_sources":      [{"ip": r["ip"], "bytes_total": int(r["bytes_total"]), "flow_count": int(r["flow_count"])} for r in inbound_top],
        "top_outbound_destinations": [{"ip": r["ip"], "bytes_total": int(r["bytes_total"]), "flow_count": int(r["flow_count"])} for r in outbound_top],
    }


@router.get("/elephant-flows", summary="Individual large flows above a byte threshold")
async def elephant_flows(
    device_id:    Optional[str] = Query(default=None),
    minutes:      int           = Query(default=60, ge=1, le=10080),
    min_mb:       float         = Query(default=5.0, ge=0.1, le=10000, description="Minimum flow size in MB"),
    limit:        int           = Query(default=50, ge=1, le=200),
    principal:       Principal     = Depends(get_current_principal),
    db:           AsyncSession  = Depends(get_db),
) -> list[dict]:
    if device_id:
        await _assert_device_in_tenant(device_id, principal, db)
        device_ids = [device_id]
    else:
        device_ids = await _tenant_device_ids(principal, db)
    if not device_ids:
        return []

    min_bytes = int(min_mb * 1_000_000)

    rows = await _ch(f"""
        SELECT
            toString(collector_device_id)                   AS device_uuid,
            flow_type,
            toUnixTimestamp(flow_start) * 1000              AS start_ms,
            toUnixTimestamp(flow_end)   * 1000              AS end_ms,
            dateDiff('second', flow_start, flow_end)        AS duration_s,
            {_ip_display('src_ip', 'src_ip6')}               AS src_ip,
            {_ip_display('dst_ip', 'dst_ip6')}               AS dst_ip,
            src_port,
            dst_port,
            ip_protocol,
            tcp_flags,
            bytes * sampling_rate                           AS bytes_est,
            bytes                                           AS bytes_raw,
            packets,
            sampling_rate
        FROM flow_records
        WHERE {_device_filter(device_ids)}
          AND flow_start >= now() - INTERVAL {minutes} MINUTE
          AND bytes * sampling_rate >= {min_bytes}
        ORDER BY bytes_est DESC
        LIMIT {limit}
    """)

    dev_rows = (await db.execute(
        select(Device.id, Device.hostname, Device.fqdn)
        .where(Device.tenant_id == principal.active_tenant_id)
    )).all()
    dev_names = {str(r.id): r.fqdn or r.hostname for r in dev_rows}

    return [
        {
            "device_name":  dev_names.get(r["device_uuid"], r["device_uuid"][:8]),
            "flow_type":    r["flow_type"],
            "start_ms":     int(r["start_ms"]),
            "end_ms":       int(r["end_ms"]),
            "duration_s":   int(r["duration_s"]),
            "src_ip":       r["src_ip"],
            "dst_ip":       r["dst_ip"],
            "src_port":     int(r["src_port"]),
            "dst_port":     int(r["dst_port"]),
            "service":      _PORT_SERVICE.get(int(r["dst_port"]), f"port/{r['dst_port']}"),
            "protocol":     PROTO_NAMES.get(int(r["ip_protocol"]), str(r["ip_protocol"])),
            "tcp_flags":    int(r["tcp_flags"]),
            "bytes_est":    int(r["bytes_est"]),
            "bytes_raw":    int(r["bytes_raw"]),
            "packets":      int(r["packets"]),
            "sampling_rate":int(r["sampling_rate"]),
            "bps":          int(r["bytes_est"]) * 8 // max(int(r["duration_s"]), 1),
        }
        for r in rows
    ]


@router.get("/subnet-summary", summary="Traffic grouped by /24 subnet")
async def subnet_summary(
    device_id:    Optional[str] = Query(default=None),
    minutes:      int           = Query(default=60, ge=1, le=10080),
    direction:    str           = Query(default="src", description="src | dst"),
    limit:        int           = Query(default=25, ge=1, le=100),
    principal:       Principal     = Depends(get_current_principal),
    db:           AsyncSession  = Depends(get_db),
) -> list[dict]:
    if device_id:
        await _assert_device_in_tenant(device_id, principal, db)
        device_ids = [device_id]
    else:
        device_ids = await _tenant_device_ids(principal, db)
    if not device_ids:
        return []

    ip_col = "src_ip" if direction == "src" else "dst_ip"

    rows = await _ch(f"""
        SELECT
            concat(IPv4NumToString(bitAnd({ip_col}, 0xFFFFFF00)), '/24') AS subnet,
            sum(bytes_total)    AS bytes_total,
            sum(flow_count)     AS flow_count,
            uniq({ip_col})      AS unique_ips
        FROM flow_agg_1min
        WHERE {_device_filter(device_ids)}
          AND minute >= now() - INTERVAL {minutes} MINUTE
        GROUP BY bitAnd({ip_col}, 0xFFFFFF00)
        ORDER BY bytes_total DESC
        LIMIT {limit}
    """)

    total = sum(int(r["bytes_total"]) for r in rows) or 1
    return [
        {
            "subnet":      r["subnet"],
            "bytes_total": int(r["bytes_total"]),
            "flow_count":  int(r["flow_count"]),
            "unique_ips":  int(r["unique_ips"]),
            "pct":         round(int(r["bytes_total"]) / total * 100, 1),
        }
        for r in rows
    ]


@router.get("/tcp-flags", summary="TCP flag breakdown for recent flows")
async def tcp_flags_summary(
    device_id:    Optional[str] = Query(default=None),
    minutes:      int           = Query(default=60, ge=1, le=10080),
    principal:       Principal     = Depends(get_current_principal),
    db:           AsyncSession  = Depends(get_db),
) -> dict:
    if device_id:
        await _assert_device_in_tenant(device_id, principal, db)
        device_ids = [device_id]
    else:
        device_ids = await _tenant_device_ids(principal, db)
    if not device_ids:
        return {}

    rows = await _ch(f"""
        SELECT
            -- SYN only (potential scan / connection attempt)
            countIf(bitAnd(tcp_flags, 2) > 0 AND bitAnd(tcp_flags, 16) = 0 AND bitAnd(tcp_flags, 18) != 18) AS syn_only,
            -- SYN-ACK (connection established)
            countIf(bitAnd(tcp_flags, 18) = 18)   AS syn_ack,
            -- RST (connection refused / reset)
            countIf(bitAnd(tcp_flags, 4) > 0)     AS rst,
            -- FIN (graceful close)
            countIf(bitAnd(tcp_flags, 1) > 0)     AS fin,
            -- ACK only (data transfer)
            countIf(bitAnd(tcp_flags, 16) > 0 AND bitAnd(tcp_flags, 2) = 0 AND bitAnd(tcp_flags, 4) = 0 AND bitAnd(tcp_flags, 1) = 0) AS ack_only,
            -- PSH+ACK (data push)
            countIf(bitAnd(tcp_flags, 24) = 24)   AS psh_ack,
            -- URG
            countIf(bitAnd(tcp_flags, 32) > 0)    AS urg,
            count()                                AS total_flows,
            sum(bytes)                             AS total_bytes
        FROM flow_records
        WHERE {_device_filter(device_ids)}
          AND flow_start >= now() - INTERVAL {minutes} MINUTE
          AND ip_protocol = 6
    """)

    if not rows:
        return {}
    r = rows[0]

    # Top RST sources (most connection resets — indicates problems or scans)
    rst_top = await _ch(f"""
        SELECT
            {_ip_display('src_ip', 'src_ip6')}  AS src_ip,
            count()                              AS rst_count,
            uniq({_ip_display('dst_ip', 'dst_ip6')}) AS unique_targets,
            uniq(dst_port)                       AS unique_ports
        FROM flow_records
        WHERE {_device_filter(device_ids)}
          AND flow_start >= now() - INTERVAL {minutes} MINUTE
          AND ip_protocol = 6
          AND bitAnd(tcp_flags, 4) > 0
        GROUP BY src_ip, src_ip6
        ORDER BY rst_count DESC
        LIMIT 10
    """)

    # SYN-only top sources (scanner candidates)
    syn_top = await _ch(f"""
        SELECT
            {_ip_display('src_ip', 'src_ip6')}  AS src_ip,
            count()                              AS syn_count,
            uniq({_ip_display('dst_ip', 'dst_ip6')}) AS unique_targets,
            uniq(dst_port)                       AS unique_ports
        FROM flow_records
        WHERE {_device_filter(device_ids)}
          AND flow_start >= now() - INTERVAL {minutes} MINUTE
          AND ip_protocol = 6
          AND bitAnd(tcp_flags, 2) > 0
          AND bitAnd(tcp_flags, 16) = 0
        GROUP BY src_ip, src_ip6
        HAVING unique_ports > 3 OR unique_targets > 3
        ORDER BY syn_count DESC
        LIMIT 10
    """)

    total = int(r["total_flows"]) or 1
    return {
        "total_tcp_flows": int(r["total_flows"]),
        "total_bytes":     int(r["total_bytes"]),
        "flags": {
            "syn_only": {"count": int(r["syn_only"]), "pct": round(int(r["syn_only"]) / total * 100, 1)},
            "syn_ack":  {"count": int(r["syn_ack"]),  "pct": round(int(r["syn_ack"])  / total * 100, 1)},
            "rst":      {"count": int(r["rst"]),      "pct": round(int(r["rst"])      / total * 100, 1)},
            "fin":      {"count": int(r["fin"]),      "pct": round(int(r["fin"])      / total * 100, 1)},
            "ack_only": {"count": int(r["ack_only"]), "pct": round(int(r["ack_only"]) / total * 100, 1)},
            "psh_ack":  {"count": int(r["psh_ack"]),  "pct": round(int(r["psh_ack"])  / total * 100, 1)},
        },
        "top_rst_sources": [
            {"ip": r["src_ip"], "rst_count": int(r["rst_count"]),
             "unique_targets": int(r["unique_targets"]), "unique_ports": int(r["unique_ports"])}
            for r in rst_top
        ],
        "scan_candidates": [
            {"ip": r["src_ip"], "syn_count": int(r["syn_count"]),
             "unique_targets": int(r["unique_targets"]), "unique_ports": int(r["unique_ports"])}
            for r in syn_top
        ],
    }


# ── Intel helpers ─────────────────────────────────────────────────────────────

async def _get_abuseipdb_key(db: AsyncSession) -> str:
    platform = await load_platform_defaults(db)
    return platform.get("abuseipdb_api_key", "")


def _attach_intel(ip: str, intel: dict) -> dict:
    entry = intel.get(ip, {})
    return {
        "country_iso":   entry.get("country_iso"),
        "country_name":  entry.get("country_name"),
        "asn":           entry.get("asn"),
        "asn_org":       entry.get("asn_org"),
        "abuse_score":   entry.get("abuse_score"),
        "abuse_reports": entry.get("abuse_reports"),
        "abuse_isp":     entry.get("abuse_isp"),
        "is_private":    is_private(ip),
    }


# ── Intel endpoints ────────────────────────────────────────────────────────────

@router.get("/geo-summary", summary="Flow volume grouped by country of origin")
async def geo_summary(
    device_id:    Optional[str] = Query(default=None),
    minutes:      int           = Query(default=60, ge=1, le=10080),
    limit:        int           = Query(default=30, ge=1, le=100),
    principal:       Principal     = Depends(get_current_principal),
    db:           AsyncSession  = Depends(get_db),
) -> list[dict]:
    if device_id:
        await _assert_device_in_tenant(device_id, principal, db)
        device_ids = [device_id]
    else:
        device_ids = await _tenant_device_ids(principal, db)
    if not device_ids:
        return []

    # Pull top source IPs by bytes (both v4 and v6)
    dev_filter = _device_filter(device_ids)
    rows = await _ch(f"""
        SELECT ip, sum(bytes_total) AS bytes_total
        FROM (
            SELECT IPv4NumToString(src_ip) AS ip, bytes_total
            FROM flow_agg_1min
            WHERE {dev_filter}
              AND minute >= now() - INTERVAL {minutes} MINUTE
            UNION ALL
            SELECT IPv6NumToString(src_ip6) AS ip, bytes_total
            FROM flow_agg6_1min
            WHERE {dev_filter}
              AND minute >= now() - INTERVAL {minutes} MINUTE
        )
        GROUP BY ip
        ORDER BY bytes_total DESC
        LIMIT 500
    """)

    if not rows:
        return []

    ips = [r["ip"] for r in rows if not is_private(r["ip"])]
    # Enrich geo in background — return what's cached, kick off fetch for missing
    intel = await get_intel(ips)
    import asyncio
    asyncio.create_task(enrich_ips(ips))

    # Aggregate by country
    country_bytes: dict[str, dict] = {}
    for r in rows:
        ip    = r["ip"]
        priv  = is_private(ip)
        entry = intel.get(ip, {})
        iso   = entry.get("country_iso") or ("PRIVATE" if priv else "UNKNOWN")
        name  = entry.get("country_name") or ("Private/RFC1918" if priv else "Unknown")
        b     = int(r["bytes_total"])
        if iso not in country_bytes:
            country_bytes[iso] = {"country_iso": iso, "country_name": name,
                                   "bytes_total": 0, "unique_ips": 0}
        country_bytes[iso]["bytes_total"] += b
        country_bytes[iso]["unique_ips"]  += 1

    results = sorted(country_bytes.values(), key=lambda x: x["bytes_total"], reverse=True)
    return results[:limit]


@router.get("/threats", summary="IPs with high AbuseIPDB scores seen in recent flows")
async def flow_threats(
    device_id:    Optional[str] = Query(default=None),
    minutes:      int           = Query(default=60, ge=1, le=10080),
    min_score:    int           = Query(default=25, ge=1, le=100),
    limit:        int           = Query(default=50, ge=1, le=200),
    principal:       Principal     = Depends(get_current_principal),
    db:           AsyncSession  = Depends(get_db),
) -> list[dict]:
    if device_id:
        await _assert_device_in_tenant(device_id, principal, db)
        device_ids = [device_id]
    else:
        device_ids = await _tenant_device_ids(principal, db)
    if not device_ids:
        return []

    abuseipdb_key = await _get_abuseipdb_key(db)

    dev_filter = _device_filter(device_ids)
    rows = await _ch(f"""
        SELECT ip, sum(bytes_total) AS bytes_total,
               sum(flow_count) AS flow_count,
               uniq(dst_addr) AS unique_destinations
        FROM (
            SELECT IPv4NumToString(src_ip) AS ip,
                   IPv4NumToString(dst_ip) AS dst_addr,
                   bytes_total, flow_count
            FROM flow_agg_1min
            WHERE {dev_filter}
              AND minute >= now() - INTERVAL {minutes} MINUTE
            UNION ALL
            SELECT IPv6NumToString(src_ip6) AS ip,
                   IPv6NumToString(dst_ip6) AS dst_addr,
                   bytes_total, flow_count
            FROM flow_agg6_1min
            WHERE {dev_filter}
              AND minute >= now() - INTERVAL {minutes} MINUTE
        )
        GROUP BY ip
        ORDER BY bytes_total DESC
        LIMIT 200
    """)

    if not rows:
        return []

    ips = [r["ip"] for r in rows if not is_private(r["ip"])]
    # Enrich with abuse data (uses cache, fetches stale entries in background)
    import asyncio
    asyncio.create_task(enrich_ips(ips, abuseipdb_key))
    intel = await get_intel(ips)

    results = []
    for r in rows:
        ip     = r["ip"]
        entry  = intel.get(ip, {})
        score  = entry.get("abuse_score")
        if score is None or score < min_score:
            continue
        results.append({
            "ip":                  ip,
            "abuse_score":         score,
            "abuse_reports":       entry.get("abuse_reports"),
            "abuse_isp":           entry.get("abuse_isp"),
            "abuse_domain":        entry.get("abuse_domain"),
            "country_iso":         entry.get("country_iso"),
            "country_name":        entry.get("country_name"),
            "asn_org":             entry.get("asn_org"),
            "bytes_total":         int(r["bytes_total"]),
            "flow_count":          int(r["flow_count"]),
            "unique_destinations": int(r["unique_destinations"]),
        })

    results.sort(key=lambda x: x["abuse_score"], reverse=True)
    return results[:limit]


@router.get("/ip-intel", summary="Batch GeoIP + abuse intel for a list of IPs")
async def ip_intel_batch(
    ips:          str  = Query(..., description="Comma-separated IP addresses"),
    enrich:       bool = Query(default=False, description="Trigger background enrichment for stale entries"),
    principal:       Principal     = Depends(get_current_principal),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    ip_list = [ip.strip() for ip in ips.split(",") if ip.strip()][:50]
    if not ip_list:
        return {}

    if enrich:
        abuseipdb_key = await _get_abuseipdb_key(db)
        import asyncio
        asyncio.create_task(enrich_ips(ip_list, abuseipdb_key))

    intel = await get_intel(ip_list)
    return {
        ip: {
            "country_iso":   d.get("country_iso"),
            "country_name":  d.get("country_name"),
            "asn":           d.get("asn"),
            "asn_org":       d.get("asn_org"),
            "city":          d.get("city"),
            "abuse_score":   d.get("abuse_score"),
            "abuse_reports": d.get("abuse_reports"),
            "abuse_isp":     d.get("abuse_isp"),
            "abuse_domain":  d.get("abuse_domain"),
            "is_private":    d.get("is_private", False),
        }
        for ip, d in intel.items()
    }
