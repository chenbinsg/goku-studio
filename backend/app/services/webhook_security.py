"""Shared security helpers for inbound webhook and docs exposure policy."""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import secrets
import threading
import time
from typing import Optional

logger = logging.getLogger(__name__)

_TRUE_VALUES = {"1", "true", "yes", "on"}
_PROD_VALUES = {"prod", "production"}
_DEFAULT_TIMESTAMP_TOLERANCE_SECONDS = 300
_replay_lock = threading.Lock()
_replay_cache: dict[str, float] = {}


def insecure_webhooks_allowed() -> bool:
    """Return True only when operators explicitly opt into insecure webhook mode."""
    return os.environ.get("AIOS_ALLOW_INSECURE_WEBHOOKS", "").strip().lower() in _TRUE_VALUES


def allow_missing_webhook_secret(channel: str) -> bool:
    """Gate legacy insecure webhook behavior behind an explicit env switch."""
    allowed = insecure_webhooks_allowed()
    if allowed:
        logger.warning(
            "AIOS_ALLOW_INSECURE_WEBHOOKS is enabled; %s webhook verification will accept missing secrets. "
            "Use only for local development.",
            channel,
        )
    return allowed


def api_docs_enabled() -> bool:
    """Enable FastAPI docs in non-production by default, or via explicit override."""
    raw = os.environ.get("ENABLE_API_DOCS")
    if raw is not None and raw.strip() != "":
        return raw.strip().lower() in _TRUE_VALUES

    env = (
        os.environ.get("APP_ENV")
        or os.environ.get("ENVIRONMENT")
        or os.environ.get("ENV")
        or ""
    ).strip().lower()
    return env not in _PROD_VALUES


def webhook_timestamp_tolerance_seconds() -> int:
    raw = os.environ.get("AIOS_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS", "").strip()
    if not raw:
        return _DEFAULT_TIMESTAMP_TOLERANCE_SECONDS
    try:
        value = int(raw)
    except ValueError:
        logger.warning(
            "Invalid AIOS_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS=%r; falling back to %s",
            raw,
            _DEFAULT_TIMESTAMP_TOLERANCE_SECONDS,
        )
        return _DEFAULT_TIMESTAMP_TOLERANCE_SECONDS
    return max(30, value)


def validate_timestamp(raw_timestamp: str | None, *, now: Optional[int] = None) -> bool:
    if not raw_timestamp:
        return False
    try:
        ts = int(raw_timestamp)
    except (TypeError, ValueError):
        return False
    current = int(now if now is not None else time.time())
    return abs(current - ts) <= webhook_timestamp_tolerance_seconds()


def compute_timestamped_hmac(secret_value: str, *, timestamp: str, body: bytes) -> str:
    payload = timestamp.encode("utf-8") + b"." + body
    digest = hmac.new(secret_value.encode("utf-8"), payload, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def verify_timestamped_hmac(
    secret_value: str,
    *,
    timestamp: str | None,
    body: bytes,
    provided_signature: str | None,
) -> bool:
    if not timestamp or not provided_signature:
        return False
    expected = compute_timestamped_hmac(secret_value, timestamp=timestamp, body=body)
    return secrets.compare_digest(expected, provided_signature)


def check_and_store_replay(*, cache_key: str, ttl_seconds: Optional[int] = None) -> bool:
    now = time.time()
    ttl = float(ttl_seconds or webhook_timestamp_tolerance_seconds())
    expiry = now + ttl
    with _replay_lock:
        expired = [key for key, until in _replay_cache.items() if until <= now]
        for key in expired:
            _replay_cache.pop(key, None)
        if cache_key in _replay_cache:
            return False
        _replay_cache[cache_key] = expiry
    return True
