"""License-gated module loader.

Discovers `modules/<name>/manifest.yaml`, and mounts each module's router onto
the app only when its `license_key` is covered by a valid license. Re-running
`mount_licensed` after a license upload mounts newly-licensed modules without a
restart (it resets the cached OpenAPI schema and skips already-mounted ones).

manifest.yaml schema:
    name:        hello
    version:     1.0.0
    license_key: hello                 # the key checked via is_licensed()
    router:      backend.modules.hello.router:router   # "import.path:attribute"
"""
from __future__ import annotations

import importlib
import os

import structlog
import yaml

logger = structlog.get_logger(__name__)

_MODULES_DIR = os.path.dirname(__file__)
_mounted: set[str] = set()


def discover() -> list[dict]:
    """Return parsed manifests for all modules under modules/*/manifest.yaml."""
    manifests: list[dict] = []
    for name in sorted(os.listdir(_MODULES_DIR)):
        mpath = os.path.join(_MODULES_DIR, name, "manifest.yaml")
        if not os.path.isfile(mpath):
            continue
        try:
            with open(mpath) as f:
                m = yaml.safe_load(f) or {}
            if m.get("name") and m.get("router") and m.get("license_key"):
                manifests.append(m)
            else:
                logger.warning("module_manifest_incomplete", path=mpath)
        except Exception as exc:
            logger.error("module_manifest_error", path=mpath, error=str(exc))
    return manifests


def _import_router(spec: str):
    mod_path, _, attr = spec.partition(":")
    module = importlib.import_module(mod_path)
    return getattr(module, attr or "router")


def mount_licensed(app, prefix: str = "/api/v1") -> list[str]:
    """Mount the routers of all licensed, not-yet-mounted modules. Returns the
    list of module names mounted on this call."""
    from fastapi import Depends
    from ..licensing import is_licensed
    from ..dependencies import require_license

    newly: list[str] = []
    for m in discover():
        name = m["name"]
        if name in _mounted:
            continue
        if not is_licensed(m["license_key"]):
            continue
        try:
            router = _import_router(m["router"])
            # Inject a per-request license gate so a license REVOKED after mount
            # returns 402 immediately (routes can't be cleanly unmounted at
            # runtime). Never-licensed modules are simply never mounted (404).
            app.include_router(
                router, prefix=prefix,
                dependencies=[Depends(require_license(m["license_key"]))],
            )
            _mounted.add(name)
            newly.append(name)
            logger.info("module_mounted", module=name, version=m.get("version"))
        except Exception as exc:
            logger.error("module_mount_failed", module=name, error=str(exc))

    if newly:
        # Routes added after startup require invalidating the cached schema.
        app.openapi_schema = None
    return newly
