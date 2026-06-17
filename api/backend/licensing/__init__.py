"""Anthrimon licensing — the single, frozen interface the rest of the app uses.

Everything (routers, evaluators, module loader, UI status endpoint) calls only
`is_licensed()` / `license_info()`. The *source* of truth here is an offline
RS256-signed license file verified against a bundled public key — but because
nothing outside this module reads the file or the claims directly, swapping in an
online/SaaS provider later changes only this module's internals.

Free tier = no valid license file. Absent / invalid / expired / wrong-machine
licenses all degrade to free tier (with a loud log), unless `license_strict` is
set, in which case a wrong-machine license hard-fails at startup.
"""
from __future__ import annotations

import os
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

import jwt
import structlog

from .fingerprint import machine_fingerprint

logger = structlog.get_logger(__name__)

_PUBKEY_PATH = os.path.join(os.path.dirname(__file__), "keys", "anthrimon_license_pub.pem")

_lock = threading.Lock()
_cached: Optional["LicenseInfo"] = None


@dataclass
class LicenseInfo:
    valid: bool = False
    modules: list[str] = field(default_factory=list)
    max_devices: int = 0                      # 0 = unlimited
    tenant: Optional[str] = None
    lic_id: Optional[str] = None
    expires_at: Optional[str] = None          # ISO8601
    machine_bound: bool = False               # license carries machine_ids
    machine_match: bool = True                # local fingerprint ∈ machine_ids (or unbound)
    reason: str = "free_tier"                 # why not valid, when valid is False

    def as_dict(self) -> dict:
        return {
            "valid": self.valid,
            "modules": self.modules,
            "max_devices": self.max_devices,
            "tenant": self.tenant,
            "lic_id": self.lic_id,
            "expires_at": self.expires_at,
            "machine_bound": self.machine_bound,
            "machine_match": self.machine_match,
            "reason": self.reason,
        }


def _public_key() -> Optional[bytes]:
    try:
        with open(_PUBKEY_PATH, "rb") as f:
            return f.read()
    except OSError:
        logger.warning("license_pubkey_missing", path=_PUBKEY_PATH)
        return None


def verify_bytes(raw: bytes | str) -> tuple[bool, dict | str]:
    """Verify a raw license token's signature, expiry, and machine binding.

    Returns (True, claims) or (False, error_message). Used by the upload handler
    to validate BEFORE persisting, and by load_license().
    """
    pub = _public_key()
    if pub is None:
        return False, "license public key not bundled"
    token = raw.decode() if isinstance(raw, (bytes, bytearray)) else raw
    token = token.strip()
    try:
        claims = jwt.decode(token, pub, algorithms=["RS256"])
    except jwt.ExpiredSignatureError:
        return False, "license has expired"
    except jwt.InvalidTokenError as exc:
        return False, f"invalid license signature: {exc}"

    machine_ids = claims.get("machine_ids") or []
    if machine_ids:
        fp = machine_fingerprint()
        if fp not in machine_ids:
            return False, (
                "license is bound to a different machine "
                f"(this host is {fp})"
            )
    return True, claims


def _license_path() -> str:
    from ..config import get_settings
    return get_settings().license_path


def _strict() -> bool:
    from ..config import get_settings
    return bool(getattr(get_settings(), "license_strict", False))


def _build_info(claims: dict) -> LicenseInfo:
    exp = claims.get("exp")
    return LicenseInfo(
        valid=True,
        modules=list(claims.get("modules") or []),
        max_devices=int(claims.get("max_devices") or 0),
        tenant=claims.get("tenant"),
        lic_id=claims.get("lic_id"),
        expires_at=datetime.fromtimestamp(exp, timezone.utc).isoformat() if exp else None,
        machine_bound=bool(claims.get("machine_ids")),
        machine_match=True,
        reason="licensed",
    )


def load_license() -> LicenseInfo:
    """(Re)read and verify the license file; cache and return the result.

    Always returns a LicenseInfo (free tier on any problem). Called once at
    startup and again after an upload/delete via reload_license().
    """
    global _cached
    path = _license_path()
    info: LicenseInfo

    if not os.path.exists(path):
        info = LicenseInfo(valid=False, reason="free_tier")
    else:
        try:
            with open(path, "rb") as f:
                raw = f.read()
        except OSError as exc:
            info = LicenseInfo(valid=False, reason=f"unreadable: {exc}")
        else:
            ok, result = verify_bytes(raw)
            if ok:
                info = _build_info(result)  # type: ignore[arg-type]
            else:
                msg = str(result)
                # Distinguish wrong-machine (node-lock) from other failures.
                if "different machine" in msg:
                    if _strict():
                        logger.error("license_machine_mismatch_strict", detail=msg)
                        raise RuntimeError(f"License node-lock failed: {msg}")
                    logger.warning("license_machine_mismatch", detail=msg,
                                   action="degrading to free tier")
                    info = LicenseInfo(valid=False, machine_bound=True,
                                       machine_match=False, reason=msg)
                else:
                    logger.warning("license_invalid", detail=msg)
                    info = LicenseInfo(valid=False, reason=msg)

    with _lock:
        _cached = info
    if info.valid:
        logger.info("license_loaded", lic_id=info.lic_id, modules=info.modules,
                    expires_at=info.expires_at)
    return info


def reload_license() -> LicenseInfo:
    return load_license()


def license_info() -> LicenseInfo:
    """Return the cached license status (loads on first access)."""
    if _cached is None:
        return load_license()
    return _cached


def is_licensed(module: str) -> bool:
    """Return True if `module` is covered by a currently-valid license.

    A license whose modules list contains "*" is a grant-all license and covers
    every module.
    """
    info = license_info()
    if not info.valid:
        return False
    return "*" in info.modules or module in info.modules
