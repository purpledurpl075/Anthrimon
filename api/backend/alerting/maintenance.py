"""Maintenance window active-check logic shared by the engine and API."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

if TYPE_CHECKING:
    from ..models.alert import MaintenanceWindow


def is_window_active(window: "MaintenanceWindow", now: datetime) -> bool:
    if not window.is_recurring:
        return window.starts_at <= now <= window.ends_at

    if not window.recurrence_cron:
        return False

    try:
        from croniter import croniter
        duration = window.ends_at - window.starts_at
        # Find the most recent scheduled start at or before now
        cron = croniter(window.recurrence_cron, now)
        last_start = cron.get_prev(datetime).replace(tzinfo=timezone.utc)
        return now <= last_start + duration
    except Exception:
        return False


async def load_active_windows(db: AsyncSession, tenant_id: str) -> list["MaintenanceWindow"]:
    """Load all currently active maintenance windows for a tenant."""
    from ..models.alert import MaintenanceWindow
    from sqlalchemy import text as _text, or_ as _or

    now = datetime.now(timezone.utc)
    # Push non-recurring window time filter to SQL to avoid loading expired rows.
    # Recurring windows must still be checked in Python (is_window_active handles cron logic).
    rows = (await db.execute(
        select(MaintenanceWindow).where(
            MaintenanceWindow.tenant_id == tenant_id,
            _or(
                MaintenanceWindow.is_recurring == True,  # noqa: E712
                (MaintenanceWindow.starts_at <= now) & (MaintenanceWindow.ends_at >= now),
            ),
        )
    )).scalars().all()

    return [w for w in rows if is_window_active(w, now)]


def device_in_maintenance(device: dict, active_windows: list["MaintenanceWindow"]) -> bool:
    """Return True if any active window covers this device."""
    device_id = device.get("id", "")
    tags = device.get("tags") or []
    if isinstance(tags, str):
        import json
        try:
            tags = json.loads(tags)
        except Exception:
            tags = []

    for w in active_windows:
        sel = w.device_selector
        if sel is None:
            return True  # window applies to all devices
        if "device_ids" in sel and device_id in (sel["device_ids"] or []):
            return True
        if "tags" in sel and any(t in tags for t in (sel["tags"] or [])):
            return True
        if "vendors" in sel and device.get("vendor") in (sel["vendors"] or []):
            return True

    return False
