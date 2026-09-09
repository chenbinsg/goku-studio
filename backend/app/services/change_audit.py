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

import re
from datetime import date, datetime
from typing import Any, Iterable

# Values longer than this are recorded as a length summary instead of the text.
# A system prompt runs to tens of KB; storing two copies per edit would bloat
# every row of the trail and slow the timeline query that reads them.
TEXT_LIMIT = 500

# Keys whose values never enter the trail, at any nesting depth.
_SECRET_KEY_RE = re.compile(r"(key|token|secret|password|passwd|credential)", re.I)

_REDACTED = "[REDACTED]"


def _mask(value: Any) -> Any:
    """Recursively replace secret-looking values, preserving structure."""
    if isinstance(value, dict):
        return {
            k: (_REDACTED if _SECRET_KEY_RE.search(str(k)) else _mask(v))
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [_mask(v) for v in value]
    return value


def _plain(value: Any) -> Any:
    """Make a column value JSON-serialisable and bounded."""
    if isinstance(value, (datetime, date)):
        return value.isoformat()
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
        out[col.name] = _plain(getattr(obj, col.name, None))
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


# Timestamps say nothing a diff does not already carry: updated_at moves on
# every edit and would make every row look changed.
AGENT_SKIP_FIELDS = ("created_at", "updated_at")
