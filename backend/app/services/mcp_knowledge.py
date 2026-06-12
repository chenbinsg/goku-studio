"""MCP capability catalog → Knowledge base sync.

Mirrors a server's **currently usable** MCP capabilities into
``knowledge_docs`` so Agents can *discover / describe* what capabilities
exist (semantic + BM25 retrieval). This is discovery only — it does NOT
grant the ability to invoke them (that's authorization + tool pool).

Single source of truth & freshness contract
--------------------------------------------
The knowledge base reflects the **current usable capability catalog**, not
a historical archive:

* One ``KnowledgeDoc`` per server, keyed by ``source = f"mcp:{code}"``
  (plus its markdown chunks, which share the same ``source``).
* :func:`refresh_server_knowledge` rebuilds that doc from the server's
  **active** capabilities — but only when the server itself is **enabled
  and not soft-deleted**; otherwise it just purges (an enabled-but-empty
  or disabled server leaves nothing behind).
* :func:`purge_server_knowledge` removes the doc, its chunks, and their
  vectors. Idempotent.

Hook points (wired by callers):
  * after a successful capability sync   → refresh
  * server disabled / soft-deleted        → purge
  * server (re-)enabled                   → refresh (or next sync)

Failure isolation: every public function swallows-and-logs on error so a
knowledge-base hiccup never breaks the capability-sync / status-change
main flow. Returns the number of docs written/removed (0 on no-op/error).
"""
from __future__ import annotations

import logging
import uuid
from typing import Optional

from sqlalchemy.orm import Session

from app import models

logger = logging.getLogger(__name__)

# Stable per-server key. Both the parent doc and its chunks carry this in
# ``source`` so purge can find everything with a single predicate.
def _source_key(server_code: str) -> str:
    return f"mcp:{server_code}"


def _format_params(input_schema: Optional[dict]) -> str:
    """Render an MCP capability inputSchema as a compact markdown bullet list."""
    schema = input_schema or {}
    props = schema.get("properties") or {}
    if not isinstance(props, dict) or not props:
        return "  - (无入参)"
    required = set(schema.get("required") or [])
    lines = []
    for pname, pdef in props.items():
        pdef = pdef if isinstance(pdef, dict) else {}
        ptype = pdef.get("type", "any")
        req = "必填" if pname in required else "可选"
        desc = (pdef.get("description") or "").strip()
        suffix = f" — {desc}" if desc else ""
        lines.append(f"  - `{pname}` ({ptype}, {req}){suffix}")
    return "\n".join(lines)


def _build_markdown(server: models.MCPServer, caps: list[models.MCPCapability]) -> str:
    """One markdown doc; one ``## {capability_name}`` section per capability.

    ``chunk_markdown`` splits on the ``##`` headers, so each capability
    lands in (roughly) its own chunk for precise retrieval.
    """
    key = _source_key(server.code)
    header = (
        f"# MCP 能力目录:{server.name}（{server.code}）\n\n"
        f"> 本文档由系统按 MCP server 同步自动生成，反映**当前可用能力**。"
        f"server 停用 / 删除后会自动清除。source={key}\n"
    )
    sections = []
    for cap in caps:
        sections.append(
            f"## {cap.capability_name}\n\n"
            f"- **Server**: `{server.code}`\n"
            f"- **能力状态**: {cap.status}\n"
            f"- **说明**: {(cap.description or '（无）').strip()}\n"
            f"- **入参**:\n{_format_params(cap.input_schema)}\n"
        )
    return header + "\n" + "\n".join(sections)


def _delete_existing(db: Session, server_code: str) -> int:
    """Delete the server's doc + chunks + their vectors. Returns rows removed."""
    from app.services import vector_store

    key = _source_key(server_code)
    rows = db.query(models.KnowledgeDoc).filter(models.KnowledgeDoc.source == key).all()
    if not rows:
        return 0
    vector_ids = [r.vector_id for r in rows if r.vector_id]
    if vector_ids:
        try:
            vector_store.delete_many(vector_ids)
        except Exception as e:  # vectors are best-effort; rows are authoritative
            logger.warning("mcp_knowledge: vector delete failed for %s: %s", key, e)
    # Delete chunks before their parent — knowledge_docs.parent_id is a
    # self-referential FK, so removing the parent first would violate it.
    children = [r for r in rows if r.parent_id is not None]
    parents = [r for r in rows if r.parent_id is None]
    for r in children:
        db.delete(r)
    db.flush()
    for r in parents:
        db.delete(r)
    db.flush()
    return len(rows)


_INDEX_SOURCE = "mcp:_index"


def refresh_server_index(db: Session) -> int:
    """Rebuild the single 'available MCP services' overview doc, so ANY agent
    (via knowledge_search) can enumerate ALL usable MCP servers + their capability
    counts in one shot. Real-time: rebuilt on every server change.
    Returns the number of servers listed."""
    from app.services import embedding as emb_svc, vector_store

    try:
        old = db.query(models.KnowledgeDoc).filter(models.KnowledgeDoc.source == _INDEX_SOURCE).all()
        vids = [r.vector_id for r in old if r.vector_id]
        if vids:
            try:
                vector_store.delete_many(vids)
            except Exception:
                pass
        for r in old:
            db.delete(r)
        db.flush()

        servers = (
            db.query(models.MCPServer)
            .filter(models.MCPServer.deleted_at.is_(None), models.MCPServer.status == "enabled")
            .order_by(models.MCPServer.name)
            .all()
        )
        head = (
            f"# 可用的 MCP 服务总览（共 {len(servers)} 个）\n\n"
            "> 本文档列出当前平台**全部可用的 MCP 服务（服务器）及其能力数**，由系统按 MCP 服务变化"
            "实时维护。回答“有哪些 MCP 服务 / 哪些 MCP 服务器可用 / 列出全部 MCP 服务 / 能用哪些 MCP”"
            "这类问题时，**以本清单为准**（每个服务的具体能力见各自的「MCP 能力目录」）。\n"
        )
        rows = []
        for s in servers:
            cap_n = (
                db.query(models.MCPCapability)
                .filter(models.MCPCapability.server_id == s.id, models.MCPCapability.status == "active")
                .count()
            )
            desc = (s.description or "").strip().replace("\n", " ")
            rows.append(
                f"- **{s.name}**（`{s.code}`）— 类别 {s.service_category or '-'}，"
                f"{cap_n} 个能力，健康 {s.health_status or '-'}。{desc}"
            )
        content = head + "\n" + ("\n".join(rows) if rows else "（当前没有可用的 MCP 服务）")
        title = "可用的 MCP 服务总览（全部 MCP 服务器清单）"

        doc_id = str(uuid.uuid4())
        vector = emb_svc.get_embedding(content[:8000])
        vid = vector_store.upsert(
            memory_id=doc_id, vector=vector,
            payload={"title": title, "source": _INDEX_SOURCE, "type": "knowledge"},
        )
        db.add(models.KnowledgeDoc(
            id=doc_id, title=title, content=content, source=_INDEX_SOURCE,
            tags=["mcp", "index", "服务总览", "可用服务"], vector_id=vid, tenant_id=None,
        ))
        db.commit()
        logger.info("mcp_knowledge: refreshed MCP service index — %d servers", len(servers))
        return len(servers)
    except Exception as e:
        logger.warning("mcp_knowledge: service index refresh failed: %s", e)
        try:
            db.rollback()
        except Exception:
            pass
        return 0


def purge_server_knowledge(db: Session, server: models.MCPServer) -> int:
    """Remove all knowledge for ``server`` (doc + chunks + vectors), and rebuild
    the service overview. Idempotent."""
    try:
        removed = _delete_existing(db, server.code)
        db.commit()
        if removed:
            logger.info("mcp_knowledge: purged %d rows for %s", removed, _source_key(server.code))
        refresh_server_index(db)
        return removed
    except Exception as e:
        logger.warning("mcp_knowledge: purge failed for %s: %s", server.code, e)
        try:
            db.rollback()
        except Exception:
            pass
        return 0


def refresh_server_knowledge(db: Session, server: models.MCPServer) -> int:
    """Rebuild this server's per-capability catalog AND the global service-overview
    doc (both real-time → any agent can discover available MCP services + their
    capabilities via knowledge_search). Returns docs written for this server."""
    n = _refresh_server_doc(db, server)
    refresh_server_index(db)
    return n


def _refresh_server_doc(db: Session, server: models.MCPServer) -> int:
    """Rebuild the server's knowledge doc from its **active** capabilities.

    Always purges first (idempotent). Rebuilds only when the server is
    enabled, not soft-deleted, and has ≥1 active capability — otherwise
    leaves nothing (a disabled/empty server must not appear in the catalog).
    Returns the number of docs written (parent + chunks), 0 on no-op/error.
    """
    from app.services import embedding as emb_svc, vector_store
    from app.services.chunker import chunk_markdown

    try:
        # 1. Always clear stale rows for this source.
        _delete_existing(db, server.code)

        # 2/3. Skip rebuild for not-usable servers.
        usable = server.deleted_at is None and server.status == "enabled"
        if not usable:
            db.commit()
            return 0
        caps = (
            db.query(models.MCPCapability)
            .filter(
                models.MCPCapability.server_id == server.id,
                models.MCPCapability.status == "active",
            )
            .order_by(models.MCPCapability.capability_name)
            .all()
        )
        if not caps:
            db.commit()
            return 0

        # 4/5. Build the markdown doc.
        key = _source_key(server.code)
        title = f"MCP 能力目录:{server.name}（{server.code}）"
        tags = ["mcp", "capability", server.code]
        content = _build_markdown(server, caps)

        doc_id = str(uuid.uuid4())
        vector = emb_svc.get_embedding(content[:8000])
        vector_id = vector_store.upsert(
            memory_id=doc_id,
            vector=vector,
            payload={"title": title, "source": key, "type": "knowledge"},
        )
        db.add(models.KnowledgeDoc(
            id=doc_id,
            title=title,
            content=content,
            source=key,
            tags=tags,
            vector_id=vector_id,
            tenant_id=None,  # MCP servers are platform-global, not tenant-scoped
        ))
        written = 1

        # Markdown-aware chunking — one ## section ≈ one chunk.
        for i, chunk in enumerate(chunk_markdown(content, chunk_size=500)):
            chunk_id = str(uuid.uuid4())
            chunk_vec = emb_svc.get_embedding(chunk[:8000])
            chunk_vec_id = vector_store.upsert(
                memory_id=chunk_id,
                vector=chunk_vec,
                payload={"title": title, "source": key, "type": "knowledge_chunk",
                         "parent_id": doc_id, "chunk_index": i},
            )
            db.add(models.KnowledgeDoc(
                id=chunk_id,
                parent_id=doc_id,
                chunk_index=i,
                title=f"{title} [chunk {i+1}]",
                content=chunk,
                source=key,
                tags=tags,
                vector_id=chunk_vec_id,
                tenant_id=None,
            ))
            written += 1

        db.commit()
        logger.info("mcp_knowledge: refreshed %s — %d caps, %d docs", key, len(caps), written)
        return written
    except Exception as e:
        logger.warning("mcp_knowledge: refresh failed for %s: %s", server.code, e)
        try:
            db.rollback()
        except Exception:
            pass
        return 0


def refresh_server_knowledge_by_id(server_id: str) -> int:
    """Thread-safe entry for async callers: opens its own session, fetches
    the server, refreshes. Used via ``run_in_executor`` from the async
    ``sync_capabilities`` so we never share a Session across threads.
    """
    from app.db import SessionLocal

    db = SessionLocal()
    try:
        server = db.query(models.MCPServer).filter(models.MCPServer.id == server_id).first()
        if server is None:
            return 0
        return refresh_server_knowledge(db, server)
    except Exception as e:
        logger.warning("mcp_knowledge: refresh_by_id failed for %s: %s", server_id, e)
        return 0
    finally:
        db.close()
