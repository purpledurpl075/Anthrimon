"""Custom dashboards — per-user (optionally tenant-shared) saved layouts of
summary and free-form "metric" widgets."""
from __future__ import annotations

import copy
import uuid
from typing import Optional

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..dashboard_templates import DASHBOARD_TEMPLATES
from ..dependencies import Principal, get_current_principal, get_db
from ..models.dashboard import DEFAULT_LAYOUT, Dashboard
from ..models.tenant import User
from ..schemas.dashboard import (
    DashboardCreate,
    DashboardRead,
    DashboardTemplateInfo,
    DashboardUpdate,
)

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/dashboards", tags=["dashboards"])

_SHARE_ROLES = {"tenant_admin", "operator"}

# Default layout for the dashboard a brand-new user lands on — mirrors
# DEFAULT_VISIBLE_LAYOUT in useDashboardLayout.ts.
_DEFAULT_MY_DASHBOARD_WIDGETS: list[dict] = [
    {"type": "stat_cards",       "x": 0, "y": 0, "w": 12, "h": 2},
    {"type": "problem_devices",  "x": 0, "y": 2, "w": 6,  "h": 3},
    {"type": "open_alerts",      "x": 6, "y": 2, "w": 6,  "h": 3},
    {"type": "alert_severity",   "x": 0, "y": 5, "w": 6,  "h": 3},
    {"type": "interface_health", "x": 6, "y": 5, "w": 6,  "h": 3},
    {"type": "top_bandwidth",    "x": 0, "y": 8, "w": 12, "h": 4},
]


def _assign_instance_ids(widgets: list[dict]) -> list[dict]:
    out = []
    for w in widgets:
        w = dict(w)
        w["instance_id"] = str(uuid.uuid4())
        out.append(w)
    return out


def _default_my_dashboard_layout() -> dict:
    return {
        "widgets": _assign_instance_ids(_DEFAULT_MY_DASHBOARD_WIDGETS),
        "time_range": "24h",
        "refresh_interval_s": 60,
    }


def _can_edit(dash: Dashboard, principal: Principal) -> bool:
    if dash.user_id == principal.user.id:
        return True
    return principal.is_platform_admin or principal.tenant_role == "tenant_admin"


async def _unique_name(db: AsyncSession, tenant_id: uuid.UUID, user_id: uuid.UUID, base_name: str) -> str:
    existing = set((await db.execute(
        select(Dashboard.name).where(Dashboard.tenant_id == tenant_id, Dashboard.user_id == user_id)
    )).scalars().all())
    if base_name not in existing:
        return base_name
    i = 2
    while f"{base_name} ({i})" in existing:
        i += 1
    return f"{base_name} ({i})"


async def _to_read(db: AsyncSession, dash: Dashboard, principal: Principal, owner_names: dict[uuid.UUID, str]) -> DashboardRead:
    read = DashboardRead.model_validate(dash)
    read.owner_name = owner_names.get(dash.user_id)
    read.can_edit = _can_edit(dash, principal)
    return read


# ── Templates (must be declared before /{dashboard_id}) ────────────────────────

@router.get("/templates", response_model=list[DashboardTemplateInfo], summary="List built-in dashboard templates")
async def list_templates(
    principal: Principal = Depends(get_current_principal),
) -> list[DashboardTemplateInfo]:
    return [
        DashboardTemplateInfo(key=key, name=tpl["name"], description=tpl["description"])
        for key, tpl in DASHBOARD_TEMPLATES.items()
    ]


@router.post("/templates/{key}/clone", response_model=DashboardRead, status_code=status.HTTP_201_CREATED,
              summary="Create a new dashboard from a built-in template")
async def clone_template(
    key: str,
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> DashboardRead:
    tpl = DASHBOARD_TEMPLATES.get(key)
    if tpl is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown dashboard template")

    layout = copy.deepcopy(tpl["layout"])
    layout["widgets"] = _assign_instance_ids(layout.get("widgets", []))

    name = await _unique_name(db, principal.active_tenant_id, principal.user.id, tpl["name"])

    dash = Dashboard(
        tenant_id=principal.active_tenant_id,
        user_id=principal.user.id,
        name=name,
        description=tpl["description"],
        is_shared=False,
        is_default=False,
        layout=layout,
    )
    db.add(dash)
    await db.commit()

    return await _to_read(db, dash, principal, {principal.user.id: principal.user.username})


# ── CRUD ─────────────────────────────────────────────────────────────────────

@router.get("", response_model=list[DashboardRead], summary="List dashboards (own + tenant-shared)")
async def list_dashboards(
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> list[DashboardRead]:
    rows = (await db.execute(
        select(Dashboard).where(
            Dashboard.tenant_id == principal.active_tenant_id,
            or_(Dashboard.user_id == principal.user.id, Dashboard.is_shared.is_(True)),
        ).order_by(Dashboard.name)
    )).scalars().all()

    if not rows:
        dash = Dashboard(
            tenant_id=principal.active_tenant_id,
            user_id=principal.user.id,
            name="My Dashboard",
            description="",
            is_shared=False,
            is_default=True,
            layout=_default_my_dashboard_layout(),
        )
        db.add(dash)
        await db.commit()
        rows = [dash]

    owner_ids = {r.user_id for r in rows}
    owner_names: dict[uuid.UUID, str] = {}
    if owner_ids:
        users = (await db.execute(
            select(User.id, User.username).where(User.id.in_(owner_ids))
        )).all()
        owner_names = {u.id: u.username for u in users}

    return [await _to_read(db, r, principal, owner_names) for r in rows]


@router.post("", response_model=DashboardRead, status_code=status.HTTP_201_CREATED, summary="Create a new dashboard")
async def create_dashboard(
    body: DashboardCreate,
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> DashboardRead:
    if body.is_shared and principal.tenant_role not in _SHARE_ROLES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only operators and tenant admins can share dashboards with the tenant",
        )

    layout = copy.deepcopy(body.layout) if body.layout else copy.deepcopy(DEFAULT_LAYOUT)
    layout.setdefault("widgets", [])
    layout.setdefault("time_range", "24h")
    layout.setdefault("refresh_interval_s", 60)
    layout["widgets"] = [
        {**w, "instance_id": w.get("instance_id") or str(uuid.uuid4())}
        for w in layout["widgets"]
    ]

    dash = Dashboard(
        tenant_id=principal.active_tenant_id,
        user_id=principal.user.id,
        name=body.name,
        description=body.description,
        is_shared=body.is_shared,
        is_default=False,
        layout=layout,
    )
    db.add(dash)
    try:
        await db.commit()
    except Exception as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A dashboard named '{body.name}' already exists",
        ) from exc

    return await _to_read(db, dash, principal, {principal.user.id: principal.user.username})


async def _get_visible_dashboard(dashboard_id: uuid.UUID, principal: Principal, db: AsyncSession) -> Dashboard:
    dash = (await db.execute(
        select(Dashboard).where(
            Dashboard.id == dashboard_id,
            Dashboard.tenant_id == principal.active_tenant_id,
            or_(Dashboard.user_id == principal.user.id, Dashboard.is_shared.is_(True)),
        )
    )).scalar_one_or_none()
    if dash is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found")
    return dash


@router.get("/{dashboard_id}", response_model=DashboardRead, summary="Get a single dashboard")
async def get_dashboard(
    dashboard_id: uuid.UUID,
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> DashboardRead:
    dash = await _get_visible_dashboard(dashboard_id, principal, db)
    owner_names: dict[uuid.UUID, str] = {}
    user = (await db.execute(select(User.id, User.username).where(User.id == dash.user_id))).one_or_none()
    if user:
        owner_names[user.id] = user.username
    return await _to_read(db, dash, principal, owner_names)


@router.patch("/{dashboard_id}", response_model=DashboardRead, summary="Update a dashboard")
async def update_dashboard(
    dashboard_id: uuid.UUID,
    body: DashboardUpdate,
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> DashboardRead:
    dash = await _get_visible_dashboard(dashboard_id, principal, db)
    if not _can_edit(dash, principal):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You cannot edit this dashboard")

    if body.is_shared is not None:
        if body.is_shared and principal.tenant_role not in _SHARE_ROLES and not principal.is_platform_admin:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only operators and tenant admins can share dashboards with the tenant",
            )
        dash.is_shared = body.is_shared

    if body.name is not None:
        dash.name = body.name
    if body.description is not None:
        dash.description = body.description
    if body.layout is not None:
        layout = copy.deepcopy(body.layout)
        layout.setdefault("widgets", [])
        layout.setdefault("time_range", "24h")
        layout.setdefault("refresh_interval_s", 60)
        layout["widgets"] = [
            {**w, "instance_id": w.get("instance_id") or str(uuid.uuid4())}
            for w in layout["widgets"]
        ]
        dash.layout = layout

    if body.is_default is True:
        await db.execute(
            update(Dashboard)
            .where(
                Dashboard.tenant_id == principal.active_tenant_id,
                Dashboard.user_id == principal.user.id,
                Dashboard.id != dash.id,
                Dashboard.is_default.is_(True),
            )
            .values(is_default=False)
        )
        dash.is_default = True
    elif body.is_default is False:
        dash.is_default = False

    try:
        await db.commit()
    except Exception as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A dashboard named '{body.name}' already exists",
        ) from exc

    owner_names: dict[uuid.UUID, str] = {}
    user = (await db.execute(select(User.id, User.username).where(User.id == dash.user_id))).one_or_none()
    if user:
        owner_names[user.id] = user.username
    return await _to_read(db, dash, principal, owner_names)


@router.delete("/{dashboard_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None, summary="Delete a dashboard")
async def delete_dashboard(
    dashboard_id: uuid.UUID,
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> None:
    dash: Optional[Dashboard] = (await db.execute(
        select(Dashboard).where(
            Dashboard.id == dashboard_id,
            Dashboard.tenant_id == principal.active_tenant_id,
        )
    )).scalar_one_or_none()
    if dash is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found")
    if not _can_edit(dash, principal):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You cannot delete this dashboard")

    await db.delete(dash)
    await db.commit()


@router.post("/{dashboard_id}/clone", response_model=DashboardRead, status_code=status.HTTP_201_CREATED, summary="Clone a dashboard")
async def clone_dashboard(
    dashboard_id: uuid.UUID,
    principal: Principal = Depends(get_current_principal),
    db: AsyncSession = Depends(get_db),
) -> DashboardRead:
    source = await _get_visible_dashboard(dashboard_id, principal, db)

    name = await _unique_name(db, principal.active_tenant_id, principal.user.id, f"{source.name} (copy)")

    dash = Dashboard(
        tenant_id=principal.active_tenant_id,
        user_id=principal.user.id,
        name=name,
        description=source.description,
        is_shared=False,
        is_default=False,
        layout=copy.deepcopy(source.layout),
    )
    db.add(dash)
    await db.commit()

    return await _to_read(db, dash, principal, {principal.user.id: principal.user.username})
