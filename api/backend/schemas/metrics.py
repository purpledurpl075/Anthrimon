from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class MetricDefOut(BaseModel):
    id: str
    label: str
    category: str
    unit: str
    value_type: str
    default_max: Optional[float] = None
    thresholds: Optional[dict] = None
