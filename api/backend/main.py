from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import AsyncGenerator

import structlog
from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import get_settings
from .database import engine
from .logging_config import configure_logging
from .alerting.engine import start_alert_engine
from .configmgmt.collector import start_config_collector
from .collectors.monitor import start_collector_monitor
from .routers import (admin_router, alerts_router, auth_router, channels_router,
                      bgp_router, collectors_router, config_router, credentials_router, devices_router,
                      discovery_router, flow_router, syslog_router, interfaces_router,
                      maintenance_router, overview_router, policies_router, topology_router,
                      users_router)
from .routers.topology import start_topology_refresh_loop

configure_logging()
logger = structlog.get_logger(__name__)
_settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    logger.info("anthrimon_api_starting", version="0.1.0")
    engine_task   = await start_alert_engine()
    topology_task = await start_topology_refresh_loop(interval_seconds=300)
    config_task    = start_config_collector(interval_s=3600)
    monitor_task   = start_collector_monitor()
    yield
    engine_task.cancel()
    topology_task.cancel()
    config_task.cancel()
    monitor_task.cancel()
    try:
        await engine_task
    except asyncio.CancelledError:
        pass
    try:
        await topology_task
    except asyncio.CancelledError:
        pass
    try:
        await config_task
    except asyncio.CancelledError:
        pass
    try:
        await monitor_task
    except asyncio.CancelledError:
        pass
    await engine.dispose()
    logger.info("anthrimon_api_stopped")


app = FastAPI(
    title="Anthrimon API",
    description="Network monitoring and orchestration platform API",
    version="0.1.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)

# Allow the React dev server. In production, set CORS_ORIGINS env var.
_cors_origins = _settings.cors_origins if _settings.cors_origins else [
    "http://localhost:5173",
    "http://localhost:3000",
    "http://127.0.0.1:5173",
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Global exception handlers ──────────────────────────────────────────────────

@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.error("unhandled_exception", path=request.url.path, error=str(exc), exc_info=exc)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "Internal server error"},
    )


# ── Health check (unauthenticated) ─────────────────────────────────────────────

@app.get("/health", tags=["meta"], summary="Liveness probe")
async def health_check() -> dict:
    return {"status": "ok", "version": "0.1.0"}


# ── API v1 routers ─────────────────────────────────────────────────────────────

PREFIX = "/api/v1"

app.include_router(admin_router,       prefix=PREFIX)
app.include_router(auth_router,        prefix=PREFIX)
app.include_router(devices_router,     prefix=PREFIX)
app.include_router(interfaces_router,  prefix=PREFIX)
app.include_router(alerts_router,      prefix=PREFIX)
app.include_router(channels_router,    prefix=PREFIX)
app.include_router(maintenance_router, prefix=PREFIX)
app.include_router(credentials_router, prefix=PREFIX)
app.include_router(discovery_router,   prefix=PREFIX)
app.include_router(overview_router,    prefix=PREFIX)
app.include_router(flow_router,        prefix=PREFIX)
app.include_router(syslog_router,      prefix=PREFIX)
app.include_router(config_router,      prefix=PREFIX)
app.include_router(bgp_router,         prefix=PREFIX)
app.include_router(collectors_router,  prefix=PREFIX)
app.include_router(policies_router,    prefix=PREFIX)
app.include_router(topology_router,    prefix=PREFIX)
app.include_router(users_router,       prefix=PREFIX)
