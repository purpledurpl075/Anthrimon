from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict


class SavedViewCreate(BaseModel):
    page: str
    name: str
    query: str
    is_shared: bool = False


class SavedViewRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    page: str
    name: str
    query: str
    is_shared: bool
    user_id: uuid.UUID
    created_at: datetime
    updated_at: datetime

    # Enriched display field populated by the router
    owner_name: Optional[str] = None
