from __future__ import annotations

from ..config import get_settings


def vm_url() -> str:
    """Return the VictoriaMetrics base URL from settings."""
    return get_settings().victoriametrics_url


def ch_url() -> str:
    """Return the ClickHouse HTTP base URL from settings."""
    return get_settings().clickhouse_url
