"""Read-only observability queries for the MCP server detail page.

Surfaces four views — all backed by tables populated elsewhere
(probes, call logs, audit logs, authorizations):

  - :func:`get_health_state` — current snapshot + consecutive_failures
    + last_recovered_at, computed from ``mcp_servers`` mirror columns
    plus a short scan of recent ``mcp_health_records``.
  - :func:`list_health_records` — paginated time-series of probes.
  - :func:`list_call_logs` — paginated + filtered invocation log.
  - :func:`list_change_logs` — paginated audit-log union over the
    resource types tied to this server (server, capability,
    authorization).

All four share these conventions:

  - Server existence is enforced once at the top with
    :func:`_get_server_or_404` (soft-delete aware).
  - Pagination is uniform (``offset`` / ``limit``) and returns ``(total,
    items)``. Limit defaults to 50 and is clamped to 200 at the router
    layer — the service trusts what's passed.
  - The service never modifies state. No audit writes, no DB mutations.

Sanitization
  ``mcp_call_logs.input_summary`` / ``output_summary`` are sanitized at
  INSERT time (see :mod:`app.services.mcp_capabilities._sanitize_args`).
  This module just surfaces what was stored — no re-sanitization
  needed and none performed.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional, Tuple, List

from fastapi import HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models import (
    MCPCapabilityAuthorization,
    AuditLog,
    MCPCallLog,
    MCPCapability,
    MCPHealthRecord,
    MCPServer,
    User,
)
from app.schemas import (
    MCPCallLogItem,
    MCPChangeLogItem,
    MCPHealthRecordItem,
    MCPServerHealthState,
)

logger = logging.getLogger(__name__)


# ─── Common lookup ────────────────────────────────────────────────────

def _get_server_or_404(db: Session, server_id: str) -> MCPServer:
    server = (
        db.query(MCPServer)
        .filter(MCPServer.id == server_id, MCPServer.deleted_at.is_(None))
        .first()
    )
    if server is None:
        raise HTTPException(404, f"MCP server {server_id!r} not found")
    return server


def _username_map(db: Session, user_ids: List[str]) -> dict[str, str]:
    """Bulk-fetch usernames for a list of user ids (skips NULLs)."""
    cleaned = [u for u in {*user_ids} if u]
    if not cleaned:
        return {}
    rows = db.query(User.id, User.username).filter(User.id.in_(cleaned)).all()
    return {uid: uname for uid, uname in rows}


# ─── 1. Health state ──────────────────────────────────────────────────

# Window size for computing consecutive_failures / last_recovered_at.
# The mirror columns on mcp_servers cover the "latest" view cheaply;
# this slice is just enough to walk back to the most recent recovery.
_HEALTH_HISTORY_SCAN = 200


def get_health_state(db: Session, server_id: str) -> MCPServerHealthState:
    """Current health snapshot for the detail page header.

    Combines the cheap mirrored columns on ``mcp_servers`` with two
    derived fields:

      - ``consecutive_failures`` — run-length of ``abnormal`` probes
        ending at the latest record. 0 when the latest probe is
        ``normal`` or when no probe has ever run.
      - ``last_recovered_at`` — ``checked_at`` of the most recent
        ``abnormal → normal`` transition, walking history newest-first.
        None when the server has never recovered (always-normal, or
        currently in its first-ever failure streak).

    Both are computed off the latest ``_HEALTH_HISTORY_SCAN`` rows —
    enough for the typical case of "show me how long it's been
    broken". Anything older is the time-series detail's job.
    """
    server = _get_server_or_404(db, server_id)

    # Pull last error_type/message from the most recent record so the
    # header can display *why* it's abnormal without forcing a second
    # round-trip to /health-records.
    history = (
        db.query(MCPHealthRecord)
        .filter(MCPHealthRecord.server_id == server.id)
        .order_by(MCPHealthRecord.checked_at.desc())
        .limit(_HEALTH_HISTORY_SCAN)
        .all()
    )

    last_error_type: Optional[str] = None
    last_error_message: Optional[str] = None
    consecutive_failures = 0
    last_recovered_at: Optional[datetime] = None

    if history:
        latest = history[0]
        last_error_type = latest.error_type
        last_error_message = latest.error_message

        if latest.status == "abnormal":
            # Walk newest-first while still abnormal.
            for rec in history:
                if rec.status != "abnormal":
                    break
                consecutive_failures += 1

        # Find the most recent abnormal→normal transition. Walk pairs
        # (newer, older); when newer is 'normal' and older is 'abnormal'
        # the newer row is the recovery point.
        for newer, older in zip(history, history[1:]):
            if newer.status == "normal" and older.status == "abnormal":
                last_recovered_at = newer.checked_at
                break

    return MCPServerHealthState(
        server_id=server.id,
        health_status=server.health_status,
        last_checked_at=server.last_checked_at,
        last_response_time=server.last_response_time,
        last_sync_status=server.last_sync_status,
        last_error_type=last_error_type,
        last_error_message=last_error_message,
        consecutive_failures=consecutive_failures,
        last_recovered_at=last_recovered_at,
    )


# ─── 2. Health records (time-series) ──────────────────────────────────

def list_health_records(
    db: Session,
    server_id: str,
    *,
    status: Optional[str] = None,
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
    offset: int = 0,
    limit: int = 50,
) -> Tuple[int, List[MCPHealthRecordItem]]:
    """Paginated time-series of probe results for this server.

    Default order is newest-first (``checked_at DESC``). Filters:

      - ``status`` — restrict to ``normal`` or ``abnormal`` only.
      - ``start`` / ``end`` — inclusive time window over ``checked_at``.
    """
    _get_server_or_404(db, server_id)
    q = db.query(MCPHealthRecord).filter(MCPHealthRecord.server_id == server_id)
    if status:
        q = q.filter(MCPHealthRecord.status == status)
    if start is not None:
        q = q.filter(MCPHealthRecord.checked_at >= start)
    if end is not None:
        q = q.filter(MCPHealthRecord.checked_at <= end)

    total = q.count()
    rows = (
        q.order_by(MCPHealthRecord.checked_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    items = [
        MCPHealthRecordItem(
            id=r.id,
            server_id=r.server_id,
            status=r.status,
            response_time=r.response_time,
            error_type=r.error_type,
            error_message=r.error_message,
            checked_at=r.checked_at,
        )
        for r in rows
    ]
    return total, items


# ─── 3. Call logs ─────────────────────────────────────────────────────

def list_call_logs(
    db: Session,
    server_id: str,
    *,
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
    user_id: Optional[str] = None,
    ai_tool_id: Optional[str] = None,
    capability_id: Optional[str] = None,
    result: Optional[str] = None,
    invoke_type: Optional[str] = None,
    offset: int = 0,
    limit: int = 50,
) -> Tuple[int, List[MCPCallLogItem]]:
    """Paginated invocation log scoped to this server.

    Newest-first by ``called_at``. All filters AND together; passing
    none returns every row for the server (subject to pagination).

    Username is joined in via a one-shot lookup over the unique user
    ids on the returned page — cheaper than a SQL JOIN when the result
    set is small relative to the users table.
    """
    _get_server_or_404(db, server_id)

    q = db.query(MCPCallLog).filter(MCPCallLog.mcp_server_id == server_id)
    if start is not None:
        q = q.filter(MCPCallLog.called_at >= start)
    if end is not None:
        q = q.filter(MCPCallLog.called_at <= end)
    if user_id:
        q = q.filter(MCPCallLog.user_id == user_id)
    if ai_tool_id:
        q = q.filter(MCPCallLog.ai_tool_id == ai_tool_id)
    if capability_id:
        q = q.filter(MCPCallLog.mcp_capability_id == capability_id)
    if result:
        q = q.filter(MCPCallLog.result == result)
    if invoke_type:
        q = q.filter(MCPCallLog.invoke_type == invoke_type)

    total = q.count()
    rows = (
        q.order_by(MCPCallLog.called_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )

    user_names = _username_map(db, [r.user_id for r in rows if r.user_id])
    items = [
        MCPCallLogItem(
            id=r.id,
            mcp_server_id=r.mcp_server_id,
            mcp_server_name=r.mcp_server_name,
            mcp_capability_id=r.mcp_capability_id,
            mcp_capability_name=r.mcp_capability_name,
            ai_tool_id=r.ai_tool_id,
            ai_tool_name=r.ai_tool_name,
            user_id=r.user_id,
            user_name=user_names.get(r.user_id) if r.user_id else None,
            session_id=r.session_id,
            invoke_type=r.invoke_type,
            input_summary=r.input_summary,
            output_summary=r.output_summary,
            result=r.result,
            response_time=r.response_time,
            error_type=r.error_type,
            error_message=r.error_message,
            called_at=r.called_at,
        )
        for r in rows
    ]
    return total, items


# ─── 4. Changes (audit log union) ─────────────────────────────────────

def list_change_logs(
    db: Session,
    server_id: str,
    *,
    offset: int = 0,
    limit: int = 50,
) -> Tuple[int, List[MCPChangeLogItem]]:
    """Paginated audit-log view scoped to this server.

    Union of three resource families:

      1. ``mcp_server`` — server CRUD, enable/disable, connection_test,
         capability_sync (written by :mod:`app.services.mcp_servers` and
         :mod:`app.routers.mcp_servers`).
      2. ``mcp_capability`` — capability-level edits (quota config etc.)
         whose ``resource_id`` is one of this server's capabilities.
      3. ``mcp_capability_authorization`` — authorization grants whose
         ``resource_id`` is one of this server's authorizations.

    The capability + authorization id sets are looked up once and folded
    into the WHERE clause — no JOINs over audit_logs (which has no FK
    back to mcp_servers, by design).
    """
    _get_server_or_404(db, server_id)

    capability_ids = [
        cid for (cid,) in
        db.query(MCPCapability.id).filter(MCPCapability.server_id == server_id).all()
    ]
    # Every authorization ever created under this server — including
    # soft-deleted ones, so their create/delete audit rows still show.
    authorization_ids = [
        aid for (aid,) in
        db.query(MCPCapabilityAuthorization.id).filter(
            MCPCapabilityAuthorization.mcp_server_id == server_id
        ).all()
    ]

    clauses = [
        (AuditLog.resource_type == "mcp_server") & (AuditLog.resource_id == server_id),
    ]
    if capability_ids:
        clauses.append(
            (AuditLog.resource_type == "mcp_capability")
            & (AuditLog.resource_id.in_(capability_ids))
        )
    if authorization_ids:
        clauses.append(
            (AuditLog.resource_type == "mcp_capability_authorization")
            & (AuditLog.resource_id.in_(authorization_ids))
        )

    q = db.query(AuditLog).filter(or_(*clauses))
    total = q.count()
    rows = (
        q.order_by(AuditLog.created_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )

    user_names = _username_map(db, [r.user_id for r in rows if r.user_id])
    items = [
        MCPChangeLogItem(
            id=r.id,
            action=r.action,
            resource_type=r.resource_type,
            resource_id=r.resource_id,
            user_id=r.user_id,
            user_name=user_names.get(r.user_id) if r.user_id else None,
            details=r.details,
            ip_address=r.ip_address,
            created_at=r.created_at,
        )
        for r in rows
    ]
    return total, items


