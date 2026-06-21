from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field


class ChangeActionCreate(BaseModel):
    device_id: uuid.UUID
    action_type: str
    payload: dict[str, Any] = {}


class ChangeRequestCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: Optional[str] = None
    rollback_plan: Optional[str] = None
    scheduled_at: Optional[datetime] = None
    actions: list[ChangeActionCreate] = Field(min_length=1, max_length=50)


class ChangeActionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    device_id: uuid.UUID
    step_order: int
    action_type: str
    payload: dict[str, Any]
    status: str
    output: Optional[str] = None
    error_message: Optional[str] = None
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None

    device_name: Optional[str] = None


class ChangeRequestRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tenant_id: uuid.UUID
    title: str
    description: Optional[str] = None
    status: str
    requested_by: uuid.UUID
    approved_by: Optional[uuid.UUID] = None
    executed_by: Optional[uuid.UUID] = None
    approval_notes: Optional[str] = None
    rejection_reason: Optional[str] = None
    scheduled_at: Optional[datetime] = None
    executed_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    rollback_plan: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    actions: list[ChangeActionRead] = []

    requested_by_name: Optional[str] = None
    approved_by_name: Optional[str] = None
    executed_by_name: Optional[str] = None


class ApproveRequest(BaseModel):
    notes: Optional[str] = None


class RejectRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=1000)
