"""Generic metric catalog + query endpoint for custom-dashboard "metric"
widgets (gauge / stat / graph)."""
from __future__ import annotations

import time
import uuid
from typing import Optional

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import Principal, accessible_device_ids_subquery, get_current_principal, get_db
from ..metrics_registry import METRIC_BY_ID, METRIC_REGISTRY
from ..models.device import Device
from ..models.interface import Interface
from ..schemas.metrics import MetricDefOut

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/metrics", tags=["metrics"])

_VM_URL = "http://localhost:8428"


def _escape_label(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


async def _vm_instant(query: str) -> tuple[Optional[float], Optional[int]]:
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(f"{_VM_URL}/api/v1/query", params={"query": query})
            r.raise_for_status()
            result = r.json().get("data", {}).get("result", [])
            if result and result[0].get("value"):
                ts, val = result[0]["value"]
                return float(val), int(float(ts))
    except Exception:
        pass
    return None, None


async def _vm_range(query: str, start: int, end: int, step: int) -> list[list[float]]:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                f"{_VM_URL}/api/v1/query_range",
                params={"query": query, "start": start, "end": end, "step": step},
            )
            r.raise_for_status()
            result = r.json().get("data", {}).get("result", [])
            if result:
                return [[int(v[0]), float(v[1])] for v in result[0].get("values", [])]
    except Exception:
        pass
    return []


def _range_step(range_minutes: float) -> int:
    if range_minutes <= 60:
        return 30
    if range_minutes <= 360:
        return 60
    if range_minutes <= 1440:
        return 300
    return 3600


@router.get("/catalog", response_model=list[MetricDefOut], summary="List available generic metrics")
async def metric_catalog(
    principal: Principal = Depends(get_current_principal),
) -> list[MetricDefOut]:
    return [
        MetricDefOut(
            id=m.id, label=m.label, category=m.category, unit=m.unit,
            value_type=m.value_type, default_max=m.default_max, thresholds=m.thresholds,
        )
        for m in METRIC_REGISTRY
    ]


@router.get("/query", summary="Query a generic metric for a device/interface")
async def query_metric(
    metric_id: str = Query(...),
    device_id: uuid.UUID = Query(...),
    interface_name: Optional[str] = Query(default=None),
    mode: str = Query(default="instant", pattern="^(instant|range)$"),
    range_minutes: float = Query(default=60, ge=1, le=10080),
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> dict:
    metric = METRIC_BY_ID.get(metric_id)
    if metric is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown metric")
    if metric.category == "interface" and not interface_name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="interface_name is required for this metric")

    exists = (await db.execute(
        select(Device.id).where(
            Device.id == device_id,
            Device.id.in_(accessible_device_ids_subquery(principal)),
        )
    )).scalar_one_or_none()
    if exists is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")

    promql = metric.promql.replace("$device", str(device_id))
    if interface_name:
        promql = promql.replace("$interface", _escape_label(interface_name))

    speed_bps: Optional[int] = None
    if metric.needs_interface_speed:
        speed_bps = (await db.execute(
            select(Interface.speed_bps).where(
                Interface.device_id == device_id,
                Interface.name == interface_name,
            )
        )).scalar_one_or_none()

    if mode == "range":
        now   = int(time.time())
        start = now - int(range_minutes * 60)
        step  = _range_step(range_minutes)
        series = await _vm_range(promql, start, now, step)
        if metric.needs_interface_speed:
            series = [[ts, round(v / speed_bps * 100, 4)] for ts, v in series] if speed_bps else []
        return {"unit": metric.unit, "series": series}

    value, ts = await _vm_instant(promql)
    if metric.needs_interface_speed:
        value = round(value / speed_bps * 100, 4) if (value is not None and speed_bps) else None
    return {"unit": metric.unit, "value": value, "timestamp": ts}
