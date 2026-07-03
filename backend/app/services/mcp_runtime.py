"""MCP runtime — DB-backed loader + connection probing + capability sync.

Task 2 makes the DB the single source of truth for "what MCP servers
are running right now". This module owns:

- :func:`build_runtime_config`: turn one ``MCPServer`` row into the
  ``MCPServerConfig`` dataclass the existing ``app.agent.mcp.client``
  consumes — decrypts secrets, injects auth headers, splits the
  command string into ``command + args``.
- :func:`load_active_runtime_configs`: returns the full
  ``{code: config}`` dict the runtime should currently be connected
  to (``status='enabled'`` AND ``deleted_at IS NULL``).
- :func:`get_active_runtime_configs`: same as above but manages its
  own ``SessionLocal`` for code paths outside a request scope
  (registry init at startup, refresh hooks).

Secret handling
  The dataclass returned here carries DECRYPTED env values — that's
  the form ``client.MCPServerConnection`` needs to spawn / connect
  the subprocess. Plaintext never escapes back over the API; service
  layer responses are still built from masked column reads.
"""
from __future__ import annotations

import asyncio
import json
import logging
import shlex
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.agent.mcp.client import MCPServerConnection
from app.agent.mcp.config import MCPServerConfig
from app.models import MCPCapability, MCPHealthRecord, MCPPrompt, MCPResource, MCPServer
from app.services import encryption

logger = logging.getLogger(__name__)


def build_runtime_config(server: MCPServer, db: Optional[Session] = None) -> MCPServerConfig:
    """Project one DB row into a runtime-ready :class:`MCPServerConfig`.

    Mapping:
      * ``name``         ← ``server.code`` (stable external id; matches
        the .mcp.json key convention so the in-memory registry keys
        don't shift when we switch source-of-truth)
      * ``type``         ← ``connection_type``
      * ``command/args`` ← ``shlex.split(start_command)`` then ${VAR}
        substitution per :mod:`app.agent.mcp.config` so seeded
        templates like ``${NPX}`` resolve to the live binary path
      * ``url``          ← ``service_url``
      * ``env``          ← decrypted ``env_config`` JSON dict, plus
        external-connection injection (per ``env_config.connection_id``)
        and auth-header injection per ``auth_type``

    External-connection binding:
      If env_config carries ``connection_id`` (a code referencing
      ``mcp_external_connections``), this function will:
        1. Look up the connection (must exist, enabled, non-deleted);
        2. Decrypt secret_json + assemble config_json / allowed_scopes;
        3. Inject the resulting env vars per :func:`_inject_connection_env`;
        4. Drop ``connection_id`` from the subprocess env (it's an
           internal binding key, not a runtime variable).

      Servers whose ``start_command`` matches the needs-connection list
      (storage-s3, github, slack, postgres) MUST have a connection_id;
      otherwise this raises :class:`MCPConnectionError` and the runtime
      pool skips the server.

    Legacy-secret guard:
      Any forbidden env field (AWS_*, *_TOKEN, *_PASSWORD …) found in
      env_config raises immediately — even though P2 blocks new writes
      at the save path, old rows might carry stale credentials.

    Raises:
      * :exc:`app.services.encryption.SecretKeyMissing` if
        ``GOKU_SECRET_KEY`` isn't configured and the row carries
        ciphertext.
      * :exc:`app.services.mcp_external_connections.MCPConnectionError`
        when the bound connection is missing / disabled / mistyped or
        env_config contains forbidden secret fields.
    """
    # Local imports — these modules might import back into us via the
    # service registry, so defer to function scope.
    from app.agent.mcp.config import _build_substitutions, _interpolate
    from app.services.mcp_external_connections import (
        MCPConnectionError,
        get_decrypted_connection_for_runtime,
    )
    from app.services.mcp_servers import (
        FORBIDDEN_ENV_CONFIG_FIELDS,
        _needs_connection,
    )

    subs = _build_substitutions()

    parts = shlex.split(server.start_command) if server.start_command else []
    parts = [_interpolate(p, subs) for p in parts]
    command = parts[0] if parts else ""
    args = parts[1:]

    # env block: stdio gets these as subprocess env, SSE/HTTP as
    # request headers (client.py's existing convention).
    env: Dict[str, str] = {}
    if server.env_config:
        plain = encryption.decrypt_secret(server.env_config)
        if plain:
            try:
                parsed = json.loads(plain)
                if isinstance(parsed, dict):
                    # Interpolate ${VAR} tokens in values the same way
                    # start_command parts are interpolated above — otherwise
                    # things like AIOS_BACKEND_ENV=${BACKEND_ENV} reach the
                    # subprocess as the literal string "${BACKEND_ENV}" and
                    # the server can't locate its .env (silently fails to
                    # bootstrap DATABASE_URL etc.). Keys stay literal.
                    env = {str(k): _interpolate(str(v), subs) for k, v in parsed.items()}
            except json.JSONDecodeError:
                # Corrupt env JSON — log + start with empty env. Better
                # to attempt connection without env than to fail the
                # whole runtime load over one bad row.
                logger.warning(
                    "MCP server %s: env_config decrypted but is not valid JSON; "
                    "skipping env block",
                    server.code,
                )

    # Legacy-secret guard. Forbidden = anything the per-type connection
    # injector OWNS. Surfacing as a structured error tells the operator
    # exactly what to migrate, with no secret values leaking into logs.
    leaked = sorted({k for k in env if k.upper() in FORBIDDEN_ENV_CONFIG_FIELDS})
    if leaked:
        raise MCPConnectionError(
            "MCP_ENV_SECRET_FIELD_NOT_ALLOWED",
            f"MCP Server「{server.code}」的环境变量中含有不允许的密钥字段:"
            f"{'、'.join(leaked)}。这些字段应该通过「绑定外部连接」管理,"
            f"请编辑该 MCP Server 清理环境变量并绑定对应的外部连接。",
        )

    # External-connection bindings. Both keys are internal (subprocess
    # env should never see them) — pop both before any further use.
    conn_code = env.pop("connection_id", None)
    server_auth_code = env.pop("server_auth_connection_id", None)
    required_type = _needs_connection(server.start_command)
    if required_type and not conn_code:
        raise MCPConnectionError(
            "MCP_CONNECTION_REQUIRED",
            f"MCP Server「{server.code}」必须绑定 {required_type} 类型的外部连接才能启动。"
            f"请点击「编辑连接配置」在「绑定外部连接」下拉中选择对应连接;"
            f"如果还没有,请先到「MCP 管理 → 外部连接管理」创建。",
        )
    if (conn_code or server_auth_code) and db is None:
        # All known callers pass db; surface the missing arg rather than
        # silently skipping injection.
        raise MCPConnectionError(
            "MCP_CONNECTION_CONFIG_INVALID",
            f"内部错误:解析 MCP Server「{server.code}」的外部连接时数据库会话不可用,"
            f"请联系管理员。",
        )
    if conn_code:
        # get_decrypted_connection_for_runtime: existence + enabled +
        # not-deleted + secret-decrypt + audit-log. Raises MCPConnectionError
        # on any failure path; type mismatch is caught by `_inject_connection_env`.
        conn = get_decrypted_connection_for_runtime(db, conn_code)
        if required_type and conn["connection_type"] != required_type:
            raise MCPConnectionError(
                "MCP_CONNECTION_TYPE_UNSUPPORTED",
                f"MCP Server「{server.code}」需要 {required_type} 类型的外部连接,"
                f"但「{conn_code}」是 {conn['connection_type']} 类型。"
                f"请重新选择匹配类型的连接。",
            )
        _inject_connection_env(env, conn)
    if server_auth_code:
        # Goku → MCP server endpoint authentication. Reuses the `url`
        # external-connection type since that already carries an
        # `authorization_header` secret field; we just borrow it and write
        # an Authorization env var that http/sse clients pick up.
        auth_conn = get_decrypted_connection_for_runtime(db, server_auth_code)
        if auth_conn["connection_type"] != "url":
            raise MCPConnectionError(
                "MCP_CONNECTION_TYPE_UNSUPPORTED",
                f"MCP Server「{server.code}」的「MCP Server 调用鉴权」必须是 url 类型外部连接,"
                f"但「{server_auth_code}」是 {auth_conn['connection_type']} 类型。",
            )
        header = (auth_conn.get("secret") or {}).get("authorization_header")
        if not header:
            raise MCPConnectionError(
                "MCP_CONNECTION_SECRET_MISSING",
                f"外部连接「{server_auth_code}」没有配置 authorization_header,"
                f"无法用于「MCP Server 调用鉴权」。请到「外部连接管理」补全该字段。",
            )
        env["Authorization"] = str(header)

    # Built-in Goku MCP servers launch as ``<venv python> -m app.<module>``.
    # Such a subprocess needs ``backend/`` on its import path to resolve the
    # ``app`` package. That path is pure infrastructure — never something an
    # admin should hand-set — so inject it here instead of carrying it in
    # env_config. ``setdefault`` so an explicit env_config override still wins.
    if "-m" in args and any(a.startswith("app.") for a in args):
        env.setdefault("PYTHONPATH", subs["BACKEND_DIR"])

    # Legacy auth_secret path: deprecated by P8 (Goku → MCP server
    # authentication now lives in mcp_external_connections via
    # env_config.server_auth_connection_id). Rows that still carry a
    # raw auth_secret + auth_type get a one-time warning so the operator
    # knows to migrate, but we no longer inject anything from them —
    # per the "no backward-compat" stance.
    if server.auth_secret and not server_auth_code:
        logger.warning(
            "MCP server %s has legacy auth_secret set but no "
            "env_config.server_auth_connection_id — migrate this row to the "
            "external-connection (url type) flow; the legacy secret is "
            "being ignored at runtime",
            server.code,
        )

    # Note: ``allow_agent_auto_invoke`` is intentionally NOT propagated
    # into the dataclass here. The upstream MCPServerConfig has no such
    # field today; the per-server "let agents auto-invoke without
    # approval" gate is a separate concern wired through
    # ``MCPToolWrapper`` and the approval pipeline — a follow-up Task.
    # The DB column stays the source of truth so future code can pick
    # it up without another schema change.
    return MCPServerConfig(
        name=server.code,
        type=server.connection_type,
        command=command,
        args=args,
        env=env,
        url=server.service_url or "",
    )


def _inject_connection_env(env: Dict[str, str], conn: Dict[str, Any]) -> None:
    """Map a decrypted external connection into MCP-server env vars.

    Receives the dict returned by
    :func:`mcp_external_connections.get_decrypted_connection_for_runtime`
    (already-decrypted ``secret``, ``config``, ``allowed_scopes``,
    ``connection_type``). Mutates ``env`` in place.

    Per-type rules follow the spec section 六:

      s3
        AWS_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (required)
        S3_ENDPOINT_URL / S3_FORCE_PATH_STYLE (optional)
        S3_ALLOWED_BUCKETS / S3_ALLOWED_PREFIXES (from allowed_scopes)
        S3_BUCKET (only if exactly one allowed_bucket — single-bucket
                   convenience; do NOT auto-pick when multiple buckets)

      sftp
        SFTP_HOST / SFTP_PORT / SFTP_USERNAME / SFTP_AUTH_TYPE
        SFTP_PASSWORD or SFTP_PRIVATE_KEY (+ SFTP_PRIVATE_KEY_PASSPHRASE)
        SFTP_ALLOWED_PATHS

      url
        URL_ALLOWED_DOMAINS / URL_AUTHORIZATION_HEADER
        URL_TIMEOUT_SECONDS / URL_MAX_DOWNLOAD_SIZE / URL_DENY_PRIVATE_IP

      local_path
        LOCAL_ALLOWED_DIRS

      database
        DB_TYPE / DB_HOST / DB_PORT / DB_NAME / DB_USERNAME / DB_PASSWORD
        DB_READ_ONLY / DB_ALLOWED_TABLES

      github
        GITHUB_TOKEN / GITHUB_API_BASE_URL
        GITHUB_ALLOWED_ORGS / GITHUB_ALLOWED_REPOS
        Also writes GITHUB_PERSONAL_ACCESS_TOKEN — the official Anthropic
        MCP server reads that name.

      slack
        SLACK_BOT_TOKEN / SLACK_WORKSPACE / SLACK_ALLOWED_CHANNELS

    All values stringified (subprocess env requires str). Missing
    optional fields are simply not injected. Required-field absence
    raises :class:`MCPConnectionError` with code
    ``MCP_CONNECTION_SECRET_MISSING`` or ``MCP_CONNECTION_CONFIG_INVALID``.
    """
    from app.services.mcp_external_connections import MCPConnectionError

    cfg: Dict[str, Any] = conn.get("config") or {}
    sec: Dict[str, Any] = conn.get("secret") or {}
    scopes: Dict[str, Any] = conn.get("allowed_scopes") or {}
    ctype = conn.get("connection_type")
    code = conn.get("code", "?")

    def _set(name: str, value: Any) -> None:
        if value is None:
            return
        if isinstance(value, bool):
            env[name] = "true" if value else "false"
        elif isinstance(value, (list, tuple)):
            env[name] = ",".join(str(v) for v in value if v not in (None, ""))
        else:
            s = str(value)
            if s != "":
                env[name] = s

    def _require_secret(*keys: str) -> None:
        missing = [k for k in keys if not sec.get(k)]
        if missing:
            raise MCPConnectionError(
                "MCP_CONNECTION_SECRET_MISSING",
                f"外部连接「{code}」缺少必需的密钥字段:{'、'.join(missing)}。"
                f"请到「MCP 管理 → 外部连接管理」编辑该连接并补全密钥。",
            )

    def _require_config(*keys: str) -> None:
        missing = [k for k in keys if cfg.get(k) in (None, "")]
        if missing:
            raise MCPConnectionError(
                "MCP_CONNECTION_CONFIG_INVALID",
                f"外部连接「{code}」缺少必需的配置字段:{'、'.join(missing)}。"
                f"请到「MCP 管理 → 外部连接管理」编辑该连接并补全配置。",
            )

    if ctype == "s3":
        _require_secret("aws_access_key_id", "aws_secret_access_key")
        _require_config("region")
        _set("AWS_REGION", cfg.get("region"))
        _set("AWS_ACCESS_KEY_ID", sec.get("aws_access_key_id"))
        _set("AWS_SECRET_ACCESS_KEY", sec.get("aws_secret_access_key"))
        _set("AWS_SESSION_TOKEN", sec.get("aws_session_token"))
        _set("S3_ENDPOINT_URL", cfg.get("endpoint_url"))
        _set("S3_FORCE_PATH_STYLE", cfg.get("force_path_style"))
        allowed_buckets = scopes.get("allowed_buckets") or []
        _set("S3_ALLOWED_BUCKETS", allowed_buckets)
        _set("S3_ALLOWED_PREFIXES", scopes.get("allowed_prefixes") or [])
        # Single-bucket convenience: only when exactly one allowed bucket
        # is configured. With multiple buckets the calling logic must
        # decide explicitly which one to use; auto-picking would be a
        # surprising authorization escape.
        if isinstance(allowed_buckets, (list, tuple)) and len(allowed_buckets) == 1:
            _set("S3_BUCKET", allowed_buckets[0])
        return

    if ctype == "sftp":
        _require_config("host", "username")
        auth_type = (cfg.get("auth_type") or "password").lower()
        if auth_type == "password":
            _require_secret("password")
        elif auth_type == "key":
            _require_secret("private_key")
        _set("SFTP_HOST", cfg.get("host"))
        _set("SFTP_PORT", cfg.get("port") or 22)
        _set("SFTP_USERNAME", cfg.get("username"))
        _set("SFTP_AUTH_TYPE", auth_type)
        _set("SFTP_PASSWORD", sec.get("password"))
        _set("SFTP_PRIVATE_KEY", sec.get("private_key"))
        _set("SFTP_PRIVATE_KEY_PASSPHRASE", sec.get("private_key_passphrase"))
        _set("SFTP_ALLOWED_PATHS", scopes.get("allowed_paths") or [])
        return

    if ctype == "url":
        _set("URL_ALLOWED_DOMAINS", scopes.get("allowed_domains") or [])
        _set("URL_AUTHORIZATION_HEADER", sec.get("authorization_header"))
        _set("URL_TIMEOUT_SECONDS", cfg.get("timeout_seconds"))
        _set("URL_MAX_DOWNLOAD_SIZE", cfg.get("max_download_size"))
        # Default to denying private IPs unless explicitly overridden —
        # SSRF defence in depth. allowed_scopes.allow_private_ip=true
        # turns it off for the narrow case of intentional intranet calls.
        deny = not bool(scopes.get("allow_private_ip", False))
        _set("URL_DENY_PRIVATE_IP", deny)
        return

    if ctype == "local_path":
        _set("LOCAL_ALLOWED_DIRS", scopes.get("allowed_dirs") or [])
        return

    if ctype == "database":
        # DB name may arrive as `database` (the key the mcp_connection_admin tool
        # spec documents) or `name`; accept either so the tool contract and this
        # runtime can't drift apart. Mirrors the same fix in goku-core's
        # mcp_runtime.py — keep both copies in sync.
        db_name = cfg.get("database") or cfg.get("name")
        _require_config("db_type", "host", "username")
        if not db_name:
            raise MCPConnectionError(
                "MCP_CONNECTION_CONFIG_INVALID",
                f"外部连接「{code}」缺少必需的配置字段:database。"
                f"请到「MCP 管理 → 外部连接管理」编辑该连接并补全配置。",
            )
        _require_secret("password")
        _set("DB_TYPE", cfg.get("db_type"))
        _set("DB_HOST", cfg.get("host"))
        _set("DB_PORT", cfg.get("port"))
        _set("DB_NAME", db_name)
        _set("DB_USERNAME", cfg.get("username"))
        _set("DB_PASSWORD", sec.get("password"))
        # read_only lives in allowed_scopes (alongside allowed_tables), where
        # the UI puts it — NOT in config. Default True: a missing flag locks
        # down rather than silently allowing writes.
        _set("DB_READ_ONLY", scopes.get("read_only", True))
        _set("DB_ALLOWED_TABLES", scopes.get("allowed_tables") or [])
        return

    if ctype == "github":
        _require_secret("token")
        _set("GITHUB_TOKEN", sec.get("token"))
        # The official @modelcontextprotocol/server-github expects this
        # env name; write both so the connection works with either the
        # built-in style or the upstream package without re-mapping.
        _set("GITHUB_PERSONAL_ACCESS_TOKEN", sec.get("token"))
        _set("GITHUB_API_BASE_URL", cfg.get("api_base_url"))
        _set("GITHUB_ALLOWED_ORGS", scopes.get("allowed_orgs") or [])
        _set("GITHUB_ALLOWED_REPOS", scopes.get("allowed_repos") or [])
        return

    if ctype == "slack":
        _require_secret("bot_token")
        _set("SLACK_BOT_TOKEN", sec.get("bot_token"))
        _set("SLACK_WORKSPACE", cfg.get("workspace"))
        _set("SLACK_ALLOWED_CHANNELS", scopes.get("allowed_channels") or [])
        return

    raise MCPConnectionError(
        "MCP_CONNECTION_TYPE_UNSUPPORTED",
        f"外部连接「{code}」的类型 {ctype} 暂不支持运行时注入。"
        f"当前支持类型:s3 / sftp / url / local_path / database / github / slack。",
    )


def load_active_runtime_configs(db: Session) -> Dict[str, MCPServerConfig]:
    """Build the ``{code: config}`` dict for all servers the runtime
    should currently connect to.

    Filter: ``status='enabled'`` AND ``deleted_at IS NULL``. Any row
    that fails to decrypt / parse is skipped with a warning — one
    broken server must not stop the rest of the runtime.
    """
    servers = (
        db.query(MCPServer)
        .filter(MCPServer.status == "enabled")
        .filter(MCPServer.deleted_at.is_(None))
        .order_by(MCPServer.code)
        .all()
    )
    out: Dict[str, MCPServerConfig] = {}
    for s in servers:
        try:
            out[s.code] = build_runtime_config(s, db)
        except encryption.SecretKeyMissing:
            # Loud at runtime — GOKU_SECRET_KEY is missing but a row
            # needs decryption. Don't swallow; re-raise so the operator
            # notices instead of silently running with fewer servers.
            raise
        except Exception as e:
            logger.warning(
                "MCP runtime: skipping server %s: failed to build config: %s",
                s.code, e,
            )
    return out


def get_active_runtime_configs() -> Dict[str, MCPServerConfig]:
    """Like :func:`load_active_runtime_configs` but opens / closes its
    own :class:`SessionLocal`.

    Used by code paths outside a request scope — registry init at
    backend startup, refresh hooks after server CRUD.
    """
    from app.db import SessionLocal
    db = SessionLocal()
    try:
        return load_active_runtime_configs(db)
    finally:
        db.close()


# ─── Connection probing ────────────────────────────────────────────────

@dataclass
class ProbeResult:
    """Outcome of one :func:`probe_connection` call.

    ``status`` follows the same vocabulary as
    ``MCPServer.health_status`` (``normal`` / ``abnormal``). ``error_type``
    is one of the classifiers when the probe fails:
    ``unreachable / auth_failed / timeout / protocol_mismatch /
    discovery_failed / upstream_error / unknown``. ``upstream_error`` is a
    5xx from the remote server; ``unknown`` is used when the cause can't be
    determined (rather than mislabelling it ``protocol_mismatch``). The
    probe always returns within ``timeout`` seconds (caller-controlled) —
    failures don't hang the request.
    """
    status: str                 # 'normal' | 'abnormal'
    response_time_ms: int
    capabilities_discovered: int
    error_type: Optional[str]
    error_message: Optional[str]


# Heuristic strings that lift a free-text error into one of the spec's
# error_type classifiers. Order matters — more specific first.
_AUTH_TOKENS = ("401", "403", "unauthorized", "forbidden", "auth")
_TIMEOUT_TOKENS = ("timed out", "timeout")
_UNREACHABLE_TOKENS = ("not found", "no such file", "connection refused",
                       "could not connect", "name or service not known")
_DISCOVERY_TOKENS = ("list_tools", "discover", "tools/list", "method not found")


# Exception types/messages that are pure async-teardown noise: anyio /
# asyncio cancel sibling tasks the moment one fails, and unwinding the MCP
# SDK's nested task groups + async generators throws a flurry of secondary
# errors (CancelledError, WouldBlock, GeneratorExit, "cancel scope in a
# different task", "async generator already running"). These mask the REAL
# cause (e.g. a 401) — letting one win is exactly how a 401 surfaced as
# ``protocol_mismatch`` / "Cancelled via cancel scope". Never pick one when
# a real leaf exists.
_NOISE_MESSAGE_TOKENS = (
    "cancel scope",
    "asynchronous generator is already running",
    "async generator is already running",
    "generator didn't stop",
)


def _is_cancel_noise(exc: BaseException) -> bool:
    if isinstance(exc, (asyncio.CancelledError, GeneratorExit)):
        return True
    name = type(exc).__name__
    # anyio internal stream-state signals carry no diagnostic value.
    if name in ("WouldBlock", "EndOfStream", "ClosedResourceError",
                "BrokenResourceError"):
        return True
    msg = (str(exc) or "").lower()
    return any(tok in msg for tok in _NOISE_MESSAGE_TOKENS)


def _iter_leaves(exc: BaseException, _depth: int = 0,
                 _seen: Optional[set] = None):
    """Yield every leaf exception reachable from ``exc``.

    Flattens nested ``ExceptionGroup``s (anyio / TaskGroup) and follows
    BOTH the ``__cause__`` AND ``__context__`` chains — the MCP SDK's
    teardown buries the real transport failure (e.g. a 401
    ``httpx.HTTPStatusError``) on a different branch than the
    CancelledError that ends up on top, so following only one link misses
    it. Bounded depth + id-dedup guard against cycles.
    """
    if _seen is None:
        _seen = set()
    if exc is None or id(exc) in _seen or _depth > 40:
        return
    _seen.add(id(exc))
    subs = getattr(exc, "exceptions", None)  # ExceptionGroup / BaseExceptionGroup
    if subs:
        for sub in subs:
            yield from _iter_leaves(sub, _depth + 1, _seen)
    else:
        yield exc
    for link in ("__cause__", "__context__"):
        nxt = getattr(exc, link, None)
        if nxt is not None:
            yield from _iter_leaves(nxt, _depth + 1, _seen)


def _http_status(exc: BaseException) -> Optional[int]:
    """The HTTP status code carried by an exception, if any.

    Works for httpx / requests-style errors that expose
    ``.response.status_code`` (e.g. ``httpx.HTTPStatusError`` on a 401).
    """
    resp = getattr(exc, "response", None)
    code = getattr(resp, "status_code", None)
    return code if isinstance(code, int) else None


def _classify_http_status(code: int, msg: str) -> tuple[str, str]:
    """Map a concrete HTTP status onto an error_type. The status is the
    strongest signal we get — always surface the code in the message."""
    if code in (401, 403, 407):
        return "auth_failed", f"HTTP {code}: {msg}"
    if code == 404:
        return "unreachable", f"HTTP {code}: {msg}"
    if code >= 500:
        return "upstream_error", f"HTTP {code}: {msg}"
    return "protocol_mismatch", f"HTTP {code}: {msg}"


def _classify_probe_error(exc: BaseException) -> tuple[str, str]:
    """Map an exception raised during ``probe_connection`` into an
    ``(error_type, message)`` pair.

    Flattens the ``ExceptionGroup`` the MCP SDK raises (via anyio
    TaskGroups), follows cause/context chains, then classifies the most
    INFORMATIVE leaf — never a bare cancellation, which is just teardown
    noise from sibling tasks. An explicit HTTP status wins outright. When
    the only thing left is cancellation noise we say so honestly (type
    ``unknown``) instead of inventing a misleading ``protocol_mismatch``.
    """
    leaves = list(_iter_leaves(exc)) or [exc]
    informative = [e for e in leaves if not _is_cancel_noise(e)]

    # 1) A concrete HTTP status is the clearest cause (e.g. 401 → auth).
    for e in informative:
        code = _http_status(e)
        if code is not None:
            return _classify_http_status(code, str(e) or type(e).__name__)

    # 2) Type / free-text heuristics over real leaves (cancellation noise
    #    only as a last resort, so its useless text never masks a real one).
    for e in informative or leaves:
        msg = str(e) or type(e).__name__
        low = msg.lower()
        if isinstance(e, (asyncio.TimeoutError, TimeoutError)):
            return "timeout", "Connection probe timed out"
        if isinstance(e, FileNotFoundError):
            return "unreachable", f"Executable / path not found: {msg}"
        if isinstance(e, ConnectionError):
            return "unreachable", msg
        if any(tok in low for tok in _TIMEOUT_TOKENS):
            return "timeout", msg
        if any(tok in low for tok in _AUTH_TOKENS):
            return "auth_failed", msg
        if any(tok in low for tok in _UNREACHABLE_TOKENS):
            return "unreachable", msg
        if any(tok in low for tok in _DISCOVERY_TOKENS):
            return "discovery_failed", msg

    # 3) Nothing classified. Surface the real leaf raw rather than guess.
    if informative:
        e = informative[0]
        return "unknown", f"{type(e).__name__}: {str(e) or '(no message)'}"
    # Only cancellation noise reached us — be honest about it.
    return "unknown", (
        f"Probe interrupted with no explicit error ({str(leaves[0])[:160]}); "
        "upstream likely returned a non-MCP response (4xx/5xx or a redirect)."
    )


def _http_fallback_diagnosis_sync(
    url: str, headers: Dict[str, str], timeout: float,
) -> Optional[tuple[str, str]]:
    """Synchronous raw HTTP probe — replays the MCP ``initialize`` POST and
    reads the real status line / redirect. Runs in a worker thread (see
    :func:`_http_fallback_diagnosis`) so it is immune to the corrupted
    asyncio cancel-scope state the failed SDK handshake leaves behind.
    """
    try:
        import httpx
        body = {
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26", "capabilities": {},
                "clientInfo": {"name": "goku-probe", "version": "0"},
            },
        }
        hdrs = dict(headers or {})
        hdrs.setdefault("Accept", "application/json, text/event-stream")
        hdrs.setdefault("Content-Type", "application/json")
        # follow_redirects=False on purpose: a 3xx here is itself the
        # diagnosis (e.g. a missing trailing slash bouncing /mcp → /mcp/).
        with httpx.Client(timeout=min(timeout, 15.0),
                          follow_redirects=False) as client:
            resp = client.post(url, json=body, headers=hdrs)
        code = resp.status_code
        snippet = (resp.text or "").strip().replace("\n", " ")[:160]
        if 300 <= code < 400:
            loc = resp.headers.get("location", "?")
            return "protocol_mismatch", (
                f"HTTP {code} redirect → {loc}. The MCP client does not follow "
                f"redirects; point service_url straight at the final endpoint "
                f"(a missing trailing '/' is the usual cause)."
            )
        if code >= 400:
            return _classify_http_status(code, snippet or f"HTTP {code}")
        # 2xx but the SDK handshake still failed — genuinely a protocol issue.
        return "protocol_mismatch", (
            f"Endpoint returned HTTP {code} but the MCP handshake failed; "
            f"it may not speak Streamable HTTP. Body: {snippet}"
        )
    except Exception as e:  # fallback must never raise
        logger.debug("http fallback diagnosis failed: %s", e)
        return None


async def _http_fallback_diagnosis(
    config: MCPServerConfig, *, timeout: float,
) -> Optional[tuple[str, str]]:
    """Best-effort raw HTTP probe for ``http`` servers, used only when the
    MCP handshake failed without surfacing a real cause.

    The Streamable HTTP SDK runs its transport in a nested anyio task group
    and exits it lazily, so an HTTP-level rejection (e.g. 401) raised inside
    that task is swallowed during teardown and never reaches the caller —
    all we get is ``CancelledError``. To still tell the operator WHY, we
    replay the ``initialize`` POST directly. The actual request runs in a
    worker thread because the failed handshake corrupts this task's
    cancel-scope state, which would otherwise cancel any further ``await``.
    Returns an ``(error_type, message)`` pair, or ``None``.
    """
    if config.type != "http" or not config.url:
        return None
    try:
        return await asyncio.to_thread(
            _http_fallback_diagnosis_sync, config.url, config.env or {}, timeout,
        )
    except Exception as e:
        logger.debug("http fallback diagnosis dispatch failed: %s", e)
        return None


async def _diagnose_connect_error(
    config: MCPServerConfig, exc: BaseException, *, timeout: float,
) -> tuple[str, str]:
    """Classify a failed MCP connect and, for opaque HTTP failures, replay
    a raw initialize request to recover the real upstream status.
    """
    err_type, err_msg = _classify_probe_error(exc)
    if err_type in ("unknown", "protocol_mismatch"):
        fallback = await _http_fallback_diagnosis(config, timeout=timeout)
        if fallback is not None:
            err_type, err_msg = fallback
    return err_type, err_msg


def _diagnose_connect_error_sync(
    config: MCPServerConfig, exc: BaseException, *, timeout: float,
) -> tuple[str, str]:
    """Synchronous variant for paths whose asyncio task may already be
    poisoned by the Streamable HTTP client's cancel-scope teardown.
    """
    err_type, err_msg = _classify_probe_error(exc)
    if err_type in ("unknown", "protocol_mismatch") and config.type == "http" and config.url:
        fallback = _http_fallback_diagnosis_sync(
            config.url, config.env or {}, timeout,
        )
        if fallback is not None:
            err_type, err_msg = fallback
    return err_type, err_msg


async def probe_connection(
    config: MCPServerConfig,
    *,
    timeout: float = 30.0,
) -> ProbeResult:
    """Open a one-off MCP connection to ``config``, exercise the
    handshake + discovery, then close.

    Independent of the live ``MCPClientManager`` pool — the probe
    spins up its own subprocess / SSE stream so it works on
    not-yet-enabled servers too. Always returns a :class:`ProbeResult`;
    exceptions are caught and classified.

    The handshake runs in a throwaway event loop on a worker thread. The
    MCP Streamable HTTP transport exits its nested anyio task group from a
    different task than it entered, which corrupts the *calling* task's
    cancel-scope state on failure — every subsequent ``await`` (including
    the HTTP fallback diagnosis) would then immediately raise
    ``CancelledError``. Isolating the connect in its own loop keeps that
    damage off the request task. This also mirrors how the live
    ``MCPClientManager`` runs connects on a dedicated background loop.
    """
    started = time.monotonic()

    def _run_connect() -> int:
        async def _inner() -> int:
            conn = MCPServerConnection(config)
            try:
                await asyncio.wait_for(conn.connect(), timeout=timeout)
                return len(conn.capabilities)
            finally:
                try:
                    await conn.disconnect()
                except Exception as e:
                    logger.debug("probe_connection: disconnect cleanup error: %s", e)
        return asyncio.run(_inner())

    try:
        capability_count = await asyncio.to_thread(_run_connect)
        elapsed_ms = int((time.monotonic() - started) * 1000)
        return ProbeResult(
            status="normal",
            response_time_ms=elapsed_ms,
            capabilities_discovered=capability_count,
            error_type=None,
            error_message=None,
        )
    except BaseException as exc:
        elapsed_ms = int((time.monotonic() - started) * 1000)
        err_type, err_msg = await _diagnose_connect_error(
            config, exc, timeout=timeout,
        )
        return ProbeResult(
            status="abnormal",
            response_time_ms=elapsed_ms,
            capabilities_discovered=0,
            error_type=err_type,
            error_message=err_msg,
        )


# ─── Capability sync ───────────────────────────────────────────────────

@dataclass
class CapabilityBucketResult:
    """Per-bucket sync counts. ``ok=False`` means we failed to even
    enumerate the upstream side (server doesn't speak that capability
    type, or it errored mid-discovery). When ``ok=False`` the counts
    stay 0.

    ``kind`` is one of ``'capabilities' | 'resources' | 'prompts'``.
    Note: "capabilities" here refers to MCP's executable endpoints
    (what the MCP spec calls "tools") — Goku names them this way to
    avoid colliding with the platform's AI Tool registry.
    """
    kind: str                   # 'capabilities' | 'resources' | 'prompts'
    ok: bool
    error: Optional[str]
    added: int = 0
    updated: int = 0
    synced: int = 0
    removed: int = 0


@dataclass
class SyncResult:
    """Full ``POST /sync`` outcome. ``status`` aggregates the three
    per-bucket ok flags into one stable code:

      - ``success``         — all three succeeded (including "empty set"
                              counts as success)
      - ``partial_success`` — at least one succeeded, at least one failed
      - ``failed``          — none succeeded (or the initial connection
                              never came up)

    ``synced_at`` mirrors ``mcp_servers.last_synced_at`` for the caller's
    convenience.
    """
    status: str
    capabilities: CapabilityBucketResult
    resources: CapabilityBucketResult
    prompts: CapabilityBucketResult
    synced_at: datetime
    error_type: Optional[str] = None
    error_message: Optional[str] = None


def _attr(obj: object, name: str, default=None):
    """Pull a field off an MCP SDK object regardless of whether it's a
    Pydantic model or a plain dataclass. Returns ``default`` for None."""
    v = getattr(obj, name, default)
    return v if v is not None else default


def _server_supports(conn: MCPServerConnection, feature: str) -> bool:
    """True when the upstream server advertised ``feature`` during the
    MCP ``initialize`` handshake.

    ``feature`` is one of ``'tools' / 'resources' / 'prompts' / 'logging'``.
    The MCP spec says clients SHOULD NOT call ``<feature>/list`` methods
    when the server hasn't advertised the corresponding capability —
    doing so produces -32601 noise and creates the misleading impression
    of a partial-failure sync.

    Falls back to ``True`` if we can't read the capabilities (e.g. older
    SDK, attribute moved) — we'd rather try and Method-not-found-catch
    than silently skip a supported feature.
    """
    try:
        caps = getattr(conn.session, "_server_capabilities", None)
        if caps is None:
            return True
        v = getattr(caps, feature, None)
        return v is not None
    except Exception:
        return True


def _is_method_not_found(exc: BaseException) -> bool:
    """True when an exception from an MCP SDK call signals JSON-RPC
    ``-32601 Method not found``.

    Many servers omit ``resources/list`` or ``prompts/list`` entirely.
    The SDK surfaces that as ``McpError`` with ``error.code = -32601``
    (constant ``METHOD_NOT_FOUND`` in ``mcp.types``). Treating it as a
    sync failure mis-classifies fully-working servers as partial_success.

    Falls back to a substring match against ``str(exc)`` so we still
    classify correctly even when the SDK version doesn't ship McpError
    in the expected location.
    """
    try:
        from mcp.shared.exceptions import McpError
        from mcp.types import METHOD_NOT_FOUND
        if isinstance(exc, McpError):
            code = getattr(getattr(exc, "error", None), "code", None)
            if code == METHOD_NOT_FOUND:
                return True
    except Exception:
        pass
    return "method not found" in str(exc).lower()


async def _sync_capabilities(
    db: Session, server: MCPServer, conn: MCPServerConnection,
) -> CapabilityBucketResult:
    """Diff upstream MCP capabilities (executable endpoints) against
    ``mcp_capabilities`` and apply the delta.

    Match key: ``capability_name`` within ``server_id`` (unique
    constraint). Lifecycle is tracked by the ``status`` column
    (active / inactive), NOT a ``deleted_at`` column:

      - upstream has, DB doesn't                → INSERT (added)
      - upstream has, DB has same content       → touch last_synced_at
                                                  (synced)
      - upstream has, DB has different content  → UPDATE description /
                                                  input_schema (updated)
      - upstream has, DB has it as 'inactive'   → flip back to 'active',
                                                  refresh content (added,
                                                  counts as a re-add)
      - upstream lacks, DB has as 'active'      → flip to 'inactive'
                                                  (removed)
      - upstream lacks, DB has as 'inactive'    → no-op (already gone)
    """
    try:
        upstream = await conn.session.list_tools()
        items = list(upstream.tools)
    except Exception as e:
        return CapabilityBucketResult(kind="capabilities", ok=False, error=str(e))

    by_name_upstream = {t.name: t for t in items}
    # Pull EVERY row (including 'removed') so re-adds upsert correctly
    # — unique constraint is (server_id, capability_name).
    existing = (
        db.query(MCPCapability)
        .filter(MCPCapability.server_id == server.id)
        .all()
    )
    by_name_db = {c.capability_name: c for c in existing}

    added = updated = synced = removed = 0
    now = datetime.utcnow()

    for name, t in by_name_upstream.items():
        desc = _attr(t, "description", "") or ""
        schema = _attr(t, "inputSchema", {}) or {}
        row = by_name_db.get(name)
        if row is None:
            db.add(MCPCapability(
                id=str(uuid.uuid4()),
                server_id=server.id,
                capability_name=name,
                description=desc,
                input_schema=schema,
                output_schema=None,
                status="active",
                last_synced_at=now,
                created_at=now,
                updated_at=now,
            ))
            added += 1
        elif row.status == "inactive":
            # Re-add of a previously-inactive capability. Refresh content
            # and flip back to active. Counts as an "added" delta from
            # the admin's POV.
            row.status = "active"
            row.description = desc
            row.input_schema = schema
            row.last_synced_at = now
            row.updated_at = now
            added += 1
        elif (row.description or "") != desc or (row.input_schema or {}) != schema:
            row.description = desc
            row.input_schema = schema
            row.last_synced_at = now
            row.updated_at = now
            updated += 1
        else:
            row.last_synced_at = now
            synced += 1

    for name, row in by_name_db.items():
        if name not in by_name_upstream and row.status == "active":
            row.status = "inactive"
            row.updated_at = now
            removed += 1

    db.commit()
    return CapabilityBucketResult(
        kind="capabilities", ok=True, error=None,
        added=added, updated=updated, synced=synced, removed=removed,
    )


async def _sync_resources(
    db: Session, server: MCPServer, conn: MCPServerConnection,
) -> CapabilityBucketResult:
    """Diff upstream Resources against ``mcp_resources``. Match key:
    ``uri`` within ``server_id``.

    Protocol-compliant: only calls ``resources/list`` when the server
    advertised the ``resources`` capability during ``initialize``.
    Servers that don't advertise (e.g. tool-only servers like GitHub)
    are skipped with ``ok=True, synced=0`` — they have nothing to sync
    by definition.

    The Method-not-found catch is kept as a belt-and-suspenders for
    servers that advertise ``resources`` but reject the actual list
    call (broken upstream behavior).
    """
    if not _server_supports(conn, "resources"):
        return CapabilityBucketResult(
            kind="resources", ok=True, error=None,
            added=0, updated=0, synced=0, removed=0,
        )
    try:
        upstream = await conn.session.list_resources()
        items = list(upstream.resources)
    except Exception as e:
        if _is_method_not_found(e):
            return CapabilityBucketResult(
                kind="resources", ok=True, error=None,
                added=0, updated=0, synced=0, removed=0,
            )
        return CapabilityBucketResult(kind="resources", ok=False, error=str(e))

    by_uri_upstream = {str(_attr(r, "uri", "")): r for r in items if _attr(r, "uri", None)}
    existing = (
        db.query(MCPResource)
        .filter(MCPResource.server_id == server.id, MCPResource.deleted_at.is_(None))
        .all()
    )
    by_uri_db = {r.uri: r for r in existing}

    added = updated = synced = removed = 0
    now = datetime.utcnow()

    for uri, r in by_uri_upstream.items():
        name = _attr(r, "name", None)
        mime = _attr(r, "mimeType", None)
        desc = _attr(r, "description", None)
        row = by_uri_db.get(uri)
        if row is None:
            db.add(MCPResource(
                id=str(uuid.uuid4()),
                server_id=server.id,
                uri=uri,
                name=name,
                mime_type=mime,
                description=desc,
                created_at=now,
                updated_at=now,
            ))
            added += 1
        elif row.name != name or row.mime_type != mime or row.description != desc:
            row.name = name
            row.mime_type = mime
            row.description = desc
            row.updated_at = now
            updated += 1
        else:
            synced += 1

    for uri, row in by_uri_db.items():
        if uri not in by_uri_upstream:
            row.deleted_at = now
            removed += 1

    db.commit()
    return CapabilityBucketResult(
        kind="resources", ok=True, error=None,
        added=added, updated=updated, synced=synced, removed=removed,
    )


async def _sync_resource_templates(
    db: Session, server: MCPServer, conn: MCPServerConnection,
) -> CapabilityBucketResult:
    """Enumerate ``resources/templates/list`` from the upstream server.

    Resource templates are URI patterns (RFC 6570) the server can fill
    in at read time — e.g. ``file:///{path}``. They live under the same
    ``resources`` capability flag as concrete resources.

    Persistence is intentionally deferred: none of the MCP servers we
    currently integrate (GitHub / Memory / Filesystem / etc.) expose
    templates, so there's no schema yet for them. When a server that
    does expose templates lands, this function should be extended to
    persist into a new ``mcp_resource_templates`` table (or a
    ``is_template`` column on ``mcp_resources``). For now we honor the
    protocol — make the call if advertised, surface the count — but
    don't store.
    """
    if not _server_supports(conn, "resources"):
        return CapabilityBucketResult(
            kind="resource_templates", ok=True, error=None,
            added=0, updated=0, synced=0, removed=0,
        )
    try:
        upstream = await conn.session.list_resource_templates()
        items = list(upstream.resourceTemplates)
    except Exception as e:
        if _is_method_not_found(e):
            return CapabilityBucketResult(
                kind="resource_templates", ok=True, error=None,
                added=0, updated=0, synced=0, removed=0,
            )
        return CapabilityBucketResult(kind="resource_templates", ok=False, error=str(e))

    if items:
        logger.info(
            "mcp resource templates discovered (server=%s, count=%d) — persistence "
            "not yet implemented; first template uriTemplate=%r",
            server.code, len(items),
            getattr(items[0], "uriTemplate", None),
        )
    return CapabilityBucketResult(
        kind="resource_templates", ok=True, error=None,
        added=0, updated=0, synced=len(items), removed=0,
    )


async def _sync_prompts(
    db: Session, server: MCPServer, conn: MCPServerConnection,
) -> CapabilityBucketResult:
    """Diff upstream Prompts against ``mcp_prompts``. Match key:
    ``name`` within ``server_id``.

    Protocol-compliant: only calls ``prompts/list`` when the server
    advertised the ``prompts`` capability during ``initialize``.
    Method-not-found catch retained for misbehaving servers.
    """
    if not _server_supports(conn, "prompts"):
        return CapabilityBucketResult(
            kind="prompts", ok=True, error=None,
            added=0, updated=0, synced=0, removed=0,
        )
    try:
        upstream = await conn.session.list_prompts()
        items = list(upstream.prompts)
    except Exception as e:
        if _is_method_not_found(e):
            return CapabilityBucketResult(
                kind="prompts", ok=True, error=None,
                added=0, updated=0, synced=0, removed=0,
            )
        return CapabilityBucketResult(kind="prompts", ok=False, error=str(e))

    def _ser_args(p):
        # MCP's prompts return an arguments list; normalize to a list-
        # of-dicts for stable JSON comparison.
        out = []
        for a in (_attr(p, "arguments", []) or []):
            out.append({
                "name": _attr(a, "name", ""),
                "description": _attr(a, "description", None),
                "required": bool(_attr(a, "required", False)),
            })
        return out

    by_name_upstream = {p.name: p for p in items}
    existing = (
        db.query(MCPPrompt)
        .filter(MCPPrompt.server_id == server.id, MCPPrompt.deleted_at.is_(None))
        .all()
    )
    by_name_db = {p.name: p for p in existing}

    added = updated = synced = removed = 0
    now = datetime.utcnow()

    for name, p in by_name_upstream.items():
        desc = _attr(p, "description", None)
        args = _ser_args(p)
        row = by_name_db.get(name)
        if row is None:
            db.add(MCPPrompt(
                id=str(uuid.uuid4()),
                server_id=server.id,
                name=name,
                description=desc,
                arguments_json=args,
                created_at=now,
                updated_at=now,
            ))
            added += 1
        elif row.description != desc or (row.arguments_json or []) != args:
            row.description = desc
            row.arguments_json = args
            row.updated_at = now
            updated += 1
        else:
            synced += 1

    for name, row in by_name_db.items():
        if name not in by_name_upstream:
            row.deleted_at = now
            removed += 1

    db.commit()
    return CapabilityBucketResult(
        kind="prompts", ok=True, error=None,
        added=added, updated=updated, synced=synced, removed=removed,
    )


async def sync_capabilities(
    db: Session, server: MCPServer, *, timeout: float = 30.0,
) -> SyncResult:
    """Connect to ``server``, sync Capabilities / Resources / Prompts,
    return aggregated result.

    Independent of the live runtime pool. Each bucket is enumerated
    separately so one failing (e.g. server doesn't support resources)
    doesn't poison the rest. Aggregate status:
      - all three ``ok=True``  → ``success``
      - mixed                  → ``partial_success``
      - all ``ok=False``       → ``failed``
    """
    config = build_runtime_config(server, db)
    conn = MCPServerConnection(config)
    now = datetime.utcnow()

    try:
        await asyncio.wait_for(conn.connect(), timeout=timeout)
    except BaseException as e:
        err_type, err_msg = _diagnose_connect_error_sync(config, e, timeout=timeout)
        def empty(kind):
            return CapabilityBucketResult(kind=kind, ok=False, error=err_msg)
        server.last_sync_status = "failed"
        server.last_synced_at = now
        server.last_sync_error_message = f"connect: {err_msg}"
        db.commit()
        return SyncResult(
            status="failed",
            capabilities=empty("capabilities"),
            resources=empty("resources"),
            prompts=empty("prompts"),
            synced_at=now,
            error_type=err_type,
            error_message=err_msg,
        )

    try:
        caps_r = await _sync_capabilities(db, server, conn)
        resources_r = await _sync_resources(db, server, conn)
        # Resource templates roll up under the same "resources" bucket of
        # the SyncResult — we don't surface a 4th bucket to the API because
        # templates are conceptually a sub-flavor of resources, and the
        # frontend Resources Tab will eventually render templates inline
        # when persistence lands.
        templates_r = await _sync_resource_templates(db, server, conn)
        if not templates_r.ok:
            # Demote resources to whichever is worse.
            resources_r = CapabilityBucketResult(
                kind="resources", ok=False,
                error=f"{resources_r.error}; templates: {templates_r.error}".strip("; "),
                added=resources_r.added, updated=resources_r.updated,
                synced=resources_r.synced, removed=resources_r.removed,
            )
        prompts_r = await _sync_prompts(db, server, conn)
    finally:
        try:
            await conn.disconnect()
        except Exception as e:
            logger.debug("sync_capabilities: disconnect cleanup error: %s", e)

    oks = [caps_r.ok, resources_r.ok, prompts_r.ok]
    if all(oks):
        overall = "success"
    elif any(oks):
        overall = "partial_success"
    else:
        overall = "failed"

    # Consolidate per-bucket errors so the detail page can show WHY a
    # sync was partial/failed without re-running it. Cleared on full success.
    bucket_errors = [
        (r.kind, r.error) for r in (caps_r, resources_r, prompts_r) if not r.ok and r.error
    ]
    if bucket_errors:
        server.last_sync_error_message = "; ".join(f"{k}: {e}" for k, e in bucket_errors)
    else:
        server.last_sync_error_message = None

    server.last_sync_status = overall
    server.last_synced_at = now
    db.commit()

    # Mirror the refreshed capability catalog into the knowledge base.
    # Capabilities-only concern → gate on the capabilities bucket, not the
    # aggregate. Runs in a thread with its own Session (KB writes are sync;
    # we must not block the event loop nor share `db` across threads), and
    # is best-effort: a KB failure never affects the sync result above.
    if caps_r.ok:
        try:
            from app.services import mcp_knowledge
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None, mcp_knowledge.refresh_server_knowledge_by_id, server.id
            )
        except Exception as e:
            logger.warning("sync_capabilities: knowledge refresh dispatch failed: %s", e)

    return SyncResult(
        status=overall,
        capabilities=caps_r,
        resources=resources_r,
        prompts=prompts_r,
        synced_at=now,
    )


def record_health_probe(
    db: Session,
    server: MCPServer,
    result: ProbeResult,
) -> MCPHealthRecord:
    """Persist a probe result.

    Appends one row to ``mcp_health_records`` and mirrors the latest
    status / response_time onto ``mcp_servers`` for cheap list-page
    reads. Commits the session so the caller sees the updated server
    on the next read.
    """
    now = datetime.utcnow()
    record = MCPHealthRecord(
        id=str(uuid.uuid4()),
        server_id=server.id,
        status=result.status,
        response_time=result.response_time_ms,
        error_type=result.error_type,
        error_message=result.error_message,
        checked_at=now,
    )
    db.add(record)
    server.health_status = result.status
    server.last_checked_at = now
    server.last_response_time = result.response_time_ms
    db.commit()
    db.refresh(record)
    return record
