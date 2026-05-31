from __future__ import annotations

import uuid
from typing import Optional

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_current_user, get_db, require_role
from ..models.alert import AlertPolicy, AlertRule
from ..models.tenant import User
from pydantic import BaseModel
from ..schemas.alert import AlertPolicyCreate, AlertPolicyRead, AlertPolicyUpdate, AlertRuleRead


class ApplyPolicyRequest(BaseModel):
    device_selector: Optional[dict] = None
    # Optional per-metric threshold overrides: {"cpu_util_pct": 70, "mem_util_pct": 85}
    threshold_overrides: Optional[dict] = None
from ..schemas.common import PaginatedResponse

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/alert-policies", tags=["alert-policies"])

_seeded_tenants: set[str] = set()  # tenants that have had built-in policies seeded this process lifetime


# ── Built-in policy templates ──────────────────────────────────────────────────
# Each entry defines the policy metadata and the rules it creates when applied.

BUILTIN_TEMPLATES: list[dict] = [
    {
        "name": "Standard Switch",
        "description": "Best-practice monitoring for access and distribution switches.",
        "rules": [
            {"name": "CPU high (warn)",      "metric": "cpu_util_pct",   "condition": "gt", "threshold": 85, "duration_seconds": 300, "severity": "warning",  "escalation_severity": "major",    "escalation_seconds": 600},
            {"name": "CPU critical",         "metric": "cpu_util_pct",   "condition": "gt", "threshold": 95, "duration_seconds": 120, "severity": "critical"},
            {"name": "Memory high",          "metric": "mem_util_pct",   "condition": "gt", "threshold": 90, "duration_seconds": 300, "severity": "warning",  "escalation_severity": "major",    "escalation_seconds": 900},
            {"name": "Interface down",       "metric": "interface_down", "condition": "eq", "threshold": None, "duration_seconds": 0, "severity": "warning",  "stable_for_seconds": 30, "suppress_if_parent_down": True},
            {"name": "Device unreachable",   "metric": "device_down",    "condition": "eq", "threshold": None, "duration_seconds": 0, "severity": "critical"},
        ],
    },
    {
        "name": "Core Router",
        "description": "Tighter thresholds for core and distribution routers.",
        "rules": [
            {"name": "CPU high (warn)",      "metric": "cpu_util_pct",   "condition": "gt", "threshold": 75, "duration_seconds": 120, "severity": "warning",  "escalation_severity": "critical", "escalation_seconds": 300},
            {"name": "CPU critical",         "metric": "cpu_util_pct",   "condition": "gt", "threshold": 90, "duration_seconds": 60,  "severity": "critical"},
            {"name": "Memory high",          "metric": "mem_util_pct",   "condition": "gt", "threshold": 85, "duration_seconds": 300, "severity": "warning",  "escalation_severity": "major",    "escalation_seconds": 600},
            {"name": "Interface down",       "metric": "interface_down", "condition": "eq", "threshold": None, "duration_seconds": 0, "severity": "critical", "stable_for_seconds": 30, "suppress_if_parent_down": True},
            {"name": "Device unreachable",   "metric": "device_down",    "condition": "eq", "threshold": None, "duration_seconds": 0, "severity": "critical"},
        ],
    },
    {
        "name": "Firewall",
        "description": "Monitoring for perimeter and internal firewalls.",
        "rules": [
            {"name": "CPU high",             "metric": "cpu_util_pct",   "condition": "gt", "threshold": 90, "duration_seconds": 300, "severity": "warning",  "escalation_severity": "critical", "escalation_seconds": 600},
            {"name": "Memory high",          "metric": "mem_util_pct",   "condition": "gt", "threshold": 90, "duration_seconds": 300, "severity": "warning"},
            {"name": "Device unreachable",   "metric": "device_down",    "condition": "eq", "threshold": None, "duration_seconds": 0, "severity": "critical"},
        ],
    },
    {
        "name": "Interface Flap Detection",
        "description": "Detect and alert on unstable interfaces across all devices.",
        "rules": [
            {"name": "Interface flapping",   "metric": "interface_flap", "condition": "gt", "threshold": 3, "duration_seconds": 300, "severity": "warning",  "stable_for_seconds": 120},
        ],
    },
    {
        "name": "Access Point",
        "description": "Monitoring for wireless access points. Higher memory threshold since APs "
                       "run lean, lower CPU threshold since spikes often indicate radio issues.",
        "rules": [
            {"name": "CPU high",           "metric": "cpu_util_pct",   "condition": "gt", "threshold": 80, "duration_seconds": 180, "severity": "warning", "escalation_severity": "major", "escalation_seconds": 600},
            {"name": "Memory critical",    "metric": "mem_util_pct",   "condition": "gt", "threshold": 95, "duration_seconds": 300, "severity": "critical"},
            {"name": "Device unreachable", "metric": "device_down",    "condition": "eq", "threshold": None, "duration_seconds": 0, "severity": "critical"},
            {"name": "AP rebooted",        "metric": "uptime",         "condition": "lt", "threshold": 300, "duration_seconds": 0,  "severity": "warning", "notify_on_resolve": True},
        ],
    },
    {
        "name": "Temperature Monitoring",
        "description": "Alert on high temperature sensors. Works on any device that exposes "
                       "ENTITY-SENSOR-MIB, Cisco ENVMON, Juniper, or Arista sensors.",
        "rules": [
            {"name": "Temperature high (warn)",     "metric": "temperature", "condition": "gt", "threshold": 65, "duration_seconds": 120, "severity": "warning"},
            {"name": "Temperature critical",        "metric": "temperature", "condition": "gt", "threshold": 80, "duration_seconds": 60,  "severity": "critical"},
        ],
    },
    {
        "name": "Interface Error Rate",
        "description": "Alert on interfaces accumulating significant error counts. "
                       "Indicates bad cabling, duplex mismatch, or faulty SFP.",
        "rules": [
            {"name": "Interface errors rising",  "metric": "interface_errors", "condition": "gt", "threshold": 500,   "duration_seconds": 300, "severity": "warning"},
            {"name": "Interface errors critical","metric": "interface_errors", "condition": "gt", "threshold": 5000,  "duration_seconds": 120, "severity": "major"},
        ],
    },
    {
        "name": "Reachability & Reboot",
        "description": "Catch devices that reboot faster than the SNMP stale threshold detects. "
                       "Uptime < 5 min fires on the first health poll after a device comes back up, "
                       "covering reboots that device_down would miss.",
        "rules": [
            {"name": "Device rebooted",      "metric": "uptime", "condition": "lt", "threshold": 300, "duration_seconds": 0, "severity": "warning",  "notify_on_resolve": True},
            {"name": "Device unreachable",   "metric": "device_down", "condition": "eq", "threshold": None, "duration_seconds": 0, "severity": "critical"},
        ],
    },
]


async def seed_builtin_policies(db: AsyncSession, tenant_id: uuid.UUID) -> None:
    """Ensure all built-in policy templates exist for a tenant. Idempotent."""
    for tpl in BUILTIN_TEMPLATES:
        existing = (await db.execute(
            select(AlertPolicy).where(
                AlertPolicy.tenant_id == tenant_id,
                AlertPolicy.name == tpl["name"],
                AlertPolicy.is_builtin == True,  # noqa: E712
            )
        )).scalar_one_or_none()
        if existing is None:
            policy = AlertPolicy(
                tenant_id=tenant_id,
                name=tpl["name"],
                description=tpl["description"],
                is_builtin=True,
                is_enabled=True,
            )
            db.add(policy)
            await db.flush()  # get the ID
            logger.info("builtin_policy_seeded", name=tpl["name"], tenant=str(tenant_id))


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("", response_model=list[AlertPolicyRead], summary="List alert policies")
async def list_policies(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[AlertPolicyRead]:
    tid = str(current_user.tenant_id)
    if tid not in _seeded_tenants:
        await seed_builtin_policies(db, current_user.tenant_id)
        await db.commit()
        _seeded_tenants.add(tid)
    result = await db.execute(
        select(AlertPolicy)
        .where(AlertPolicy.tenant_id == current_user.tenant_id)
        .order_by(AlertPolicy.is_builtin.desc(), AlertPolicy.name)
    )
    return [AlertPolicyRead.model_validate(p) for p in result.scalars().all()]


@router.post("", response_model=AlertPolicyRead, status_code=status.HTTP_201_CREATED,
             summary="Create a custom alert policy")
async def create_policy(
    body: AlertPolicyCreate,
    current_user: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> AlertPolicyRead:
    policy = AlertPolicy(tenant_id=current_user.tenant_id, **body.model_dump(exclude_none=True))
    db.add(policy)
    await db.commit()
    await db.refresh(policy)
    return AlertPolicyRead.model_validate(policy)


@router.patch("/{policy_id}", response_model=AlertPolicyRead, summary="Update a policy")
async def update_policy(
    policy_id: uuid.UUID,
    body: AlertPolicyUpdate,
    current_user: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> AlertPolicyRead:
    policy = await _get(policy_id, current_user.tenant_id, db)
    if policy.is_builtin:
        raise HTTPException(status_code=400, detail="Built-in policies cannot be edited — apply them to create editable rules")
    for field, value in body.model_dump(exclude_none=True).items():
        setattr(policy, field, value)
    await db.commit()
    await db.refresh(policy)
    return AlertPolicyRead.model_validate(policy)


@router.delete("/{policy_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None,
               summary="Delete a custom policy")
async def delete_policy(
    policy_id: uuid.UUID,
    current_user: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> None:
    policy = await _get(policy_id, current_user.tenant_id, db)
    if policy.is_builtin:
        raise HTTPException(status_code=400, detail="Built-in policies cannot be deleted")
    await db.delete(policy)
    await db.commit()


@router.post("/{policy_id}/apply", response_model=list[AlertRuleRead],
             status_code=status.HTTP_201_CREATED, summary="Apply a policy — create its rules for a device selector")
async def apply_policy(
    policy_id: uuid.UUID,
    body: ApplyPolicyRequest,
    current_user: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> list[AlertRuleRead]:
    """
    Instantiates all template rules for this policy, scoped to body.device_selector.
    Returns the created AlertRule objects.
    """
    policy = await _get(policy_id, current_user.tenant_id, db)

    # Find the template definition (builtin or derive from existing rules)
    tpl = next((t for t in BUILTIN_TEMPLATES if t["name"] == policy.name), None)
    if tpl is None:
        raise HTTPException(status_code=400, detail="No template definition found for this policy")

    threshold_overrides = body.threshold_overrides or {}
    created = []
    for rule_tpl in tpl["rules"]:
        tpl_fields = {k: v for k, v in rule_tpl.items() if v is not None}
        # Apply caller's threshold overrides for this metric
        metric = tpl_fields.get("metric", "")
        if metric in threshold_overrides and threshold_overrides[metric] is not None:
            tpl_fields["threshold"] = threshold_overrides[metric]
        rule = AlertRule(
            tenant_id=current_user.tenant_id,
            policy_id=policy.id,
            device_selector=body.device_selector,
            notify_on_resolve=True,
            **tpl_fields,
        )
        db.add(rule)
        created.append(rule)

    await db.commit()
    for r in created:
        await db.refresh(r)

    logger.info("policy_applied", policy=policy.name, rules=len(created),
                tenant=str(current_user.tenant_id))
    return [AlertRuleRead.model_validate(r) for r in created]


# ── Helper ─────────────────────────────────────────────────────────────────────

async def _get(policy_id: uuid.UUID, tenant_id: uuid.UUID, db: AsyncSession) -> AlertPolicy:
    result = await db.execute(
        select(AlertPolicy).where(AlertPolicy.id == policy_id, AlertPolicy.tenant_id == tenant_id)
    )
    policy = result.scalar_one_or_none()
    if policy is None:
        raise HTTPException(status_code=404, detail="Policy not found")
    return policy
