"""Field-level diffs for the audit trail.

``audit_logs.details`` used to carry only a name, so 889 ``update_agent`` rows
were indistinguishable from one another: the trail could say *who* touched an
agent but never *what they changed*. These helpers produce the ``changes``
shape the MCP tables already use — ``{field: {"before": ..., "after": ...}}`` —
so one renderer can display every resource type.

Deliberately MySQL-only: nothing here writes to stdout. The ES pipeline sees a
process's log stream, and audit rows are not log lines — mixing the two is what
buried the config trail under tool-call traffic in the first place.
"""
from __future__ import annotations

import enum
import hashlib
import hmac
import json
import os
import re
from datetime import date, datetime
from typing import Any, Iterable

# Values longer than this are recorded as a length summary instead of the text.
# A system prompt runs to tens of KB; storing two copies per edit would bloat
# every row of the trail and slow the timeline query that reads them.
TEXT_LIMIT = 500

# Keys whose values never enter the trail, at any nesting depth. Deliberately
# broad: nested config is free-form (apiKey, x_auth_token), and over-masking a
# value there costs less than leaking one.
_SECRET_KEY_RE = re.compile(r"(key|token|secret|password|passwd|credential)", re.I)

# Column names that hold a secret. Narrower than the key rule on purpose: a
# column is a known name, and the broad rule would hide `quota_tokens_per_day`
# and `trigger_keywords`, which are ordinary values a reader needs.
_SECRET_COLUMN_RE = re.compile(
    r"(^|_)(api_key|key|secret|password|passwd|token|credential|backup_codes)($|_)", re.I)

_REDACTED = "[REDACTED]"


def _fingerprint(value: Any) -> Any:
    """What a secret is recorded as.

    Not a flat "[REDACTED]": then the before and after of a rotated secret are
    identical, the diff sees no change, and a credential swap leaves no trace.
    The tag is an HMAC under the server's SECRET_KEY — equal values give equal
    tags, so a change shows, while the tag cannot be reversed or guessed
    offline. An unset secret stays visibly unset.
    """
    if value is None or value == "":
        return value
    key = os.environ.get("SECRET_KEY", "").encode()
    if not key:
        return _REDACTED
    raw = json.dumps(value, sort_keys=True, default=str).encode()
    return f"[REDACTED·{hmac.new(key, raw, hashlib.sha256).hexdigest()[:8]}]"


def _mask(value: Any) -> Any:
    """Recursively replace secret-looking values, preserving structure."""
    if isinstance(value, dict):
        return {
            k: (_fingerprint(v) if _SECRET_KEY_RE.search(str(k)) else _mask(v))
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [_mask(v) for v in value]
    return value


def _plain(value: Any) -> Any:
    """Make a column value JSON-serialisable and bounded."""
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    # Enum columns (an SSO protocol, a task status) would otherwise reach the
    # JSON column as objects it cannot serialise, and the whole row is lost.
    if isinstance(value, enum.Enum):
        return value.value
    value = _mask(value)
    if isinstance(value, str) and len(value) > TEXT_LIMIT:
        return {"_truncated": True, "length": len(value), "head": value[:TEXT_LIMIT]}
    return value


def snapshot(obj: Any, *, skip: Iterable[str] = ()) -> dict[str, Any]:
    """Capture an ORM row as a plain dict, ready to diff or store."""
    skip = set(skip)
    out: dict[str, Any] = {}
    for col in obj.__table__.columns:
        if col.name in skip:
            continue
        value = getattr(obj, col.name, None)
        # A column that *is* a secret (a tenant's api_key, an SSO client
        # secret) was copied verbatim before: masking only ever looked at keys
        # inside dict values, never at the column's own name.
        out[col.name] = (_fingerprint(value) if _SECRET_COLUMN_RE.search(col.name)
                         else _plain(value))
    return out


def diff(before: dict[str, Any] | None, after: dict[str, Any] | None) -> dict[str, Any]:
    """Return only the fields that actually changed.

    An empty result means the request wrote nothing — the caller should skip the
    audit row entirely rather than record a no-op edit, which is most of what a
    "save" button produces.
    """
    before, after = before or {}, after or {}
    changed: dict[str, Any] = {}
    for key in set(before) | set(after):
        b, a = before.get(key), after.get(key)
        if b != a:
            changed[key] = {"before": b, "after": a}
    return changed


def field_diff(field: str, before: Any, after: Any) -> dict[str, Any]:
    """The diff for one known field, with the same bounding and masking as
    `snapshot` — for callers that changed a single column and have plain values
    in hand, rather than an ORM row to snapshot twice.

    Snapshotting reads the row's table metadata; a caller doing work that must
    happen regardless (reverting a prompt, say) should not have that work depend
    on the row being introspectable.
    """
    if _SECRET_COLUMN_RE.search(field):
        b, a = _fingerprint(before), _fingerprint(after)
    else:
        b, a = _plain(before), _plain(after)
    return {} if b == a else {field: {"before": b, "after": a}}


# Timestamps say nothing a diff does not already carry: updated_at moves on
# every edit and would make every row look changed.
AGENT_SKIP_FIELDS = ("created_at", "updated_at")
