"""Built-in starter dashboard templates.

Each template is a static layout (widget type + grid position + optional
config) that can be cloned into a new dashboard owned by the requesting user.
Widgets are listed without `instance_id` — the clone endpoint assigns a fresh
UUID per widget so multiple clones never collide.
"""
from __future__ import annotations

from typing import TypedDict


class TemplateWidget(TypedDict, total=False):
    type: str
    x: int
    y: int
    w: int
    h: int
    config: dict


class DashboardTemplate(TypedDict):
    name: str
    description: str
    layout: dict


DASHBOARD_TEMPLATES: dict[str, DashboardTemplate] = {
    "noc-overview": {
        "name": "NOC Overview",
        "description": "At-a-glance health for a network operations center: open alerts, problem devices, and routing status.",
        "layout": {
            "time_range": "24h",
            "refresh_interval_s": 60,
            "widgets": [
                {"type": "alert_severity",   "x": 0, "y": 0, "w": 6, "h": 3},
                {"type": "problem_devices",  "x": 6, "y": 0, "w": 6, "h": 3},
                {"type": "open_alerts",      "x": 0, "y": 3, "w": 6, "h": 3},
                {"type": "routing_health",   "x": 6, "y": 3, "w": 6, "h": 3},
                {"type": "syslog_activity",  "x": 0, "y": 6, "w": 6, "h": 2},
                {"type": "collector_status", "x": 6, "y": 6, "w": 6, "h": 2},
            ],
        },
    },
    "capacity-planning": {
        "name": "Capacity Planning",
        "description": "Top resource consumers plus free-form gauges for the links and devices you care about most.",
        "layout": {
            "time_range": "24h",
            "refresh_interval_s": 60,
            "widgets": [
                {"type": "top_cpu",      "x": 0, "y": 0, "w": 4, "h": 3},
                {"type": "top_memory",   "x": 4, "y": 0, "w": 4, "h": 3},
                {"type": "metric_graph", "x": 8, "y": 0, "w": 4, "h": 3,
                 "config": {"title": "Configure this widget"}},
                {"type": "top_bandwidth","x": 0, "y": 3, "w": 12, "h": 4},
                {"type": "metric_graph", "x": 0, "y": 7, "w": 6, "h": 3,
                 "config": {"title": "Configure this widget"}},
                {"type": "metric_graph", "x": 6, "y": 7, "w": 6, "h": 3,
                 "config": {"title": "Configure this widget"}},
            ],
        },
    },
    "routing-health": {
        "name": "Routing Health",
        "description": "BGP and OSPF session state, prefix counts, and recent flaps across the network.",
        "layout": {
            "time_range": "24h",
            "refresh_interval_s": 60,
            "widgets": [
                {"type": "bgp_summary",       "x": 0, "y": 0, "w": 6, "h": 3},
                {"type": "bgp_prefix_totals", "x": 6, "y": 0, "w": 6, "h": 3},
                {"type": "ospf_areas",        "x": 0, "y": 3, "w": 4, "h": 3},
                {"type": "bgp_flap_log",      "x": 4, "y": 3, "w": 8, "h": 4},
            ],
        },
    },
    "syslog-bandwidth": {
        "name": "Syslog & Bandwidth",
        "description": "Live syslog activity alongside the busiest interfaces and devices.",
        "layout": {
            "time_range": "24h",
            "refresh_interval_s": 60,
            "widgets": [
                {"type": "top_bandwidth",   "x": 0, "y": 0, "w": 12, "h": 4},
                {"type": "syslog_activity", "x": 0, "y": 4, "w": 4, "h": 2},
                {"type": "syslog_heatmap",  "x": 4, "y": 4, "w": 8, "h": 3},
                {"type": "syslog_feed",     "x": 0, "y": 7, "w": 12, "h": 4},
            ],
        },
    },
}
