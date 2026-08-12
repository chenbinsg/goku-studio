"""Forward runtime work (MCP live connections, embeddings/RAG) to goku-core.

Studio is the management plane: it owns CRUD but must never do runtime work
itself.

*MCP*: Studio owns the ``mcp_servers`` CRUD but must never spawn or connect
to MCP servers. Built-in stdio servers
(``${VENV_PYTHON} -m app.agent.mcp.servers.*``) only exist in the goku-core
codebase — spawning them from the Studio process fails with
``ModuleNotFoundError: No module named 'app.agent.mcp.servers'``. And even
for external stdio / http servers, the health signal that matters is
whether the *runtime* (core) can reach them: a probe from the Studio
process measures the wrong interpreter, venv, and network vantage point.

*Knowledge / RAG*: same shape. ``app.services.embedding``,
``vector_store``, ``chunker``, ``file_parser`` and ``reranker`` live only in
core, and only core is configured with the vector store and embedding
provider. Studio's knowledge write/search endpoints therefore forward to
core's identical ``/api/v1/knowledge`` endpoints.

So these endpoints forward to core's identical routes under the same
prefix and return core's response verbatim (identical response schemas —
the routers are siblings of the same original file). Core writes the health
records, synced capabilities, call logs, knowledge rows, vectors, and audit
entries into the shared DB, so the Studio UI reads them back exactly as if
the work had happened locally; Studio must NOT duplicate those writes.

Auth: Studio login is a redirect through core and both services verify the
same JWTs, so the caller's ``Authorization`` header is forwarded as-is.
``X-Tenant-ID`` is forwarded too, so a superuser's explicit tenant override
resolves to the same tenant on core as it would have locally.
"""
from __future__ import annotations

import logging
from typing import Any

import httpx
from fastapi import HTTPException, Request

from app.config import settings

logger = logging.getLogger(__name__)

# Embedding a large document is one provider round-trip per chunk, which
# runs well past the MCP-sized default. Knowledge writes pass this instead.
KNOWLEDGE_TIMEOUT_SECS = 600


def _headers(request: Request) -> dict[str, str]:
    """Auth + tenant headers to carry over to core (both optional)."""
    headers: dict[str, str] = {}
    for name in ("authorization", "x-tenant-id"):
        value = request.headers.get(name)
        if value:
            headers[name] = value
    return headers


async def _relay(
    request: Request,
    method: str,
    path: str,
    *,
    json_body: dict | None = None,
    files: dict | None = None,
    data: dict | None = None,
    timeout: int | None = None,
    purpose: str,
) -> httpx.Response:
    """Send one request to core and normalise its failure modes.

    On a core-side HTTP error the status code and ``detail`` are relayed
    unchanged so the frontend sees the same error it would get from core
    directly. If core is unreachable the caller gets a 502 that names
    ``CORE_API_URL`` — the fix is almost always "start goku-core" or
    "point CORE_API_URL at it".
    """
    url = settings.CORE_API_URL.rstrip("/") + path
    kwargs: dict[str, Any] = {"headers": _headers(request)}
    if json_body is not None:
        kwargs["json"] = json_body
    if files is not None:
        kwargs["files"] = files
    if data is not None:
        kwargs["data"] = data

    try:
        async with httpx.AsyncClient(timeout=timeout or settings.CORE_API_TIMEOUT_SECS) as client:
            resp = await client.request(method, url, **kwargs)
    except httpx.RequestError as exc:
        logger.warning("goku-core runtime unreachable at %s: %s", url, exc)
        raise HTTPException(
            status_code=502,
            detail=(
                f"无法连接 goku-core runtime（{settings.CORE_API_URL}）：{exc}。"
                f"{purpose}由 runtime 执行，请确认 goku-core 服务已启动，"
                f"或通过环境变量 CORE_API_URL 指向正确地址。"
            ),
        ) from exc

    if resp.status_code >= 400:
        try:
            detail = resp.json().get("detail", resp.text[:500])
        except ValueError:
            detail = resp.text[:500]
        raise HTTPException(status_code=resp.status_code, detail=detail)

    return resp


async def post_to_core(
    request: Request,
    path: str,
    json_body: dict | None = None,
    *,
    timeout: int | None = None,
    purpose: str = "MCP 连接测试/能力同步",
) -> dict:
    """POST ``path`` (e.g. ``/api/v1/mcp-servers/{id}/test``) to goku-core.

    Returns core's parsed JSON body on 2xx.
    """
    resp = await _relay(request, "POST", path, json_body=json_body, timeout=timeout, purpose=purpose)
    return resp.json()


async def put_to_core(
    request: Request,
    path: str,
    json_body: dict | None = None,
    *,
    timeout: int | None = None,
    purpose: str = "该写操作",
) -> dict:
    """PUT ``path`` to goku-core. Same relay semantics as :func:`post_to_core`.
    Used for writes that must run in core — e.g. a capability
    ``result-script`` (the sandbox lives in core)."""
    resp = await _relay(request, "PUT", path, json_body=json_body, timeout=timeout, purpose=purpose)
    return resp.json()


async def delete_to_core(
    request: Request,
    path: str,
    *,
    timeout: int | None = None,
    purpose: str = "该删除操作",
) -> None:
    """DELETE ``path`` on goku-core. Returns nothing — core's delete endpoints
    answer 204, so there is no body to parse or relay."""
    await _relay(request, "DELETE", path, timeout=timeout, purpose=purpose)


async def post_file_to_core(
    request: Request,
    path: str,
    *,
    filename: str,
    content: bytes,
    content_type: str | None = None,
    form_fields: dict | None = None,
    timeout: int | None = None,
    purpose: str = "该上传",
) -> dict:
    """POST a multipart upload to core, relaying the file plus form fields.

    ``form_fields`` entries whose value is ``None`` are dropped so core sees
    an absent field rather than the string ``"None"``.
    """
    files = {"file": (filename, content, content_type or "application/octet-stream")}
    data = {k: v for k, v in (form_fields or {}).items() if v is not None}
    resp = await _relay(
        request, "POST", path, files=files, data=data, timeout=timeout, purpose=purpose
    )
    return resp.json()
