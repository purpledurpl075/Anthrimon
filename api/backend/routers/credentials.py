from __future__ import annotations

import uuid

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from .. import crypto as _crypto
from ..dependencies import get_current_user, get_db, require_role
from ..models.credential import Credential
from ..models.tenant import User
from ..schemas.credential import CredentialCreate, CredentialRead, CredentialUpdate

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/credentials", tags=["credentials"])

_SNMP_TYPES = ("snmp_v2c", "snmp_v3")
_ALL_TYPES   = ("snmp_v2c", "snmp_v3", "gnmi_tls", "ssh", "api_token", "netconf")

# Fields that are encrypted at rest.  All other fields (username, port, …)
# are stored and returned as-is.
_SENSITIVE = ("password", "passphrase", "private_key")
_REDACTED  = "***"


def _encrypt_data(data: dict) -> dict:
    """Return a copy of data with sensitive fields encrypted."""
    if not _crypto.is_configured():
        return data
    out = dict(data)
    for field in _SENSITIVE:
        val = out.get(field)
        if val and val != _REDACTED:
            out[field] = _crypto.encrypt(str(val))
    return out


def _redact_data(data: dict) -> dict:
    """Return a copy of data with sensitive fields replaced by '***'."""
    out = dict(data)
    for field in _SENSITIVE:
        if out.get(field):
            out[field] = _REDACTED
    return out


def _cred_read(cred: Credential) -> CredentialRead:
    """Build a CredentialRead response with sensitive fields redacted."""
    raw = cred.data if isinstance(cred.data, dict) else {}
    return CredentialRead(
        id=cred.id,
        name=cred.name,
        type=cred.type,
        data=_redact_data(raw),
        created_at=cred.created_at,
        updated_at=cred.updated_at,
    )


def _type_filter(types: tuple[str, ...]):
    return Credential.type.in_(types)


@router.get("", response_model=list[CredentialRead], summary="List credentials")
async def list_credentials(
    all: bool = Query(default=False, description="Return all types; default returns SNMP only"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[CredentialRead]:
    types = _ALL_TYPES if all else _SNMP_TYPES
    result = await db.execute(
        select(Credential)
        .where(Credential.tenant_id == current_user.tenant_id, _type_filter(types))
        .order_by(Credential.name)
    )
    return [_cred_read(c) for c in result.scalars().all()]


@router.post("", response_model=CredentialRead, status_code=status.HTTP_201_CREATED,
             summary="Create a credential")
async def create_credential(
    body: CredentialCreate,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> CredentialRead:
    if body.type not in _ALL_TYPES:
        raise HTTPException(status_code=400, detail=f"Unknown credential type '{body.type}'")
    cred = Credential(
        tenant_id=current_user.tenant_id,
        name=body.name,
        type=body.type,
        data=_encrypt_data(body.data),
    )
    db.add(cred)
    await db.commit()
    await db.refresh(cred)
    logger.info("credential_created", id=str(cred.id), name=cred.name, type=cred.type)
    return _cred_read(cred)


@router.get("/{cred_id}", response_model=CredentialRead, summary="Get a credential")
async def get_credential(
    cred_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CredentialRead:
    cred = await _get(cred_id, current_user.tenant_id, db)
    return _cred_read(cred)


@router.patch("/{cred_id}", response_model=CredentialRead, summary="Update a credential")
async def update_credential(
    cred_id: uuid.UUID,
    body: CredentialUpdate,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> CredentialRead:
    cred = await _get(cred_id, current_user.tenant_id, db)
    if body.name is not None:
        cred.name = body.name
    if body.data is not None:
        new_data = dict(body.data)
        existing = cred.data if isinstance(cred.data, dict) else {}
        # If a sensitive field is the redacted placeholder "***", the user
        # didn't change it — preserve the currently stored (encrypted) value.
        for field in _SENSITIVE:
            if new_data.get(field) == _REDACTED:
                if existing.get(field):
                    new_data[field] = existing[field]  # keep encrypted blob
                else:
                    del new_data[field]
        cred.data = _encrypt_data(new_data)
    await db.commit()
    await db.refresh(cred)
    logger.info("credential_updated", id=str(cred_id))
    return _cred_read(cred)


@router.delete("/{cred_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None,
               summary="Delete a credential")
async def delete_credential(
    cred_id: uuid.UUID,
    current_user: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> None:
    cred = await _get(cred_id, current_user.tenant_id, db)
    await db.delete(cred)
    await db.commit()
    logger.info("credential_deleted", id=str(cred_id))


async def _get(cred_id: uuid.UUID, tenant_id: uuid.UUID, db: AsyncSession) -> Credential:
    result = await db.execute(
        select(Credential).where(Credential.id == cred_id, Credential.tenant_id == tenant_id)
    )
    cred = result.scalar_one_or_none()
    if cred is None:
        raise HTTPException(status_code=404, detail="Credential not found")
    return cred
