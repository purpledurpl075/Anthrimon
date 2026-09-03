from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

# Shared with routers/bgp.py so the Routing tab's "is this device actually
# reachable" check uses the exact same threshold as eval_device_down(),
# rather than a second, potentially-drifting copy of the formula.


def device_stale_seconds(poll_interval_s: int, platform: Optional[dict]) -> int:
    """Stale threshold in seconds: device_down_stale_multiplier x the device's
    own poll interval, floored at device_down_stale_min_s (platform settings,
    default 6x and 90s respectively)."""
    stale_min = int((platform or {}).get("device_down_stale_min_s", 90))
    stale_multiplier = float((platform or {}).get("device_down_stale_multiplier", 6))
    return max(stale_min, int(poll_interval_s * stale_multiplier))


def is_device_stale(
    last_polled: Optional[datetime],
    poll_interval_s: int,
    platform: Optional[dict],
) -> bool:
    if last_polled is None:
        return True
    threshold = device_stale_seconds(poll_interval_s, platform)
    return (datetime.now(timezone.utc) - last_polled).total_seconds() > threshold
