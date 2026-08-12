"""Knowledge write/search paths must be forwarded to goku-core.

``app.services.embedding`` / ``vector_store`` / ``chunker`` / ``file_parser`` /
``reranker`` exist only in the core codebase, and only core is configured with
a vector store and an embedding provider. When these endpoints ran their own
lazy ``from app.services import embedding …`` they booted fine and then 500'd
on the first request with ``ImportError: cannot import name 'embedding'``.
Because the imports sat inside the function bodies, a boot-time route check
could not catch it. These tests pin the forwarding instead.
"""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

from starlette.requests import Request

from app.routers.studio.knowledge import (
    KnowledgeCreate,
    KnowledgeSearchRequest,
    create_knowledge,
    delete_knowledge,
    search_knowledge,
)


def _request(method: str, path: str) -> Request:
    return Request(
        {
            "type": "http",
            "method": method,
            "path": path,
            "headers": [
                (b"authorization", b"Bearer test-token"),
                (b"x-tenant-id", b"tenant-a"),
            ],
        }
    )


def test_create_is_forwarded_to_core():
    body = KnowledgeCreate(title="产品手册", content="x" * 2000, tags=["docs"])
    request = _request("POST", "/api/v1/knowledge")
    expected = {"id": "doc-1", "title": "产品手册", "chunks": 4}

    with patch(
        "app.services.core_runtime_proxy.post_to_core",
        new=AsyncMock(return_value=expected),
    ) as post_to_core:
        result = asyncio.run(create_knowledge(body, current_user=object(), request=request))

    assert result == expected
    args, kwargs = post_to_core.await_args
    assert args[0] is request
    assert args[1] == "/api/v1/knowledge"
    assert args[2] == body.model_dump(mode="json")
    assert kwargs["timeout"] > 120, "embedding many chunks outlasts the MCP-sized default"


def test_search_is_forwarded_to_core():
    body = KnowledgeSearchRequest(query="退款政策", top_k=3)
    request = _request("POST", "/api/v1/knowledge/search")
    expected = {"results": [], "query": "退款政策", "total": 0}

    with patch(
        "app.services.core_runtime_proxy.post_to_core",
        new=AsyncMock(return_value=expected),
    ) as post_to_core:
        result = asyncio.run(search_knowledge(body, current_user=object(), request=request))

    assert result == expected
    args, _ = post_to_core.await_args
    assert args[1] == "/api/v1/knowledge/search"
    assert args[2] == body.model_dump(mode="json")


def test_delete_is_forwarded_to_core():
    request = _request("DELETE", "/api/v1/knowledge/doc-1")

    with patch(
        "app.services.core_runtime_proxy.delete_to_core",
        new=AsyncMock(return_value=None),
    ) as delete_to_core:
        result = asyncio.run(delete_knowledge("doc-1", current_user=object(), request=request))

    assert result is None
    args, _ = delete_to_core.await_args
    assert args[1] == "/api/v1/knowledge/doc-1"


def test_proxy_forwards_auth_and_tenant_headers():
    """A superuser's X-Tenant-ID override must resolve to the same tenant on core."""
    from app.services.core_runtime_proxy import _headers

    assert _headers(_request("POST", "/api/v1/knowledge")) == {
        "authorization": "Bearer test-token",
        "x-tenant-id": "tenant-a",
    }


def test_upload_drops_absent_form_fields():
    """``title=None`` must not reach core as the literal string "None"."""
    from app.services import core_runtime_proxy

    captured: dict = {}

    async def fake_relay(request, method, path, **kwargs):
        captured.update(kwargs)

        class _Resp:
            @staticmethod
            def json():
                return {"id": "doc-1"}

        return _Resp()

    request = _request("POST", "/api/v1/knowledge/upload")
    with patch.object(core_runtime_proxy, "_relay", new=fake_relay):
        result = asyncio.run(
            core_runtime_proxy.post_file_to_core(
                request,
                "/api/v1/knowledge/upload",
                filename="handbook.pdf",
                content=b"%PDF-1.4",
                content_type="application/pdf",
                form_fields={"title": None, "source": "wiki", "tags": None},
            )
        )

    assert result == {"id": "doc-1"}
    assert captured["data"] == {"source": "wiki"}
    assert captured["files"]["file"] == ("handbook.pdf", b"%PDF-1.4", "application/pdf")


def test_every_verb_goes_through_the_shared_relay():
    """Each new per-verb helper used to re-copy the same 25 lines of error handling.

    get_from_core was the third copy; this keeps a fourth from appearing.
    """
    import ast
    import inspect
    from pathlib import Path

    from app.services import core_runtime_proxy

    source = Path(inspect.getfile(core_runtime_proxy)).read_text(encoding="utf-8")
    tree = ast.parse(source)

    offenders = []
    for node in tree.body:
        if not isinstance(node, ast.AsyncFunctionDef) or node.name.startswith("_"):
            continue
        calls = {
            n.func.id
            for n in ast.walk(node)
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
        }
        if "_relay" not in calls:
            offenders.append(node.name)

    assert not offenders, f"these bypass _relay and re-implement the error handling: {offenders}"


def test_knowledge_router_imports_no_core_only_services():
    """The router must not reach for modules that do not exist in Studio."""
    import ast
    from pathlib import Path

    source = Path(__file__).resolve().parents[1] / "app" / "routers" / "studio" / "knowledge.py"
    tree = ast.parse(source.read_text(encoding="utf-8"))

    core_only = {"embedding", "vector_store", "chunker", "file_parser", "reranker"}
    offenders = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and (node.module or "").startswith("app.services"):
            tail = (node.module or "").split(".")[-1]
            names = {a.name for a in node.names}
            if tail in core_only or names & core_only:
                offenders.append(f"line {node.lineno}: {node.module} -> {sorted(names)}")

    assert not offenders, "core-only services imported in Studio: " + "; ".join(offenders)
