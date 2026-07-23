"""AES-256-GCM encryption matching the Go collector's wire format.

Wire format: base64url( nonce_12_bytes || ciphertext_and_tag )
Key source:  ANTHRIMON_ENCRYPTION_KEY env var (64 lowercase hex chars = 32 bytes)
"""
from __future__ import annotations

import base64
import binascii
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def _load_key() -> bytes:
    hex_key = os.environ.get("ANTHRIMON_ENCRYPTION_KEY", "").strip()
    if not hex_key:
        raise RuntimeError(
            "ANTHRIMON_ENCRYPTION_KEY is not set — cannot encrypt/decrypt secrets"
        )
    try:
        raw = binascii.unhexlify(hex_key)
    except binascii.Error as exc:
        raise ValueError("ANTHRIMON_ENCRYPTION_KEY must be 64 lowercase hex chars") from exc
    if len(raw) != 32:
        raise ValueError("ANTHRIMON_ENCRYPTION_KEY must be 64 hex chars (32 bytes)")
    return raw


def is_configured() -> bool:
    return bool(os.environ.get("ANTHRIMON_ENCRYPTION_KEY", "").strip())


def encrypt(plaintext: str) -> str:
    """Return base64url(nonce_12 || ciphertext+tag)."""
    key = _load_key()
    nonce = os.urandom(12)
    ct = AESGCM(key).encrypt(nonce, plaintext.encode(), None)
    return base64.urlsafe_b64encode(nonce + ct).decode()


def decrypt(blob: str) -> str:
    """Decrypt a blob produced by encrypt(). Raises on bad key or tampered data."""
    key = _load_key()
    data = base64.urlsafe_b64decode(blob)
    if len(data) < 12:
        raise ValueError("Ciphertext too short")
    plaintext = AESGCM(key).decrypt(data[:12], data[12:], None)
    return plaintext.decode()


# ── Credential.data field-level helpers ──────────────────────────────────────
# Every place that stores or reads a Credential.data JSONB dict (SNMP
# community/auth/priv secrets, SSH passwords, etc.) must route through these
# three functions so the set of encrypted-at-rest fields has one definition.

SENSITIVE_CREDENTIAL_FIELDS = (
    "password", "passphrase", "private_key",  # ssh / netconf / gnmi
    "auth_key", "priv_key",                   # snmp_v3
    "community",                              # snmp_v2c
)
REDACTED_PLACEHOLDER = "***"


def encrypt_credential_data(data: dict) -> dict:
    """Return a copy of a Credential.data dict with sensitive fields encrypted."""
    if not is_configured():
        return data
    out = dict(data)
    for field in SENSITIVE_CREDENTIAL_FIELDS:
        val = out.get(field)
        if val and val != REDACTED_PLACEHOLDER:
            out[field] = encrypt(str(val))
    return out


def decrypt_credential_data(data: dict) -> dict:
    """Return a copy of a Credential.data dict with sensitive fields decrypted
    back to plaintext for actual use (SNMP auth, SSH login, snmptrapd config, …).

    A field that fails to decrypt is left as-is rather than raising — this
    covers legacy rows stored before encryption was enabled/fixed for that
    field, which are already plaintext.
    """
    if not is_configured():
        return data
    out = dict(data)
    for field in SENSITIVE_CREDENTIAL_FIELDS:
        val = out.get(field)
        if not val:
            continue
        try:
            out[field] = decrypt(val)
        except Exception:
            pass
    return out


def redact_credential_data(data: dict) -> dict:
    """Return a copy of a Credential.data dict with sensitive fields replaced
    by a fixed placeholder, for display in API responses."""
    out = dict(data)
    for field in SENSITIVE_CREDENTIAL_FIELDS:
        if out.get(field):
            out[field] = REDACTED_PLACEHOLDER
    return out
