"""Registry of generic metrics that can be plotted on custom-dashboard
"metric" widgets (gauge / stat / graph).

Each entry is a small PromQL template with `$device` / `$interface`
placeholders, substituted by routers/metrics.py after validating the caller
has access to the target device.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class MetricDef:
    id: str
    label: str
    category: str       # "device" | "interface"
    unit: str
    value_type: str     # "gauge" (bounded 0-100-ish) | "raw" (open-ended)
    default_max: Optional[float]
    promql: str
    thresholds: Optional[dict] = None   # {"warn": float, "crit": float}
    # interface.utilization_pct only: the promql above yields a bps numerator;
    # the router divides by the interface's speed_bps (from Postgres) * 100.
    needs_interface_speed: bool = False


METRIC_REGISTRY: list[MetricDef] = [
    MetricDef(
        id="device.cpu_pct", label="CPU Utilization", category="device", unit="%",
        value_type="gauge", default_max=100,
        promql='anthrimon_device_cpu_util_pct{device_id="$device"}',
        thresholds={"warn": 70, "crit": 90},
    ),
    MetricDef(
        id="device.mem_pct", label="Memory Utilization", category="device", unit="%",
        value_type="gauge", default_max=100,
        promql='(anthrimon_device_mem_used_bytes{device_id="$device",mem_type="ram"} '
               '/ anthrimon_device_mem_total_bytes{device_id="$device",mem_type="ram"})*100',
        thresholds={"warn": 70, "crit": 90},
    ),
    MetricDef(
        id="device.rtt_ms", label="Ping RTT", category="device", unit="ms",
        value_type="raw", default_max=None,
        promql='anthrimon_device_rtt_ms{device_id="$device",stat="avg"}',
        thresholds={"warn": 100, "crit": 300},
    ),
    MetricDef(
        id="device.loss_pct", label="Packet Loss", category="device", unit="%",
        value_type="gauge", default_max=100,
        promql='anthrimon_device_loss_pct{device_id="$device"}',
        thresholds={"warn": 1, "crit": 5},
    ),
    MetricDef(
        id="device.temp_c", label="Temperature", category="device", unit="°C",
        value_type="raw", default_max=None,
        promql='max(anthrimon_device_temp_celsius{device_id="$device"})',
        thresholds={"warn": 60, "crit": 75},
    ),
    MetricDef(
        id="interface.in_bps", label="Inbound Traffic", category="interface", unit="bps",
        value_type="raw", default_max=None,
        promql='rate(anthrimon_if_in_octets_total{device_id="$device",if_name="$interface"}[5m])*8',
    ),
    MetricDef(
        id="interface.out_bps", label="Outbound Traffic", category="interface", unit="bps",
        value_type="raw", default_max=None,
        promql='rate(anthrimon_if_out_octets_total{device_id="$device",if_name="$interface"}[5m])*8',
    ),
    MetricDef(
        id="interface.utilization_pct", label="Utilization", category="interface", unit="%",
        value_type="gauge", default_max=100,
        promql='rate(anthrimon_if_in_octets_total{device_id="$device",if_name="$interface"}[5m])*8',
        thresholds={"warn": 70, "crit": 90},
        needs_interface_speed=True,
    ),
    MetricDef(
        id="interface.errors_rate", label="Errors/Discards", category="interface", unit="err/s",
        value_type="raw", default_max=None,
        promql='rate(anthrimon_if_in_errors_total{device_id="$device",if_name="$interface"}[5m]) '
               '+ rate(anthrimon_if_out_errors_total{device_id="$device",if_name="$interface"}[5m])',
        thresholds={"warn": 1, "crit": 10},
    ),
]

METRIC_BY_ID: dict[str, MetricDef] = {m.id: m for m in METRIC_REGISTRY}
