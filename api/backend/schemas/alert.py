from __future__ import annotations

import uuid
from datetime import datetime
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field


class AlertRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tenant_id: uuid.UUID
    rule_id: Optional[uuid.UUID] = None
    device_id: Optional[uuid.UUID] = None
    interface_id: Optional[uuid.UUID] = None
    severity: str
    status: str
    title: str
    message: Optional[str] = None
    context: dict = {}
    triggered_at: datetime
    acknowledged_at: Optional[datetime] = None
    acknowledged_by: Optional[uuid.UUID] = None
    resolved_at: Optional[datetime] = None
    resolved_by: Optional[uuid.UUID] = None
    suppressed_by_alert_id: Optional[uuid.UUID] = None
    suppressed_child_count: int = 0
    suppressed_children: list["SuppressedChildSummary"] = []
    created_at: datetime
    updated_at: datetime


class SuppressedChildSummary(BaseModel):
    """Lightweight view of a child suppressed under a parent alert."""
    id: uuid.UUID
    title: str
    severity: str
    metric: Optional[str] = None
    device_name: Optional[str] = None
    triggered_at: datetime


class AlertRuleCreate(BaseModel):
    name: str
    description: Optional[str] = None
    is_enabled: bool = True
    policy_id: Optional[uuid.UUID] = None
    device_selector: Optional[dict] = None
    metric: str
    condition: str = "gt"
    threshold: Optional[float] = None
    duration_seconds: int = Field(default=0, ge=0)
    renotify_seconds: int = Field(default=3600, ge=0)
    severity: str = "warning"
    # Escalation
    escalation_severity: Optional[str] = None
    escalation_seconds: Optional[int] = None
    # Flap suppression
    stable_for_seconds: int = Field(default=0, ge=0)
    # Correlated suppression
    suppress_if_parent_down: bool = False
    parent_device_id: Optional[uuid.UUID] = None
    # Baseline
    baseline_enabled: bool = False
    baseline_deviation_pct: Optional[float] = None
    # Multi-condition
    extra_conditions: list[dict] = []
    # Notifications
    notify_on_resolve: bool = True
    custom_oid: Optional[str] = None
    channel_ids: list[uuid.UUID] = []
    maintenance_window_ids: list[uuid.UUID] = []


class AlertRuleUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    is_enabled: Optional[bool] = None
    device_selector: Optional[dict] = None
    metric: Optional[str] = None
    condition: Optional[str] = None
    threshold: Optional[float] = None
    duration_seconds: Optional[int] = None
    renotify_seconds: Optional[int] = None
    severity: Optional[str] = None
    escalation_severity: Optional[str] = None
    escalation_seconds: Optional[int] = None
    stable_for_seconds: Optional[int] = None
    suppress_if_parent_down: Optional[bool] = None
    parent_device_id: Optional[uuid.UUID] = None
    baseline_enabled: Optional[bool] = None
    baseline_deviation_pct: Optional[float] = None
    extra_conditions: Optional[list[dict]] = None
    notify_on_resolve: Optional[bool] = None
    custom_oid: Optional[str] = None
    channel_ids: Optional[list[uuid.UUID]] = None
    maintenance_window_ids: Optional[list[uuid.UUID]] = None


class AlertRuleRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tenant_id: uuid.UUID
    policy_id: Optional[uuid.UUID] = None
    name: str
    description: Optional[str] = None
    is_enabled: bool
    device_selector: Optional[dict] = None
    metric: str
    condition: str
    threshold: Optional[float] = None
    duration_seconds: int
    renotify_seconds: int
    severity: str
    escalation_severity: Optional[str] = None
    escalation_seconds: Optional[int] = None
    stable_for_seconds: int = 0
    suppress_if_parent_down: bool = False
    parent_device_id: Optional[uuid.UUID] = None
    baseline_enabled: bool = False
    baseline_deviation_pct: Optional[float] = None
    extra_conditions: list[Any] = []
    notify_on_resolve: bool = True
    custom_oid: Optional[str] = None
    channel_ids: list[Any] = []
    maintenance_window_ids: list[Any] = []
    created_at: datetime
    updated_at: datetime


class NotificationChannelCreate(BaseModel):
    name: str
    type: str  # "email" | "slack" | "webhook" | "pagerduty" | "teams"
    config: dict = {}
    is_enabled: bool = True


class NotificationChannelUpdate(BaseModel):
    name: Optional[str] = None
    config: Optional[dict] = None
    is_enabled: Optional[bool] = None


class NotificationChannelRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tenant_id: uuid.UUID
    name: str
    type: str
    config: dict
    is_enabled: bool
    created_at: datetime
    updated_at: datetime


class NotificationSendLogRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    channel_id: uuid.UUID
    alert_id: Optional[uuid.UUID]
    event: str
    status: str
    error: Optional[str]
    attempts: int
    sent_at: datetime


class AlertPolicyCreate(BaseModel):
    name: str
    description: Optional[str] = None
    is_enabled: bool = True
    device_selector: Optional[dict] = None


class AlertPolicyUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    is_enabled: Optional[bool] = None
    device_selector: Optional[dict] = None


class AlertPolicyRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tenant_id: uuid.UUID
    name: str
    description: Optional[str] = None
    is_enabled: bool
    is_builtin: bool
    device_selector: Optional[dict] = None
    created_at: datetime
    updated_at: datetime


class AlertBulkAction(str, Enum):
    acknowledge = "acknowledge"
    resolve = "resolve"


class AlertBulkRequest(BaseModel):
    alert_ids: list[uuid.UUID] = Field(min_length=1, max_length=500)
    action: AlertBulkAction


class AlertBulkResponse(BaseModel):
    updated: int
