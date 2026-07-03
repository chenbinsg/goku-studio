"""Forward MCP live-connection operations to the goku-core runtime.

Studio is the management plane: it owns the ``mcp_servers`` CRUD but must
never spawn or connect to MCP servers itself. Built-in stdio servers
(``${VENV_PYTHON} -m app.agent.mcp.servers.*``) only exist in the goku-core
codebase — spawning them from the Studio process fails with
``ModuleNotFoundError: No module named 'app.agent.mcp.servers'``. And even
for external stdio / http servers, the health signal that matters is
whether the *runtime* (core) can reach them: a probe from the Studio
process measures the wrong interpreter, venv, and network vantage point.

So the live-connection endpoints (``/test``, ``/sync``,
``/capabilities/{id}/test-invoke``) forward to core's identical endpoints
under the same ``/api/v1/mcp-servers`` prefix and return core's response
verbatim (identical response schemas — the routers are siblings of the
same original file). Core writes the health records, synced capabilities,
call logs, and audit entries into the shared DB, so the Studio UI reads
them back exactly as if the work had happened locally; Studio must NOT
duplicate those writes.

Auth: Studio login is a redirect through core and both services verify the
same JWTs, so the caller's ``Authorization`` header is forwarded as-is.
"""
from __future__ import annotations

import logging

import httpx
from fastapi import HTTPException, Request

from app.config import settings

logger = logging.getLogger(__name__)


async def post_to_core(request: Request, path: str, json_body: dict | None = None) -> dict:
    """POST ``path`` (e.g. ``/api/v1/mcp-servers/{id}/test``) to goku-core.

    Returns core's parsed JSON body on 2xx. On a core-side HTTP error the
    status code and ``detail`` are relayed unchanged so the frontend sees
    the same error it would get from core directly. If core is unreachable
    the caller gets a 502 that names ``CORE_API_URL`` — the fix is almost
    always "start goku-core" or "point CORE_API_URL at it".
    """
    url = settings.CORE_API_URL.rstrip("/") + path
    headers = {}
    authorization = request.headers.get("authorization")
    if authorization:
        headers["Authorization"] = authorization

    try:
        async with httpx.AsyncClient(timeout=settings.CORE_API_TIMEOUT_SECS) as client:
            resp = await client.post(url, json=json_body, headers=headers)
    except httpx.RequestError as exc:
        logger.warning("goku-core runtime unreachable at %s: %s", url, exc)
        raise HTTPException(
            status_code=502,
            detail=(
                f"无法连接 goku-core runtime（{settings.CORE_API_URL}）：{exc}。"
                f"MCP 连接测试/能力同步由 runtime 执行，请确认 goku-core 服务已启动，"
                f"或通过环境变量 CORE_API_URL 指向正确地址。"
            ),
        ) from exc

    if resp.status_code >= 400:
        try:
            detail = resp.json().get("detail", resp.text[:500])
        except ValueError:
            detail = resp.text[:500]
        raise HTTPException(status_code=resp.status_code, detail=detail)

    return resp.json()
