"""Periodic housekeeping: prune unbounded Postgres tables.

Runs every 6 hours and deletes rows older than the configured retention
windows.  Retention periods are intentionally generous defaults —
operators can tune them via platform settings if needed.
"""
from __future__ import annotations

import asyncio

import structlog
from sqlalchemy import text

from .database import AsyncSessionLocal

logger = structlog.get_logger(__name__)

RETENTION_DEFAULTS = {
    "interface_status_log_days": 90,
    "bgp_session_events_days": 90,
    "notification_send_log_days": 90,
    "config_backups_keep_per_device": 50,
    "compliance_results_keep_per_pair": 20,
    "trap_events_days": 30,
}


async def _run_housekeeping() -> None:
    async with AsyncSessionLocal() as db:
        # Interface status log
        days = RETENTION_DEFAULTS["interface_status_log_days"]
        res = await db.execute(text(
            f"DELETE FROM interface_status_log "
            f"WHERE recorded_at < now() - interval '{days} days'"
        ))
        if res.rowcount:
            logger.info("housekeeping_pruned", table="interface_status_log", deleted=res.rowcount, retention_days=days)

        # BGP session events
        days = RETENTION_DEFAULTS["bgp_session_events_days"]
        res = await db.execute(text(
            f"DELETE FROM bgp_session_events "
            f"WHERE recorded_at < now() - interval '{days} days'"
        ))
        if res.rowcount:
            logger.info("housekeeping_pruned", table="bgp_session_events", deleted=res.rowcount, retention_days=days)

        # Notification send log
        days = RETENTION_DEFAULTS["notification_send_log_days"]
        res = await db.execute(text(
            f"DELETE FROM notification_send_log "
            f"WHERE sent_at < now() - interval '{days} days'"
        ))
        if res.rowcount:
            logger.info("housekeeping_pruned", table="notification_send_log", deleted=res.rowcount, retention_days=days)

        # Trap events
        days = RETENTION_DEFAULTS["trap_events_days"]
        res = await db.execute(text(
            f"DELETE FROM trap_events "
            f"WHERE received_at < now() - interval '{days} days'"
        ))
        if res.rowcount:
            logger.info("housekeeping_pruned", table="trap_events", deleted=res.rowcount, retention_days=days)

        # Config backups — keep N most recent per device
        keep = RETENTION_DEFAULTS["config_backups_keep_per_device"]
        res = await db.execute(text(f"""
            DELETE FROM config_backups
            WHERE id IN (
                SELECT id FROM (
                    SELECT id, ROW_NUMBER() OVER (
                        PARTITION BY device_id ORDER BY collected_at DESC
                    ) AS rn
                    FROM config_backups
                ) ranked
                WHERE rn > {keep}
            )
        """))
        if res.rowcount:
            logger.info("housekeeping_pruned", table="config_backups", deleted=res.rowcount, keep_per_device=keep)

        # Compliance results — keep N most recent per device+policy
        keep = RETENTION_DEFAULTS["compliance_results_keep_per_pair"]
        res = await db.execute(text(f"""
            DELETE FROM compliance_results
            WHERE id IN (
                SELECT id FROM (
                    SELECT id, ROW_NUMBER() OVER (
                        PARTITION BY device_id, policy_id ORDER BY checked_at DESC
                    ) AS rn
                    FROM compliance_results
                ) ranked
                WHERE rn > {keep}
            )
        """))
        if res.rowcount:
            logger.info("housekeeping_pruned", table="compliance_results", deleted=res.rowcount, keep_per_pair=keep)

        await db.commit()


async def _housekeeping_loop(interval_s: int = 21600) -> None:
    """Run housekeeping on startup and then every interval_s seconds (default 6h)."""
    await asyncio.sleep(60)
    while True:
        try:
            await _run_housekeeping()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("housekeeping_error")
        await asyncio.sleep(interval_s)


def start_housekeeping(interval_s: int = 21600) -> asyncio.Task:
    return asyncio.create_task(_housekeeping_loop(interval_s))
