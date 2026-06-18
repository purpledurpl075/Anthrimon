from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from typing import Optional

import httpx
import structlog
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

def _canon_port(s: Optional[str]) -> str:
    """Canonicalise an interface/port name so vendor abbreviations match:
    collapse the leading media-type word to its first two letters and keep only
    the numeric path. e.g. 'GigabitEthernet0/1' & 'Gi0/1' → 'gi0/1';
    'Ethernet1' & 'Et1' → 'et1'; 'Port-channel10' & 'Po10' → 'po10';
    '1/1/1' → '1/1/1'; a plain alpha name (e.g. 'console') is left as-is."""
    s = (s or "").strip().lower()
    if not s:
        return ""
    m = re.match(r"^([a-z]+)(.*)$", s)
    if m:
        digits = re.sub(r"[^0-9/.:]", "", m.group(2))
        return (m.group(1)[:2] + digits) if digits else s
    return re.sub(r"[^0-9/.:]", "", s)


from ..dependencies import (
    get_current_principal, get_db, Principal,
    accessible_device_ids_subquery, _tenant_device_ids, _is_tenant_wide,
)
from ..models.device import Device
from ..models.interface import Interface, LLDPNeighbor, CDPNeighbor
from ..database import AsyncSessionLocal
from ..services.urls import vm_url

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/topology", tags=["topology"])

_ZERO_UUID = "00000000-0000-0000-0000-000000000000"

# ── In-memory cache ────────────────────────────────────────────────────────────
# tenant_id → (computed_at, result_dict)
_cache:      dict[str, tuple[float, dict]] = {}
_in_flight:  set[str] = set()   # tenants currently being refreshed
CACHE_TTL    = 30                # seconds — return stale data instantly, refresh behind


def _cache_get(tenant_id: str) -> Optional[dict]:
    entry = _cache.get(tenant_id)
    if entry and (time.monotonic() - entry[0]) < CACHE_TTL:
        return entry[1]
    return None


def _cache_set(tenant_id: str, result: dict) -> None:
    _cache[tenant_id] = (time.monotonic(), result)
    if len(_cache) > 500:
        cutoff = time.monotonic() - CACHE_TTL * 10
        stale = [k for k, (t, _) in _cache.items() if t < cutoff]
        for k in stale:
            _cache.pop(k, None)


# ── Edge computation ───────────────────────────────────────────────────────────

async def _compute_edges(devices: list, db: AsyncSession) -> list[dict]:
    """Build edge list from LLDP/CDP neighbor tables — 3 queries total."""
    if not devices:
        return []

    dev_ids = [d.id for d in devices]

    dev_by_ip: dict[str, str] = {
        d.mgmt_ip_str: str(d.id) for d in devices
    }
    dev_by_host: dict[str, str] = {}
    for d in devices:
        if d.hostname:
            dev_by_host[d.hostname.lower()] = str(d.id)
        if d.fqdn:
            dev_by_host[d.fqdn.lower()] = str(d.id)

    def resolve_device(name: Optional[str], ip: Optional[str]) -> Optional[str]:
        if ip:
            clean = str(ip).split("/")[0]
            if clean in dev_by_ip:
                return dev_by_ip[clean]
        if name:
            key = name.lower()
            if key in dev_by_host:
                return dev_by_host[key]
            for host, did in dev_by_host.items():
                if key.startswith(host) or host.startswith(key):
                    return did
        return None

    # Fetch interfaces + both neighbor tables in parallel
    ifaces_q   = db.execute(select(Interface).where(Interface.device_id.in_(dev_ids)))
    lldp_q     = db.execute(select(LLDPNeighbor).where(LLDPNeighbor.device_id.in_(dev_ids)))
    cdp_q      = db.execute(select(CDPNeighbor).where(CDPNeighbor.device_id.in_(dev_ids)))

    ifaces_r, lldp_r, cdp_r = await asyncio.gather(ifaces_q, lldp_q, cdp_q)

    # Build several lookup indexes per device so a neighbor's port reference can
    # be matched to an interface even when the LLDP/CDP port name differs from the
    # SNMP ifName (e.g. "GigabitEthernet0/1" vs "Gi0/1", an ifIndex, or an ifAlias).
    iface_info:     dict[str, dict] = {}   # device:exact-name
    iface_by_canon: dict[str, dict] = {}   # device:canonical-name (abbrev-normalised)
    iface_by_index: dict[str, dict] = {}   # device:if_index
    iface_by_desc:  dict[str, dict] = {}   # device:lowercased description (ifAlias)
    for i in ifaces_r.scalars().all():
        dev = str(i.device_id)
        info = {"id": str(i.id), "speed_bps": i.speed_bps, "if_index": i.if_index}
        iface_info[f"{dev}:{i.name}"] = info
        iface_by_canon.setdefault(f"{dev}:{_canon_port(i.name)}", info)
        if i.if_index is not None:
            iface_by_index.setdefault(f"{dev}:{i.if_index}", info)
        if i.description:
            iface_by_desc.setdefault(f"{dev}:{i.description.strip().lower()}", info)

    def resolve_iface(dev_id: str, *candidates: Optional[str]) -> dict:
        """Resolve an interface for a device from one or more port references,
        trying exact name → canonical name → ifIndex → ifAlias in turn."""
        for c in candidates:
            if not c:
                continue
            # Some agents report the port as a quoted ifAlias (e.g. Arista
            # '"P2P -> vEOS7 Eth1"'); strip surrounding quotes before matching.
            cs = str(c).strip().strip('"').strip("'").strip()
            if not cs:
                continue
            hit = (iface_info.get(f"{dev_id}:{cs}")
                   or iface_by_canon.get(f"{dev_id}:{_canon_port(cs)}"))
            if hit:
                return hit
            if cs.isdigit():
                hit = iface_by_index.get(f"{dev_id}:{int(cs)}")
                if hit:
                    return hit
            hit = iface_by_desc.get(f"{dev_id}:{cs.lower()}")
            if hit:
                return hit
        return {}

    edges: list[dict] = []
    seen_pairs: set[frozenset] = set()

    for n in lldp_r.scalars().all():
        src_id = str(n.device_id)
        dst_id = resolve_device(n.remote_system_name, n.remote_mgmt_ip)
        if not dst_id or dst_id == src_id:
            continue
        pair = frozenset([src_id, dst_id])
        if pair in seen_pairs:
            continue
        seen_pairs.add(pair)
        src_iface = resolve_iface(src_id, n.local_port_name)
        # Resolve target interface via remote_port_desc (usually the SNMP name)
        # then remote_port_id (name / ifIndex / ifAlias, depending on subtype).
        dst_iface = resolve_iface(dst_id, n.remote_port_desc, n.remote_port_id)
        edges.append({
            "id":               f"lldp-{src_id[:8]}-{dst_id[:8]}",
            "source":           src_id,
            "target":           dst_id,
            "source_port":      n.local_port_name,
            "target_port":      n.remote_port_id or n.remote_port_desc,
            "source_iface_id":  src_iface.get("id"),
            "source_speed_bps": src_iface.get("speed_bps"),
            "source_if_index":  src_iface.get("if_index"),
            "target_iface_id":  dst_iface.get("id"),
            "target_speed_bps": dst_iface.get("speed_bps"),
            "protocol":         "lldp",
        })

    for n in cdp_r.scalars().all():
        src_id = str(n.device_id)
        dst_id = resolve_device(n.remote_device_id, n.remote_mgmt_ip)
        if not dst_id or dst_id == src_id:
            continue
        pair = frozenset([src_id, dst_id])
        if pair in seen_pairs:
            continue
        seen_pairs.add(pair)
        src_iface = resolve_iface(src_id, n.local_port_name)
        dst_iface = resolve_iface(dst_id, n.remote_port_id)
        edges.append({
            "id":               f"cdp-{src_id[:8]}-{dst_id[:8]}",
            "source":           src_id,
            "target":           dst_id,
            "source_port":      n.local_port_name,
            "target_port":      n.remote_port_id,
            "source_iface_id":  src_iface.get("id"),
            "source_speed_bps": src_iface.get("speed_bps"),
            "source_if_index":  src_iface.get("if_index"),
            "target_iface_id":  dst_iface.get("id"),
            "target_speed_bps": dst_iface.get("speed_bps"),
            "protocol":         "cdp",
        })

    return edges


# ── Topology persist ───────────────────────────────────────────────────────────

async def _persist_topology_links(tenant_id: str, edges: list[dict]) -> None:
    """Batch-upsert topology edges using unnest arrays — single round-trip."""
    if not edges:
        return
    try:
        # Normalise: canonical ordering (lower UUID = source)
        srcs, dsts, ltypes, metas, sifaces = [], [], [], [], []
        for edge in edges:
            src, dst = edge["source"], edge["target"]
            if src > dst:
                # Canonical ordering: lower UUID = source. Swap everything.
                src, dst = dst, src
                meta = {
                    "source_port":      edge.get("target_port"),
                    "dest_port":        edge.get("source_port"),
                    "source_speed_bps": edge.get("target_speed_bps"),
                    "dest_iface_id":    edge.get("source_iface_id"),
                }
                siface = edge.get("target_iface_id")
            else:
                meta = {
                    "source_port":      edge.get("source_port"),
                    "dest_port":        edge.get("target_port"),
                    "source_speed_bps": edge.get("source_speed_bps"),
                    "source_if_index":  edge.get("source_if_index"),
                    "dest_iface_id":    edge.get("target_iface_id"),
                }
                siface = edge.get("source_iface_id")
            srcs.append(src)
            dsts.append(dst)
            ltypes.append(edge.get("protocol", "lldp"))
            metas.append(json.dumps({k: v for k, v in meta.items() if v is not None}))
            sifaces.append(siface or _ZERO_UUID)

        async with AsyncSessionLocal() as db:
            # Full replace: wipe tenant's links then re-insert the current set.
            # This ensures downed interfaces (and their stale rows) are immediately
            # removed rather than persisting until the 10-minute prune window.
            await db.execute(
                text("DELETE FROM topology_links WHERE tenant_id = CAST(:tid AS uuid)"),
                {"tid": tenant_id},
            )
            if srcs:
                await db.execute(text("""
                    INSERT INTO topology_links
                        (tenant_id, source_device_id, source_interface_id,
                         dest_device_id, link_type, metadata, discovered_at, updated_at)
                    SELECT
                        CAST(:tid AS uuid),
                        unnest(CAST(:srcs AS uuid[])),
                        NULLIF(unnest(CAST(:sifaces AS uuid[])), CAST(:zero AS uuid)),
                        unnest(CAST(:dsts AS uuid[])),
                        unnest(CAST(:ltypes AS topology_link_type[])),
                        unnest(CAST(:metas AS jsonb[])),
                        now(), now()
                """), {
                    "tid":    tenant_id,
                    "srcs":   srcs,
                    "dsts":   dsts,
                    "ltypes": ltypes,
                    "metas":  metas,
                    "sifaces":sifaces,
                    "zero":   _ZERO_UUID,
                })
            await db.commit()
    except Exception:
        logger.exception("topology_links_persist_failed")


# ── Refresh ────────────────────────────────────────────────────────────────────

async def _refresh_topology(tenant_id: str) -> None:
    """Recompute topology, update topology_links, and populate the in-memory cache."""
    if tenant_id in _in_flight:
        return  # already running for this tenant
    _in_flight.add(tenant_id)
    t0 = time.monotonic()
    try:
        async with AsyncSessionLocal() as db:
            devices = (await db.execute(
                select(Device).where(
                    Device.tenant_id == uuid.UUID(tenant_id),
                    Device.is_active == True,  # noqa: E712
                )
            )).scalars().all()
            edges = await _compute_edges(devices, db)

        await _persist_topology_links(tenant_id, edges)

        connected_ids = {e["source"] for e in edges} | {e["target"] for e in edges}
        result = {
            "nodes": [
                {
                    "id":          str(d.id),
                    "hostname":    d.display_name,
                    "mgmt_ip":     d.mgmt_ip_str,
                    "vendor":      d.vendor,
                    "device_type": d.device_type,
                    "status":      d.status,
                    "connected":   str(d.id) in connected_ids,
                    "site_id":     str(d.site_id) if d.site_id else None,
                }
                for d in devices
            ],
            "edges": edges,
        }
        _cache_set(tenant_id, result)
        logger.debug("topology_refresh_complete", tenant_id=tenant_id,
                     nodes=len(result["nodes"]), edges=len(edges),
                     ms=round((time.monotonic() - t0) * 1000))
    except Exception:
        logger.exception("topology_refresh_failed", tenant_id=tenant_id)
    finally:
        _in_flight.discard(tenant_id)


async def start_topology_refresh_loop(interval_seconds: int = 300) -> asyncio.Task:
    """Periodic topology refresh — runs for all tenants concurrently."""
    async def _loop() -> None:
        while True:
            await asyncio.sleep(interval_seconds)
            try:
                async with AsyncSessionLocal() as db:
                    tenant_ids = (await db.execute(
                        text("SELECT DISTINCT tenant_id::text FROM devices WHERE is_active = true")
                    )).scalars().all()
                # Refresh all tenants concurrently
                await asyncio.gather(*[_refresh_topology(tid) for tid in tenant_ids],
                                     return_exceptions=True)
            except Exception:
                logger.exception("topology_refresh_loop_error")

    return asyncio.create_task(_loop(), name="topology-refresh-loop")


# ── Per-principal post-filter ─────────────────────────────────────────────────

def _filter_topology_for_principal(result: dict, principal: Principal, accessible_ids: set[str]) -> dict:
    """Restrict a (tenant-wide, possibly cached) topology result to the caller's accessible devices."""
    if _is_tenant_wide(principal):
        return result
    nodes = [n for n in result["nodes"] if n["id"] in accessible_ids]
    edges = [e for e in result["edges"] if e["source"] in accessible_ids and e["target"] in accessible_ids]
    return {"nodes": nodes, "edges": edges}


# ── HTTP endpoints ─────────────────────────────────────────────────────────────

@router.get("", summary="Network topology graph derived from LLDP/CDP neighbor data")
async def get_topology(
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> dict:
    tenant_id = str(principal.active_tenant_id)

    accessible_ids: set[str] = set()
    if not _is_tenant_wide(principal):
        accessible_ids = set(await _tenant_device_ids(principal, db))

    # Fast path: return cached result immediately
    cached = _cache_get(tenant_id)
    if cached is not None:
        return _filter_topology_for_principal(cached, principal, accessible_ids)

    # Stale or first load: check topology_links for a warm-start
    link_rows = (await db.execute(text("""
        SELECT source_device_id::text, source_interface_id::text,
               dest_device_id::text, link_type, metadata
        FROM topology_links
        WHERE tenant_id = :tid
    """), {"tid": tenant_id})).mappings().all()

    if link_rows:
        # Deduplicate by device pair — a stale row from a downed interface may
        # still exist alongside the new row until the next background refresh.
        seen_db: set[frozenset] = set()
        deduped = []
        for row in link_rows:
            pair = frozenset([row["source_device_id"], row["dest_device_id"]])
            if pair not in seen_db:
                seen_db.add(pair)
                deduped.append(row)
        link_rows = deduped

        # Return persisted edges immediately and refresh in background
        edges = [
            {
                "id":               f"{row['link_type']}-{row['source_device_id'][:8]}-{row['dest_device_id'][:8]}",
                "source":           row["source_device_id"],
                "target":           row["dest_device_id"],
                "source_port":      (row["metadata"] or {}).get("source_port"),
                "target_port":      (row["metadata"] or {}).get("dest_port"),
                "source_iface_id":  row["source_interface_id"],
                "source_speed_bps": (row["metadata"] or {}).get("source_speed_bps"),
                "source_if_index":  (row["metadata"] or {}).get("source_if_index"),
                "target_iface_id":  (row["metadata"] or {}).get("dest_iface_id"),
                "target_speed_bps": (row["metadata"] or {}).get("dest_speed_bps"),
                "protocol":         row["link_type"],
            }
            for row in link_rows
        ]
        devices = (await db.execute(
            select(Device).where(Device.tenant_id == principal.active_tenant_id,
                                 Device.is_active == True)  # noqa: E712
        )).scalars().all()
        connected_ids = {e["source"] for e in edges} | {e["target"] for e in edges}
        result = {
            "nodes": [
                {
                    "id":          str(d.id),
                    "hostname":    d.display_name,
                    "mgmt_ip":     d.mgmt_ip_str,
                    "vendor":      d.vendor,
                    "device_type": d.device_type,
                    "status":      d.status,
                    "connected":   str(d.id) in connected_ids,
                    "site_id":     str(d.site_id) if d.site_id else None,
                }
                for d in devices
            ],
            "edges": edges,
        }
        _cache_set(tenant_id, result)
        # Kick off background refresh — next request will get fresher data
        asyncio.create_task(_refresh_topology(tenant_id))
        return _filter_topology_for_principal(result, principal, accessible_ids)

    # Truly first run — compute synchronously so the page isn't blank
    await _refresh_topology(tenant_id)
    result = _cache.get(tenant_id, (0, {"nodes": [], "edges": []}))[1]
    return _filter_topology_for_principal(result, principal, accessible_ids)


@router.get("/link-utilisation", summary="Current utilisation snapshot for a set of interfaces")
async def get_link_utilisation_batch(
    iface_ids: str = Query(..., description="Comma-separated interface UUIDs"),
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> dict:
    raw_ids = [i.strip() for i in iface_ids.split(",") if i.strip()]
    if not raw_ids:
        return {}

    valid_uuids: list[uuid.UUID] = []
    for r in raw_ids:
        try:
            valid_uuids.append(uuid.UUID(r))
        except ValueError:
            pass
    if not valid_uuids:
        return {}

    rows = (await db.execute(
        select(Interface.id, Interface.device_id, Interface.if_index, Interface.speed_bps)
        .join(Device, Interface.device_id == Device.id)
        .where(
            Interface.id.in_(valid_uuids),
            Device.tenant_id == principal.active_tenant_id,
            Device.id.in_(accessible_device_ids_subquery(principal)),
        )
    )).all()
    if not rows:
        return {}

    key_to_iface: dict[tuple[str, str], tuple[str, int | None]] = {
        (str(r.device_id), str(r.if_index)): (str(r.id), r.speed_bps) for r in rows
    }
    device_re = "|".join({str(r.device_id) for r in rows})

    async def vm_instant(metric: str) -> dict[str, float]:
        query = f'rate({metric}{{device_id=~"{device_re}"}}[2m]) * 8'
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(f"{vm_url()}/api/v1/query",
                                        params={"query": query})
            series_list = resp.json().get("data", {}).get("result", [])
        except Exception:
            logger.exception("topo_util_vm_failed", metric=metric)
            return {}
        out: dict[str, float] = {}
        for series in series_list:
            did = series["metric"].get("device_id", "")
            idx = series["metric"].get("if_index", "")
            val = series.get("value")
            entry = key_to_iface.get((did, idx))
            if entry:
                out[entry[0]] = float(val[1]) if val else 0.0
        return out

    in_map, out_map = await asyncio.gather(
        vm_instant("anthrimon_if_in_octets_total"),
        vm_instant("anthrimon_if_out_octets_total"),
    )

    return {
        str(r.id): {
            "in_bps":    in_map.get(str(r.id), 0.0),
            "out_bps":   out_map.get(str(r.id), 0.0),
            "speed_bps": r.speed_bps,
        }
        for r in rows
    }
