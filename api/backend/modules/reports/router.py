"""Advanced Reports — scheduled, branded PDF/CSV reports for capacity, SLA,
and inventory. Licensed module (license_key: "reports").

Router is intentionally thin: CRUD for scheduled_reports, run history, and
on-demand generation. The actual data aggregation + PDF/CSV rendering lives
in backend.reports (generator.py, capacity.py, sla.py, inventory.py) so it
can be shared with the background scheduler (backend.reports.scheduler).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import structlog
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ...dependencies import get_current_user, get_db, require_role
from ...models.report import ReportRun, ScheduledReport
from ...models.tenant import User
from ...schemas.report import (
    PreviewReportRequest, ReportRunRead, RunReportRequest, ScheduledReportCreate,
    ScheduledReportRead, ScheduledReportUpdate,
)

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/reports", tags=["reports"])


def _next_fire(cron_expr: str, now: datetime) -> datetime | None:
    try:
        from croniter import croniter
        return croniter(cron_expr, now).get_next(datetime).replace(tzinfo=timezone.utc)
    except Exception:
        return None


async def _check_site_ownership(filters: dict, tenant_id: uuid.UUID, db: AsyncSession) -> None:
    """If filters carries a site_id (feature 2 scoping), verify it belongs to
    the caller's tenant — prevents a cross-tenant/garbage site_id silently
    producing an empty report."""
    site_id = filters.get("site_id") if filters else None
    if not site_id:
        return
    from ...models.site import Site
    site = (await db.execute(
        select(Site.id).where(Site.id == site_id, Site.tenant_id == tenant_id)
    )).scalar_one_or_none()
    if site is None:
        raise HTTPException(status_code=400, detail="filters.site_id does not belong to this tenant")


# ── Scheduled reports (CRUD) ───────────────────────────────────────────────

@router.get("/schedules", response_model=list[ScheduledReportRead])
async def list_schedules(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ScheduledReportRead]:
    rows = (await db.execute(
        select(ScheduledReport)
        .where(ScheduledReport.tenant_id == current_user.tenant_id)
        .order_by(ScheduledReport.created_at.desc())
    )).scalars().all()
    return [ScheduledReportRead.model_validate(r) for r in rows]


@router.post("/schedules", response_model=ScheduledReportRead, status_code=status.HTTP_201_CREATED)
async def create_schedule(
    body: ScheduledReportCreate,
    request: Request,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> ScheduledReportRead:
    await _check_site_ownership(body.filters, current_user.tenant_id, db)
    now = datetime.now(timezone.utc)
    r = ScheduledReport(
        tenant_id=current_user.tenant_id,
        user_id=current_user.id,
        next_run_at=_next_fire(body.recurrence_cron, now),
        **body.model_dump(),
    )
    db.add(r)
    await db.flush()
    from ...audit import audit as _audit
    await _audit(db, action="create", resource_type="scheduled_report",
                 resource_id=r.id,
                 new_value={"name": r.name, "report_type": r.report_type, "formats": r.formats,
                            "recurrence_cron": r.recurrence_cron, "recipients": r.recipients},
                 user=current_user, request=request)
    await db.commit()
    await db.refresh(r)
    logger.info("scheduled_report_created", id=str(r.id), name=r.name, report_type=r.report_type)
    return ScheduledReportRead.model_validate(r)


@router.patch("/schedules/{schedule_id}", response_model=ScheduledReportRead)
async def update_schedule(
    schedule_id: uuid.UUID,
    body: ScheduledReportUpdate,
    request: Request,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> ScheduledReportRead:
    r = await _get_schedule(schedule_id, current_user.tenant_id, db)
    if body.filters is not None:
        await _check_site_ownership(body.filters, current_user.tenant_id, db)
    before = {"name": r.name, "formats": r.formats, "recurrence_cron": r.recurrence_cron,
              "recipients": r.recipients, "is_enabled": r.is_enabled}
    updates = body.model_dump(exclude_none=True)
    for field, value in updates.items():
        setattr(r, field, value)
    if "recurrence_cron" in updates:
        r.next_run_at = _next_fire(r.recurrence_cron, datetime.now(timezone.utc))
    after = {"name": r.name, "formats": r.formats, "recurrence_cron": r.recurrence_cron,
             "recipients": r.recipients, "is_enabled": r.is_enabled}
    from ...audit import audit as _audit
    await _audit(db, action="update", resource_type="scheduled_report",
                 resource_id=r.id, old_value=before, new_value=after,
                 user=current_user, request=request)
    await db.commit()
    await db.refresh(r)
    return ScheduledReportRead.model_validate(r)


@router.delete("/schedules/{schedule_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
async def delete_schedule(
    schedule_id: uuid.UUID,
    request: Request,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> None:
    r = await _get_schedule(schedule_id, current_user.tenant_id, db)
    from ...audit import audit as _audit
    await _audit(db, action="delete", resource_type="scheduled_report",
                 resource_id=r.id,
                 old_value={"name": r.name, "report_type": r.report_type, "recipients": r.recipients},
                 user=current_user, request=request)
    await db.delete(r)
    await db.commit()
    logger.info("scheduled_report_deleted", id=str(schedule_id))


async def _get_schedule(schedule_id: uuid.UUID, tenant_id: uuid.UUID, db: AsyncSession) -> ScheduledReport:
    r = (await db.execute(
        select(ScheduledReport).where(
            ScheduledReport.id == schedule_id,
            ScheduledReport.tenant_id == tenant_id,
        )
    )).scalar_one_or_none()
    if r is None:
        raise HTTPException(status_code=404, detail="Scheduled report not found")
    return r


# ── On-demand generation + run history ─────────────────────────────────────

@router.post("/run", response_model=ReportRunRead, status_code=status.HTTP_202_ACCEPTED)
async def run_report_now(
    body: RunReportRequest,
    background_tasks: BackgroundTasks,
    request: Request,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> ReportRunRead:
    """Kick off an ad-hoc (not scheduled) report generation in the background;
    poll GET /reports/runs/{id} or list /reports/runs for status."""
    await _check_site_ownership(body.filters, current_user.tenant_id, db)
    run = ReportRun(
        tenant_id=current_user.tenant_id,
        report_type=body.report_type,
        format=body.format,
        status="pending",
        triggered_by=current_user.id,
    )
    db.add(run)
    await db.commit()
    await db.refresh(run)

    from ...reports.generator import generate_and_store

    background_tasks.add_task(
        generate_and_store,
        run_id=run.id,
        tenant_id=current_user.tenant_id,
        report_type=body.report_type,
        fmt=body.format,
        filters=body.filters,
        email_to=body.email_to,
    )

    from ...audit import audit as _audit
    await _audit(db, action="report_generate", resource_type="report_run",
                 resource_id=run.id,
                 new_value={"report_type": body.report_type, "format": body.format},
                 user=current_user, request=request)
    await db.commit()
    return ReportRunRead.model_validate(run)


@router.post("/preview")
async def preview_report(
    body: PreviewReportRequest,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Render-only preview (feature 5) — same role gate as /reports/run since
    sensitive data is still rendered, but no ReportRun row is created and no
    file is written to disk, so it isn't audited as report_generate either."""
    await _check_site_ownership(body.filters, current_user.tenant_id, db)

    from ...reports.comparisons import get_report_data_with_comparison
    from ...reports.render import render_report_html

    result = await get_report_data_with_comparison(body.report_type, db, current_user.tenant_id, body.filters)
    if isinstance(result, dict) and "deltas" in result and "current" in result:
        data = result["current"]
        comparison = {"previous": result["previous"], "deltas": result["deltas"]}
    else:
        data = result
        comparison = None

    html = await render_report_html(
        db, current_user.tenant_id, body.report_type, data,
        generated_by=current_user.email, comparison=comparison,
    )
    return Response(content=html, media_type="text/html")


@router.get("/runs", response_model=list[ReportRunRead])
async def list_runs(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ReportRunRead]:
    rows = (await db.execute(
        select(ReportRun)
        .where(ReportRun.tenant_id == current_user.tenant_id)
        .order_by(ReportRun.started_at.desc())
        .limit(100)
    )).scalars().all()
    return [ReportRunRead.model_validate(r) for r in rows]


@router.get("/runs/{run_id}", response_model=ReportRunRead)
async def get_run(
    run_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ReportRunRead:
    run = await _get_run(run_id, current_user.tenant_id, db)
    return ReportRunRead.model_validate(run)


@router.get("/runs/{run_id}/download")
async def download_run(
    run_id: uuid.UUID,
    request: Request,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> FileResponse:
    run = await _get_run(run_id, current_user.tenant_id, db)
    if run.status != "success" or not run.file_path:
        raise HTTPException(status_code=409, detail="Report is not ready")

    from ...audit import audit as _audit
    await _audit(db, action="report_download", resource_type="report_run",
                 resource_id=run.id,
                 new_value={"report_type": run.report_type, "format": run.format},
                 user=current_user, request=request)
    await db.commit()

    media_type = "application/pdf" if run.format == "pdf" else "text/csv"
    filename = f"{run.report_type}-report-{run.id}.{run.format}"
    return FileResponse(run.file_path, media_type=media_type, filename=filename)


@router.delete("/runs/{run_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
async def delete_run(
    run_id: uuid.UUID,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Delete a saved report: removes the generated file from disk (if any)
    and its history row. Does not affect the parent schedule, if any."""
    run = await _get_run(run_id, current_user.tenant_id, db)
    if run.file_path:
        import os
        try:
            os.remove(run.file_path)
        except OSError as exc:
            logger.warning("report_run_file_delete_failed", run_id=str(run_id), error=str(exc))
    await db.delete(run)
    await db.commit()
    logger.info("report_run_deleted", id=str(run_id))


async def _get_run(run_id: uuid.UUID, tenant_id: uuid.UUID, db: AsyncSession) -> ReportRun:
    run = (await db.execute(
        select(ReportRun).where(ReportRun.id == run_id, ReportRun.tenant_id == tenant_id)
    )).scalar_one_or_none()
    if run is None:
        raise HTTPException(status_code=404, detail="Report run not found")
    return run
