"""Failure notification for scheduled reports (feature 6). Mirrors
configmgmt/collector.py's _fire_config_change_alerts() — reuses the tenant's
existing AlertRule/NotificationChannel machinery (channel_ids, retry,
cooldown, business-hours, send-logging) rather than inventing a parallel
notification path. A tenant admin opts in by creating an AlertRule with
metric == "report_failure" and attaching their desired channel_ids, exactly
as they already do for config_change."""
from __future__ import annotations

import hashlib
import uuid
from datetime import datetime, timezone

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.alert import Alert, AlertRule
from ..models.report import ScheduledReport

logger = structlog.get_logger(__name__)


async def fire_report_failure_alert(db: AsyncSession, sched: ScheduledReport, error: str) -> None:
    """Create an Alert + dispatch notifications for any tenant AlertRule
    configured with metric == "report_failure". Never raises — a notify
    failure must not break the scheduler's retry/bookkeeping loop (the
    caller wraps this in its own try/except regardless, matching the
    config_change mirror's isolation)."""
    from ..alerting import notify

    rules = (await db.execute(
        select(AlertRule).where(
            AlertRule.tenant_id == sched.tenant_id,
            AlertRule.metric == "report_failure",
            AlertRule.is_enabled == True,  # noqa: E712
        )
    )).scalars().all()

    if not rules:
        return

    now = datetime.now(timezone.utc)
    fp_base = hashlib.sha256(f"report_failure:{sched.id}".encode()).hexdigest()[:32]

    for rule in rules:
        alert = Alert(
            id=uuid.uuid4(),
            tenant_id=rule.tenant_id,
            rule_id=rule.id,
            device_id=None,
            severity=rule.severity,
            status="open",
            title=f"Scheduled report '{sched.name}' failed {sched.consecutive_failures}x",
            message=rule.description or error[:500],
            context={
                "metric": "report_failure",
                "schedule_id": str(sched.id),
                "schedule_name": sched.name,
                "consecutive_failures": sched.consecutive_failures,
                "error": error[:500],
            },
            triggered_at=now,
            fingerprint=f"{fp_base}:{sched.consecutive_failures}",
            last_notified_at=now,
        )
        db.add(alert)
        await db.commit()

        logger.info("report_failure_alert_fired", schedule_id=str(sched.id), rule=rule.name,
                    consecutive_failures=sched.consecutive_failures)

        try:
            await notify.dispatch(alert, rule, resolved=False)
        except Exception as exc:
            logger.error("report_failure_notify_failed", error=str(exc))
