from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, field_validator, model_validator

# The 10 real, data-backed report types. "bundle" (added below) is a
# synthetic 11th type whose filters carry a report_types sub-list of these.
REAL_REPORT_TYPES = (
    "capacity", "sla", "inventory",
    "compliance", "alert_summary", "config_changes",
    "flow_top_talkers", "interface_health", "bgp_health", "syslog_security",
)
REPORT_TYPES = REAL_REPORT_TYPES + ("bundle",)
REPORT_FORMATS = ("pdf", "csv")


def _validate_bundle_filters(report_type: str, filters: dict) -> None:
    """When report_type is "bundle" (feature 4), filters.report_types must be
    a non-empty list of the other 10 real types, no duplicates, no
    self-reference. No-op for every other report_type."""
    if report_type != "bundle":
        return
    types = filters.get("report_types")
    if not isinstance(types, list) or not types:
        raise ValueError("filters.report_types must be a non-empty list when report_type is 'bundle'")
    seen: set[str] = set()
    for t in types:
        if t not in REAL_REPORT_TYPES:
            raise ValueError(f"filters.report_types entries must be one of {REAL_REPORT_TYPES}")
        if t in seen:
            raise ValueError(f"filters.report_types contains duplicate entry: {t}")
        seen.add(t)


def _validate_filters(v: dict) -> dict:
    """Shared filters-dict validation for date-range + site scoping (features
    1/2). Per-report-type keys (e.g. `limit`, `compare`) are left unvalidated
    — only the cross-type start/end/site_id keys are checked here."""
    start, end = v.get("start"), v.get("end")
    if start or end:
        if not (start and end):
            raise ValueError("filters.start and filters.end must both be provided together")
        try:
            start_dt = datetime.fromisoformat(str(start))
            end_dt = datetime.fromisoformat(str(end))
        except ValueError:
            raise ValueError("filters.start/end must be ISO 8601 date/datetime strings")
        if start_dt >= end_dt:
            raise ValueError("filters.start must be before filters.end")
    site_id = v.get("site_id")
    if site_id is not None:
        try:
            uuid.UUID(str(site_id))
        except ValueError:
            raise ValueError("filters.site_id must be a valid UUID")
    return v


class ScheduledReportCreate(BaseModel):
    name: str
    report_type: str
    formats: list[str] = ["pdf"]
    filters: dict = {}
    recurrence_cron: str
    recipients: list[str] = []
    is_enabled: bool = True
    email_subject: Optional[str] = None
    email_note: Optional[str] = None

    @field_validator("report_type")
    @classmethod
    def check_report_type(cls, v: str) -> str:
        if v not in REPORT_TYPES:
            raise ValueError(f"report_type must be one of {REPORT_TYPES}")
        return v

    @field_validator("formats")
    @classmethod
    def check_formats(cls, v: list[str]) -> list[str]:
        if not v or any(f not in REPORT_FORMATS for f in v):
            raise ValueError(f"formats must be a non-empty subset of {REPORT_FORMATS}")
        return v

    @field_validator("recurrence_cron")
    @classmethod
    def check_cron(cls, v: str) -> str:
        from croniter import croniter
        if not croniter.is_valid(v):
            raise ValueError("recurrence_cron is not a valid cron expression")
        return v

    @field_validator("filters")
    @classmethod
    def check_filters(cls, v: dict) -> dict:
        return _validate_filters(v)

    @model_validator(mode="after")
    def check_bundle(self) -> "ScheduledReportCreate":
        _validate_bundle_filters(self.report_type, self.filters)
        return self


class ScheduledReportUpdate(BaseModel):
    name: Optional[str] = None
    formats: Optional[list[str]] = None
    filters: Optional[dict] = None
    recurrence_cron: Optional[str] = None
    recipients: Optional[list[str]] = None
    is_enabled: Optional[bool] = None
    email_subject: Optional[str] = None
    email_note: Optional[str] = None

    @field_validator("recurrence_cron")
    @classmethod
    def check_cron(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        from croniter import croniter
        if not croniter.is_valid(v):
            raise ValueError("recurrence_cron is not a valid cron expression")
        return v

    @field_validator("filters")
    @classmethod
    def check_filters(cls, v: Optional[dict]) -> Optional[dict]:
        if v is None:
            return v
        return _validate_filters(v)


class ScheduledReportRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tenant_id: uuid.UUID
    user_id: uuid.UUID
    name: str
    report_type: str
    formats: list[str]
    filters: dict
    recurrence_cron: str
    recipients: list[str]
    is_enabled: bool
    last_run_at: Optional[datetime] = None
    next_run_at: Optional[datetime] = None
    email_subject: Optional[str] = None
    email_note: Optional[str] = None
    consecutive_failures: int = 0
    created_at: datetime
    updated_at: datetime


class ReportRunRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tenant_id: uuid.UUID
    scheduled_report_id: Optional[uuid.UUID] = None
    report_type: str
    format: str
    status: str
    error: Optional[str] = None
    file_size_bytes: Optional[int] = None
    triggered_by: Optional[uuid.UUID] = None
    emailed_to: Optional[list[str]] = None
    started_at: datetime
    completed_at: Optional[datetime] = None


class RunReportRequest(BaseModel):
    """Ad-hoc, one-off report generation (not tied to a saved schedule)."""
    report_type: str
    format: str
    filters: dict = {}
    email_to: list[str] = []

    @field_validator("report_type")
    @classmethod
    def check_report_type(cls, v: str) -> str:
        if v not in REPORT_TYPES:
            raise ValueError(f"report_type must be one of {REPORT_TYPES}")
        return v

    @field_validator("format")
    @classmethod
    def check_format(cls, v: str) -> str:
        if v not in REPORT_FORMATS:
            raise ValueError(f"format must be one of {REPORT_FORMATS}")
        return v

    @field_validator("filters")
    @classmethod
    def check_filters(cls, v: dict) -> dict:
        return _validate_filters(v)

    @model_validator(mode="after")
    def check_bundle(self) -> "RunReportRequest":
        _validate_bundle_filters(self.report_type, self.filters)
        return self


class PreviewReportRequest(BaseModel):
    """Render-only preview (feature 5) — no ReportRun row is created, nothing
    is stored to disk. Same report_type/filters validation as RunReportRequest."""
    report_type: str
    filters: dict = {}

    @field_validator("report_type")
    @classmethod
    def check_report_type(cls, v: str) -> str:
        if v not in REPORT_TYPES:
            raise ValueError(f"report_type must be one of {REPORT_TYPES}")
        return v

    @field_validator("filters")
    @classmethod
    def check_filters(cls, v: dict) -> dict:
        return _validate_filters(v)

    @model_validator(mode="after")
    def check_bundle(self) -> "PreviewReportRequest":
        _validate_bundle_filters(self.report_type, self.filters)
        return self
