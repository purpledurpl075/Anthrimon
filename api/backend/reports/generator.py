"""Orchestrates one report run: aggregate data -> render (PDF/CSV) -> store
on disk -> update the ReportRun row -> optionally email. Shared by the
on-demand /reports/run endpoint and the scheduler (backend.reports.scheduler)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from pathlib import Path

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import AsyncSessionLocal
from ..models.report import ReportRun
from .csv_export import REPORT_CSV_FUNCS
from .render import html_to_pdf_bytes, render_report_html

logger = structlog.get_logger(__name__)

_REPORTS_ROOT = Path("/var/lib/anthrimon/reports")


async def _resolve_generated_by(db: AsyncSession, run: ReportRun) -> str | None:
    """Watermark text for the report header (feature 7). On-demand runs are
    attributed to the triggering user; scheduled runs (triggered_by is NULL
    — no human fired them) are attributed to the schedule name instead."""
    if run.triggered_by:
        from ..models.tenant import User
        email = (await db.execute(
            select(User.email).where(User.id == run.triggered_by)
        )).scalar_one_or_none()
        if email:
            return email
    if run.scheduled_report_id:
        from ..models.report import ScheduledReport
        name = (await db.execute(
            select(ScheduledReport.name).where(ScheduledReport.id == run.scheduled_report_id)
        )).scalar_one_or_none()
        if name:
            return f"Scheduled: {name}"
    return None


async def generate_and_store(
    run_id: uuid.UUID,
    tenant_id: uuid.UUID,
    report_type: str,
    fmt: str,
    filters: dict,
    email_to: list[str] | None = None,
    email_subject: str | None = None,
    email_note: str | None = None,
) -> None:
    """Runs as a background task (see modules/reports/router.py's run_report_now
    and reports/scheduler.py's ReportScheduler). Never raises — failures are
    recorded on the ReportRun row instead, since nothing awaits this task."""
    async with AsyncSessionLocal() as db:
        run = (await db.execute(
            select(ReportRun).where(ReportRun.id == run_id)
        )).scalar_one_or_none()
        if run is None:
            logger.error("report_run_missing", run_id=str(run_id))
            return

        run.status = "running"
        await db.commit()

        try:
            from .comparisons import get_report_data_with_comparison
            result = await get_report_data_with_comparison(report_type, db, tenant_id, filters)
            if isinstance(result, dict) and "deltas" in result and "current" in result:
                data = result["current"]
                comparison = {"previous": result["previous"], "deltas": result["deltas"]}
            else:
                data = result
                comparison = None

            generated_by = await _resolve_generated_by(db, run)

            tenant_dir = _REPORTS_ROOT / str(tenant_id)
            tenant_dir.mkdir(parents=True, exist_ok=True)
            file_path = tenant_dir / f"{run_id}.{fmt}"

            if fmt == "pdf":
                html = await render_report_html(
                    db, tenant_id, report_type, data,
                    generated_by=generated_by, comparison=comparison,
                )
                content = await html_to_pdf_bytes(html)
                file_path.write_bytes(content)
            else:
                csv_func = REPORT_CSV_FUNCS[report_type]
                content = csv_func(data).encode("utf-8")
                file_path.write_bytes(content)

            run.status = "success"
            run.file_path = str(file_path)
            run.file_size_bytes = len(content)
            run.completed_at = datetime.now(timezone.utc)
            await db.commit()
            logger.info("report_run_success", run_id=str(run_id), report_type=report_type,
                       format=fmt, bytes=len(content))

            if email_to:
                from ..alerting.notify import send_report_email
                try:
                    await send_report_email(
                        db, tenant_id, recipients=email_to, report_type=report_type,
                        file_path=str(file_path), fmt=fmt,
                        subject=email_subject, note=email_note,
                    )
                    run.emailed_to = email_to
                    await db.commit()
                except Exception as exc:
                    logger.warning("report_email_failed", run_id=str(run_id), error=str(exc))

        except Exception as exc:
            logger.error("report_run_failed", run_id=str(run_id), error=str(exc))
            run.status = "failed"
            run.error = str(exc)[:2000]
            run.completed_at = datetime.now(timezone.utc)
            await db.commit()
