"""MCP Capability ↔ Principal authorization service.

Implements the "MCP 能力授权调用方" feature. Default-deny: an MCP
Capability cannot be called by any principal unless an enabled,
non-deleted ``mcp_capability_authorizations`` row grants it.

A "principal" is whatever calls a capability — ``(principal_type,
principal_id)``, type ∈ ai_tool / agent / workflow / system_job.

Owns:
  - authorization CRUD (list / create / patch / enable / disable /
    soft-delete) — principal-generic
  - quota math: capability total quota, per-authorization allocated
    quota, ``remaining_authorizable_quota`` (= limit − Σ allocated),
    edit-time exclude-self
  - lazy period reset
  - capability total-quota PATCH
  - the invocation enforcement chain (spec §8) + quota consume

The core check is principal-generic: AI Tool and Agent invocations both
go through :func:`check_principal_authorization` /
:func:`invoke_principal_via_mcp` — no per-type duplication.
"""
from __future__ import annotations

import logging
import time
import uuid
from datetime import datetime, timedelta
from typing import Any, List, Optional, Tuple

from fastapi import HTTPException, Request, status
from sqlalchemy import func
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app import auth as _auth
from app.models import (
    AgentDefinition,
    MCPCallLog,
    MCPCapability,
    MCPCapabilityAuthorization,
    MCPServer,
    Tool as AITool,
)
from app.schemas import (
    MCPAuthorizationCreate,
    MCPAuthorizationItem,
    MCPAuthorizationSummaryResponse,
    MCPAuthorizationUpdate,
    MCPCapabilityAuthorizationSummary,
    MCPCapabilityQuotaConfig,
    MCPCapabilityQuotaUpdate,
)
from app.services import mcp_capabilities as caps

logger = logging.getLogger(__name__)

_AUDIT_TYPE = "mcp_capability_authorization"

# Structured invocation error codes (spec §10).
ERR_NOT_AUTHORIZED = "MCP_CAPABILITY_NOT_AUTHORIZED"
ERR_AUTHZ_DISABLED = "MCP_AUTHORIZATION_DISABLED"
ERR_AUTHZ_QUOTA = "MCP_AUTHORIZED_QUOTA_EXCEEDED"
ERR_CAPABILITY_QUOTA = "MCP_CAPABILITY_QUOTA_EXCEEDED"
ERR_CAPABILITY_RATE = "MCP_CAPABILITY_RATE_EXCEEDED"

# principal_type values accepted by the backend. The first version's UI
# only offers ai_tool / agent; workflow / system_job are reserved.
VALID_PRINCIPAL_TYPES = {"ai_tool", "agent", "workflow", "system_job"}


# ─── Lookups ──────────────────────────────────────────────────────────

def _get_server_or_404(db: Session, server_id: str) -> MCPServer:
    server = (
        db.query(MCPServer)
        .filter(MCPServer.id == server_id, MCPServer.deleted_at.is_(None))
        .first()
    )
    if server is None:
        raise HTTPException(404, f"MCP server {server_id!r} not found")
    return server


def _get_capability_or_404(
    db: Session, server_id: str, capability_id: str,
) -> MCPCapability:
    """Capability scoped to a server. Allows inactive capabilities —
    authorization CRUD may target either; the invoke path re-checks
    active separately."""
    cap = (
        db.query(MCPCapability)
        .filter(
            MCPCapability.id == capability_id,
            MCPCapability.server_id == server_id,
        )
        .first()
    )
    if cap is None:
        raise HTTPException(
            404, f"MCP capability {capability_id!r} not found on server {server_id!r}",
        )
    return cap


def resolve_principal(
    db: Session, principal_type: str, principal_id: str,
) -> Tuple[bool, Optional[str]]:
    """Resolve a principal to ``(exists, display_name)``.

      - ai_tool → ``tools`` registry
      - agent   → ``agent_definitions``
      - workflow / system_job → reserved; accepted without a registry
        check (returns exists=True, name=None) until those subsystems
        expose lookups.
    """
    if principal_type == "ai_tool":
        t = db.query(AITool).filter(AITool.id == principal_id).first()
        return (t is not None, t.name if t else None)
    if principal_type == "agent":
        a = db.query(AgentDefinition).filter(AgentDefinition.id == principal_id).first()
        return (a is not None, a.name if a else None)
    if principal_type in ("workflow", "system_job"):
        return (True, None)
    return (False, None)


def _principal_names(db: Session, pairs: list[tuple[str, str]]) -> dict[tuple[str, str], str]:
    """Bulk-resolve display names for a set of (type, id) pairs."""
    out: dict[tuple[str, str], str] = {}
    tool_ids = [pid for (pt, pid) in pairs if pt == "ai_tool"]
    agent_ids = [pid for (pt, pid) in pairs if pt == "agent"]
    if tool_ids:
        for t in db.query(AITool).filter(AITool.id.in_(set(tool_ids))).all():
            out[("ai_tool", t.id)] = t.name
    if agent_ids:
        for a in db.query(AgentDefinition).filter(AgentDefinition.id.in_(set(agent_ids))).all():
            out[("agent", a.id)] = a.name
    return out


def _get_authorization_or_404(
    db: Session, server_id: str, authorization_id: str,
) -> MCPCapabilityAuthorization:
    """Fetch a non-deleted authorization scoped to a server."""
    authz = (
        db.query(MCPCapabilityAuthorization)
        .filter(
            MCPCapabilityAuthorization.id == authorization_id,
            MCPCapabilityAuthorization.mcp_server_id == server_id,
            MCPCapabilityAuthorization.deleted_at.is_(None),
        )
        .first()
    )
    if authz is None:
        raise HTTPException(
            404, f"Authorization {authorization_id!r} not found on server {server_id!r}",
        )
    return authz


# ─── Period / lazy reset ──────────────────────────────────────────────

def _period_end(period: str, now: datetime) -> datetime:
    """End of the calendar period containing ``now`` (UTC)."""
    if period == "minute":
        return now.replace(second=0, microsecond=0) + timedelta(minutes=1)
    if period == "hour":
        return now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    if period == "day":
        return now.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
    if period == "month":
        base = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        return base.replace(year=base.year + 1, month=1) if base.month == 12 \
            else base.replace(month=base.month + 1)
    return now + timedelta(days=1)


def _maybe_reset(obj: Any, period: Optional[str]) -> None:
    """Lazy period reset. When now has passed ``quota_reset_at``, zero
    the counter and roll the marker. No-op when no period. Caller commits."""
    if not period:
        return
    now = datetime.utcnow()
    if obj.quota_reset_at is None or now >= obj.quota_reset_at:
        obj.quota_used = 0
        obj.quota_reset_at = _period_end(period, now)


def _maybe_reset_rate(cap: MCPCapability) -> None:
    """Lazy minute-window reset for the per-capability rate limit. Zeroes
    ``rate_used`` and rolls ``rate_reset_at`` to the next minute boundary
    once the current one has passed. No-op when no rate limit is set.
    Caller commits."""
    if cap.rate_limit is None:
        return
    now = datetime.utcnow()
    if cap.rate_reset_at is None or now >= cap.rate_reset_at:
        cap.rate_used = 0
        cap.rate_reset_at = _period_end("minute", now)


# ─── Quota math ───────────────────────────────────────────────────────

def _authorized_quota_sum(
    db: Session, capability_id: str, *, exclude_authorization_id: Optional[str] = None,
) -> int:
    """Σ allocated_quota over enabled, non-deleted authorizations on a
    capability. Optionally excludes one row (edit-self path, spec §9.2)."""
    q = db.query(func.coalesce(func.sum(MCPCapabilityAuthorization.allocated_quota), 0)).filter(
        MCPCapabilityAuthorization.mcp_capability_id == capability_id,
        MCPCapabilityAuthorization.enabled.is_(True),
        MCPCapabilityAuthorization.deleted_at.is_(None),
    )
    if exclude_authorization_id:
        q = q.filter(MCPCapabilityAuthorization.id != exclude_authorization_id)
    return int(q.scalar() or 0)


def _authorized_principal_count(db: Session, capability_id: str) -> int:
    """Distinct enabled, non-deleted principals authorized on a capability."""
    return int(
        db.query(func.count(func.distinct(
            func.concat(MCPCapabilityAuthorization.principal_type, ":",
                        MCPCapabilityAuthorization.principal_id))))
        .filter(
            MCPCapabilityAuthorization.mcp_capability_id == capability_id,
            MCPCapabilityAuthorization.enabled.is_(True),
            MCPCapabilityAuthorization.deleted_at.is_(None),
        )
        .scalar() or 0
    )


def _quota_view(db: Session, cap: MCPCapability) -> MCPCapabilityQuotaConfig:
    """Read-side capability quota block. Applies lazy reset first."""
    _maybe_reset(cap, cap.quota_period if cap.quota_enabled else None)
    _maybe_reset_rate(cap)
    authorized = _authorized_quota_sum(db, cap.id)
    remaining: Optional[int] = None
    if cap.quota_enabled and cap.quota_limit is not None:
        remaining = max(cap.quota_limit - authorized, 0)
    return MCPCapabilityQuotaConfig(
        enabled=bool(cap.quota_enabled),
        period=cap.quota_period,
        limit=cap.quota_limit,
        used=cap.quota_used or 0,
        reset_at=cap.quota_reset_at,
        authorized_quota_sum=authorized,
        remaining_authorizable_quota=remaining,
        authorized_principal_count=_authorized_principal_count(db, cap.id),
        rate_limit=cap.rate_limit,
        rate_used=cap.rate_used or 0,
        rate_reset_at=cap.rate_reset_at,
    )


# ─── Audit ────────────────────────────────────────────────────────────

def _audit(
    db: Session, *, user_id: Optional[str], action: str,
    resource_id: str, request: Optional[Request], details: dict[str, Any],
    resource_type: str = _AUDIT_TYPE,
) -> None:
    try:
        _auth.log_audit_action(
            db, user_id=user_id, action=action,
            resource_type=resource_type, resource_id=resource_id,
            details=details, request=request,
        )
    except Exception as e:
        logger.warning("authorization audit log failed (%s): %s", action, e)


# ─── Capability total-quota PATCH ─────────────────────────────────────

def update_capability_quota(
    db: Session, server_id: str, capability_id: str,
    payload: MCPCapabilityQuotaUpdate,
    *, user_id: Optional[str], request: Optional[Request] = None,
) -> MCPCapabilityQuotaConfig:
    """Set / clear a capability's TOTAL quota + per-minute rate limit."""
    _get_server_or_404(db, server_id)
    cap = _get_capability_or_404(db, server_id, capability_id)
    before = {
        "quota_enabled": cap.quota_enabled,
        "quota_limit": cap.quota_limit,
        "quota_period": cap.quota_period,
        "rate_limit": cap.rate_limit,
    }

    # Rate limit is independent of the period-quota toggle: 0 / None clears
    # it, a positive value sets it (and seeds the minute window).
    new_rate = payload.rate_limit if payload.rate_limit else None
    if new_rate != cap.rate_limit:
        cap.rate_limit = new_rate
        cap.rate_used = 0
        cap.rate_reset_at = (
            _period_end("minute", datetime.utcnow()) if new_rate is not None else None
        )

    if payload.enabled:
        if payload.limit is None or payload.period is None:
            raise HTTPException(400, "limit and period are required when enabled=true")
        already = _authorized_quota_sum(db, cap.id)
        if already > payload.limit:
            raise HTTPException(
                400,
                f"Cannot set limit={payload.limit}: existing authorizations "
                f"already sum to {already}",
            )
        cap.quota_enabled = True
        cap.quota_limit = payload.limit
        cap.quota_period = payload.period
        _maybe_reset(cap, payload.period)
        if cap.quota_reset_at is None:
            cap.quota_reset_at = _period_end(payload.period, datetime.utcnow())
    else:
        cap.quota_enabled = False
        cap.quota_limit = None
        cap.quota_period = None
        cap.quota_reset_at = None

    cap.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(cap)

    after = {
        "quota_enabled": cap.quota_enabled,
        "quota_limit": cap.quota_limit,
        "quota_period": cap.quota_period,
        "rate_limit": cap.rate_limit,
    }
    changes = {k: {"before": before[k], "after": after[k]} for k in before if before[k] != after[k]}
    if changes:
        _audit(
            db, user_id=user_id, action="mcp_capability.quota_update",
            resource_type="mcp_capability", resource_id=cap.id,
            request=request,
            details={"capability_name": cap.capability_name,
                     "server_id": cap.server_id, "changes": changes},
        )
    return _quota_view(db, cap)


# ─── Authorization mode + blacklist ───────────────────────────────────

def update_capability_authorization_mode(
    db: Session, server_id: str, capability_id: str, mode: str,
    *, user_id: Optional[str], request: Optional[Request] = None,
) -> dict[str, Any]:
    """Switch a capability between 'required' (default-deny) and 'public'
    (allow-all + optional blacklist). Returns the new mode + blacklist count.
    Existing mcp_capability_authorizations rows are NOT deleted on mode flip
    — they're ignored in public mode and re-honored if the admin flips back.
    """
    from app.models import MCPCapabilityBlacklist

    if mode not in ("required", "public"):
        raise HTTPException(400, f"mode must be 'required' or 'public', got {mode!r}")
    _get_server_or_404(db, server_id)
    cap = _get_capability_or_404(db, server_id, capability_id)
    before = cap.authorization_mode
    if before != mode:
        cap.authorization_mode = mode
        cap.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(cap)
        _audit(
            db, user_id=user_id, action="mcp_capability.authorization_mode_update",
            resource_type="mcp_capability", resource_id=cap.id, request=request,
            details={"capability_name": cap.capability_name,
                     "server_id": cap.server_id,
                     "changes": {"authorization_mode": {"before": before, "after": mode}}},
        )
    blacklist_count = (
        db.query(MCPCapabilityBlacklist)
        .filter(MCPCapabilityBlacklist.mcp_capability_id == cap.id).count()
    )
    return {
        "mcp_capability_id": cap.id,
        "capability_name": cap.capability_name,
        "authorization_mode": cap.authorization_mode,
        "blacklist_count": blacklist_count,
    }


def list_capability_blacklist(
    db: Session, server_id: str, capability_id: str,
) -> Tuple[int, List[dict[str, Any]]]:
    """Return all blacklist rows for one capability (newest first)."""
    from app.models import MCPCapabilityBlacklist

    _get_server_or_404(db, server_id)
    cap = _get_capability_or_404(db, server_id, capability_id)
    rows = (
        db.query(MCPCapabilityBlacklist)
        .filter(MCPCapabilityBlacklist.mcp_capability_id == cap.id)
        .order_by(MCPCapabilityBlacklist.created_at.desc())
        .all()
    )
    items = [
        {
            "id": r.id,
            "mcp_capability_id": r.mcp_capability_id,
            "principal_type": r.principal_type,
            "principal_id": r.principal_id,
            "principal_name": r.principal_name,
            "reason": r.reason,
            "created_at": r.created_at,
        }
        for r in rows
    ]
    return len(items), items


def add_capability_blacklist(
    db: Session, server_id: str, capability_id: str,
    principal_type: str, principal_id: str, reason: Optional[str],
    *, user_id: Optional[str], request: Optional[Request] = None,
) -> dict[str, Any]:
    """Add (principal_type, principal_id) to a capability's blacklist.
    Idempotent: a duplicate (cap, ptype, pid) is rejected with 409."""
    from app.models import MCPCapabilityBlacklist

    if principal_type not in VALID_PRINCIPAL_TYPES:
        raise HTTPException(400, f"unknown principal_type {principal_type!r}")
    _get_server_or_404(db, server_id)
    cap = _get_capability_or_404(db, server_id, capability_id)
    _, principal_name = resolve_principal(db, principal_type, principal_id)

    dup = (
        db.query(MCPCapabilityBlacklist)
        .filter(
            MCPCapabilityBlacklist.mcp_capability_id == cap.id,
            MCPCapabilityBlacklist.principal_type == principal_type,
            MCPCapabilityBlacklist.principal_id == principal_id,
        )
        .first()
    )
    if dup:
        raise HTTPException(409, f"{principal_type} {principal_id!r} already blacklisted")

    row = MCPCapabilityBlacklist(
        id=str(uuid.uuid4()),
        mcp_capability_id=cap.id,
        principal_type=principal_type, principal_id=principal_id,
        principal_name=principal_name,
        reason=reason,
        created_by=user_id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    _audit(
        db, user_id=user_id, action="mcp_capability.blacklist_add",
        resource_type="mcp_capability", resource_id=cap.id, request=request,
        details={"capability_name": cap.capability_name, "server_id": cap.server_id,
                 "blacklist_id": row.id, "principal_type": principal_type,
                 "principal_id": principal_id, "principal_name": principal_name,
                 "reason": reason},
    )
    return {
        "id": row.id,
        "mcp_capability_id": row.mcp_capability_id,
        "principal_type": row.principal_type,
        "principal_id": row.principal_id,
        "principal_name": row.principal_name,
        "reason": row.reason,
        "created_at": row.created_at,
    }


def remove_capability_blacklist(
    db: Session, server_id: str, capability_id: str, blacklist_id: str,
    *, user_id: Optional[str], request: Optional[Request] = None,
) -> None:
    """Hard-delete a blacklist row. Audit captures the snapshot."""
    from app.models import MCPCapabilityBlacklist

    _get_server_or_404(db, server_id)
    cap = _get_capability_or_404(db, server_id, capability_id)
    row = (
        db.query(MCPCapabilityBlacklist)
        .filter(
            MCPCapabilityBlacklist.id == blacklist_id,
            MCPCapabilityBlacklist.mcp_capability_id == cap.id,
        )
        .first()
    )
    if not row:
        raise HTTPException(404, "blacklist entry not found")
    snapshot = {
        "blacklist_id": row.id,
        "principal_type": row.principal_type,
        "principal_id": row.principal_id,
        "principal_name": row.principal_name,
        "reason": row.reason,
    }
    db.delete(row)
    db.commit()
    _audit(
        db, user_id=user_id, action="mcp_capability.blacklist_remove",
        resource_type="mcp_capability", resource_id=cap.id, request=request,
        details={"capability_name": cap.capability_name, "server_id": cap.server_id,
                 **snapshot},
    )


# ─── Authorization serialization ──────────────────────────────────────

def _to_item(
    authz: MCPCapabilityAuthorization,
    principal_name: Optional[str],
    server: Optional[MCPServer],
    cap: Optional[MCPCapability],
) -> MCPAuthorizationItem:
    _maybe_reset(authz, authz.quota_period)
    remaining: Optional[int] = None
    if authz.allocated_quota is not None:
        remaining = max(authz.allocated_quota - (authz.quota_used or 0), 0)
    return MCPAuthorizationItem(
        authorization_id=authz.id,
        principal_type=authz.principal_type,
        principal_id=authz.principal_id,
        principal_name=principal_name,
        mcp_server_id=authz.mcp_server_id,
        mcp_server_name=server.name if server else None,
        mcp_capability_id=authz.mcp_capability_id,
        mcp_capability_name=cap.capability_name if cap else "",
        capability_status=cap.status if cap else None,
        enabled=bool(authz.enabled),
        quota_period=authz.quota_period,
        allocated_quota=authz.allocated_quota,
        quota_used=authz.quota_used or 0,
        quota_remaining=remaining,
        quota_reset_at=authz.quota_reset_at,
        parameter_mapping_json=authz.parameter_mapping_json,
        parameter_defaults_json=authz.parameter_defaults_json,
        created_at=authz.created_at,
        updated_at=authz.updated_at,
    )


def list_authorized_principals(
    db: Session, server_id: str,
) -> Tuple[int, list[MCPAuthorizationItem]]:
    """All non-deleted authorizations under a server, newest first."""
    server = _get_server_or_404(db, server_id)
    rows = (
        db.query(MCPCapabilityAuthorization)
        .filter(
            MCPCapabilityAuthorization.mcp_server_id == server.id,
            MCPCapabilityAuthorization.deleted_at.is_(None),
        )
        .order_by(MCPCapabilityAuthorization.created_at.desc())
        .all()
    )
    names = _principal_names(db, [(r.principal_type, r.principal_id) for r in rows])
    cap_ids = {r.mcp_capability_id for r in rows}
    caps_ = {c.id: c for c in db.query(MCPCapability).filter(MCPCapability.id.in_(cap_ids)).all()} if cap_ids else {}
    items = [
        _to_item(r, names.get((r.principal_type, r.principal_id)),
                 server, caps_.get(r.mcp_capability_id))
        for r in rows
    ]
    db.commit()  # persist lazy resets triggered in _to_item
    return len(items), items


# ─── Authorization CRUD ───────────────────────────────────────────────

def create_authorization(
    db: Session, server_id: str, payload: MCPAuthorizationCreate,
    *, user_id: Optional[str], request: Optional[Request] = None,
) -> MCPAuthorizationItem:
    """Grant a principal the right to call a capability (spec §8.4)."""
    server = _get_server_or_404(db, server_id)
    cap = _get_capability_or_404(db, server_id, payload.mcp_capability_id)

    if payload.principal_type not in VALID_PRINCIPAL_TYPES:
        raise HTTPException(400, f"unknown principal_type {payload.principal_type!r}")
    exists, principal_name = resolve_principal(db, payload.principal_type, payload.principal_id)
    if not exists:
        raise HTTPException(
            404, f"{payload.principal_type} {payload.principal_id!r} not found")

    # §8.4.4 — no existing non-deleted authorization for (principal, capability).
    dup = (
        db.query(MCPCapabilityAuthorization)
        .filter(
            MCPCapabilityAuthorization.principal_type == payload.principal_type,
            MCPCapabilityAuthorization.principal_id == payload.principal_id,
            MCPCapabilityAuthorization.mcp_capability_id == cap.id,
            MCPCapabilityAuthorization.deleted_at.is_(None),
        )
        .first()
    )
    if dup is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"principal {payload.principal_type}:{payload.principal_id} is already "
            f"authorized for capability {cap.capability_name!r}",
        )

    _validate_quota_for_write(
        db, cap, payload.allocated_quota, payload.quota_period,
        enabled=payload.enabled, exclude_authorization_id=None,
    )

    now = datetime.utcnow()
    authz = MCPCapabilityAuthorization(
        id=str(uuid.uuid4()),
        principal_type=payload.principal_type,
        principal_id=payload.principal_id,
        mcp_server_id=server.id,
        mcp_capability_id=cap.id,
        enabled=payload.enabled,
        allocated_quota=payload.allocated_quota,
        quota_period=payload.quota_period or (cap.quota_period if cap.quota_enabled else None),
        quota_used=0,
        quota_reset_at=None,
        parameter_mapping_json=payload.parameter_mapping_json,
        parameter_defaults_json=payload.parameter_defaults_json,
        created_by=user_id, created_at=now,
        updated_by=user_id, updated_at=now,
    )
    db.add(authz)
    db.commit()
    db.refresh(authz)

    _audit(
        db, user_id=user_id, action="mcp_capability_authorization.create",
        resource_id=authz.id, request=request,
        details={
            "principal_type": authz.principal_type, "principal_id": authz.principal_id,
            "principal_name": principal_name,
            "mcp_server_id": authz.mcp_server_id,
            "mcp_capability_id": authz.mcp_capability_id,
            "mcp_capability_name": cap.capability_name,
            "allocated_quota": authz.allocated_quota,
            "quota_period": authz.quota_period, "enabled": authz.enabled,
        },
    )
    return _to_item(authz, principal_name, server, cap)


def update_authorization(
    db: Session, server_id: str, authorization_id: str,
    payload: MCPAuthorizationUpdate,
    *, user_id: Optional[str], request: Optional[Request] = None,
) -> MCPAuthorizationItem:
    """Edit an authorization (spec §9). principal / capability are NOT
    editable. allocated_quota is validated with this authorization's own
    slice excluded from the sum."""
    server = _get_server_or_404(db, server_id)
    authz = _get_authorization_or_404(db, server_id, authorization_id)
    cap = db.query(MCPCapability).filter(MCPCapability.id == authz.mcp_capability_id).first()
    _, principal_name = resolve_principal(db, authz.principal_type, authz.principal_id)

    data = payload.model_dump(exclude_unset=True)
    before = {k: getattr(authz, k) for k in data}

    new_enabled = data.get("enabled", authz.enabled)
    new_alloc = data.get("allocated_quota", authz.allocated_quota)
    new_period = data.get("quota_period", authz.quota_period)
    if cap is not None:
        _validate_quota_for_write(
            db, cap, new_alloc, new_period,
            enabled=new_enabled, exclude_authorization_id=authz.id,
        )

    for k, v in data.items():
        setattr(authz, k, v)
    authz.updated_by = user_id
    authz.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(authz)

    changes = {k: {"before": before[k], "after": getattr(authz, k)}
               for k in data if before[k] != getattr(authz, k)}
    if changes:
        _audit(
            db, user_id=user_id, action="mcp_capability_authorization.update",
            resource_id=authz.id, request=request,
            details={"principal_type": authz.principal_type,
                     "principal_id": authz.principal_id,
                     "mcp_capability_id": authz.mcp_capability_id, "changes": changes},
        )
    return _to_item(authz, principal_name, server, cap)


def set_authorization_enabled(
    db: Session, server_id: str, authorization_id: str, enabled: bool,
    *, user_id: Optional[str], request: Optional[Request] = None,
) -> MCPAuthorizationItem:
    """Enable / disable an authorization. Enabling re-validates quota."""
    server = _get_server_or_404(db, server_id)
    authz = _get_authorization_or_404(db, server_id, authorization_id)
    cap = db.query(MCPCapability).filter(MCPCapability.id == authz.mcp_capability_id).first()
    _, principal_name = resolve_principal(db, authz.principal_type, authz.principal_id)

    if enabled and not authz.enabled and cap is not None:
        _validate_quota_for_write(
            db, cap, authz.allocated_quota, authz.quota_period,
            enabled=True, exclude_authorization_id=authz.id,
        )
    authz.enabled = enabled
    authz.updated_by = user_id
    authz.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(authz)

    _audit(
        db, user_id=user_id,
        action=f"mcp_capability_authorization.{'enable' if enabled else 'disable'}",
        resource_id=authz.id, request=request,
        details={"principal_type": authz.principal_type,
                 "principal_id": authz.principal_id,
                 "mcp_capability_id": authz.mcp_capability_id, "enabled": enabled},
    )
    return _to_item(authz, principal_name, server, cap)


def delete_authorization(
    db: Session, server_id: str, authorization_id: str,
    *, user_id: Optional[str], request: Optional[Request] = None,
) -> None:
    """Soft-delete (spec §6.5). The principal can no longer call the
    capability; call-log history still resolves."""
    _get_server_or_404(db, server_id)
    authz = _get_authorization_or_404(db, server_id, authorization_id)
    authz.deleted_at = datetime.utcnow()
    authz.updated_by = user_id
    authz.updated_at = datetime.utcnow()
    db.commit()
    _audit(
        db, user_id=user_id, action="mcp_capability_authorization.delete",
        resource_id=authz.id, request=request,
        details={"principal_type": authz.principal_type,
                 "principal_id": authz.principal_id,
                 "mcp_capability_id": authz.mcp_capability_id},
    )


def _validate_quota_for_write(
    db: Session, cap: MCPCapability,
    allocated: Optional[int], period: Optional[str],
    *, enabled: bool, exclude_authorization_id: Optional[str],
) -> None:
    """Shared create/update quota validation (spec §8.3, §9.2)."""
    if not cap.quota_enabled or cap.quota_limit is None:
        return
    if not enabled:
        return
    if period is not None and cap.quota_period is not None and period != cap.quota_period:
        raise HTTPException(
            400,
            f"quota_period {period!r} must match the capability's period "
            f"{cap.quota_period!r}",
        )
    if allocated is None:
        raise HTTPException(
            400,
            f"capability {cap.capability_name!r} has quota enabled; "
            "allocated_quota is required",
        )
    others = _authorized_quota_sum(db, cap.id, exclude_authorization_id=exclude_authorization_id)
    ceiling = cap.quota_limit - others
    if allocated > ceiling:
        raise HTTPException(
            400,
            f"allocated_quota {allocated} exceeds remaining authorizable "
            f"quota {ceiling} on capability {cap.capability_name!r} "
            f"(limit={cap.quota_limit}, others={others})",
        )


# ─── Authorization summary (spec §6.1) ────────────────────────────────

def get_authorization_summary(db: Session, server_id: str) -> MCPAuthorizationSummaryResponse:
    """Per-capability quota + authorization rollup for a server.

    Only ``status='active'`` capabilities are listed — authorizing a
    principal against an inactive (upstream-removed) capability is
    moot (the invoke check rejects inactive capabilities anyway).
    Inactive rows are kept in ``mcp_capabilities`` purely so historical
    call-log rows still resolve a capability_name.
    """
    server = _get_server_or_404(db, server_id)
    cap_rows = (
        db.query(MCPCapability)
        .filter(
            MCPCapability.server_id == server.id,
            MCPCapability.status == "active",
        )
        .order_by(MCPCapability.capability_name)
        .all()
    )
    out: list[MCPCapabilityAuthorizationSummary] = []
    for cap in cap_rows:
        _maybe_reset(cap, cap.quota_period if cap.quota_enabled else None)
        authorized = _authorized_quota_sum(db, cap.id)
        remaining: Optional[int] = None
        if cap.quota_enabled and cap.quota_limit is not None:
            remaining = max(cap.quota_limit - authorized, 0)
        out.append(MCPCapabilityAuthorizationSummary(
            mcp_capability_id=cap.id,
            name=cap.capability_name,
            status=cap.status,
            authorization_mode=cap.authorization_mode or "required",
            rate_limit=cap.rate_limit,
            quota_enabled=bool(cap.quota_enabled),
            quota_period=cap.quota_period,
            quota_limit=cap.quota_limit,
            quota_used=cap.quota_used or 0,
            quota_reset_at=cap.quota_reset_at,
            authorized_quota_sum=authorized,
            remaining_authorizable_quota=remaining,
            authorized_principal_count=_authorized_principal_count(db, cap.id),
        ))
    db.commit()
    return MCPAuthorizationSummaryResponse(server_id=server.id, capabilities=out)


# ─── Invocation enforcement (spec §8, §10) ────────────────────────────

class AuthorizationError(HTTPException):
    """A structured invocation-time rejection. Carries the spec's error
    code in the response detail so callers can branch."""
    def __init__(self, code: str, message: str, **extra: Any):
        super().__init__(status_code=403, detail={"error": code, "message": message, **extra})
        self.code = code


def _enforce_capability_rate(db: Session, cap: MCPCapability, cap_name: str) -> None:
    """Capability-wide rate limit (calls/minute). Applies in BOTH
    required and public mode — it's a platform-layer burst guard,
    independent of per-principal authorization. No-op when unset."""
    if cap.rate_limit is None:
        return
    _maybe_reset_rate(cap)
    if (cap.rate_used or 0) >= cap.rate_limit:
        db.commit()  # persist the lazy reset before raising
        raise AuthorizationError(
            ERR_CAPABILITY_RATE,
            f"MCP Capability {cap_name} exceeded rate limit "
            f"({cap.rate_limit}/min)",
            capability=cap_name,
            rate_limit=cap.rate_limit, rate_used=cap.rate_used or 0,
        )


def check_principal_authorization(
    db: Session, principal_type: str, principal_id: str, mcp_capability_id: str,
) -> Tuple[Optional[MCPCapabilityAuthorization], MCPServer, MCPCapability]:
    """Run the spec §8 check chain for any principal type. Returns
    ``(authorization, server, capability)`` on success; raises
    :class:`AuthorizationError` otherwise. Does NOT consume quota.

    The ``authorization`` element is None when the capability is in
    ``public`` mode — there's no per-authorization row in that path; only
    the capability's total quota gates the call. Callers must accept None.
    """
    from app.models import MCPCapabilityBlacklist

    pref = f"{principal_type}:{principal_id}"
    cap = db.query(MCPCapability).filter(MCPCapability.id == mcp_capability_id).first()
    cap_name = cap.capability_name if cap else mcp_capability_id

    # 1. MCP Server enabled + not deleted.
    server = db.query(MCPServer).filter(MCPServer.id == cap.server_id).first() if cap else None
    if cap is None or server is None or server.deleted_at is not None or server.status != "enabled":
        raise AuthorizationError(
            ERR_NOT_AUTHORIZED,
            f"Principal {pref} cannot use {cap_name}: MCP server unavailable",
            principal_type=principal_type, principal_id=principal_id, capability=cap_name,
        )
    # 2. MCP Capability active.
    if cap.status != "active":
        raise AuthorizationError(
            ERR_NOT_AUTHORIZED, f"MCP capability {cap_name} is inactive",
            principal_type=principal_type, principal_id=principal_id, capability=cap_name,
        )

    # 2b. Public mode short-circuit:
    #     blacklist check + capability total quota; no per-authorization row.
    if cap.authorization_mode == "public":
        blacklisted = (
            db.query(MCPCapabilityBlacklist)
            .filter(
                MCPCapabilityBlacklist.mcp_capability_id == cap.id,
                MCPCapabilityBlacklist.principal_type == principal_type,
                MCPCapabilityBlacklist.principal_id == principal_id,
            )
            .first()
        )
        if blacklisted:
            raise AuthorizationError(
                ERR_NOT_AUTHORIZED,
                f"Principal {pref} is blacklisted from {cap_name}",
                principal_type=principal_type, principal_id=principal_id,
                capability=cap_name,
            )
        if cap.quota_enabled and cap.quota_limit is not None:
            _maybe_reset(cap, cap.quota_period)
            if (cap.quota_used or 0) >= cap.quota_limit:
                db.commit()
                raise AuthorizationError(
                    ERR_CAPABILITY_QUOTA,
                    f"MCP Capability {cap_name} has exceeded total quota",
                    capability=cap_name, quota_period=cap.quota_period,
                    quota_limit=cap.quota_limit, quota_used=cap.quota_used or 0,
                )
        _enforce_capability_rate(db, cap, cap_name)
        db.commit()
        return None, server, cap

    # 3. An authorization row exists for (principal, capability).
    authz = (
        db.query(MCPCapabilityAuthorization)
        .filter(
            MCPCapabilityAuthorization.principal_type == principal_type,
            MCPCapabilityAuthorization.principal_id == principal_id,
            MCPCapabilityAuthorization.mcp_capability_id == mcp_capability_id,
            MCPCapabilityAuthorization.deleted_at.is_(None),
        )
        .first()
    )
    if authz is None:
        raise AuthorizationError(
            ERR_NOT_AUTHORIZED,
            f"Principal {pref} is not authorized to use {cap_name}",
            principal_type=principal_type, principal_id=principal_id, capability=cap_name,
        )
    # 4. Authorization enabled.
    if not authz.enabled:
        raise AuthorizationError(
            ERR_AUTHZ_DISABLED,
            f"Authorization for principal {pref} to use {cap_name} is disabled",
            principal_type=principal_type, principal_id=principal_id, capability=cap_name,
        )
    # 5. Capability total quota not exceeded.
    if cap.quota_enabled and cap.quota_limit is not None:
        _maybe_reset(cap, cap.quota_period)
        if (cap.quota_used or 0) >= cap.quota_limit:
            db.commit()
            raise AuthorizationError(
                ERR_CAPABILITY_QUOTA,
                f"MCP Capability {cap_name} has exceeded total quota",
                capability=cap_name, quota_period=cap.quota_period,
                quota_limit=cap.quota_limit, quota_used=cap.quota_used or 0,
            )
    # 5b. Capability rate limit not exceeded.
    _enforce_capability_rate(db, cap, cap_name)
    # 6. Authorization quota not exceeded.
    if authz.allocated_quota is not None:
        _maybe_reset(authz, authz.quota_period)
        if (authz.quota_used or 0) >= authz.allocated_quota:
            db.commit()
            raise AuthorizationError(
                ERR_AUTHZ_QUOTA,
                f"Principal {pref} has exceeded authorized quota for {cap_name}",
                principal_type=principal_type, principal_id=principal_id,
                capability=cap_name, quota_period=authz.quota_period,
                quota_limit=authz.allocated_quota, quota_used=authz.quota_used or 0,
            )
    db.commit()
    return authz, server, cap


def consume_authorization_quota(
    db: Session, authz: Optional[MCPCapabilityAuthorization], cap: MCPCapability,
) -> dict[str, Any]:
    """Increment usage counters after a successful call (spec §12).
    Returns the before/after snapshot. Caller commits.

    ``authz`` is None for public-mode calls — in that case only the
    capability's total quota is bumped; authorization_quota_* are None.
    """
    _maybe_reset(cap, cap.quota_period if cap.quota_enabled else None)
    cap_before = cap.quota_used or 0
    if cap.quota_enabled:
        cap.quota_used = cap_before + 1
    # Rate counter — bumped independently of the period quota.
    if cap.rate_limit is not None:
        _maybe_reset_rate(cap)
        cap.rate_used = (cap.rate_used or 0) + 1
    if authz is None:
        return {
            "capability_quota_used_before": cap_before,
            "capability_quota_used_after": cap.quota_used,
            "authorization_quota_used_before": None,
            "authorization_quota_used_after": None,
        }
    _maybe_reset(authz, authz.quota_period)
    authz_before = authz.quota_used or 0
    authz.quota_used = authz_before + 1
    return {
        "capability_quota_used_before": cap_before,
        "capability_quota_used_after": cap.quota_used,
        "authorization_quota_used_before": authz_before,
        "authorization_quota_used_after": authz.quota_used,
    }


# ─── Invocation ───────────────────────────────────────────────────────

def _apply_mapping(
    input_data: dict[str, Any],
    parameter_defaults: Optional[dict[str, Any]],
    parameter_mapping: Optional[dict[str, Any]],
) -> dict[str, Any]:
    """Defaults first, then mapping ``{mcp_param: source_key}`` overlaid.
    Missing source keys are dropped."""
    result: dict[str, Any] = dict(parameter_defaults or {})
    for mcp_param, source_key in (parameter_mapping or {}).items():
        if isinstance(source_key, str) and source_key in input_data:
            result[mcp_param] = input_data[source_key]
    return result


def invoke_principal_via_mcp(
    db: Session, principal_type: str, principal_id: str, mcp_capability_id: str,
    *, input_data: dict[str, Any], user_id: Optional[str],
    session_id: Optional[str] = None, invoke_type: str = "agent_auto",
    request: Optional[Request] = None,
) -> tuple[MCPCallLog, dict]:
    """Authorized Principal → MCP-Capability invocation. The single
    enforcement entry point for ALL principal types — AI Tool and Agent
    both route here, no per-type duplication.

    Runs :func:`check_principal_authorization` (spec §8 — raises a
    structured :class:`AuthorizationError` on any failure), calls the
    live capability, consumes quota on success, writes mcp_call_logs.
    Failed checks do NOT consume quota (spec §12).
    """
    _, principal_name = resolve_principal(db, principal_type, principal_id)

    try:
        authz, server, cap = check_principal_authorization(
            db, principal_type, principal_id, mcp_capability_id)
    except AuthorizationError as ae:
        _write_denial_log(db, principal_type, principal_id, principal_name,
                          mcp_capability_id, user_id, session_id, invoke_type, ae)
        raise

    final_args = _apply_mapping(
        input_data,
        authz.parameter_defaults_json if authz else None,
        authz.parameter_mapping_json if authz else None,
    )

    from app.agent.mcp.client import get_mcp_manager
    manager = get_mcp_manager()
    sanitized_args = caps._sanitize_args(final_args)
    started = time.monotonic()
    response: dict = {}
    error_type: Optional[str] = None
    error_msg: Optional[str] = None
    result = "success"
    try:
        response = manager.call_tool(server.code, cap.capability_name, final_args)
        if response.get("error"):
            result, error_type = "failed", "invocation_error"
            error_msg = str(response["error"])[:1000]
        elif response.get("success") is False:
            result, error_type = "failed", "invocation_error"
            error_msg = str(response.get("output", ""))[:1000] or "capability reported failure"
    except Exception as e:
        result, error_type = "failed", "exception"
        error_msg = str(e)[:1000]
        response = {"error": error_msg}

    duration_ms = int((time.monotonic() - started) * 1000)
    now = datetime.utcnow()

    quota_info: dict[str, Any] = {}
    if result == "success":
        quota_info = consume_authorization_quota(db, authz, cap)

    call_log = MCPCallLog(
        id=str(uuid.uuid4()),
        mcp_server_id=server.id, mcp_server_name=server.name,
        mcp_capability_id=cap.id, mcp_capability_name=cap.capability_name,
        principal_type=principal_type, principal_id=principal_id,
        principal_name=principal_name,
        # ai_tool_* kept populated for back-compat when the principal IS
        # an ai_tool — other types leave them NULL.
        ai_tool_id=principal_id if principal_type == "ai_tool" else None,
        ai_tool_name=principal_name if principal_type == "ai_tool" else None,
        user_id=user_id, session_id=session_id, invoke_type=invoke_type,
        input_summary=sanitized_args,
        output_summary=caps._summarize_output(str(response.get("output", ""))) if result == "success" else None,
        result=result, response_time=duration_ms,
        error_type=error_type, error_message=error_msg,
        authorization_id=authz.id if authz else None,
        authorization_check_result="passed",
        quota_check_result="passed",
        quota_period=authz.quota_period if authz else None,
        quota_limit=authz.allocated_quota if authz else None,
        quota_used_before=quota_info.get("authorization_quota_used_before"),
        quota_used_after=quota_info.get("authorization_quota_used_after"),
        tenant_id=None, called_at=now,
    )
    db.add(call_log)
    cap.last_called_at = now
    # Best-effort telemetry write. The MCP call ALREADY succeeded above
    # (response in hand). When the LLM fires parallel calls to the SAME
    # capability, the shared `mcp_capabilities.last_called_at` UPDATE can
    # deadlock (MySQL 1213) — never let a telemetry-write deadlock turn a
    # successful call into a failure. Roll back + warn + return regardless.
    try:
        db.commit()
        db.refresh(call_log)
    except OperationalError as oe:
        db.rollback()
        logger.warning(
            "MCP telemetry write failed for cap=%s (call already succeeded, "
            "returning result regardless): %s",
            cap.capability_name, oe,
        )
    return call_log, response


def _write_denial_log(
    db: Session, principal_type: str, principal_id: str, principal_name: Optional[str],
    capability_id: str, user_id: Optional[str], session_id: Optional[str],
    invoke_type: str, ae: "AuthorizationError",
) -> None:
    """Persist an mcp_call_logs row for a rejected call (spec §11 — every
    denial is logged, no quota consumed)."""
    cap = db.query(MCPCapability).filter(MCPCapability.id == capability_id).first()
    is_quota = ae.code in (ERR_AUTHZ_QUOTA, ERR_CAPABILITY_QUOTA)
    try:
        db.add(MCPCallLog(
            id=str(uuid.uuid4()),
            mcp_server_id=cap.server_id if cap else "",
            mcp_server_name=None,
            mcp_capability_id=capability_id,
            mcp_capability_name=cap.capability_name if cap else "",
            principal_type=principal_type, principal_id=principal_id,
            principal_name=principal_name,
            ai_tool_id=principal_id if principal_type == "ai_tool" else None,
            ai_tool_name=principal_name if principal_type == "ai_tool" else None,
            user_id=user_id, session_id=session_id, invoke_type=invoke_type,
            input_summary=None, output_summary=None,
            result="failed", response_time=0,
            error_type="authorization_denied", error_message=ae.detail.get("message"),
            authorization_check_result="failed" if not is_quota else "passed",
            quota_check_result="failed" if is_quota else "skipped",
            error_code=ae.code,
            tenant_id=None, called_at=datetime.utcnow(),
        ))
        db.commit()
    except Exception as e:
        db.rollback()
        logger.warning("denial call-log write failed: %s", e)
