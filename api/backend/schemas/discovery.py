from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class SweepRequest(BaseModel):
    cidr: str = Field(..., examples=["10.0.2.0/24"])
    credential_ids: list[uuid.UUID] = Field(..., min_length=1)
    port: int = Field(default=161, ge=1, le=65535)
    timeout_s: int = Field(default=3, ge=1, le=10)
    max_concurrent: int = Field(default=50, ge=1, le=254)
    collector_id: Optional[uuid.UUID] = None  # None = hub; Phase 2 will dispatch to remote


class DiscoveredDevice(BaseModel):
    ip: str
    hostname: str
    vendor: str
    sys_descr: str
    sys_object_id: str
    already_in_db: bool
    device_id:     Optional[uuid.UUID] = None  # set when already_in_db is True
    credential_id: Optional[uuid.UUID] = None  # which credential responded


class SweepJob(BaseModel):
    job_id:      uuid.UUID
    status:      str           # pending | running | done | cancelled | error
    cidr:        str
    total:       int
    scanned:     int
    found:       list[DiscoveredDevice] = []
    error:       Optional[str] = None
    started_at:  datetime
    finished_at: Optional[datetime] = None
    tenant_id:   Optional[uuid.UUID] = None


class CredentialSummary(BaseModel):
    id: uuid.UUID
    name: str
    type: str
