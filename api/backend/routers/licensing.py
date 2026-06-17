"""License status + management endpoints.

- GET  /license                      — status summary for any authenticated user (UI).
- GET  /platform/license/request     — download the machine-bound license REQUEST.
- POST /platform/license             — upload + verify + persist a license.
- DELETE /platform/license           — remove the license (revert to free tier).

The signing private key never lives here; this only verifies against the bundled
public key and persists the customer-supplied file.
"""
from __future__ import annotations

import json
import os
import socket
from datetime import datetime, timezone

import structlog
from fastapi import APIRouter, Depends, File, HTTPException, Request, Response, UploadFile, status

from ..config import get_settings
from ..dependencies import get_current_principal, require_platform, Principal
from ..licensing import license_info, reload_license, verify_bytes
from ..licensing.fingerprint import machine_fingerprint

logger = structlog.get_logger(__name__)
router = APIRouter(tags=["licensing"])

_MAX_LICENSE_BYTES = 64 * 1024


@router.get("/license", summary="Current license status")
async def get_license(principal: Principal = Depends(get_current_principal)) -> dict:
    info = license_info()
    out = info.as_dict()
    # Always expose this host's fingerprint so the UI can show it / build a request.
    out["machine_fingerprint"] = machine_fingerprint()
    return out


@router.get("/platform/license/request",
            summary="Download this host's license request (machine fingerprint)")
async def download_license_request(
    principal: Principal = Depends(require_platform("platform_admin")),
) -> Response:
    req = {
        "product": "anthrimon",
        "machine_fingerprint": machine_fingerprint(),
        "hostname": socket.gethostname(),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    body = json.dumps(req, indent=2)
    return Response(
        content=body,
        media_type="application/json",
        headers={"Content-Disposition": 'attachment; filename="anthrimon-license-request.json"'},
    )


@router.post("/platform/license", summary="Upload a license file")
async def upload_license(
    request: Request,
    file: UploadFile = File(...),
    principal: Principal = Depends(require_platform("platform_admin")),
) -> dict:
    raw = await file.read()
    if not raw or len(raw) > _MAX_LICENSE_BYTES:
        raise HTTPException(status_code=400, detail="empty or oversized license file")

    # Verify BEFORE persisting — reject bad signature / wrong machine / expired.
    ok, result = verify_bytes(raw)
    if not ok:
        raise HTTPException(status_code=422, detail=str(result))

    path = get_settings().license_path
    try:
        # Write in place (installer makes the file service-writable, 0600).
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(raw.strip() + b"\n")
    except OSError as exc:
        logger.error("license_persist_failed", path=path, error=str(exc))
        raise HTTPException(
            status_code=500,
            detail=f"could not write license to {path}: {exc}. "
                   "Ensure the file is writable by the API service user.",
        )

    info = reload_license()
    # Mount any modules this license newly enables, without a restart.
    try:
        from ..modules.loader import mount_licensed
        newly = mount_licensed(request.app)
    except Exception as exc:  # never let module mounting fail the upload
        logger.warning("license_module_mount_warning", error=str(exc))
        newly = []

    logger.info("license_uploaded", lic_id=info.lic_id, modules=info.modules,
                newly_mounted=newly)
    out = info.as_dict()
    out["machine_fingerprint"] = machine_fingerprint()
    out["newly_mounted_modules"] = newly
    return out


@router.delete("/platform/license", status_code=status.HTTP_200_OK,
               summary="Remove the installed license (revert to free tier)")
async def delete_license(
    principal: Principal = Depends(require_platform("platform_admin")),
) -> dict:
    path = get_settings().license_path
    if os.path.exists(path):
        try:
            os.remove(path)
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"could not remove license: {exc}")
    info = reload_license()
    logger.info("license_removed")
    out = info.as_dict()
    out["machine_fingerprint"] = machine_fingerprint()
    return out
