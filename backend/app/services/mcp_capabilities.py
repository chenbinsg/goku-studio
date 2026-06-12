"""MCP capabilities — list / detail / test-invoke + resources & prompts.

Sits alongside :mod:`app.services.mcp_servers` (server CRUD) and
:mod:`app.services.mcp_runtime` (subprocess + sync). Owns:

- read-only list + detail for ``mcp_capabilities``
- test-invoke (live MCP call with a sanitized call-log row)
- read-only list for ``mcp_resources`` and ``mcp_prompts``

Naming note
  "MCP capability" = an executable endpoint an MCP server exposes
  (what the MCP protocol calls a "tool"). Goku reserves the word
  "Tool" for entries in its own AI Tool registry; the Capability ↔
  AI-Tool binding is a separate (later) task.

Lifecycle is per-row via ``mcp_capabilities.status`` — list /
detail filter out ``status='inactive'`` rows so admins see only
the currently-exposed set. Inactive rows stay in the DB so historical
``mcp_call_logs.mcp_capability_id`` FK references keep resolving.

Call-log sanitization
  Per the spec, ``mcp_call_logs`` MUST NOT carry tokens, keys, file
  payloads, or large response bodies. :func:`_sanitize_args` and
  :func:`_summarize_output` collapse those into short, safe summaries
  before INSERT. Tool arguments still flow to the MCP server in full —
  only the audit trail is bounded.
"""
from __future__ import annotations
import re as _re

import json
import logging
import time
import uuid
from datetime import datetime
from typing import Any, Optional, Tuple

from fastapi import HTTPException, Request, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import (
    MCPCallLog,
    MCPCapability,
    MCPPrompt,
    MCPResource,
    MCPServer,
)
from app.schemas import (
    MCPCapabilityDetail,
    MCPCapabilityListItem,
    MCPPromptListItem,
    MCPResourceListItem,
)

logger = logging.getLogger(__name__)


# ─── Shared helpers ────────────────────────────────────────────────────

def _get_server_or_404(db: Session, server_id: str) -> MCPServer:
    server = (
        db.query(MCPServer)
        .filter(MCPServer.id == server_id, MCPServer.deleted_at.is_(None))
        .first()
    )
    if server is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"MCP server {server_id!r} not found",
        )
    return server


def _get_capability_or_404(
    db: Session, server_id: str, capability_id: str,
) -> MCPCapability:
    """Fetch one capability by id, scoped to ``server_id``.
    ``status='inactive'`` capabilities are NOT visible — the admin
    shouldn't act on something the upstream server has retired."""
    cap = (
        db.query(MCPCapability)
        .filter(
            MCPCapability.id == capability_id,
            MCPCapability.server_id == server_id,
            MCPCapability.status == "active",
        )
        .first()
    )
    if cap is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                f"MCP capability {capability_id!r} not found on server "
                f"{server_id!r} (or it has been retired upstream)"
            ),
        )
    return cap


def _capability_to_list_item(c: MCPCapability) -> MCPCapabilityListItem:
    return MCPCapabilityListItem(
        id=c.id,
        server_id=c.server_id,
        capability_name=c.capability_name,
        description=c.description,
        status=c.status,
        authorization_mode=c.authorization_mode or "required",
        quota_enabled=bool(c.quota_enabled),
        quota_period=c.quota_period,
        quota_limit=c.quota_limit,
        rate_limit=c.rate_limit,
        last_synced_at=c.last_synced_at,
        last_called_at=c.last_called_at,
        created_at=c.created_at,
        updated_at=c.updated_at,
    )


def _capability_to_detail(c: MCPCapability, db: Session) -> MCPCapabilityDetail:
    """Build the detail response including the per-capability rate-limit
    block. ``db`` is needed for the allocated-sum query that powers
    ``remaining``.
    """
    from app.services import mcp_authorizations as _authz
    base = _capability_to_list_item(c).model_dump()
    return MCPCapabilityDetail(
        **base,
        input_schema=c.input_schema,
        output_schema=c.output_schema,
        quota=_authz._quota_view(db, c),
    )


# ─── Capabilities: list / detail ───────────────────────────────────────

def list_capabilities(
    db: Session,
    server_id: str,
    *,
    keyword: Optional[str] = None,
    page: int = 1,
    size: int = 50,
) -> Tuple[int, list[MCPCapabilityListItem]]:
    """Currently-exposed capabilities on ``server_id``.

    Includes ``status in ('active', 'disabled')`` — the upstream's current
    surface area plus any admin-disabled ones (so they remain visible and
    re-enablable). Sync-retired ``'inactive'`` rows stay hidden.
    """
    _get_server_or_404(db, server_id)
    q = db.query(MCPCapability).filter(
        MCPCapability.server_id == server_id,
        MCPCapability.status.in_(("active", "disabled")),
    )
    if keyword:
        like = f"%{keyword}%"
        q = q.filter(MCPCapability.capability_name.like(like))
    total = q.count()
    rows = (
        q.order_by(MCPCapability.capability_name)
        .offset((page - 1) * size)
        .limit(size)
        .all()
    )
    return total, [_capability_to_list_item(c) for c in rows]


def get_capability_detail(
    db: Session, server_id: str, capability_id: str,
) -> MCPCapabilityDetail:
    _get_server_or_404(db, server_id)
    cap = _get_capability_or_404(db, server_id, capability_id)
    return _capability_to_detail(cap, db)


# ─── Manual enable / disable (independent of deletion) ─────────────────

def _get_capability_any_status(
    db: Session, server_id: str, capability_id: str,
) -> MCPCapability:
    """Like :func:`_get_capability_or_404` but does NOT require
    ``status='active'`` — needed to re-enable a manually disabled
    capability (whose status is ``'disabled'``)."""
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
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"MCP capability {capability_id!r} not found on server {server_id!r}",
        )
    return cap


def set_capability_status(
    db: Session,
    server_id: str,
    capability_id: str,
    *,
    disabled: bool,
    user_id: Optional[str] = None,
    request: Optional[Request] = None,
) -> dict[str, Any]:
    """Manually disable / re-enable a single capability.

    ``'disabled'`` is an **admin-set** status, deliberately distinct from
    the sync-managed ``'inactive'``: :mod:`app.services.mcp_runtime` only
    flips between ``active`` and ``inactive``, so a disabled capability
    stays disabled across re-syncs. A disabled capability drops out of the
    live tool pool and the knowledge catalog. Independent of deletion.

    Returns the new status plus the impact (who was using / authorized for
    this capability) so callers can warn the admin.
    """
    server = _get_server_or_404(db, server_id)
    cap = _get_capability_any_status(db, server_id, capability_id)
    impact = capability_usage(db, server, capability_names=[cap.capability_name])
    before = cap.status
    target = "disabled" if disabled else "active"
    if before != target:
        cap.status = target
        cap.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(cap)
        from app.services import mcp_authorizations as _authz
        _authz._audit(
            db, user_id=user_id,
            action="mcp_capability.disable" if disabled else "mcp_capability.enable",
            resource_type="mcp_capability", resource_id=cap.id, request=request,
            details={"capability_name": cap.capability_name, "server_id": server_id,
                     "changes": {"status": {"before": before, "after": target}}},
        )
        try:
            from app.services import mcp_knowledge
            mcp_knowledge.refresh_server_knowledge(db, server)
        except Exception as e:  # KB hiccup must not fail the status change
            logger.warning("KB refresh after capability status change failed: %s", e)
    return {
        "mcp_capability_id": cap.id,
        "capability_name": cap.capability_name,
        "status": cap.status,
        "impact": impact,
    }


def capability_usage(
    db: Session,
    server: MCPServer,
    *,
    capability_names: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Reverse-lookup who depends on a server's capabilities — for an
    **informational** impact warning before disable / delete (never blocks).

    For each capability tool name (``{server.code}__{capability_name}``):
      - ``bound_by``    : names of agents whose ``allowed_tools`` reference it
      - ``authorizations``: count of active authorization rows

    Only capabilities that are actually bound or authorized are returned.
    """
    from app.models import AgentDefinition, MCPCapabilityAuthorization

    caps_q = db.query(MCPCapability).filter(MCPCapability.server_id == server.id)
    if capability_names is not None:
        caps_q = caps_q.filter(MCPCapability.capability_name.in_(capability_names))
    caps = caps_q.all()
    prefix = f"{server.code}__"
    by_tool = {f"{prefix}{c.capability_name}": c for c in caps}

    bound: dict[str, set] = {tn: set() for tn in by_tool}
    agents = (
        db.query(AgentDefinition.name, AgentDefinition.allowed_tools)
        .filter(AgentDefinition.allowed_tools.isnot(None))
        .all()
    )
    for name, allowed in agents:
        if not allowed:
            continue
        for t in allowed:
            if t in bound:
                bound[t].add(name)

    rows = (
        db.query(MCPCapabilityAuthorization.mcp_capability_id, func.count())
        .filter(
            MCPCapabilityAuthorization.mcp_server_id == server.id,
            MCPCapabilityAuthorization.deleted_at.is_(None),
        )
        .group_by(MCPCapabilityAuthorization.mcp_capability_id)
        .all()
    )
    authz_by_cap = {cid: int(n) for cid, n in rows}

    items = []
    for tn, cap in by_tool.items():
        agents_bound = sorted(bound.get(tn, ()))
        n_authz = authz_by_cap.get(cap.id, 0)
        if agents_bound or n_authz:
            items.append({
                "tool": tn,
                "capability_name": cap.capability_name,
                "status": cap.status,
                "bound_by": agents_bound,
                "authorizations": n_authz,
            })
    return {
        "server_code": server.code,
        "in_use": items,
        "agents": sorted({a for it in items for a in it["bound_by"]}),
        "total_authorizations": sum(it["authorizations"] for it in items),
    }


# ─── Test-invoke + call-log sanitization ──────────────────────────────

# Substring tokens that mark an env-var / argument name as "secret-ish";
# values for these keys never appear in the call log — they're replaced
# with ``"[REDACTED]"``. Lower-case comparison.
_SECRET_KEY_MARKERS = ("key", "token", "secret", "password", "passwd", "credential")

# Value-side guard:某些场景下入参的 KEY 名不像 secret(比如 file-parser 的
# ``source.url``),但 VALUE 本身是个 presigned URL 一类的临时凭据。仅按 key
# 名脱敏会把它落进 mcp_call_logs 的 input_summary 明文 —— 这条正则用来在
# 值本体里识别这种凭据并强制 [REDACTED]。命中条件刻意收紧到「presigned URL
# 的签名 query 参数」,避免把普通 URL(没有签名)误判。
_PRESIGNED_URL_RE = _re.compile(
    r"(?:[?&])(?:X-Amz-Signature|X-Goog-Signature|Signature|sig)=",
    flags=_re.IGNORECASE,
)
# 整段 presigned URL 匹配 —— _summarize_output JSON.parse 失败时的兜底脱敏。
# ``http(s)://...`` 后面紧跟非空白字符,直到下一个空白或引号。命中条件:
# query 部分含**签名参数** OR **AWS 凭据参数**(X-Amz-Credential=AKIA…)。
# 加 Credential 是为了把「已被旧版长度截断、把 X-Amz-Signature 那段尾巴剁掉
# 只剩 AKIA 前缀的脏行」也覆盖到(2026-05-27 回填场景)。普通 URL 没这些
# 参数,不会误伤。
_PRESIGNED_FULL_URL_RE = _re.compile(
    r"""https?://[^\s"'<>]+?
        (?:[?&])(?:X-Amz-Signature|X-Goog-Signature|Signature|sig|X-Amz-Credential)=
        [^\s"'<>]*""",
    flags=_re.IGNORECASE | _re.VERBOSE,
)

# Maximum length of any single string value preserved in the call log
# args; longer strings get truncated to head + "...(<N>chars truncated)".
_MAX_VAL_LEN = 200
# Maximum output preview length; the full result body is NEVER logged.
_MAX_OUTPUT_PREVIEW = 500


def _looks_like_secret_key(name: str) -> bool:
    low = (name or "").lower()
    return any(m in low for m in _SECRET_KEY_MARKERS)


def _looks_like_presigned_url(value: Any) -> bool:
    """Value-side check: 字符串里含 X-Amz-Signature / X-Goog-Signature / 等
    presigned 签名 query 参数 → 视为临时凭据,必须脱敏。"""
    return isinstance(value, str) and bool(_PRESIGNED_URL_RE.search(value))


def _sanitize_value(name: str, value: Any) -> Any:
    """Trim / mask a single argument value for call-log storage.

    - Field name looks like a secret → ``"[REDACTED]"``
    - Value is a presigned URL(含 X-Amz-Signature 等签名 query)→ ``"[REDACTED]"``
    - Long strings get truncated with a marker
    - Nested dicts / lists: recurse
    - Everything else passes through verbatim
    """
    if _looks_like_secret_key(name):
        return "[REDACTED]"
    if isinstance(value, str):
        if _looks_like_presigned_url(value):
            return "[REDACTED]"
        if len(value) > _MAX_VAL_LEN:
            return value[:_MAX_VAL_LEN] + f"...(+{len(value) - _MAX_VAL_LEN} chars truncated)"
        return value
    if isinstance(value, dict):
        return {k: _sanitize_value(k, v) for k, v in value.items()}
    if isinstance(value, list):
        return [_sanitize_value(name, item) for item in value]
    return value


def _sanitize_args(args: dict[str, Any]) -> dict[str, Any]:
    """Build the call-log-safe form of an invocation's arguments."""
    if not isinstance(args, dict):
        return {"_non_dict_args": str(type(args).__name__)}
    return {k: _sanitize_value(k, v) for k, v in args.items()}


def _redact_presigned_in_text(text: str) -> str:
    """Regex-only fallback:把字符串里所有「带签名参数的 URL」整段替换成
    ``[REDACTED_PRESIGNED_URL]``。仅在 JSON.parse 失败的兜底分支使用。

    命中条件:URL 形态(``http(s)://``)+ 后续含 X-Amz-Signature /
    X-Goog-Signature / Signature / sig query 参数。配 ``\\S`` 贪婪到第一个
    空白或引号,所以会把整段 presigned URL 连带 AKIA credential 一锅端。
    """
    return _PRESIGNED_FULL_URL_RE.sub("[REDACTED_PRESIGNED_URL]", text)


def _summarize_output(text: str) -> str:
    """Trim long outputs for the call log + response preview.

    脱敏 + 长度截断两道工序:

    1. **脱敏**:先尝试把 ``text`` 当 JSON parse。
       - 成功 → 走 :func:`_sanitize_value` 树形递归(同 input_summary 路径),
         然后 ``json.dumps`` 回字符串。这一步会把 presigned URL value、
         secret-ish key 的值都改成 ``[REDACTED]``。
       - 失败 → fall back 到 :func:`_redact_presigned_in_text`,用正则把
         字符串里所有带签名 query 的 URL 整段抹掉。
    2. **截断**:脱敏后再做长度上限,行为不变。

    入参 ``text`` 必须已经是 ``str`` —— caller 在外面做了 ``str(...)``。
    """
    if not text:
        return ""
    # ---- 1. 脱敏 -----------------------------------------------------
    sanitized: str
    try:
        parsed = json.loads(text)
    except (TypeError, ValueError):
        parsed = None
    if parsed is not None and isinstance(parsed, (dict, list)):
        # _sanitize_value 接受 (name, value);顶层用空字符串当 name —— 触发
        # 不了 secret-key 路径,但递归进去后子 key 名会被正常检查。
        cleaned = _sanitize_value("", parsed)
        try:
            sanitized = json.dumps(cleaned, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            sanitized = _redact_presigned_in_text(text)
    else:
        sanitized = _redact_presigned_in_text(text)

    # ---- 2. 长度截断(对脱敏后的串生效)----------------------------
    if len(sanitized) > _MAX_OUTPUT_PREVIEW:
        return sanitized[:_MAX_OUTPUT_PREVIEW] + f"...(+{len(sanitized) - _MAX_OUTPUT_PREVIEW} chars truncated)"
    return sanitized


# Invoke-type constants. ``mcp_test`` is what the admin's
# /capabilities/{id}/test-invoke endpoint writes. A later task adds
# ``agent`` (live AI agent execution).
INVOKE_TYPE_MCP_TEST = "mcp_test"


def invoke_capability(
    db: Session,
    server_id: str,
    capability_id: str,
    arguments: dict[str, Any],
    *,
    user_id: Optional[str],
    session_id: Optional[str] = None,
    invoke_type: str = INVOKE_TYPE_MCP_TEST,
    request: Optional[Request] = None,
) -> tuple[MCPCallLog, dict]:
    """Live-call an MCP capability via the runtime pool and append a
    sanitized row to ``mcp_call_logs``.

    Pre-conditions:
      - Server must not be soft-deleted (filtered in _get_server_or_404).
      - Server.status must be 'enabled' — disabled servers aren't
        connected, so a call would fail. Surfaced as a clear 400.
      - Capability must exist on the server with ``status='active'``.

    Returns ``(MCPCallLog row, raw_response_dict)``. The router builds
    its preview response from the raw dict; the DB row already has
    the SANITIZED form.
    """
    server = _get_server_or_404(db, server_id)
    cap = _get_capability_or_404(db, server_id, capability_id)

    if server.status != "enabled":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Server {server.code!r} is disabled; enable it before testing.",
        )

    from app.agent.mcp.client import get_mcp_manager
    manager = get_mcp_manager()

    sanitized_args = _sanitize_args(arguments or {})
    started = time.monotonic()
    response: dict = {}
    error_type: Optional[str] = None
    error_msg: Optional[str] = None
    result = "success"
    try:
        # manager.call_tool wraps the asyncio bridge; safe from sync
        # FastAPI handlers.
        response = manager.call_tool(server.code, cap.capability_name, arguments or {})
        if response.get("error"):
            result = "failed"
            error_msg = str(response["error"])[:1000]
            error_type = "invocation_error"
        elif response.get("success") is False:
            result = "failed"
            error_msg = str(response.get("output", ""))[:1000] or "capability reported failure"
            error_type = "invocation_error"
    except Exception as e:
        result = "failed"
        error_msg = str(e)[:1000]
        error_type = "exception"
        response = {"error": error_msg}

    duration_ms = int((time.monotonic() - started) * 1000)
    now = datetime.utcnow()

    output_preview = _summarize_output(str(response.get("output", "")))

    call_log = MCPCallLog(
        id=str(uuid.uuid4()),
        mcp_server_id=server.id,
        mcp_server_name=server.name,
        mcp_capability_id=cap.id,
        mcp_capability_name=cap.capability_name,
        ai_tool_id=None,
        ai_tool_name=None,
        user_id=user_id,
        session_id=session_id,
        invoke_type=invoke_type,
        input_summary=sanitized_args,
        output_summary=output_preview if result == "success" else None,
        result=result,
        response_time=duration_ms,
        error_type=error_type,
        error_message=error_msg,
        tenant_id=None,
        called_at=now,
    )
    db.add(call_log)
    cap.last_called_at = now
    db.commit()
    db.refresh(call_log)

    return call_log, response


# ─── Resources / Prompts: list-only ────────────────────────────────────

def list_resources(
    db: Session,
    server_id: str,
    *,
    page: int = 1,
    size: int = 50,
) -> Tuple[int, list[MCPResourceListItem]]:
    """All non-deleted Resources for ``server_id``.

    ``MCPResource`` keeps using ``deleted_at`` (unlike capabilities
    which uses ``status`` to track upstream-driven lifecycle).
    """
    _get_server_or_404(db, server_id)
    q = db.query(MCPResource).filter(
        MCPResource.server_id == server_id,
        MCPResource.deleted_at.is_(None),
    )
    total = q.count()
    rows = (
        q.order_by(MCPResource.uri)
        .offset((page - 1) * size)
        .limit(size)
        .all()
    )
    return total, [
        MCPResourceListItem(
            id=r.id, server_id=r.server_id, uri=r.uri,
            name=r.name, mime_type=r.mime_type, description=r.description,
            created_at=r.created_at, updated_at=r.updated_at,
        )
        for r in rows
    ]


def list_prompts(
    db: Session,
    server_id: str,
    *,
    page: int = 1,
    size: int = 50,
) -> Tuple[int, list[MCPPromptListItem]]:
    """All non-deleted Prompts for ``server_id``."""
    _get_server_or_404(db, server_id)
    q = db.query(MCPPrompt).filter(
        MCPPrompt.server_id == server_id,
        MCPPrompt.deleted_at.is_(None),
    )
    total = q.count()
    rows = (
        q.order_by(MCPPrompt.name)
        .offset((page - 1) * size)
        .limit(size)
        .all()
    )
    return total, [
        MCPPromptListItem(
            id=p.id, server_id=p.server_id, name=p.name,
            description=p.description, arguments_json=p.arguments_json,
            created_at=p.created_at, updated_at=p.updated_at,
        )
        for p in rows
    ]
