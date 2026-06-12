"""Platform-managed external connection configs for the MCP module.

CRUD + encryption/masking for ``mcp_external_connections`` — connection
parameters and encrypted secrets for external systems (S3 / SFTP / URL /
local_path / database / GitHub / Slack) that MCP Servers reach.

Secret handling:
  - ``secret_json`` values are stored as ``enc:v1:<ciphertext>``
  - API responses mask every secret value (never plaintext / ciphertext)
  - :func:`get_decrypted_connection_for_runtime` is the ONLY path that
    returns plaintext, and only for backend runtime use — it audit-logs
    the secret read.

This module does NOT touch MCP Server authorization. ``mcp_servers``
stays the authorization boundary; a connection is only a config holder.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Any, Optional

from fastapi import HTTPException, Request
from sqlalchemy.orm import Session

from app import auth as _auth
from app.models import MCPExternalConnection
from app.services.encryption import (
    MASK_DISPLAY,
    decrypt_secret, encrypt_secret, looks_like_mask, mask_secret,
)

logger = logging.getLogger(__name__)

VALID_CONNECTION_TYPES = {
    "s3", "sftp", "url", "local_path", "database", "github", "slack",
}

# ─── Structured error codes ───────────────────────────────────────────
ERR_NOT_FOUND = "MCP_CONNECTION_NOT_FOUND"
ERR_DISABLED = "MCP_CONNECTION_DISABLED"
ERR_ACCESS_DENIED = "MCP_CONNECTION_ACCESS_DENIED"
ERR_TYPE_UNSUPPORTED = "MCP_CONNECTION_TYPE_UNSUPPORTED"
ERR_TEST_FAILED = "MCP_CONNECTION_TEST_FAILED"
ERR_SCOPE_DENIED = "MCP_CONNECTION_SCOPE_DENIED"
ERR_SECRET_MISSING = "MCP_CONNECTION_SECRET_MISSING"
ERR_CONFIG_INVALID = "MCP_CONNECTION_CONFIG_INVALID"

_AUDIT_TYPE = "mcp_external_connection"


class MCPConnectionError(Exception):
    """Structured connection error for non-HTTP runtime paths."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}")


# ─── secret helpers ───────────────────────────────────────────────────

def _encrypt_secret_dict(
    new_secret: Optional[dict[str, Any]],
    existing_secret: Optional[dict[str, Any]],
) -> dict[str, Any]:
    """Merge an incoming secret dict into the stored one.

    Per field: a masked value (frontend left it untouched) keeps the
    existing ciphertext; any other value is encrypted (idempotent — an
    already ``enc:v1:`` value is not double-encrypted).
    """
    out: dict[str, Any] = dict(existing_secret or {})
    for key, value in (new_secret or {}).items():
        if value is None or value == "":
            # Treat empty as "no change" — explicit clearing isn't a
            # first-version need; the field just stays as stored.
            continue
        if looks_like_mask(str(value)):
            continue
        out[key] = encrypt_secret(str(value))
    return out


def _mask_secret_dict(secret: Optional[dict[str, Any]]) -> dict[str, str]:
    """Mask every secret value for an API response."""
    return {k: mask_secret(v) for k, v in (secret or {}).items()}


# Industry-standard preview: first 4 + 8 stars + last 4. The 8-star
# middle is deliberately the same width as MASK_DISPLAY's sentinel so
# `looks_like_mask` keeps treating these as "leave unchanged" if they
# round-trip back via the edit drawer — otherwise an admin saving without
# touching the field would overwrite the stored secret with its preview.
_PREVIEW_MIN_PLAIN_LEN = 12  # below this we fall back to MASK_DISPLAY so
                              # short tokens don't surface meaningful prefix


def _preview_mask(stored: Optional[str]) -> str:
    """Render a partial-mask preview (e.g. ``AKIA********QABC``) so the
    admin can tell which credential is currently configured. For short
    secrets (under ``_PREVIEW_MIN_PLAIN_LEN`` chars), or if decryption
    fails, returns the full :data:`MASK_DISPLAY` sentinel instead — a
    4-char prefix on an 8-char token is far too much information.
    """
    if not stored:
        return ""
    try:
        plain = decrypt_secret(stored)
    except Exception:
        # GOKU_SECRET_KEY missing or ciphertext corrupt — never crash the
        # detail endpoint over presentation; the value is still safely
        # encrypted at rest.
        return MASK_DISPLAY
    if not plain or len(plain) < _PREVIEW_MIN_PLAIN_LEN:
        return MASK_DISPLAY
    return f"{plain[:4]}********{plain[-4:]}"


def _preview_mask_dict(secret: Optional[dict[str, Any]]) -> dict[str, str]:
    """Detail-view dict version of :func:`_preview_mask`."""
    return {k: _preview_mask(v) for k, v in (secret or {}).items()}


def _decrypt_secret_dict(secret: Optional[dict[str, Any]]) -> dict[str, str]:
    """Decrypt every secret value — runtime use only."""
    return {k: decrypt_secret(v) for k, v in (secret or {}).items()}


# ─── serialization ────────────────────────────────────────────────────

def _to_list_item(conn: MCPExternalConnection) -> dict[str, Any]:
    return {
        "id": conn.id,
        "code": conn.code,
        "name": conn.name,
        "connection_type": conn.connection_type,
        "enabled": bool(conn.enabled),
        "test_status": conn.test_status,
        "last_tested_at": conn.last_tested_at,
        # Non-secret scope (allowed_domains / allowed_buckets / allowed_dirs).
        "allowed_scopes": conn.allowed_scopes_json or {},
        "created_at": conn.created_at,
        "updated_at": conn.updated_at,
    }


def _to_detail(conn: MCPExternalConnection) -> dict[str, Any]:
    """Full view with secrets PREVIEW-masked (first/last 4 chars) — safe
    for API responses. Short secrets fall back to the full mask sentinel
    so a 4-char prefix on a small token isn't disclosed."""
    return {
        **_to_list_item(conn),
        "config": conn.config_json or {},
        "secret": _preview_mask_dict(conn.secret_json),
        "allowed_scopes": conn.allowed_scopes_json or {},
        "last_test_error": conn.last_test_error,
    }


# ─── lookups ──────────────────────────────────────────────────────────

def _get_or_404(db: Session, connection_id: str) -> MCPExternalConnection:
    conn = (
        db.query(MCPExternalConnection)
        .filter(
            MCPExternalConnection.id == connection_id,
            MCPExternalConnection.deleted_at.is_(None),
        )
        .first()
    )
    if conn is None:
        raise HTTPException(404, f"external connection {connection_id!r} not found")
    return conn


def _audit(
    db: Session, *, user_id: Optional[str], action: str,
    resource_id: str, request: Optional[Request], details: dict[str, Any],
) -> None:
    try:
        _auth.log_audit_action(
            db, user_id=user_id, action=action,
            resource_type=_AUDIT_TYPE, resource_id=resource_id,
            details=details, request=request,
        )
    except Exception as e:  # audit must never break the main flow
        logger.warning("external-connection audit failed (%s): %s", action, e)


# ─── CRUD ─────────────────────────────────────────────────────────────

def list_connections(
    db: Session, *, connection_type: Optional[str] = None,
    enabled: Optional[bool] = None, keyword: Optional[str] = None,
) -> tuple[int, list[dict[str, Any]]]:
    """List non-deleted connections, newest first. All filters optional."""
    q = db.query(MCPExternalConnection).filter(
        MCPExternalConnection.deleted_at.is_(None)
    )
    if connection_type:
        q = q.filter(MCPExternalConnection.connection_type == connection_type)
    if enabled is not None:
        q = q.filter(MCPExternalConnection.enabled == enabled)
    if keyword:
        like = f"%{keyword}%"
        q = q.filter(
            (MCPExternalConnection.code.like(like))
            | (MCPExternalConnection.name.like(like))
        )
    rows = q.order_by(MCPExternalConnection.created_at.desc()).all()
    return len(rows), [_to_list_item(r) for r in rows]


def get_connection(db: Session, connection_id: str) -> dict[str, Any]:
    """Detail view with masked secrets."""
    return _to_detail(_get_or_404(db, connection_id))


def create_connection(
    db: Session, payload, *, user_id: Optional[str],
    request: Optional[Request] = None,
) -> dict[str, Any]:
    """Create a connection. Secret values are encrypted before insert."""
    if payload.connection_type not in VALID_CONNECTION_TYPES:
        raise HTTPException(
            400, f"unsupported connection_type {payload.connection_type!r}")
    dup = (
        db.query(MCPExternalConnection)
        .filter(MCPExternalConnection.code == payload.code)
        .first()
    )
    if dup:
        raise HTTPException(409, f"connection code {payload.code!r} already exists")

    conn = MCPExternalConnection(
        id=str(uuid.uuid4()),
        code=payload.code,
        name=payload.name,
        connection_type=payload.connection_type,
        enabled=payload.enabled,
        config_json=payload.config or {},
        secret_json=_encrypt_secret_dict(payload.secret, None),
        allowed_scopes_json=payload.allowed_scopes or {},
        test_status=None,
        created_by=user_id,
        updated_by=user_id,
    )
    db.add(conn)
    db.commit()
    db.refresh(conn)
    _audit(
        db, user_id=user_id, action="mcp_external_connection.create",
        resource_id=conn.id, request=request,
        details={"code": conn.code, "name": conn.name,
                 "connection_type": conn.connection_type,
                 "secret_fields": sorted((conn.secret_json or {}).keys())},
    )
    return _to_detail(conn)


def update_connection(
    db: Session, connection_id: str, payload, *, user_id: Optional[str],
    request: Optional[Request] = None,
) -> dict[str, Any]:
    """Patch a connection. Masked secret values keep the stored ciphertext."""
    conn = _get_or_404(db, connection_id)
    changed: list[str] = []

    if payload.name is not None and payload.name != conn.name:
        conn.name = payload.name
        changed.append("name")
    if payload.enabled is not None and payload.enabled != conn.enabled:
        conn.enabled = payload.enabled
        changed.append("enabled")
    if payload.config is not None:
        conn.config_json = payload.config
        changed.append("config")
    if payload.allowed_scopes is not None:
        conn.allowed_scopes_json = payload.allowed_scopes
        changed.append("allowed_scopes")
    if payload.secret is not None:
        conn.secret_json = _encrypt_secret_dict(payload.secret, conn.secret_json)
        changed.append("secret")

    if changed:
        conn.updated_by = user_id
        conn.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(conn)
        _audit(
            db, user_id=user_id, action="mcp_external_connection.update",
            resource_id=conn.id, request=request,
            details={"code": conn.code, "changed_fields": changed},
        )
    return _to_detail(conn)


def _set_enabled(
    db: Session, connection_id: str, value: bool, *, user_id: Optional[str],
    request: Optional[Request] = None,
) -> dict[str, Any]:
    conn = _get_or_404(db, connection_id)
    if conn.enabled != value:
        conn.enabled = value
        conn.updated_by = user_id
        conn.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(conn)
        _audit(
            db, user_id=user_id,
            action=f"mcp_external_connection.{'enable' if value else 'disable'}",
            resource_id=conn.id, request=request, details={"code": conn.code},
        )
    return _to_detail(conn)


def enable_connection(db, connection_id, *, user_id, request=None):
    return _set_enabled(db, connection_id, True, user_id=user_id, request=request)


def disable_connection(db, connection_id, *, user_id, request=None):
    return _set_enabled(db, connection_id, False, user_id=user_id, request=request)


def soft_delete_connection(
    db: Session, connection_id: str, *, user_id: Optional[str],
    request: Optional[Request] = None,
) -> None:
    """Soft-delete: set deleted_at. Runtime treats deleted as unusable."""
    conn = _get_or_404(db, connection_id)
    conn.deleted_at = datetime.utcnow()
    conn.updated_by = user_id
    db.commit()
    _audit(
        db, user_id=user_id, action="mcp_external_connection.delete",
        resource_id=conn.id, request=request, details={"code": conn.code},
    )


# ─── runtime access ───────────────────────────────────────────────────

def get_decrypted_connection_for_runtime(
    db: Session, connection_ref: str, *, user_id: Optional[str] = None,
    request: Optional[Request] = None,
) -> dict[str, Any]:
    """Resolve a connection (by code OR id) for backend runtime use and
    return its config + DECRYPTED secrets.

    NOT for the API layer — this is the only path that yields plaintext.
    The secret read is audit-logged. Raises :class:`MCPConnectionError`
    (structured, non-HTTP) on any failure so callers can map it.
    """
    conn = (
        db.query(MCPExternalConnection)
        .filter(
            (MCPExternalConnection.code == connection_ref)
            | (MCPExternalConnection.id == connection_ref),
            MCPExternalConnection.deleted_at.is_(None),
        )
        .first()
    )
    if conn is None:
        raise MCPConnectionError(ERR_NOT_FOUND, f"connection {connection_ref!r} not found")
    if not conn.enabled:
        raise MCPConnectionError(ERR_DISABLED, f"connection {conn.code!r} is disabled")

    _audit(
        db, user_id=user_id, action="mcp_external_connection.secret_read",
        resource_id=conn.id, request=request,
        details={"code": conn.code, "connection_type": conn.connection_type},
    )
    return {
        "id": conn.id,
        "code": conn.code,
        "connection_type": conn.connection_type,
        "config": conn.config_json or {},
        "secret": _decrypt_secret_dict(conn.secret_json),
        "allowed_scopes": conn.allowed_scopes_json or {},
    }


# ─── connection test ──────────────────────────────────────────────────
#
# P3 ships a SHALLOW test: it verifies the connection is usable in
# principle — type supported, enabled, and the secret fields that type
# requires are present. P4 deepens this into real connectivity probes
# (S3 HeadBucket, SFTP handshake, URL HEAD, ...).

# Required secret fields per connection type. SFTP is special — it needs
# password OR private_key — handled in code, not by this table.
_REQUIRED_SECRET_FIELDS: dict[str, list[str]] = {
    "s3": ["aws_access_key_id", "aws_secret_access_key"],
    "url": [],
    "local_path": [],
    "database": ["password"],
    "github": ["token"],
    "slack": ["bot_token"],
}


def _shallow_check(conn: MCPExternalConnection) -> None:
    """Raise MCPConnectionError if the connection can't possibly work."""
    ctype = conn.connection_type
    if ctype not in VALID_CONNECTION_TYPES:
        raise MCPConnectionError(ERR_TYPE_UNSUPPORTED, f"unsupported type {ctype!r}")
    if not conn.enabled:
        raise MCPConnectionError(ERR_DISABLED, "connection is disabled")
    secret = conn.secret_json or {}
    if ctype == "sftp":
        if not (secret.get("password") or secret.get("private_key")):
            raise MCPConnectionError(
                ERR_SECRET_MISSING, "sftp needs password or private_key")
    else:
        missing = [f for f in _REQUIRED_SECRET_FIELDS.get(ctype, []) if not secret.get(f)]
        if missing:
            raise MCPConnectionError(
                ERR_SECRET_MISSING, f"missing secret fields: {', '.join(missing)}")


def test_connection(
    db: Session, connection_id: str, *, user_id: Optional[str],
    request: Optional[Request] = None,
) -> dict[str, Any]:
    """Test a connection and persist test_status / last_tested_at /
    last_test_error. Returns the outcome dict.

    Runs the shallow check first (type / enabled / required secrets),
    then a real per-type connectivity probe.
    """
    conn = _get_or_404(db, connection_id)
    status_ = "ok"
    error: Optional[str] = None
    detail = ""
    try:
        _shallow_check(conn)
        detail = _probe_connection(conn)
    except MCPConnectionError as e:
        status_, error, detail = "failed", e.message, e.code
    except Exception as e:  # any probe-level failure → failed, not 500
        status_, error, detail = "failed", str(e)[:480], ERR_TEST_FAILED

    conn.test_status = status_
    conn.last_tested_at = datetime.utcnow()
    conn.last_test_error = error
    db.commit()
    db.refresh(conn)
    _audit(
        db, user_id=user_id, action="mcp_external_connection.test",
        resource_id=conn.id, request=request,
        details={"code": conn.code, "test_status": status_, "error": error},
    )
    return {
        "test_status": conn.test_status,
        "last_tested_at": conn.last_tested_at,
        "last_test_error": conn.last_test_error,
        "detail": detail,
    }


# ─── per-type connectivity probes ─────────────────────────────────────

def _probe_connection(conn: MCPExternalConnection) -> str:
    """Real connectivity probe. Returns a short success detail string;
    raises MCPConnectionError on failure."""
    cfg = conn.config_json or {}
    sec = _decrypt_secret_dict(conn.secret_json)
    ctype = conn.connection_type
    if ctype == "s3":
        return _probe_s3(cfg, sec, conn.allowed_scopes_json or {})
    if ctype == "url":
        return _probe_url(cfg, sec, conn.allowed_scopes_json or {})
    if ctype == "local_path":
        return _probe_local_path(conn.allowed_scopes_json or {})
    if ctype == "database":
        return _probe_database(cfg, sec)
    if ctype == "github":
        return _probe_github(cfg, sec)
    if ctype == "slack":
        return _probe_slack(sec)
    if ctype == "sftp":
        return _probe_sftp(cfg)
    raise MCPConnectionError(ERR_TYPE_UNSUPPORTED, f"unsupported type {ctype!r}")


def _probe_s3(cfg: dict, sec: dict, scopes: dict) -> str:
    import boto3
    from botocore.config import Config as BotoConfig
    buckets = scopes.get("allowed_buckets") or []
    if not buckets:
        raise MCPConnectionError(ERR_SCOPE_DENIED, "allowed_buckets is empty")
    client = boto3.client(
        "s3",
        region_name=cfg.get("region") or "us-east-1",
        aws_access_key_id=sec.get("aws_access_key_id"),
        aws_secret_access_key=sec.get("aws_secret_access_key"),
        endpoint_url=cfg.get("endpoint_url") or None,
        config=BotoConfig(
            signature_version="s3v4",
            s3={"addressing_style": "path" if cfg.get("force_path_style") else "virtual"},
            connect_timeout=8, read_timeout=8, retries={"max_attempts": 1},
        ),
    )
    client.head_bucket(Bucket=buckets[0])
    return f"head_bucket ok ({buckets[0]})"


def _probe_url(cfg: dict, sec: dict, scopes: dict) -> str:
    import httpx
    domains = scopes.get("allowed_domains") or []
    if not domains:
        raise MCPConnectionError(ERR_SCOPE_DENIED, "allowed_domains is empty")
    target = f"https://{domains[0]}"
    headers = {}
    if sec.get("authorization_header"):
        headers["Authorization"] = sec["authorization_header"]
    timeout = float(cfg.get("timeout_seconds") or 15)
    resp = httpx.head(target, headers=headers, timeout=timeout, follow_redirects=False)
    return f"HEAD {domains[0]} → http {resp.status_code}"


def _probe_local_path(scopes: dict) -> str:
    import os
    dirs = scopes.get("allowed_dirs") or []
    if not dirs:
        raise MCPConnectionError(ERR_SCOPE_DENIED, "allowed_dirs is empty")
    missing = [d for d in dirs if not os.path.isdir(d)]
    if missing:
        raise MCPConnectionError(ERR_CONFIG_INVALID, f"dirs not found: {', '.join(missing)}")
    return f"{len(dirs)} allowed_dir(s) exist"


def _probe_database(cfg: dict, sec: dict) -> str:
    if (cfg.get("db_type") or "mysql") != "mysql":
        # Only MySQL has a bundled driver; others pass shallow only.
        return "shallow ok (non-mysql: driver not bundled)"
    import pymysql
    conn = pymysql.connect(
        host=cfg.get("host"), port=int(cfg.get("port") or 3306),
        user=cfg.get("username"), password=sec.get("password") or "",
        database=cfg.get("database"), connect_timeout=8,
    )
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
            cur.fetchone()
    finally:
        conn.close()
    return "mysql SELECT 1 ok"


def _probe_github(cfg: dict, sec: dict) -> str:
    import httpx
    base = (cfg.get("api_base_url") or "https://api.github.com").rstrip("/")
    resp = httpx.get(
        f"{base}/user",
        headers={"Authorization": f"Bearer {sec.get('token', '')}",
                 "Accept": "application/vnd.github+json"},
        timeout=15,
    )
    if resp.status_code != 200:
        raise MCPConnectionError(ERR_TEST_FAILED, f"github /user → http {resp.status_code}")
    return f"github /user ok ({resp.json().get('login', '?')})"


def _probe_slack(sec: dict) -> str:
    import httpx
    resp = httpx.post(
        "https://slack.com/api/auth.test",
        headers={"Authorization": f"Bearer {sec.get('bot_token', '')}"},
        timeout=15,
    )
    body = resp.json()
    if not body.get("ok"):
        raise MCPConnectionError(ERR_TEST_FAILED, f"slack auth.test: {body.get('error')}")
    return f"slack auth.test ok ({body.get('team', '?')})"


def _probe_sftp(cfg: dict) -> str:
    """Socket-level reachability only — paramiko is not bundled, so the
    full auth handshake is not verified here."""
    import socket
    host, port = cfg.get("host"), int(cfg.get("port") or 22)
    if not host:
        raise MCPConnectionError(ERR_CONFIG_INVALID, "sftp host is required")
    with socket.create_connection((host, port), timeout=8):
        pass
    return f"tcp {host}:{port} reachable (auth not verified — paramiko absent)"


# ─── scope validation (runtime security gate) ─────────────────────────

# Path prefixes a local_path connection may never touch.
_FORBIDDEN_LOCAL_ROOTS = (
    "/etc", "/root", "/home", "/proc", "/sys", "/var/run", "/boot", "/dev",
)


def _has_traversal(p: str) -> bool:
    """True if a path contains a `..` segment or is otherwise unsafe."""
    return ".." in (p or "").replace("\\", "/").split("/")


def validate_connection_scope(
    connection_type: str, allowed_scopes: Optional[dict[str, Any]],
    target: dict[str, Any],
) -> None:
    """Raise :class:`MCPConnectionError` if ``target`` is outside the
    connection's ``allowed_scopes``. The runtime security gate — call it
    before every external resource access.

    ``target`` carries the type-relevant keys:
      s3         → bucket, object_key
      sftp       → remote_path
      url        → url
      local_path → path
      database   → table
      github     → repo
      slack      → channel
    """
    scopes = allowed_scopes or {}

    if connection_type == "s3":
        bucket = target.get("bucket")
        key = target.get("object_key")
        allowed_buckets = scopes.get("allowed_buckets") or []
        if bucket not in allowed_buckets:
            raise MCPConnectionError(
                ERR_SCOPE_DENIED, f"bucket {bucket!r} not in allowed_buckets")
        if key is not None:
            if not key or key.startswith("/") or _has_traversal(key):
                raise MCPConnectionError(ERR_SCOPE_DENIED, f"invalid object_key {key!r}")
            prefixes = scopes.get("allowed_prefixes") or []
            if prefixes and not any(key.startswith(p) for p in prefixes):
                raise MCPConnectionError(
                    ERR_SCOPE_DENIED, f"object_key {key!r} outside allowed_prefixes")
        return

    if connection_type == "sftp":
        path = target.get("remote_path") or ""
        if not path or _has_traversal(path):
            raise MCPConnectionError(ERR_SCOPE_DENIED, f"invalid remote_path {path!r}")
        allowed = scopes.get("allowed_paths") or []
        if allowed and not any(path.startswith(p) for p in allowed):
            raise MCPConnectionError(
                ERR_SCOPE_DENIED, f"remote_path {path!r} outside allowed_paths")
        return

    if connection_type == "url":
        _validate_url_scope(target.get("url") or "", scopes)
        return

    if connection_type == "local_path":
        import os
        path = target.get("path") or ""
        if not path or _has_traversal(path):
            raise MCPConnectionError(ERR_SCOPE_DENIED, f"invalid path {path!r}")
        real = os.path.realpath(path)
        if any(real == r or real.startswith(r + "/") for r in _FORBIDDEN_LOCAL_ROOTS):
            raise MCPConnectionError(ERR_SCOPE_DENIED, f"path {path!r} hits a system dir")
        allowed = scopes.get("allowed_dirs") or []
        if not any(real == os.path.realpath(d) or real.startswith(os.path.realpath(d) + "/")
                   for d in allowed):
            raise MCPConnectionError(
                ERR_SCOPE_DENIED, f"path {path!r} outside allowed_dirs")
        return

    if connection_type == "database":
        table = target.get("table")
        if table is not None:
            allowed = scopes.get("allowed_tables") or []
            if allowed and table not in allowed:
                raise MCPConnectionError(
                    ERR_SCOPE_DENIED, f"table {table!r} not in allowed_tables")
        return

    if connection_type == "github":
        repo = target.get("repo")
        if repo is not None:
            allowed = scopes.get("allowed_repos") or []
            if allowed and repo not in allowed:
                raise MCPConnectionError(
                    ERR_SCOPE_DENIED, f"repo {repo!r} not in allowed_repos")
        return

    if connection_type == "slack":
        channel = target.get("channel")
        if channel is not None:
            allowed = scopes.get("allowed_channels") or []
            if allowed and channel not in allowed:
                raise MCPConnectionError(
                    ERR_SCOPE_DENIED, f"channel {channel!r} not in allowed_channels")
        return

    raise MCPConnectionError(ERR_TYPE_UNSUPPORTED, f"unsupported type {connection_type!r}")


def _validate_url_scope(url: str, scopes: dict[str, Any]) -> None:
    """SSRF guard for url-type connections: http/https only, host in
    allowed_domains, no private / loopback / link-local / metadata IPs."""
    import ipaddress
    import socket
    from urllib.parse import urlparse

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise MCPConnectionError(ERR_SCOPE_DENIED, "only http/https URLs allowed")
    host = (parsed.hostname or "").lower()
    if not host or host in ("localhost", "0.0.0.0"):
        raise MCPConnectionError(ERR_SCOPE_DENIED, f"host {host!r} is not allowed")

    allowed_domains = scopes.get("allowed_domains") or []
    if not allowed_domains:
        raise MCPConnectionError(ERR_SCOPE_DENIED, "allowed_domains is empty")
    if not any(host == d.lower() or host.endswith("." + d.lower()) for d in allowed_domains):
        raise MCPConnectionError(ERR_SCOPE_DENIED, f"host {host!r} not in allowed_domains")

    # Resolve and reject private / loopback / link-local / metadata IPs.
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError as e:
        raise MCPConnectionError(ERR_SCOPE_DENIED, f"host {host!r} unresolvable: {e}")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast
                or str(ip) == "169.254.169.254"):
            raise MCPConnectionError(
                ERR_SCOPE_DENIED, f"host {host!r} resolves to blocked IP {ip}")
