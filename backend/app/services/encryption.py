"""Symmetric encryption for secrets at rest.

New module that lets the MCP server-config feature store API keys,
auth tokens, env-var blocks and other credentials as ciphertext in
MySQL. Designed to be a reusable helper for any future "store this
secret in the DB" use case — explicitly NOT MCP-specific.

Storage format:

    DB cell value = ``enc:v1:<base64-Fernet-token>``

The ``enc:v1:`` version prefix lets us:
- Detect "this is already encrypted" — :func:`encrypt_secret` is
  therefore idempotent, which matters because update paths often
  receive a mix of new-plaintext-values and unchanged-already-stored
  ones.
- Upgrade to v2/v3 schemes later without ambiguity.
- Keep legacy plaintext rows (if any ever existed) round-trippable
  during migration: :func:`decrypt_secret` passes through values that
  don't carry the prefix.

Configuration:

    Set ``GOKU_SECRET_KEY`` (env var) to a Fernet-compatible base64
    key (32 raw bytes, base64-encoded → 44 characters ending in "=").

    Generate one with::

        python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

    Add it to ``backend/.env``. Keep it stable across deploys — losing
    or rotating the key makes existing ciphertext unreadable (the
    :func:`decrypt_secret` call will raise :exc:`DecryptionFailed`).

Bootstrap policy:

    The module imports cleanly even when ``GOKU_SECRET_KEY`` is missing,
    so unrelated endpoints / migrations can keep working. The first
    call to :func:`encrypt_secret` / :func:`decrypt_secret` from any
    code path raises :exc:`SecretKeyMissing` — explicit and loud, never
    silently fall back to plaintext.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger(__name__)


_ENV_KEY = "GOKU_SECRET_KEY"
_PREFIX_V1 = "enc:v1:"

# Display sentinel returned to the UI for a "secret is set but we won't
# show it" state. Stays as a constant here so service / router layers
# all use the same string and the frontend can keep a stable check.
MASK_DISPLAY = "已配置 ********"
# Audit log sentinel for a secret-field change. Audit rows are durable
# and may be readable by ops staff who shouldn't see the live value, so
# the value itself NEVER appears in audit details — only this marker.
AUDIT_REDACTED = "[REDACTED]"


class SecretKeyMissing(RuntimeError):
    """``GOKU_SECRET_KEY`` is not set / invalid; encryption operations
    cannot proceed. Surfaces at first call rather than at import time so
    the rest of the backend (unrelated routes, migrations, etc.) can
    still run when the key is intentionally not configured (e.g. during
    initial setup).
    """


class DecryptionFailed(RuntimeError):
    """A stored ciphertext cannot be decrypted. Causes:

    - The encryption key was rotated or replaced (most common).
    - The ciphertext was corrupted on disk.
    - Someone hand-edited the row.
    """


_fernet: Optional[Fernet] = None


def _get_fernet() -> Fernet:
    """Lazily build the Fernet instance from ``GOKU_SECRET_KEY``.

    Cached at module level after first successful build so we don't pay
    the parse cost on every encrypt/decrypt call.
    """
    global _fernet
    if _fernet is not None:
        return _fernet
    key = os.environ.get(_ENV_KEY)
    if not key:
        raise SecretKeyMissing(
            f"{_ENV_KEY} env var is not set. Generate a Fernet key with: "
            'python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())" '
            "and add it to backend/.env. Without this key, MCP server "
            "secrets cannot be saved or read."
        )
    try:
        _fernet = Fernet(key.encode() if isinstance(key, str) else key)
    except Exception as e:
        raise SecretKeyMissing(
            f"{_ENV_KEY} is set but invalid — must be a base64-encoded 32-byte "
            f"Fernet key (44 chars ending in '='). Underlying error: {e}"
        ) from e
    return _fernet


def encrypt_secret(value: Optional[str]) -> Optional[str]:
    """Encrypt a plaintext secret for DB storage.

    Returns ``None`` / ``""`` unchanged so callers can pass through
    nullable fields without branching. Already-encrypted values
    (those carrying the version prefix) are also returned as-is —
    makes this safe to call on a mixed dict where some fields are
    new plaintext and some are "unchanged ciphertext we just read
    back from the DB".
    """
    if value is None or value == "":
        return value
    if value.startswith(_PREFIX_V1):
        return value
    token = _get_fernet().encrypt(value.encode("utf-8")).decode("ascii")
    return f"{_PREFIX_V1}{token}"


def decrypt_secret(stored: Optional[str]) -> Optional[str]:
    """Reverse :func:`encrypt_secret`.

    Values without the version prefix pass through as-is — supports
    one-time migration of any legacy plaintext rows without forcing a
    rewrite pass.

    Raises :exc:`DecryptionFailed` on corrupt / wrong-key ciphertext;
    raises :exc:`SecretKeyMissing` if ``GOKU_SECRET_KEY`` isn't
    configured.
    """
    if stored is None or stored == "":
        return stored
    if not stored.startswith(_PREFIX_V1):
        return stored
    try:
        return (
            _get_fernet()
            .decrypt(stored[len(_PREFIX_V1):].encode("ascii"))
            .decode("utf-8")
        )
    except InvalidToken as e:
        raise DecryptionFailed(
            "Failed to decrypt stored secret. Either the ciphertext is "
            "corrupt or the GOKU_SECRET_KEY has changed since this value "
            "was written."
        ) from e


def is_encrypted(value: Optional[str]) -> bool:
    """``True`` when ``value`` carries the version prefix and is therefore
    already encrypted. Useful for service-layer guards.
    """
    return isinstance(value, str) and value.startswith(_PREFIX_V1)


def mask_secret(stored: Optional[str]) -> str:
    """Return the UI display string for a stored secret.

    Indicates "a value is set" vs "no value" without revealing the
    plaintext or its length. Safe to call without the encryption key —
    only inspects whether ``stored`` is empty.
    """
    return MASK_DISPLAY if stored else ""


def sanitize_for_audit(stored: Optional[str]) -> str:
    """Audit-log-safe representation for a secret field.

    NEVER returns the plaintext, the ciphertext, or anything length-
    correlated — audit rows are durable and may be visible to people
    who shouldn't see secrets. Just indicates "field had a value" with
    a constant marker, or empty for absent values.
    """
    return AUDIT_REDACTED if stored else ""


def looks_like_mask(value: Optional[str]) -> bool:
    """``True`` if ``value`` looks like the UI mask sentinel coming back
    in a PUT body (because the frontend left the field untouched).

    Defence-in-depth check the service layer can use to detect "user
    didn't actually edit this secret" and skip re-encrypting / re-saving
    when re-receiving the mask string.
    """
    if not isinstance(value, str) or not value:
        return False
    return value == MASK_DISPLAY or "********" in value
