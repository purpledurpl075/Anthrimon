"""Period-over-period comparison for Advanced Reports (feature 3). Wraps a
normal aggregation call with a second call over the immediately preceding
period of equal length, then computes small per-type deltas. PDF-only —
CSV export uses the plain "current" dict and ignores comparison entirely.
"""
from __future__ import annotations

import uuid
from typing import Callable

from sqlalchemy.ext.asyncio import AsyncSession

from .aggregations import REPORT_DATA_FUNCS
from .filters import normalize_range, shift_back


def _pct_delta(cur: float | None, prev: float | None) -> float | None:
    if cur is None or prev is None or prev == 0:
        return None
    return round((cur - prev) / prev * 100, 1)


def _delta_capacity(current: dict, previous: dict) -> dict:
    prev_by_id = {d["device_id"]: d for d in previous.get("devices", [])}
    devices = []
    for d in current.get("devices", []):
        p = prev_by_id.get(d["device_id"], {})
        devices.append({
            "device_id": d["device_id"], "hostname": d["hostname"],
            "avg_cpu_pct_delta_pct": _pct_delta(d.get("avg_cpu_pct"), p.get("avg_cpu_pct")),
            "avg_in_bps_delta_pct": _pct_delta(d.get("avg_in_bps"), p.get("avg_in_bps")),
        })
    return {"devices": devices}


def _delta_sla(current: dict, previous: dict) -> dict:
    prev_by_id = {d["device_id"]: d for d in previous.get("devices", [])}
    devices = []
    for d in current.get("devices", []):
        p = prev_by_id.get(d["device_id"])
        devices.append({
            "device_id": d["device_id"], "hostname": d["hostname"],
            "uptime_pct_delta": round(d["uptime_pct"] - p["uptime_pct"], 3) if p else None,
        })
    return {"devices": devices}


def _delta_compliance(current: dict, previous: dict) -> dict:
    prev_by_policy = {s["policy"]: s for s in previous.get("summary", [])}
    summary = []
    for s in current.get("summary", []):
        p = prev_by_policy.get(s["policy"], {})
        summary.append({
            "policy": s["policy"],
            "fail_delta": s.get("fail", 0) - p.get("fail", 0),
            "pass_delta": s.get("pass", 0) - p.get("pass", 0),
        })
    return {"summary": summary}


def _delta_alert_summary(current: dict, previous: dict) -> dict:
    prev_by_sev = {s["severity"]: s for s in previous.get("by_severity", [])}
    by_severity = []
    for s in current.get("by_severity", []):
        p = prev_by_sev.get(s["severity"], {})
        by_severity.append({
            "severity": s["severity"],
            "alert_count_delta": s["alert_count"] - p.get("alert_count", 0),
            "alert_count_delta_pct": _pct_delta(s["alert_count"], p.get("alert_count")),
        })
    return {
        "total_alerts_delta": current.get("total_alerts", 0) - previous.get("total_alerts", 0),
        "total_alerts_delta_pct": _pct_delta(current.get("total_alerts"), previous.get("total_alerts")),
        "by_severity": by_severity,
    }


def _delta_config_changes(current: dict, previous: dict) -> dict:
    cur_n, prev_n = len(current.get("changes", [])), len(previous.get("changes", []))
    return {
        "change_count_delta": cur_n - prev_n,
        "change_count_delta_pct": _pct_delta(cur_n, prev_n),
    }


def _delta_flow_top_talkers(current: dict, previous: dict) -> dict:
    cur_bytes = sum(t["bytes_total"] for t in current.get("talkers", []))
    prev_bytes = sum(t["bytes_total"] for t in previous.get("talkers", []))
    return {
        "total_bytes_delta": cur_bytes - prev_bytes,
        "total_bytes_delta_pct": _pct_delta(cur_bytes, prev_bytes),
    }


def _delta_interface_health(current: dict, previous: dict) -> dict:
    prev_by_host = {d["hostname"]: d for d in previous.get("devices", [])}
    devices = []
    for d in current.get("devices", []):
        p = prev_by_host.get(d["hostname"], {})
        cur_total = d["in_errors"] + d["out_errors"] + d["flap_count"]
        prev_total = p.get("in_errors", 0) + p.get("out_errors", 0) + p.get("flap_count", 0)
        devices.append({"hostname": d["hostname"], "total_delta": cur_total - prev_total})
    return {"devices": devices}


def _delta_bgp_health(current: dict, previous: dict) -> dict:
    prev_by_key = {(s["hostname"], s["peer_ip"]): s for s in previous.get("sessions", [])}
    sessions = []
    for s in current.get("sessions", []):
        p = prev_by_key.get((s["hostname"], s["peer_ip"]), {})
        sessions.append({
            "hostname": s["hostname"], "peer_ip": s["peer_ip"],
            "state_changes_delta": s["state_changes_in_window"] - p.get("state_changes_in_window", 0),
        })
    return {"sessions": sessions}


# Types with a meaningful "previous period" comparison. inventory (no time
# axis) and syslog_security (not scoped into this batch) are excluded —
# get_report_data_with_comparison() falls back to plain current-period data
# for any type not in this dict, even if filters["compare"] is set.
REPORT_DELTA_FUNCS: dict[str, Callable[[dict, dict], dict]] = {
    "capacity": _delta_capacity,
    "sla": _delta_sla,
    "compliance": _delta_compliance,
    "alert_summary": _delta_alert_summary,
    "config_changes": _delta_config_changes,
    "flow_top_talkers": _delta_flow_top_talkers,
    "interface_health": _delta_interface_health,
    "bgp_health": _delta_bgp_health,
}


async def get_report_data_with_comparison(
    report_type: str, db: AsyncSession, tenant_id: uuid.UUID, filters: dict,
) -> dict:
    """Runs the normal aggregation for report_type. If filters["compare"] is
    truthy and the type supports comparison, also aggregates the immediately
    preceding period of equal length and computes deltas, returning
    {"current":..., "previous":..., "deltas":..., "compare": True}. Otherwise
    returns the plain current-period dict unchanged — so callers that don't
    ask for comparison, and CSV export (which never asks), see no shape
    change at all."""
    data_func = REPORT_DATA_FUNCS[report_type]
    current = await data_func(db, tenant_id, filters)

    if not filters.get("compare") or report_type not in REPORT_DELTA_FUNCS:
        return current

    start, end, _days = normalize_range(filters, report_type)
    prev_start, prev_end = shift_back(start, end)
    prev_filters = dict(filters)
    prev_filters.pop("window_days", None)
    prev_filters.pop("window", None)
    prev_filters["start"] = prev_start.isoformat()
    prev_filters["end"] = prev_end.isoformat()

    previous = await data_func(db, tenant_id, prev_filters)
    deltas = REPORT_DELTA_FUNCS[report_type](current, previous)
    return {"current": current, "previous": previous, "deltas": deltas, "compare": True}
