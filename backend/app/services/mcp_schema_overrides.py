"""Admin-curated MCP inputSchema patches (holes-only + fingerprint quarantine).

Many MCP servers ship under-specified inputSchemas — params without type
or description (e.g. es-CountTool's ``body`` is literally "Request body"),
leaving the LLM to guess formats. Admins can attach a patch per capability
param; patches obey three safety rules so a stale annotation can never
mislead the model:

1. **Holes-only merge** — a patch field applies only where the raw schema
   has NO value for it. The upstream contract always wins; when upstream
   later fills the hole itself, the patch silently stops applying.
2. **Fingerprint pinning** — each patch stores a hash of the raw param
   definition it annotated. Any upstream change flips the fingerprint.
3. **Sync-time quarantine** — every capability sync revalidates statuses:
   ``active`` (merge), ``stale_param_missing`` (param gone upstream) or
   ``stale_upstream_changed`` (definition changed). Non-active patches are
   NEVER merged; they stay visible in the UI for the admin to re-confirm,
   rewrite, or delete.

Stored shape (mcp_capabilities.schema_overrides)::

    {"params": {"body": {"description": "…", "type": "object",
                          "fingerprint": "ab12…", "status": "active"}}}

Merged at MCP tool registration (registry_integration) so the LLM sees the
effective schema on every turn with zero per-call cost.
"""
from __future__ import annotations

import copy
import hashlib
import json
from typing import Any, Optional, Tuple

# Fields an admin may supplement. Deliberately narrow: format knowledge
# only — never enum/required/default, which change validation semantics.
PATCHABLE_FIELDS = ("description", "type")

STATUS_ACTIVE = "active"
STATUS_PARAM_MISSING = "stale_param_missing"
STATUS_UPSTREAM_CHANGED = "stale_upstream_changed"


def param_fingerprint(raw_param: Any) -> str:
    """Stable hash of one param's RAW definition (order-insensitive)."""
    canon = json.dumps(raw_param or {}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()[:16]


def _props(raw_schema: Any) -> dict:
    if isinstance(raw_schema, dict) and isinstance(raw_schema.get("properties"), dict):
        return raw_schema["properties"]
    return {}


def revalidate_overrides(
    raw_schema: Any, overrides: Optional[dict],
) -> Tuple[Optional[dict], bool]:
    """Recompute each patch's status against the CURRENT raw schema.

    Called on every capability sync. Returns ``(overrides, changed)`` —
    the same dict mutated in place, and whether anything changed (so the
    caller only writes the row when needed).
    """
    if not isinstance(overrides, dict) or not isinstance(overrides.get("params"), dict):
        return overrides, False
    props = _props(raw_schema)
    changed = False
    for name, patch in overrides["params"].items():
        if not isinstance(patch, dict):
            continue
        if name not in props:
            new_status = STATUS_PARAM_MISSING
        elif patch.get("fingerprint") != param_fingerprint(props[name]):
            new_status = STATUS_UPSTREAM_CHANGED
        else:
            new_status = STATUS_ACTIVE
        if patch.get("status") != new_status:
            patch["status"] = new_status
            changed = True
    return overrides, changed


def effective_input_schema(raw_schema: Any, overrides: Optional[dict]) -> Any:
    """Raw schema ⊕ ACTIVE patches, holes-only.

    Defense in depth: even a patch marked active is re-verified against
    the current fingerprint before merging — a stale annotation must not
    reach the model even if a status write was missed somewhere.
    Returns the raw schema object untouched when nothing merges.
    """
    if not isinstance(raw_schema, dict):
        return raw_schema
    if not isinstance(overrides, dict) or not isinstance(overrides.get("params"), dict):
        return raw_schema
    props = _props(raw_schema)
    if not props:
        return raw_schema
    merged: Optional[dict] = None
    for name, patch in overrides["params"].items():
        if not isinstance(patch, dict) or patch.get("status") != STATUS_ACTIVE:
            continue
        raw_param = props.get(name)
        if raw_param is None or patch.get("fingerprint") != param_fingerprint(raw_param):
            continue
        raw_p = raw_param or {}
        additions = {}
        # ``type`` (and any future semantic field) is strictly holes-only —
        # contradicting the upstream contract is never allowed.
        if patch.get("type") and not raw_p.get("type"):
            additions["type"] = patch["type"]
        # ``description`` merges ADDITIVELY: upstream text is kept verbatim
        # and the admin supplement is appended. A supplement cannot
        # contradict the contract, and many upstream descriptions are
        # present-but-useless ("Request body") — holes-only would block
        # exactly the annotations this feature exists for.
        if patch.get("description"):
            raw_desc = (raw_p.get("description") or "").strip()
            if patch["description"].strip() not in raw_desc:
                additions["description"] = (
                    f"{raw_desc}\n{patch['description']}" if raw_desc else patch["description"]
                )
        if not additions:
            continue
        if merged is None:
            merged = copy.deepcopy(raw_schema)
        merged["properties"][name] = {**raw_p, **additions}
    return merged if merged is not None else raw_schema


def build_overrides(raw_schema: Any, params_input: dict) -> dict:
    """Build a fresh overrides dict from admin input
    ``{param: {description?, type?}}``, stamping fingerprints from the
    CURRENT raw schema. Unknown params raise ``ValueError`` (the editor
    should offer only real params); non-patchable fields are dropped.
    """
    props = _props(raw_schema)
    out: dict = {"params": {}}
    for name, fields in (params_input or {}).items():
        if name not in props:
            raise ValueError(
                f"参数 {name!r} 不存在于该能力的原始 schema 中"
                f"（可选: {', '.join(sorted(props)) or '无'}）"
            )
        if not isinstance(fields, dict):
            raise ValueError(f"参数 {name!r} 的补丁必须是对象")
        cleaned = {k: v for k, v in fields.items() if k in PATCHABLE_FIELDS and v}
        if not cleaned:
            continue
        out["params"][name] = {
            **cleaned,
            "fingerprint": param_fingerprint(props[name]),
            "status": STATUS_ACTIVE,
        }
    return out if out["params"] else {}
