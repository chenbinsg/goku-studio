"""
Knowledge base CRUD API — upload, search, and manage documents for RAG.
"""
from typing import Optional, List
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.db import get_db
from app import models, auth
from fastapi import Request
from app.limiter import limiter, _UPLOAD_RATE_LIMIT
from app.services.tenant import get_request_tenant_id
from app.services import core_runtime_proxy

router = APIRouter(prefix="/api/v1/knowledge", tags=["knowledge"])

_MAX_FILE_BYTES = 20 * 1024 * 1024  # 20 MB


class KnowledgeCreate(BaseModel):
    title: str
    content: str
    source: Optional[str] = None
    tags: List[str] = Field(default_factory=list)


class KnowledgeSearchRequest(BaseModel):
    query: str
    top_k: int = Field(default=5, ge=1, le=20)
    min_similarity: float = Field(default=0.0, ge=0.0, le=1.0)


class KnowledgeUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    source: Optional[str] = None
    tags: Optional[List[str]] = None


@router.post("/upload", status_code=201)
@limiter.limit(_UPLOAD_RATE_LIMIT)
async def upload_knowledge_file(
    request: Request,
    file: UploadFile = File(...),
    title: Optional[str] = Form(None),
    source: Optional[str] = Form(None),
    tags: Optional[str] = Form(None),
    current_user: models.User = Depends(auth.get_current_user),
):
    """
    Upload a file (PDF, DOCX, TXT, Markdown) to the knowledge base.
    Text is extracted automatically, then chunked and indexed for RAG.

    - **file**: The file to upload (max 20 MB).
    - **title**: Optional title; defaults to the filename.
    - **source**: Optional source label (e.g. URL or document name).
    - **tags**: Comma-separated list of tags.

    Proxied to core: text extraction, chunking and embedding only exist there
    (see :mod:`app.services.core_runtime_proxy`). The size guard stays here so
    an oversized upload is rejected before the bytes cross the wire.
    """
    raw = await file.read()
    if len(raw) > _MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="File too large. Maximum size is 20 MB.")

    return await core_runtime_proxy.post_file_to_core(
        request,
        "/api/v1/knowledge/upload",
        filename=file.filename or "upload",
        content=raw,
        content_type=file.content_type,
        form_fields={"title": title, "source": source, "tags": tags},
        timeout=core_runtime_proxy.KNOWLEDGE_TIMEOUT_SECS,
        purpose="文件解析与向量化",
    )


@router.post("", status_code=201)
async def create_knowledge(
    data: KnowledgeCreate,
    current_user: models.User = Depends(auth.get_current_user),
    request: Request = None,
):
    """Upload a knowledge document. Auto-chunks large documents for better RAG retrieval.

    Proxied to core: embedding, chunking and the vector-store write only exist
    there (see :mod:`app.services.core_runtime_proxy`). Core writes the rows
    into the shared DB, so the Studio list/detail endpoints read them back
    unchanged — Studio must NOT duplicate those writes.
    """
    return await core_runtime_proxy.post_to_core(
        request,
        "/api/v1/knowledge",
        data.model_dump(mode="json"),
        timeout=core_runtime_proxy.KNOWLEDGE_TIMEOUT_SECS,
        purpose="知识库写入与向量化",
    )


@router.post("/search")
async def search_knowledge(
    data: KnowledgeSearchRequest,
    current_user: models.User = Depends(auth.get_current_user),
    request: Request = None,
):
    """
    Semantic RAG search over the knowledge base.
    Returns top-k relevant document chunks ranked by vector similarity,
    with optional cross-encoder reranking and adjacent-chunk context expansion.

    Proxied to core — the query embedding, vector search and reranker all live
    there (see :mod:`app.services.core_runtime_proxy`).
    """
    return await core_runtime_proxy.post_to_core(
        request,
        "/api/v1/knowledge/search",
        data.model_dump(mode="json"),
        purpose="知识库检索",
    )


@router.get("")
def list_knowledge(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    search: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
    request: Request = None,
):
    """List knowledge documents with optional text search. Only returns top-level docs (no chunks)."""
    query = db.query(models.KnowledgeDoc).filter(models.KnowledgeDoc.parent_id == None)  # noqa: E711
    # Tenant scoping — superusers see all unless an explicit tenant header is set
    tenant_id = get_request_tenant_id(request, current_user)
    if tenant_id:
        query = query.filter(models.KnowledgeDoc.tenant_id == tenant_id)
    if search:
        query = query.filter(
            models.KnowledgeDoc.title.contains(search)
            | models.KnowledgeDoc.content.contains(search)
        )
    total = query.count()
    items = (
        query.order_by(models.KnowledgeDoc.created_at.desc())
        .offset((page - 1) * size)
        .limit(size)
        .all()
    )
    # Count chunks per document in one query
    from sqlalchemy import func
    chunk_counts: dict = {}
    if items:
        doc_ids = [d.id for d in items]
        rows = (
            db.query(models.KnowledgeDoc.parent_id, func.count(models.KnowledgeDoc.id))
            .filter(models.KnowledgeDoc.parent_id.in_(doc_ids))
            .group_by(models.KnowledgeDoc.parent_id)
            .all()
        )
        chunk_counts = {pid: cnt for pid, cnt in rows}

    return {
        "total": total,
        "items": [
            {
                "id": d.id,
                "title": d.title,
                "source": d.source,
                "tags": d.tags,
                "created_at": d.created_at,
                "content_preview": (d.content or "")[:200],
                "char_count": len(d.content or ""),
                "chunk_count": chunk_counts.get(d.id, 0),
            }
            for d in items
        ],
    }


@router.get("/{doc_id}")
def get_knowledge(
    doc_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
    request: Request = None,
):
    """Get a knowledge document by ID."""
    doc = db.query(models.KnowledgeDoc).filter(models.KnowledgeDoc.id == doc_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    # Tenant gate: non-superusers cannot read documents from other tenants
    tenant_id = get_request_tenant_id(request, current_user)
    if tenant_id and doc.tenant_id and doc.tenant_id != tenant_id:
        raise HTTPException(status_code=403, detail="Access denied: tenant mismatch")
    return {
        "id": doc.id,
        "title": doc.title,
        "content": doc.content,
        "source": doc.source,
        "tags": doc.tags,
        "tenant_id": doc.tenant_id,
        "vector_id": doc.vector_id,
        "created_at": doc.created_at,
    }


@router.delete("/{doc_id}", status_code=204)
async def delete_knowledge(
    doc_id: str,
    current_user: models.User = Depends(auth.get_current_user),
    request: Request = None,
):
    """Delete a knowledge document, its chunks, and all associated vectors.

    Proxied to core: the vectors live in core's vector store, so core deletes
    the rows and the vectors together (see :mod:`app.services.core_runtime_proxy`).
    Core also enforces the tenant gate and writes the audit entry.
    """
    await core_runtime_proxy.delete_to_core(
        request,
        f"/api/v1/knowledge/{quote(doc_id, safe='')}",
        purpose="知识库删除",
    )
