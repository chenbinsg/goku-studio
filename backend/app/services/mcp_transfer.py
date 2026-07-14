"""Import / export for MCP servers and external connections.

Export produces a JSON bundle that is safe to hand to another
environment or another admin: secret VALUES never leave the database.
Every sensitive value is replaced by :data:`SECRET_PLACEHOLDER` — an
explanatory sentence — while the KEY is kept, so the receiving side can
see exactly which credentials it must re-enter after import.

Import is CREATE-ONLY: an item whose ``code`` already exists in this
environment is skipped and reported — import never modifies an existing
server / connection (editing is what the edit drawer is for). Any
placeholder / mask-looking secret value is treated as "not provided"
and dropped, so a freshly imported entry simply has that credential
unconfigured until the admin fills it in.

Sensitivity rules per resource:
  - external connections: ``secret_json`` is sensitive by definition —
    all values are replaced; ``config_json`` / ``allowed_scopes_json``
    are non-secret by design and exported as-is.
  - servers: ``auth_secret`` is always sensitive; ``env_config`` values
    are masked when the key NAME looks credential-like (PASSWORD/TOKEN/
    SECRET/…). Binding keys (``connection_id`` etc.) and plain settings
    (``UV_CACHE_DIR``, hosts, flags) are exported verbatim so an import
    is runnable without re-typing non-secrets.
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from typing import Any, Optional

from fastapi import HTTPException, Request
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.models import MCPExternalConnection, MCPServer
from app.schemas import (
    MCPExternalConnectionCreate,
    MCPServerCreate,
)
from app.services import encryption
from app.services import mcp_external_connections as conn_svc
from app.services import mcp_servers as servers_svc

logger = logging.getLogger(__name__)

# What replaces every sensitive value in an export file. Deliberately a
# full sentence — the file is read by humans deciding what to fill in.
SECRET_PLACEHOLDER = "<敏感信息不随导出文件提供，导入后请在页面重新填写>"

BUNDLE_KIND_SERVERS = "goku-mcp-servers"
BUNDLE_KIND_CONNECTIONS = "goku-mcp-external-connections"
BUNDLE_VERSION = 1

# env_config keys whose VALUE is treated as sensitive on export. The
# save-time deny-list (FORBIDDEN_ENV_CONFIG_FIELDS) already keeps the
# runtime-owned credential fields out of env_config, but nothing stops
# an admin from storing e.g. CLICKHOUSE_PASSWORD for an official MCP
# package — so mask by key name as defence in depth.
_SENSITIVE_ENV_KEY_RE = re.compile(
    r"(pass|pwd|secret|token|credential|api_?key|private_?key|auth)", re.IGNORECASE
)

# Binding keys reference an external connection by code — that's an
# identifier, not a secret, and the import is unusable without it.
_BINDING_ENV_KEYS = frozenset({"connection_id", "server_auth_connection_id"})

# Non-secret server fields copied verbatim in both directions.
_SERVER_PLAIN_FIELDS = (
    "name", "code", "service_category", "description", "owner",
    "connection_type", "service_url", "start_command", "work_dir",
    "timeout_seconds", "retry_count", "auth_type", "auth_header_name",
    "auto_sync_enabled", "sync_frequency", "sync_scope",
    "conflict_strategy", "offline_strategy", "allow_agent_auto_invoke",
    "high_risk_confirm_required", "rate_limit_config",
    "circuit_breaker_config", "audit_enabled",
)


def _is_placeholder(value: Any) -> bool:
    """``True`` when an incoming value is our placeholder or any mask
    form (``已配置 ********`` sentinel, ``AKIA********QABC`` preview) —
    i.e. it carries no real secret and must never be persisted."""
    if not isinstance(value, str):
        return False
    return (
        value == SECRET_PLACEHOLDER
        or "敏感信息不随导出文件提供" in value
        or encryption.looks_like_mask(value)
    )


def _sensitive_env_key(key: str) -> bool:
    return key not in _BINDING_ENV_KEYS and bool(_SENSITIVE_ENV_KEY_RE.search(key))


# ── servers ───────────────────────────────────────────────────────────────────


def _decrypt_env(server: MCPServer) -> dict[str, str]:
    if not server.env_config:
        return {}
    try:
        plain = encryption.decrypt_secret(server.env_config)
        data = json.loads(plain) if plain else {}
        return data if isinstance(data, dict) else {}
    except Exception:
        # Corrupt ciphertext / missing key — export the row without env
        # rather than failing the whole bundle.
        logger.warning("env_config unreadable for server %s — exported without env", server.code)
        return {}


def export_servers(
    db: Session,
    codes: Optional[list[str]] = None,
    *,
    with_conn_codes: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Bundle active servers. Secret values → placeholder.

    ``codes`` narrows the export to specific servers (single-row export
    or a batch selection from the list page); ``None`` exports all.
    Unknown codes are reported with a 404 rather than silently skipped —
    an export that quietly misses what the admin asked for is worse
    than an error.

    ``with_conn_codes``: server codes whose BOUND external connections should
    travel in the same file (under ``connections``, secret values still
    placeholdered). For those servers the binding values are KEPT so the
    target environment can wire them up automatically on import; for the rest
    the binding is blanked (the referenced connection only exists here) but
    the key stays as a "needs binding" marker for the import dialog. Chosen
    per-server so a batch export can mix "with" and "without".
    """
    with_conn = set(with_conn_codes or ())
    q = db.query(MCPServer).filter(MCPServer.deleted_at.is_(None))
    if codes:
        q = q.filter(MCPServer.code.in_(codes))
    servers = q.order_by(MCPServer.code).all()
    if codes:
        missing = set(codes) - {s.code for s in servers}
        if missing:
            raise HTTPException(
                status_code=404,
                detail=f"找不到以下 MCP 服务器:{'、'.join(sorted(missing))}",
            )
    with_conn_servers = [s for s in servers if s.code in with_conn]
    items: list[dict[str, Any]] = []
    for s in servers:
        keep_binding = s.code in with_conn
        item: dict[str, Any] = {f: getattr(s, f) for f in _SERVER_PLAIN_FIELDS}
        item["status"] = s.status
        item["auth_secret"] = SECRET_PLACEHOLDER if s.auth_secret else None
        env = _decrypt_env(s)
        # Binding keys reference an external connection. If this server carries
        # its connections (keep_binding), keep the value so it resolves on
        # import; otherwise blank it but keep the key as a "needs binding"
        # marker for the import dialog.
        item["env_config"] = {
            k: (
                (v if keep_binding else "") if k in _BINDING_ENV_KEYS
                else SECRET_PLACEHOLDER if _sensitive_env_key(k)
                else v
            )
            for k, v in env.items()
        } or None
        items.append(item)

    bundle: dict[str, Any] = {
        "kind": BUNDLE_KIND_SERVERS,
        "version": BUNDLE_VERSION,
        "exported_at": datetime.utcnow().isoformat() + "Z",
        "items": items,
    }
    if with_conn_servers:
        bound = _bound_connection_codes(with_conn_servers)
        conns = (
            db.query(MCPExternalConnection)
            .filter(
                MCPExternalConnection.deleted_at.is_(None),
                MCPExternalConnection.code.in_(bound),
            )
            .order_by(MCPExternalConnection.code)
            .all()
        ) if bound else []
        bundle["connections"] = [_connection_to_export_item(c) for c in conns]
    return bundle


def resolve_export_server_codes(db: Session, codes: Optional[list[str]]) -> list[str]:
    """The concrete server codes an export will produce. ``codes`` given →
    validated as-is (unknown → 404); ``None`` → all active servers. Lets the
    endpoint decide JSON vs zip purely by 'how many servers come out'."""
    if codes:
        found = {
            s.code for s in db.query(MCPServer.code)
            .filter(MCPServer.deleted_at.is_(None), MCPServer.code.in_(codes)).all()
        }
        missing = set(codes) - found
        if missing:
            raise HTTPException(
                status_code=404,
                detail=f"找不到以下 MCP 服务器:{'、'.join(sorted(missing))}",
            )
        return codes
    return [
        s.code for s in db.query(MCPServer.code)
        .filter(MCPServer.deleted_at.is_(None)).order_by(MCPServer.code).all()
    ]


def export_servers_zip(
    db: Session,
    codes: list[str],
    *,
    with_conn_codes: Optional[list[str]] = None,
) -> bytes:
    """Batch export: ONE self-contained JSON per server, packed into a zip.

    Each server's file is a normal single-server bundle produced by
    :func:`export_servers`; if that server was chosen to carry its bound
    connections, they live inside its OWN file (per user spec — files are
    independent, a connection travels with the server that binds it).
    Uses the stdlib zipfile, same as the agent batch export.
    """
    import zipfile
    from io import BytesIO

    with_conn = set(with_conn_codes or ())
    archive = BytesIO()
    used: set[str] = set()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for code in codes:
            single = export_servers(
                db, codes=[code],
                with_conn_codes=[code] if code in with_conn else None,
            )
            name = f"mcp-{code}.json"
            if name in used:  # codes are unique, but be defensive
                name = f"mcp-{code}-{len(used)}.json"
            used.add(name)
            zf.writestr(name, json.dumps(single, ensure_ascii=False, indent=2))
    return archive.getvalue()


def _error_text(exc: Exception) -> str:
    if isinstance(exc, HTTPException):
        detail = exc.detail
        if isinstance(detail, dict):
            return str(detail.get("message") or detail)
        return str(detail)
    if isinstance(exc, ValidationError):
        first = exc.errors()[0]
        loc = ".".join(str(p) for p in first.get("loc", ()))
        return f"{loc}: {first.get('msg', 'invalid value')}"
    return str(exc)


def import_servers(
    db: Session,
    bundle: dict[str, Any],
    *,
    user_id: Optional[str],
    request: Optional[Request] = None,
) -> dict[str, Any]:
    """Create servers from an export bundle. CREATE-ONLY by design:
    an item whose ``code`` already exists is skipped and reported —
    import never modifies existing configuration.

    Placeholder secret values are dropped (the credential is simply
    unconfigured on the new server). Per-item failures (e.g. a bound
    connection that doesn't exist yet) are collected into ``errors``
    without aborting the rest of the file.
    """
    if bundle.get("kind") != BUNDLE_KIND_SERVERS:
        raise HTTPException(
            status_code=400,
            detail=f"导入文件不是 MCP 服务器导出文件(kind 应为 {BUNDLE_KIND_SERVERS!r})",
        )
    created: list[str] = []
    skipped: list[str] = []
    errors: list[dict[str, str]] = []
    items = bundle.get("items") or []
    for item in items:
        code = str(item.get("code") or "").strip()
        if not code:
            errors.append({"code": "", "message": "条目缺少 code 字段"})
            continue
        try:
            if servers_svc._get_active_by_code(db, code) is not None:
                skipped.append(code)
                continue
            auth_secret = item.get("auth_secret")
            if _is_placeholder(auth_secret) or not auth_secret:
                auth_secret = None
            env_in = item.get("env_config") or {}
            if not isinstance(env_in, dict):
                env_in = {}
            # Drop placeholders and empty values. An empty binding value
            # (blanked on export, and left unset in the import dialog)
            # means "no binding" — omitting the key lets create_server
            # apply the correct rule (required-connection servers are
            # rejected with a clear message; others import fine).
            env_clean = {
                k: str(v) for k, v in env_in.items()
                if not _is_placeholder(v) and str(v).strip() != ""
            }
            data = {
                f: item[f] for f in _SERVER_PLAIN_FIELDS
                if f in item and item[f] is not None
            }
            payload = MCPServerCreate(
                **data, auth_secret=auth_secret, env_config=env_clean or None,
            )
            server = servers_svc.create_server(
                db, payload, user_id=user_id, request=request,
            )
            # create_server always starts servers enabled; honour an
            # exported disabled state so the import is faithful.
            if item.get("status") == "disabled":
                server.status = "disabled"
                db.commit()
            created.append(code)
        except (HTTPException, ValidationError, ValueError) as exc:
            db.rollback()
            errors.append({"code": code, "message": _error_text(exc)})
    return {
        "total": len(items), "created": created, "skipped": skipped, "errors": errors,
    }


# ── external connections ─────────────────────────────────────────────────────


def _connection_to_export_item(c: "MCPExternalConnection") -> dict[str, Any]:
    """Serialize one connection for an export bundle. Secret values → placeholder
    (keys kept); config / allowed_scopes are non-secret and exported as-is."""
    return {
        "code": c.code,
        "name": c.name,
        "connection_type": c.connection_type,
        "enabled": bool(c.enabled),
        "config": c.config_json or {},
        "secret": {k: SECRET_PLACEHOLDER for k in (c.secret_json or {})},
        "allowed_scopes": c.allowed_scopes_json or {},
    }


def _bound_connection_codes(servers: list["MCPServer"]) -> list[str]:
    """Connection codes referenced by these servers' env_config binding keys
    (connection_id / server_auth_connection_id)."""
    codes: set[str] = set()
    for s in servers:
        env = _decrypt_env(s)
        for k in _BINDING_ENV_KEYS:
            v = env.get(k)
            if isinstance(v, str) and v.strip():
                codes.add(v.strip())
    return sorted(codes)


def server_binding_summary(db: Session, codes: list[str]) -> list[dict[str, Any]]:
    """For each server code, list the connection codes it is bound to. Powers
    the export dialog's per-server 'include its connections' checkboxes — a
    server with no bindings gets an empty list (checkbox not offered)."""
    if not codes:
        return []
    servers = (
        db.query(MCPServer)
        .filter(MCPServer.deleted_at.is_(None), MCPServer.code.in_(codes))
        .order_by(MCPServer.code)
        .all()
    )
    out: list[dict[str, Any]] = []
    for s in servers:
        env = _decrypt_env(s)
        bound = sorted({
            env[k].strip()
            for k in _BINDING_ENV_KEYS
            if isinstance(env.get(k), str) and env[k].strip()
        })
        out.append({"code": s.code, "name": s.name, "bound_connections": bound})
    return out


def export_connections(
    db: Session, codes: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Bundle active connections. All secret values → placeholder;
    config / allowed_scopes are non-secret by design and exported as-is.
    ``codes`` narrows to a selection (see :func:`export_servers`)."""
    q = db.query(MCPExternalConnection).filter(
        MCPExternalConnection.deleted_at.is_(None)
    )
    if codes:
        q = q.filter(MCPExternalConnection.code.in_(codes))
    conns = q.order_by(MCPExternalConnection.code).all()
    if codes:
        missing = set(codes) - {c.code for c in conns}
        if missing:
            raise HTTPException(
                status_code=404,
                detail=f"找不到以下外部连接:{'、'.join(sorted(missing))}",
            )
    items = [_connection_to_export_item(c) for c in conns]
    return {
        "kind": BUNDLE_KIND_CONNECTIONS,
        "version": BUNDLE_VERSION,
        "exported_at": datetime.utcnow().isoformat() + "Z",
        "items": items,
    }


def resolve_export_connection_codes(db: Session, codes: Optional[list[str]]) -> list[str]:
    """Connection-side twin of :func:`resolve_export_server_codes`: the concrete
    connection codes an export will produce (selection validated, or all)."""
    if codes:
        found = {
            c.code for c in db.query(MCPExternalConnection.code)
            .filter(MCPExternalConnection.deleted_at.is_(None),
                    MCPExternalConnection.code.in_(codes)).all()
        }
        missing = set(codes) - found
        if missing:
            raise HTTPException(
                status_code=404,
                detail=f"找不到以下外部连接:{'、'.join(sorted(missing))}",
            )
        return codes
    return [
        c.code for c in db.query(MCPExternalConnection.code)
        .filter(MCPExternalConnection.deleted_at.is_(None))
        .order_by(MCPExternalConnection.code).all()
    ]


def export_connections_zip(db: Session, codes: list[str]) -> bytes:
    """Batch connection export: ONE self-contained JSON per connection, zipped
    (mirrors :func:`export_servers_zip`). Each file reuses the single-code
    export so the format is identical to a single-connection download."""
    import zipfile
    from io import BytesIO

    archive = BytesIO()
    used: set[str] = set()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for code in codes:
            single = export_connections(db, codes=[code])
            name = f"mcp-conn-{code}.json"
            if name in used:
                name = f"mcp-conn-{code}-{len(used)}.json"
            used.add(name)
            zf.writestr(name, json.dumps(single, ensure_ascii=False, indent=2))
    return archive.getvalue()


def existing_server_codes(db: Session, codes: list[str]) -> list[str]:
    """Which of ``codes`` are already taken by an ACTIVE server. Used by
    the code-uniqueness check endpoint (import conflict dialog + the
    create drawer's live validation)."""
    if not codes:
        return []
    rows = (
        db.query(MCPServer.code)
        .filter(MCPServer.deleted_at.is_(None), MCPServer.code.in_(codes))
        .all()
    )
    return sorted({r.code for r in rows})


def existing_connection_codes(db: Session, codes: list[str]) -> list[str]:
    """Connection-side twin of :func:`existing_server_codes`."""
    if not codes:
        return []
    rows = (
        db.query(MCPExternalConnection.code)
        .filter(
            MCPExternalConnection.deleted_at.is_(None),
            MCPExternalConnection.code.in_(codes),
        )
        .all()
    )
    return sorted({r.code for r in rows})


def _get_active_connection_by_code(
    db: Session, code: str,
) -> Optional[MCPExternalConnection]:
    return (
        db.query(MCPExternalConnection)
        .filter(
            MCPExternalConnection.code == code,
            MCPExternalConnection.deleted_at.is_(None),
        )
        .first()
    )


def import_connections(
    db: Session,
    bundle: dict[str, Any],
    *,
    user_id: Optional[str],
    request: Optional[Request] = None,
) -> dict[str, Any]:
    """Create connections from an export bundle. CREATE-ONLY by design:
    an item whose ``code`` already exists is skipped and reported —
    import never modifies existing configuration.

    Secret handling: a real value supplied at import time (the user typed it
    into the import dialog) is encrypted and stored. A secret key left blank
    or still carrying the export placeholder is kept as a LABEL — the key is
    stored with an empty value so the admin sees "this field still needs a
    value" on the connection later, instead of the field silently vanishing.
    """
    if bundle.get("kind") != BUNDLE_KIND_CONNECTIONS:
        raise HTTPException(
            status_code=400,
            detail=f"导入文件不是外部连接导出文件(kind 应为 {BUNDLE_KIND_CONNECTIONS!r})",
        )
    created: list[str] = []
    skipped: list[str] = []
    errors: list[dict[str, str]] = []
    items = bundle.get("items") or []
    for item in items:
        code = str(item.get("code") or "").strip()
        if not code:
            errors.append({"code": "", "message": "条目缺少 code 字段"})
            continue
        try:
            if _get_active_connection_by_code(db, code) is not None:
                skipped.append(code)
                continue
            secret_in = item.get("secret") or {}
            if not isinstance(secret_in, dict):
                secret_in = {}
            # Split: real values → encrypt & store now; blank/placeholder →
            # keep the key as an empty label (see docstring).
            filled = {
                k: v for k, v in secret_in.items()
                if isinstance(v, str) and v.strip() and not _is_placeholder(v)
            }
            label_only = [k for k in secret_in.keys() if k not in filled]

            payload = MCPExternalConnectionCreate(
                code=code,
                name=item.get("name") or code,
                connection_type=item.get("connection_type"),
                enabled=bool(item.get("enabled", True)),
                config=item.get("config") or {},
                secret=filled,
                allowed_scopes=item.get("allowed_scopes") or {},
            )
            conn_svc.create_connection(
                db, payload, user_id=user_id, request=request,
            )
            # Persist label-only keys directly (create_connection's encrypt
            # helper drops empty values, which would lose the labels). It
            # returns a serialized dict, so re-fetch the ORM row to edit it.
            if label_only:
                row = _get_active_connection_by_code(db, code)
                if row is not None:
                    _sj = dict(row.secret_json or {})
                    for k in label_only:
                        _sj.setdefault(k, "")
                    row.secret_json = _sj
                    from sqlalchemy.orm.attributes import flag_modified
                    flag_modified(row, "secret_json")
                    db.commit()
            created.append(code)
        except (HTTPException, ValidationError, ValueError) as exc:
            db.rollback()
            errors.append({"code": code, "message": _error_text(exc)})
    return {
        "total": len(items), "created": created, "skipped": skipped, "errors": errors,
    }
