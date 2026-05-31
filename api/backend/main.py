from __future__ import annotations

import asyncio
import binascii
import datetime
import os
import sys
from contextlib import asynccontextmanager
from typing import AsyncGenerator

import structlog
from fastapi import FastAPI, Request, status
from fastapi.encoders import ENCODERS_BY_TYPE
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# All datetimes in this app are stored/returned as UTC.  Naive datetimes come
# from PostgreSQL TIMESTAMP WITHOUT TIME ZONE columns.  Append 'Z' so that
# JavaScript's Date constructor treats them as UTC and toLocaleString() etc.
# automatically convert to the browser's local timezone.
ENCODERS_BY_TYPE[datetime.datetime] = (
    lambda dt: dt.isoformat() if dt.tzinfo else dt.isoformat() + "Z"
)

from .config import get_settings
from .database import engine
from .logging_config import configure_logging
from .alerting.engine import start_alert_engine
from .alerting.baselines import start_baseline_task
from .configmgmt.collector import start_config_collector
from .configmgmt.rest_state import start_rest_state_collector
from .configmgmt.api_orchestrator import start_api_probe_loop
from .configmgmt.eapi_collector import start_eapi_isis_collector
from .collectors.monitor import start_collector_monitor
from .routers import (admin_router, alerts_router, api_methods_router, auth_router, channels_router,
                      bgp_router, collectors_router, config_router, credentials_router, devices_router,
                      discovery_router, flow_router, syslog_router, interfaces_router,
                      maintenance_router, overview_router, policies_router, topology_router,
                      users_router)
from .routers.topology import start_topology_refresh_loop

configure_logging()
logger = structlog.get_logger(__name__)
_settings = get_settings()

# ── Startup secret validation ──────────────────────────────────────────────────

# Values that prove the operator has NOT set a real JWT secret.
_INSECURE_JWT_DEFAULTS = frozenset({
    "CHANGE_ME_IN_PRODUCTION",
    "changeme",
    "secret",
    "password",
    "jwt_secret",
    "",
})


def _validate_startup_secrets() -> None:
    """Abort the process if JWT secret or encryption key are missing / default.

    Called inside the lifespan so the structured logger is ready, but before
    any background tasks start.  Using sys.exit() rather than raise so that
    uvicorn prints our message to stderr and exits with status 1 cleanly.
    """
    errors: list[str] = []

    # ── JWT secret ────────────────────────────────────────────────────────────
    jwt_key = _settings.jwt_secret_key
    if jwt_key in _INSECURE_JWT_DEFAULTS or len(jwt_key) < 32:
        errors.append(
            "jwt_secret_key is missing, a known default, or shorter than 32 characters. "
            "Set jwt_secret_key in /etc/anthrimon/api.env to a long random string "
            "(e.g.  python3 -c \"import secrets; print(secrets.token_hex(32))\")."
        )

    # ── Database password ─────────────────────────────────────────────────────
    if _settings.db_password in ("changeme", "", "password", "postgres"):
        logger.warning("insecure_db_password",
                       detail="db_password is a known insecure default — consider changing it")

    # ── Encryption key ────────────────────────────────────────────────────────
    enc_hex = os.environ.get("ANTHRIMON_ENCRYPTION_KEY", "").strip()
    if not enc_hex:
        errors.append(
            "ANTHRIMON_ENCRYPTION_KEY is not set. "
            "Generate one with: python3 -c \"import secrets; print(secrets.token_hex(32))\""
        )
    else:
        try:
            raw = binascii.unhexlify(enc_hex)
        except binascii.Error:
            raw = b""
            errors.append(
                "ANTHRIMON_ENCRYPTION_KEY contains non-hexadecimal characters. "
                "It must be exactly 64 lowercase hex digits (32 bytes)."
            )
        if raw and len(raw) != 32:
            errors.append(
                f"ANTHRIMON_ENCRYPTION_KEY must be 64 hex chars (32 bytes); "
                f"got {2 * len(raw)} chars ({len(raw)} bytes)."
            )

    if errors:
        for msg in errors:
            logger.critical("startup_aborted_insecure_secret", detail=msg)
        sys.exit(
            "API startup aborted: one or more secrets are missing or insecure. "
            "Check the structured logs above for details."
        )


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    _validate_startup_secrets()
    logger.info("anthrimon_api_starting", version="0.1.0")
    engine_task      = await start_alert_engine()
    topology_task    = await start_topology_refresh_loop(interval_seconds=300)
    config_task      = start_config_collector(interval_s=3600)
    ssh_state_task   = start_rest_state_collector(interval_s=300)
    monitor_task     = start_collector_monitor()
    baseline_task    = start_baseline_task(interval_s=3600)
    probe_task       = start_api_probe_loop(interval_s=300)
    eapi_isis_task   = start_eapi_isis_collector(interval_s=300)
    yield
    eapi_isis_task.cancel()
    probe_task.cancel()
    engine_task.cancel()
    topology_task.cancel()
    config_task.cancel()
    ssh_state_task.cancel()
    monitor_task.cancel()
    baseline_task.cancel()
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
        await ssh_state_task
    except asyncio.CancelledError:
        pass
    try:
        await monitor_task
    except asyncio.CancelledError:
        pass
    try:
        await baseline_task
    except asyncio.CancelledError:
        pass
    try:
        await eapi_isis_task
    except asyncio.CancelledError:
        pass
    try:
        await probe_task
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
app.include_router(api_methods_router, prefix=PREFIX)
app.include_router(collectors_router,  prefix=PREFIX)
app.include_router(policies_router,    prefix=PREFIX)
app.include_router(topology_router,    prefix=PREFIX)
app.include_router(users_router,       prefix=PREFIX)
