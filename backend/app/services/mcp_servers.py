"""MCP server management — repository + service.

Owns ALL access to the ``mcp_servers`` table. Routers must call into
these functions rather than touching the ORM directly so the
soft-delete (``deleted_at IS NULL``) filter, the secret encrypt/
mask pipeline, the audit-log writes, and the code-uniqueness
guarantee stay in one place.

Concepts:

- **Repository** functions (private, prefixed ``_``) own the SQL
  queries and the ``deleted_at`` filter.
- **Service** functions (public) compose repository calls with
  encryption, audit logging, validation, and reference checks.
- Soft-delete: ``soft_delete_server`` sets ``deleted_at`` instead of
  ``DELETE``. Every read function filters ``deleted_at IS NULL``.
  Soft-deleted ``code`` values stay reserved so future inserts cannot
  reuse them (uniqueness check spans active + soft-deleted rows).
- Audit: each write operation writes one row into ``audit_logs`` via
  :func:`auth.log_audit_action` with ``resource_type='mcp_server'``.
  Sensitive field changes record ONLY the constant marker
  :data:`encryption.AUDIT_REDACTED`, never the plain or ciphertext.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime
from typing import Any, Optional, Tuple

from fastapi import HTTPException, Request, status
from sqlalchemy import or_, func as _func
from sqlalchemy.orm import Session

from app import auth as _auth
from app.models import (
    MCPCapabilityAuthorization,
    MCPExternalConnection,
    MCPPermission,
    MCPPrompt,
    MCPCapability,
    MCPResource,
    MCPServer,
)
from app.schemas import (
    MCPServerCreate,
    MCPServerDetail,
    MCPServerListItem,
    MCPServerSecretsView,
    MCPServerStats,
    MCPServerUpdate,
)
from app.services import encryption

logger = logging.getLogger(__name__)


# ─── Repository: every query filters soft-deleted rows here ────────────

def _base_query(db: Session):
    """Single entry point for ``mcp_servers`` reads — applies the
    ``deleted_at IS NULL`` filter so callers don't have to remember.
    """
    return db.query(MCPServer).filter(MCPServer.deleted_at.is_(None))


def _get_by_id_strict(db: Session, server_id: str) -> MCPServer:
    """Fetch one server, or 404. Includes soft-delete filter."""
    server = _base_query(db).filter(MCPServer.id == server_id).first()
    if server is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"MCP server {server_id!r} not found",
        )
    return server


def _get_active_by_code(db: Session, code: str) -> Optional[MCPServer]:
    """Fetch an active (non-soft-deleted) server by code. Used by the
    uniqueness check on insert — only active rows hold the code; once a
    server is soft-deleted its code is free to be reused. Historical
    mcp_call_logs / mcp_capability_authorizations reference servers by
    ``mcp_server_id`` (UUID) and additionally snapshot the name, so
    reusing a code can't break their resolution.
    """
    return db.query(MCPServer).filter(
        MCPServer.code == code,
        MCPServer.deleted_at.is_(None),
    ).first()


# ─── Service: stats / list / detail ────────────────────────────────────

def get_stats(db: Session) -> MCPServerStats:
    """Counts for the list-page header. Soft-deleted rows excluded."""
    q = _base_query(db)
    rows = q.all()
    return MCPServerStats(
        total=len(rows),
        enabled=sum(1 for r in rows if r.status == "enabled"),
        disabled=sum(1 for r in rows if r.status == "disabled"),
        normal=sum(1 for r in rows if r.health_status == "normal"),
        abnormal=sum(1 for r in rows if r.health_status == "abnormal"),
        unchecked=sum(1 for r in rows if r.health_status == "unchecked"),
    )


def list_servers(
    db: Session,
    *,
    keyword: Optional[str] = None,
    service_category: Optional[str] = None,
    status_filter: Optional[str] = None,
    health_status: Optional[str] = None,
    page: int = 1,
    size: int = 20,
) -> Tuple[int, list[MCPServerListItem]]:
    """Paginated list of servers with filters. Returns ``(total, items)``.

    Aggregates ``capability_count`` and ``authorized_principal_count`` are
    computed in two batch GROUP BY queries scoped to the current
    page's server ids — never per-row.
    """
    q = _base_query(db)
    if keyword:
        like = f"%{keyword}%"
        q = q.filter(or_(MCPServer.name.like(like), MCPServer.code.like(like)))
    if service_category:
        q = q.filter(MCPServer.service_category == service_category)
    if status_filter:
        q = q.filter(MCPServer.status == status_filter)
    if health_status:
        q = q.filter(MCPServer.health_status == health_status)
    total = q.count()
    rows = (
        q.order_by(MCPServer.created_at.desc())
        .offset((page - 1) * size)
        .limit(size)
        .all()
    )
    cap_counts, authz_counts = _aggregate_counts(db, [r.id for r in rows])
    return total, [
        to_list_item(
            r,
            capability_count=cap_counts.get(r.id, 0),
            authorized_principal_count=authz_counts.get(r.id, 0),
        )
        for r in rows
    ]


def _aggregate_counts(
    db: Session,
    server_ids: list[str],
) -> tuple[dict[str, int], dict[str, int]]:
    """Batch-compute the two list-page counts for a set of server ids.

    Returns ``(capability_counts, authorized_principal_counts)`` as dicts
    keyed by server_id. Servers with zero are absent from the dict —
    callers fall back to 0 via ``.get(id, 0)``.

    Both counts honor the spec's definitions:
      - capability_count: ``mcp_capabilities`` rows with ``status='active'``
      - authorized_principal_count: ``DISTINCT(principal) from enabled,
        non-deleted mcp_capability_authorizations rows whose capability
        is active on this server. Same principal authorized on multiple
        capabilities of the same server collapses to 1.
    """
    if not server_ids:
        return {}, {}

    cap_rows = (
        db.query(MCPCapability.server_id, _func.count(MCPCapability.id))
        .filter(
            MCPCapability.server_id.in_(server_ids),
            MCPCapability.status == "active",
        )
        .group_by(MCPCapability.server_id)
        .all()
    )
    cap_counts = {sid: int(n) for sid, n in cap_rows}

    authz_rows = (
        db.query(
            MCPCapabilityAuthorization.mcp_server_id,
            _func.count(_func.distinct(_func.concat(
                MCPCapabilityAuthorization.principal_type, ':',
                MCPCapabilityAuthorization.principal_id))),
        )
        .join(MCPCapability, MCPCapabilityAuthorization.mcp_capability_id == MCPCapability.id)
        .filter(
            MCPCapabilityAuthorization.mcp_server_id.in_(server_ids),
            MCPCapabilityAuthorization.enabled.is_(True),
            MCPCapabilityAuthorization.deleted_at.is_(None),
            MCPCapability.status == "active",
        )
        .group_by(MCPCapabilityAuthorization.mcp_server_id)
        .all()
    )
    authz_counts = {sid: int(n) for sid, n in authz_rows}
    return cap_counts, authz_counts


def get_detail(db: Session, server_id: str) -> MCPServerDetail:
    return to_detail(_get_by_id_strict(db, server_id))


# ─── Serialization helpers ─────────────────────────────────────────────

def _secrets_view(server: MCPServer) -> MCPServerSecretsView:
    """Build the masked secrets view exposed in the API response.

    ``env_config`` stores an encrypted JSON dict — to surface "which
    keys are set" without leaking values, we decrypt just to read key
    names, then drop the plaintext. Decryption errors fall through to
    "configured but unreadable" so a borked key doesn't 500 the list
    page; the caller will see ``env_config_keys=[]``.
    """
    auth_set = bool(server.auth_secret)
    env_set = bool(server.env_config)
    env_keys: list[str] = []
    connection_id: Optional[str] = None
    server_auth_connection_id: Optional[str] = None
    if env_set:
        try:
            plain = encryption.decrypt_secret(server.env_config)
            if plain:
                data = json.loads(plain)
                if isinstance(data, dict):
                    env_keys = list(data.keys())
                    raw_conn = data.get("connection_id")
                    if isinstance(raw_conn, str) and raw_conn.strip():
                        connection_id = raw_conn.strip()
                    raw_auth = data.get("server_auth_connection_id")
                    if isinstance(raw_auth, str) and raw_auth.strip():
                        server_auth_connection_id = raw_auth.strip()
        except Exception as e:
            logger.warning(
                "env_config decryption failed for server %s: %s",
                server.id, e,
            )
    return MCPServerSecretsView(
        auth_secret_configured=auth_set,
        auth_secret_display=encryption.mask_secret(server.auth_secret),
        env_config_configured=env_set,
        env_config_display=encryption.mask_secret(server.env_config),
        env_config_keys=env_keys,
        env_config_connection_id=connection_id,
        env_config_server_auth_connection_id=server_auth_connection_id,
    )


def _compute_configuration_status(server: MCPServer) -> str:
    """Derived field: ``"incomplete"`` when start_command flags the
    server as needs-connection but env_config doesn't carry a
    ``connection_id``; ``"ok"`` otherwise.

    Distinct from ``health_status`` —  the latter is transport-level
    (the process spawns, ListTools succeeds) and can be green even on
    a github server with no token. Functional health requires an
    external connection too, and that's what this field captures.

    Cheap to compute: one Fernet decrypt + JSON parse per row. Called
    on every list/detail response so admins never see a stale "正常"
    on a misconfigured server.
    """
    required = _needs_connection(server.start_command)
    if required is None:
        return "ok"
    if not server.env_config:
        return "incomplete"
    try:
        plain = encryption.decrypt_secret(server.env_config)
        data = json.loads(plain) if plain else None
        if not isinstance(data, dict):
            return "incomplete"
        conn_id = data.get("connection_id")
        if not isinstance(conn_id, str) or not conn_id.strip():
            return "incomplete"
        return "ok"
    except Exception:
        # Corrupt ciphertext or key issue — surface as incomplete so
        # the operator sees that something needs attention; runtime
        # would fail to build anyway.
        return "incomplete"


def to_list_item(
    server: MCPServer,
    *,
    capability_count: int = 0,
    authorized_principal_count: int = 0,
) -> MCPServerListItem:
    return MCPServerListItem(
        id=server.id,
        name=server.name,
        code=server.code,
        service_category=server.service_category,
        description=server.description,
        owner=server.owner,
        connection_type=server.connection_type,
        status=server.status,
        health_status=server.health_status,
        last_checked_at=server.last_checked_at,
        last_synced_at=server.last_synced_at,
        capability_count=capability_count,
        authorized_principal_count=authorized_principal_count,
        configuration_status=_compute_configuration_status(server),
        created_at=server.created_at,
        updated_at=server.updated_at,
    )


def to_detail(server: MCPServer) -> MCPServerDetail:
    # Reuse the same batch GROUP BY as the list page so detail and list
    # surface identical counts. One server lookup runs two trivial queries.
    cap_counts, authz_counts_one = _aggregate_counts(_session_for(server), [server.id])
    return MCPServerDetail(
        id=server.id,
        name=server.name,
        code=server.code,
        service_category=server.service_category,
        description=server.description,
        owner=server.owner,
        connection_type=server.connection_type,
        service_url=server.service_url,
        start_command=server.start_command,
        work_dir=server.work_dir,
        timeout_seconds=server.timeout_seconds,
        retry_count=server.retry_count,
        auth_type=server.auth_type,
        auth_header_name=server.auth_header_name,
        secrets=_secrets_view(server),
        status=server.status,
        health_status=server.health_status,
        last_checked_at=server.last_checked_at,
        last_response_time=server.last_response_time,
        last_sync_status=server.last_sync_status,
        last_synced_at=server.last_synced_at,
        last_sync_error_message=server.last_sync_error_message,
        capability_count=cap_counts.get(server.id, 0),
        authorized_principal_count=authz_counts_one.get(server.id, 0),
        configuration_status=_compute_configuration_status(server),
        auto_sync_enabled=server.auto_sync_enabled,
        sync_frequency=server.sync_frequency,
        sync_scope=server.sync_scope,
        conflict_strategy=server.conflict_strategy,
        offline_strategy=server.offline_strategy,
        allow_agent_auto_invoke=server.allow_agent_auto_invoke,
        high_risk_confirm_required=server.high_risk_confirm_required,
        rate_limit_config=server.rate_limit_config,
        circuit_breaker_config=server.circuit_breaker_config,
        audit_enabled=server.audit_enabled,
        created_by=server.created_by,
        created_at=server.created_at,
        updated_by=server.updated_by,
        updated_at=server.updated_at,
    )


def _session_for(server: MCPServer) -> Session:
    """Recover the SQLAlchemy session attached to a loaded ORM object.

    ``to_detail`` is called from request handlers that already opened a
    session; we need it for the per-server aggregate query but don't want
    to thread it through every caller. ``inspect`` returns the session
    if the object is in the identity map.
    """
    from sqlalchemy import inspect
    s = inspect(server).session
    assert s is not None, "to_detail called with a detached server ORM object"
    return s


# ─── Audit-log helpers ─────────────────────────────────────────────────

# Sensitive columns whose value MUST NOT appear in audit details.
_AUDIT_REDACT_FIELDS = {"auth_secret", "env_config"}


def _diff_for_audit(
    before: Optional[dict[str, Any]],
    after: Optional[dict[str, Any]],
) -> dict[str, Any]:
    """Build a diff dict suitable for audit ``details``.

    For sensitive fields we record only "[REDACTED]→[REDACTED]"
    sentinels — auditors learn the field changed but never see the
    plaintext or ciphertext.
    """
    before = before or {}
    after = after or {}
    changed: dict[str, Any] = {}
    keys = set(before.keys()) | set(after.keys())
    for k in keys:
        b, a = before.get(k), after.get(k)
        if b == a:
            continue
        if k in _AUDIT_REDACT_FIELDS:
            changed[k] = {
                "before": encryption.sanitize_for_audit(b),
                "after": encryption.sanitize_for_audit(a),
            }
        else:
            changed[k] = {"before": b, "after": a}
    return changed


def _log_audit(
    db: Session,
    *,
    user_id: Optional[str],
    action: str,
    server: MCPServer,
    request: Optional[Request],
    details: Optional[dict[str, Any]] = None,
) -> None:
    payload = {"server_code": server.code, "server_name": server.name}
    if details:
        payload.update(details)
    try:
        _auth.log_audit_action(
            db,
            user_id=user_id,
            action=action,
            resource_type="mcp_server",
            resource_id=server.id,
            details=payload,
            request=request,
        )
    except Exception as e:
        # Audit failure must not break the user-visible operation.
        logger.warning("mcp_server audit log failed (%s): %s", action, e)


# ─── Create / Update / Delete / Enable / Disable ───────────────────────

def _orm_to_plain_dict(server: MCPServer) -> dict[str, Any]:
    """Snapshot a server row as a plain dict for diff purposes.

    Datetime values stringify so the diff is JSON-serializable. Sensitive
    columns survive here as ciphertext but :func:`_diff_for_audit` will
    redact them at the audit boundary.
    """
    out: dict[str, Any] = {}
    for col in server.__table__.columns:
        v = getattr(server, col.name)
        if isinstance(v, datetime):
            v = v.isoformat()
        out[col.name] = v
    return out


# ─── External-connection binding rules ────────────────────────────────
#
# After the mcp_external_connections refactor, external-system secrets
# (AWS keys, GitHub / Slack tokens, DB passwords, …) MUST live in
# `mcp_external_connections.secret_json` and arrive at runtime via
# `_inject_connection_env`. `mcp_servers.env_config` may only carry the
# bound `connection_id` plus per-instance runtime knobs (TTLs, timeouts).
#
# `FORBIDDEN_ENV_CONFIG_FIELDS` enumerates the env-var names the runtime
# injector OWNS. Refusing them at save time prevents admins from drifting
# back into the old "paste credentials directly into env_config" pattern;
# the deny-list is exact-match case-insensitive so legitimate keys like
# "DEFAULT_UPLOAD_URL_EXPIRES_SECONDS" pass through.
FORBIDDEN_ENV_CONFIG_FIELDS: frozenset[str] = frozenset({
    # s3 — old S3_UPLOAD_URL_EXPIRES_SECONDS / S3_DOWNLOAD_URL_EXPIRES_SECONDS
    # are deliberately listed too: renamed to DEFAULT_UPLOAD/DOWNLOAD_URL_...
    # at the runtime layer so env_config only carries the DEFAULT_ form.
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
    "AWS_REGION", "S3_ENDPOINT_URL", "S3_FORCE_PATH_STYLE",
    "S3_BUCKET", "S3_ALLOWED_BUCKETS", "S3_ALLOWED_PREFIXES",
    "S3_UPLOAD_URL_EXPIRES_SECONDS", "S3_DOWNLOAD_URL_EXPIRES_SECONDS",
    # sftp
    "SFTP_HOST", "SFTP_PORT", "SFTP_USERNAME", "SFTP_PASSWORD",
    "SFTP_AUTH_TYPE", "SFTP_PRIVATE_KEY", "SFTP_PRIVATE_KEY_PASSPHRASE",
    "SFTP_ALLOWED_PATHS",
    # url
    "URL_ALLOWED_DOMAINS", "URL_AUTHORIZATION_HEADER",
    "URL_TIMEOUT_SECONDS", "URL_MAX_DOWNLOAD_SIZE", "URL_DENY_PRIVATE_IP",
    # local_path
    "LOCAL_ALLOWED_DIRS",
    # database
    "DB_TYPE", "DB_HOST", "DB_PORT", "DB_NAME", "DB_USERNAME",
    "DB_PASSWORD", "DB_READ_ONLY", "DB_ALLOWED_TABLES",
    # github
    "GITHUB_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN",
    "GITHUB_API_BASE_URL", "GITHUB_ALLOWED_ORGS", "GITHUB_ALLOWED_REPOS",
    # slack
    "SLACK_BOT_TOKEN", "SLACK_WORKSPACE", "SLACK_ALLOWED_CHANNELS",
    # Generic secret-shaped keys. These are the names admins might
    # type if they're thinking in plain terms instead of the per-type
    # env vars above. Block them all — secrets belong in external
    # connections, period.
    "AUTH_SECRET", "TOKEN", "API_KEY", "ACCESS_TOKEN",
    "AUTHORIZATION", "AUTHORIZATION_HEADER",
    "X-API-KEY",     # check is .upper() so this catches X-Api-Key too
    "PASSWORD", "PRIVATE_KEY",
})

# Server types that REQUIRE an external connection binding. Matched as a
# substring of `start_command` so both `${VENV_PYTHON} -m app.agent.mcp.
# servers.storage_s3_server` (built-in) and any future `npx ...storage_s3`
# variant hit the same rule. Value = expected `connection_type` on the
# referenced external connection (defence-in-depth; the actual injector
# also checks).
_NEEDS_CONNECTION_BY_COMMAND: dict[str, str] = {
    "storage_s3_server": "s3",
    "storage_sftp_server": "sftp",      # not built yet — reserve the marker
    "transaction_db_server": "database",  # not built yet — reserve the marker
    "db_query_server": "database",
    "server-github": "github",
    "server-slack": "slack",
    "server-postgres": "database",
    "server-sqlite": "database",
}


def _needs_connection(start_command: Optional[str]) -> Optional[str]:
    """Return the required connection_type if this server's start_command
    matches a `_NEEDS_CONNECTION_BY_COMMAND` entry; else `None`."""
    if not start_command:
        return None
    for marker, conn_type in _NEEDS_CONNECTION_BY_COMMAND.items():
        if marker in start_command:
            return conn_type
    return None


def _raise_400(code: str, message: str) -> None:
    """Structured 400 with a stable `code` so callers can branch on it.
    Error messages must NEVER include secret values — only key names."""
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail={"code": code, "message": message},
    )


def _validate_env_config(
    db: Session,
    env: Optional[dict],
    *,
    start_command: Optional[str],
) -> None:
    """Validate an incoming env_config dict before encryption / storage.

    Enforces three rules:
      1. No external-system secret field may appear in env_config
         (`MCP_ENV_SECRET_FIELD_NOT_ALLOWED`). Those belong in
         `mcp_external_connections`.
      2. If `connection_id` is present, it must reference an existing,
         enabled, non-deleted external connection
         (`MCP_CONNECTION_NOT_FOUND` / `MCP_CONNECTION_DISABLED`).
      3. If the server's start_command matches a needs-connection type,
         `connection_id` MUST be present
         (`MCP_CONNECTION_REQUIRED`). Connection-type mismatch (e.g.
         binding a `database` connection to a storage_s3 server) is also
         rejected with the same code so the dropdown can stay simple.
    """
    if not env:
        # No env_config at all — only valid if the server doesn't need one.
        required_type = _needs_connection(start_command)
        if required_type:
            _raise_400(
                "MCP_CONNECTION_REQUIRED",
                f"该 MCP Server 必须绑定 {required_type} 类型的外部连接才能保存。"
                f"请在「绑定外部连接」下拉中选择对应连接;如果还没有,请先到"
                f"「MCP 管理 → 外部连接管理」创建。",
            )
        return

    # Rule 1: deny external-system secret fields.
    forbidden = [k for k in env.keys() if k.upper() in FORBIDDEN_ENV_CONFIG_FIELDS]
    if forbidden:
        _raise_400(
            "MCP_ENV_SECRET_FIELD_NOT_ALLOWED",
            f"环境变量不允许包含外部系统密钥 / 凭证字段:{'、'.join(sorted(forbidden))}。"
            f"这些字段应该通过「绑定外部连接」管理,运行时由系统自动注入。",
        )

    # Helper used for both connection_id (server → external system) and
    # server_auth_connection_id (Goku → server endpoint). The latter is
    # restricted to ``url`` type because it only ever stores a bearer /
    # header authorization secret.
    def _lookup(key: str, *, required_type: Optional[str], label: str) -> Optional[MCPExternalConnection]:
        raw = env.get(key)
        if raw is None:
            return None
        if not isinstance(raw, str) or not raw.strip():
            _raise_400(
                "MCP_CONNECTION_NOT_FOUND",
                f"「{label}」必须是有效的外部连接编码,请从下拉中选择。",
            )
        conn_code = raw.strip()
        row = (
            db.query(MCPExternalConnection)
            .filter(
                MCPExternalConnection.code == conn_code,
                MCPExternalConnection.deleted_at.is_(None),
            )
            .first()
        )
        if row is None:
            _raise_400(
                "MCP_CONNECTION_NOT_FOUND",
                f"找不到外部连接「{conn_code}」(可能已被删除)。请到"
                f"「MCP 管理 → 外部连接管理」确认或重新创建。",
            )
        if not row.enabled:
            _raise_400(
                "MCP_CONNECTION_DISABLED",
                f"外部连接「{conn_code}」已停用,无法绑定。请到「外部连接管理」"
                f"启用该连接,或改选其它已启用的连接。",
            )
        if required_type and row.connection_type != required_type:
            _raise_400(
                "MCP_CONNECTION_TYPE_UNSUPPORTED",
                f"「{label}」要求 {required_type} 类型的外部连接,"
                f"但「{conn_code}」是 {row.connection_type} 类型。请重新选择匹配类型的连接。",
            )
        return row

    # Rule 2: validate connection_id (server → external systems).
    bound = _lookup("connection_id", required_type=None, label="绑定外部连接")

    # Rule 2b: validate server_auth_connection_id (Goku → MCP server).
    # Pinned to ``url`` type because its only payload is an Authorization
    # header — there's no need for other types here.
    _lookup("server_auth_connection_id", required_type="url", label="MCP Server 调用鉴权")

    # Rule 3: if the server needs a connection, one must be bound — and
    # its type must match.
    required_type = _needs_connection(start_command)
    if required_type:
        if bound is None:
            _raise_400(
                "MCP_CONNECTION_REQUIRED",
                f"该 MCP Server 必须绑定 {required_type} 类型的外部连接。"
                f"请在「绑定外部连接」下拉中选择对应连接。",
            )
        if bound.connection_type != required_type:
            _raise_400(
                "MCP_CONNECTION_REQUIRED",
                f"该 MCP Server 需要 {required_type} 类型的外部连接,"
                f"但「{bound.code}」是 {bound.connection_type} 类型。请重新选择匹配类型的连接。",
            )


def _encrypt_env_dict(env: Optional[dict]) -> Optional[str]:
    """Encrypt an env dict (the runtime sees it as ``{KEY: VALUE}``) so
    the table stores a single ciphertext blob. ``None`` and ``{}`` pass
    through as ``None`` (no row content) so the secrets-view's
    ``configured`` flag stays accurate.
    """
    if not env:
        return None
    return encryption.encrypt_secret(json.dumps(env, ensure_ascii=False))


def _trigger_runtime_refresh(server_code: str) -> None:
    """Ask the live MCP runtime to re-evaluate this server.

    Called after every CRUD write so enabling / disabling / editing /
    deleting in the admin UI immediately affects what's actually
    connected. Failures are logged but never raised: the user-visible
    DB write has already succeeded; runtime refresh is a best-effort
    side-effect, and the admin can manually trigger a refresh from
    the UI if needed.
    """
    try:
        from app.agent.mcp.client import get_mcp_manager
        from app.agent.mcp.registry_integration import refresh_mcp_server
        from app.agent.tool_registry import get_tool_registry

        manager = get_mcp_manager()
        registry = get_tool_registry()
        refresh_mcp_server(registry, manager, server_code)
    except Exception as e:
        logger.warning(
            "MCP runtime refresh failed for server %r (DB write OK): %s",
            server_code, e,
        )


def create_server(
    db: Session,
    payload: MCPServerCreate,
    *,
    user_id: Optional[str],
    request: Optional[Request] = None,
) -> MCPServer:
    """Insert a new server. Enforces ``code`` uniqueness among ACTIVE
    rows only — codes of soft-deleted servers are free to be reused.
    The DB-side guarantee is provided by the ``uq_mcp_servers_active_code``
    unique index on the generated ``active_code`` column (migration 0065).
    """
    existing = _get_active_by_code(db, payload.code)
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"MCP server code {payload.code!r} is already in use",
        )

    # Reject forbidden secret fields + verify connection_id refers to a
    # real / enabled / non-deleted external connection. Raises 400 with
    # a structured code so the UI can route the message appropriately.
    _validate_env_config(
        db, payload.env_config, start_command=payload.start_command,
    )

    now = datetime.utcnow()
    server = MCPServer(
        id=str(uuid.uuid4()),
        name=payload.name,
        code=payload.code,
        service_category=payload.service_category,
        description=payload.description,
        owner=payload.owner,
        connection_type=payload.connection_type,
        service_url=payload.service_url,
        start_command=payload.start_command,
        work_dir=payload.work_dir,
        timeout_seconds=payload.timeout_seconds,
        retry_count=payload.retry_count,
        auth_type=payload.auth_type,
        auth_header_name=payload.auth_header_name,
        auth_secret=encryption.encrypt_secret(payload.auth_secret),
        env_config=_encrypt_env_dict(payload.env_config),
        status="enabled",
        health_status="unchecked",
        auto_sync_enabled=payload.auto_sync_enabled,
        sync_frequency=payload.sync_frequency,
        sync_scope=payload.sync_scope,
        conflict_strategy=payload.conflict_strategy,
        offline_strategy=payload.offline_strategy,
        allow_agent_auto_invoke=payload.allow_agent_auto_invoke,
        high_risk_confirm_required=payload.high_risk_confirm_required,
        rate_limit_config=payload.rate_limit_config,
        circuit_breaker_config=payload.circuit_breaker_config,
        audit_enabled=payload.audit_enabled,
        created_by=user_id,
        created_at=now,
        updated_by=user_id,
        updated_at=now,
    )
    db.add(server)
    db.commit()
    db.refresh(server)

    _log_audit(
        db,
        user_id=user_id,
        action="mcp_server.create",
        server=server,
        request=request,
        details={"changes": _diff_for_audit({}, _orm_to_plain_dict(server))},
    )
    _trigger_runtime_refresh(server.code)
    return server


def update_server(
    db: Session,
    server_id: str,
    payload: MCPServerUpdate,
    *,
    user_id: Optional[str],
    request: Optional[Request] = None,
) -> MCPServer:
    """Apply a partial update. Fields absent from the payload are NOT
    touched (Pydantic ``exclude_unset``). Mask sentinels round-tripped
    back from the UI are treated as "unchanged".
    """
    server = _get_by_id_strict(db, server_id)
    before = _orm_to_plain_dict(server)

    data = payload.model_dump(exclude_unset=True)

    # Pull out the explicit clear flags before they reach setattr — they
    # aren't real columns. ``True`` means "clear this secret to NULL";
    # absence / ``False`` means "respect the standard secret semantics".
    clear_auth = bool(data.pop("clear_auth_secret", False))
    clear_env = bool(data.pop("clear_env_config", False))

    # Secret semantics (matches MCPServerUpdate docstring):
    #   - clear flag True  → set column to NULL
    #   - field omitted    → keep stored value
    #   - empty / mask /
    #     whitespace value → keep stored value (NOT a clear)
    #   - real value       → encrypt and save
    if clear_auth:
        data["auth_secret"] = None
    elif "auth_secret" in data:
        new = data["auth_secret"]
        if (
            new is None
            or (isinstance(new, str) and (not new.strip() or encryption.looks_like_mask(new)))
        ):
            data.pop("auth_secret")
        else:
            data["auth_secret"] = encryption.encrypt_secret(new)

    if clear_env:
        data["env_config"] = None
    elif "env_config" in data:
        new_env = data["env_config"]
        if new_env is None or new_env == {}:
            # Empty dict / null is "no change" — same protective stance
            # as auth_secret. Use clear_env_config=True to actually wipe.
            data.pop("env_config")
        else:
            # `start_command` may also be updated in the same PATCH —
            # validate against the post-update value so needs-connection
            # check reflects the final state of the row.
            effective_command = data.get("start_command", server.start_command)
            _validate_env_config(db, new_env, start_command=effective_command)
            data["env_config"] = _encrypt_env_dict(new_env)
    else:
        # env_config wasn't touched in this PATCH, but start_command might
        # have been — re-validate the EXISTING env_config against the new
        # command so you can't "sneak" out of needs-connection by swapping
        # commands without touching env_config.
        if "start_command" in data and server.env_config:
            try:
                plain = encryption.decrypt_secret(server.env_config)
                stored = json.loads(plain) if plain else None
                if isinstance(stored, dict):
                    _validate_env_config(
                        db, stored, start_command=data["start_command"],
                    )
            except HTTPException:
                raise
            except Exception:
                # Corrupt ciphertext — let runtime layer raise; here we
                # don't block the command change since env_config is
                # already unusable.
                pass

    for key, value in data.items():
        setattr(server, key, value)
    server.updated_by = user_id
    server.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(server)

    after = _orm_to_plain_dict(server)
    _log_audit(
        db,
        user_id=user_id,
        action="mcp_server.update",
        server=server,
        request=request,
        details={"changes": _diff_for_audit(before, after)},
    )
    _trigger_runtime_refresh(server.code)
    return server


def _references_block_delete(db: Session, server_id: str) -> Optional[str]:
    """Return a human-readable reason if the server cannot be deleted.

    Block conditions (Task 1 scope):
      - mcp_tools, mcp_resources, mcp_prompts, mcp_permissions have
        active (non-deleted) rows for this server.

    Call logs (``mcp_call_logs``) do NOT block — they're preserved by
    design via soft-delete of the parent (the row stays in DB so the FK
    is satisfied; the call_log's ``server_id`` keeps resolving).
    """
    # MCPCapability tracks lifecycle via ``status`` (active /
    # inactive), NOT via ``deleted_at`` — count rows still flagged
    # 'active' to mirror what the upstream server currently exposes.
    checks = [
        ("capabilities", db.query(MCPCapability).filter(
            MCPCapability.server_id == server_id,
            MCPCapability.status == "active",
        ).count()),
        ("resources", db.query(MCPResource).filter(MCPResource.server_id == server_id, MCPResource.deleted_at.is_(None)).count()),
        ("prompts", db.query(MCPPrompt).filter(MCPPrompt.server_id == server_id, MCPPrompt.deleted_at.is_(None)).count()),
        ("permissions", db.query(MCPPermission).filter(MCPPermission.server_id == server_id, MCPPermission.deleted_at.is_(None)).count()),
    ]
    blockers = [f"{name}: {n}" for name, n in checks if n > 0]
    if blockers:
        return (
            "Server still has active dependents — clear them before deleting: "
            + ", ".join(blockers)
        )
    return None


def soft_delete_server(
    db: Session,
    server_id: str,
    *,
    user_id: Optional[str],
    request: Optional[Request] = None,
) -> None:
    """Mark a server as deleted. Refuses if status is ``enabled`` (must
    be disabled first — irreversible-looking actions get a two-step
    confirmation) or if dependents exist (tools / resources / etc.).
    """
    server = _get_by_id_strict(db, server_id)
    if server.status == "enabled":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot delete an enabled server. Disable it first.",
        )
    block_reason = _references_block_delete(db, server_id)
    if block_reason:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=block_reason)

    server.deleted_at = datetime.utcnow()
    server.updated_by = user_id
    server.updated_at = server.deleted_at
    db.commit()

    _log_audit(
        db,
        user_id=user_id,
        action="mcp_server.delete",
        server=server,
        request=request,
    )
    # Refresh after soft-delete: the loader now excludes this server,
    # so refresh_mcp_server disconnects + unregisters its tools.
    _trigger_runtime_refresh(server.code)

    # Knowledge base must not advertise a deleted server's capabilities.
    from app.services import mcp_knowledge
    mcp_knowledge.purge_server_knowledge(db, server)


def _set_status(
    db: Session,
    server_id: str,
    new_status: str,
    action: str,
    *,
    user_id: Optional[str],
    request: Optional[Request] = None,
) -> MCPServer:
    server = _get_by_id_strict(db, server_id)
    if server.status == new_status:
        return server  # idempotent; no audit entry for a no-op
    prev = server.status
    server.status = new_status
    server.updated_by = user_id
    server.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(server)
    _log_audit(
        db,
        user_id=user_id,
        action=action,
        server=server,
        request=request,
        details={"status": {"before": prev, "after": new_status}},
    )
    # Status changes affect what the runtime should connect to.
    # enable → loader includes → refresh connects.
    # disable → loader excludes → refresh disconnects.
    _trigger_runtime_refresh(server.code)

    # Keep the knowledge catalog in lockstep with usability:
    #   disabled → purge (a not-usable server must not be discoverable)
    #   enabled  → rebuild from existing active capabilities (next sync also
    #              rebuilds, but do it now so re-enable is immediate)
    from app.services import mcp_knowledge
    if new_status == "disabled":
        mcp_knowledge.purge_server_knowledge(db, server)
    elif new_status == "enabled":
        mcp_knowledge.refresh_server_knowledge(db, server)
    return server


def enable_server(
    db: Session,
    server_id: str,
    *,
    user_id: Optional[str],
    request: Optional[Request] = None,
) -> MCPServer:
    return _set_status(db, server_id, "enabled", "mcp_server.enable",
                       user_id=user_id, request=request)


def disable_server(
    db: Session,
    server_id: str,
    *,
    user_id: Optional[str],
    request: Optional[Request] = None,
) -> MCPServer:
    return _set_status(db, server_id, "disabled", "mcp_server.disable",
                       user_id=user_id, request=request)
