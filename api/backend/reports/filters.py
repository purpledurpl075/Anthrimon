"""Shared date-range resolution for Advanced Reports. Centralizes the
window_days/window normalization that was previously duplicated ad-hoc
across every aggregation function in aggregations.py."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

# Per-type default lookback window in days when no explicit range or legacy
# window filter is given. inventory is a pure snapshot — no time dimension,
# not included here.
DEFAULT_DAYS: dict[str, int] = {
    "capacity": 30,
    "sla": 30,
    "compliance": 30,
    "alert_summary": 30,
    "config_changes": 30,
    "flow_top_talkers": 7,
    "interface_health": 7,
    "bgp_health": 30,
    "syslog_security": 7,
}


def normalize_range(filters: dict, report_type: str) -> tuple[datetime, datetime, int]:
    """Resolve a report's (start, end, days) from its filters dict.

    Resolution order: explicit ISO `start`/`end` strings (both tz-aware or
    both naive-assumed-UTC) > legacy `window_days` (int, used by every type
    except capacity) / `window` (string VM duration literal like "30d",
    capacity only) for back-compat with already-saved schedules > the
    per-type default in DEFAULT_DAYS.
    """
    raw_start = filters.get("start")
    raw_end = filters.get("end")
    if raw_start and raw_end:
        start = datetime.fromisoformat(str(raw_start))
        end = datetime.fromisoformat(str(raw_end))
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        if end.tzinfo is None:
            end = end.replace(tzinfo=timezone.utc)
        days = max(1, (end - start).days)
        return start, end, days

    end = datetime.now(timezone.utc)
    if "window_days" in filters:
        days = int(filters["window_days"])
    elif "window" in filters and str(filters["window"]).endswith("d"):
        days = int(str(filters["window"])[:-1])
    else:
        days = DEFAULT_DAYS.get(report_type, 30)
    start = end - timedelta(days=days)
    return start, end, days


def shift_back(start: datetime, end: datetime) -> tuple[datetime, datetime]:
    """The immediately preceding period of equal length — for period-over-period
    comparison (feature 3). [start-span, start) precedes [start, end]."""
    span = end - start
    return start - span, start
