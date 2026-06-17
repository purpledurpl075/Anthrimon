from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict

from ..models.dashboard import DEFAULT_LAYOUT


class DashboardCreate(BaseModel):
    name: str
    description: str = ""
    is_shared: bool = False
    layout: dict = DEFAULT_LAYOUT.copy()


class DashboardUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    is_shared: Optional[bool] = None
    is_default: Optional[bool] = None
    layout: Optional[dict] = None


class DashboardRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str
    is_shared: bool
    is_default: bool
    layout: dict
    user_id: uuid.UUID
    created_at: datetime
    updated_at: datetime

    # Enriched display fields populated by the router
    owner_name: Optional[str] = None
    can_edit: bool = False


class DashboardTemplateInfo(BaseModel):
    key: str
    name: str
    description: str
