"""Sample license-gated module. Mounted only when the 'hello' module is licensed.

Proves the loader end-to-end: without a license naming "hello" this router is
never mounted (GET /api/v1/modules/hello → 404); with it, the endpoint works.
Ships no real functionality.
"""
from fastapi import APIRouter, Depends

from ...dependencies import get_current_principal, Principal
from ...licensing import license_info

router = APIRouter(prefix="/modules/hello", tags=["modules:hello"])


@router.get("", summary="Sample licensed-module endpoint")
async def hello(principal: Principal = Depends(get_current_principal)) -> dict:
    info = license_info()
    return {
        "message": "hello from a licensed module",
        "lic_id": info.lic_id,
        "modules": info.modules,
    }
