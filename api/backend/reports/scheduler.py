"""Background loop that fires due scheduled reports. Mirrors
configmgmt.collector.ConfigCollector's asyncio.sleep interval-loop shape."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import structlog
from sqlalchemy import select

from ..database import AsyncSessionLocal
from ..models.report import ReportRun, ScheduledReport
from .generator import generate_and_store

logger = structlog.get_logger(__name__)

DEFAULT_INTERVAL_S = 60  # checking for due reports is cheap; unlike device
                         # polling there's no external device load to throttle


def _next_fire(cron_expr: str, now: datetime) -> datetime | None:
    try:
        from croniter import croniter
        return croniter(cron_expr, now).get_next(datetime).replace(tzinfo=timezone.utc)
    except Exception:
        logger.warning("report_schedule_bad_cron", cron=cron_expr)
        return None


class ReportScheduler:
    """Background loop that fires due scheduled reports."""

    def __init__(self, interval_s: int = DEFAULT_INTERVAL_S):
        self.interval_s = interval_s

    async def run(self) -> None:
        logger.info("report_scheduler_started", interval_s=self.interval_s)
        await asyncio.sleep(30)  # let the app finish startup first
        while True:
            try:
                await self._fire_due()
            except Exception:
                logger.exception("report_scheduler_error")
            await asyncio.sleep(self.interval_s)

    async def _fire_due(self) -> None:
        now = datetime.now(timezone.utc)
        async with AsyncSessionLocal() as db:
            from ..alerting.settings import load_platform_defaults
            platform = await load_platform_defaults(db)
            failure_threshold = int(platform.get("report_schedule_failure_threshold", 3))

            due = (await db.execute(
                select(ScheduledReport).where(
                    ScheduledReport.is_enabled == True,   # noqa: E712
                    ScheduledReport.next_run_at <= now,
                )
            )).scalars().all()

            for sched in due:
                schedule_ok = True
                last_error: str | None = None

                for fmt in sched.formats:
                    run = ReportRun(
                        tenant_id=sched.tenant_id,
                        scheduled_report_id=sched.id,
                        report_type=sched.report_type,
                        format=fmt,
                        status="pending",
                    )
                    db.add(run)
                    await db.commit()
                    await db.refresh(run)
                    logger.info("scheduled_report_firing", schedule_id=str(sched.id),
                               name=sched.name, format=fmt, run_id=str(run.id))

                    # Retry with backoff — generate_and_store never raises, so
                    # retry-worthiness is read off run.status after each call.
                    for attempt in range(3):
                        await generate_and_store(
                            run_id=run.id, tenant_id=sched.tenant_id,
                            report_type=sched.report_type, fmt=fmt,
                            filters=sched.filters, email_to=sched.recipients,
                            email_subject=sched.email_subject, email_note=sched.email_note,
                        )
                        await db.refresh(run)
                        if run.status == "success":
                            break
                        logger.warning("scheduled_report_attempt_failed", schedule_id=str(sched.id),
                                      run_id=str(run.id), attempt=attempt + 1, error=run.error)
                        if attempt < 2:
                            await asyncio.sleep(2 ** attempt)
                            run.status = "pending"
                            await db.commit()

                    if run.status != "success":
                        schedule_ok = False
                        last_error = run.error or "unknown error"
                        run.error = f"[attempt {attempt + 1}/3] {last_error}"
                        await db.commit()

                if schedule_ok:
                    sched.consecutive_failures = 0
                    sched.last_failure_notified_at = None
                else:
                    sched.consecutive_failures += 1
                    if (sched.consecutive_failures >= failure_threshold
                            and sched.last_failure_notified_at is None):
                        from .alerts import fire_report_failure_alert
                        try:
                            await fire_report_failure_alert(db, sched, last_error or "unknown error")
                        except Exception:
                            logger.exception("report_failure_alert_error", schedule_id=str(sched.id))
                        sched.last_failure_notified_at = now

                sched.last_run_at = now
                sched.next_run_at = _next_fire(sched.recurrence_cron, now)
                await db.commit()


def start_report_scheduler(interval_s: int = DEFAULT_INTERVAL_S) -> asyncio.Task:
    scheduler = ReportScheduler(interval_s=interval_s)
    return asyncio.create_task(scheduler.run(), name="report-scheduler")
