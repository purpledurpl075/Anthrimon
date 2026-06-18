"""Public state-writer facade.

Provides stable public names for the device protocol-state write functions
that are implemented in the configmgmt layer.  Both the REST state collector
background loop and the remote-collector ingest endpoints import from here
instead of directly importing private symbols from configmgmt sub-modules.
"""
from __future__ import annotations

import uuid

from ..configmgmt.rest_state import _write_bgp as _bgp_impl
from ..configmgmt.rest_state import _write_ospf as _ospf_impl
from ..configmgmt.rest_state import _write_routes as _routes_impl
from ..configmgmt.eapi_collector import _write_isis_neighbors as _isis_impl


async def write_bgp_sessions(device_id: uuid.UUID, peers: list[dict]) -> None:
    """Upsert BGP sessions for a device and push metrics to VictoriaMetrics."""
    await _bgp_impl(device_id, peers)


async def write_ospf_neighbors(device_id: uuid.UUID, neighbors: list[dict]) -> None:
    """Upsert OSPF neighbors for a device."""
    await _ospf_impl(device_id, neighbors)


async def write_routes(device_id: uuid.UUID, routes: list[dict]) -> None:
    """Upsert route table entries for a device (mark-and-sweep for stale rows)."""
    await _routes_impl(device_id, routes)


async def write_isis_neighbors(device_id: uuid.UUID, rows: list[dict]) -> None:
    """Upsert IS-IS adjacencies for a device."""
    await _isis_impl(device_id, rows)
