"""
Knowledge base CRUD API — upload, search, and manage documents for RAG.
"""
import uuid
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.db import get_db
from app import models, auth
from fastapi import Request
from app.limiter import limiter, _UPLOAD_RATE_LIMIT
from app.services.tenant import get_request_tenant_id

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
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """
    Upload a file (PDF, DOCX, TXT, Markdown) to the knowledge base.
    Text is extracted automatically, then chunked and indexed for RAG.

    - **file**: The file to upload (max 20 MB).
    - **title**: Optional title; defaults to the filename.
    - **source**: Optional source label (e.g. URL or document name).
    - **tags**: Comma-separated list of tags.
    """
    from app.services.file_parser import extract_text
    from app.services import embedding as emb_svc, vector_store
    from app.services.chunker import chunk_text, chunk_markdown

    # Size guard
    raw = await file.read()
    if len(raw) > _MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="File too large. Maximum size is 20 MB.")

    # Extract text
    filename = file.filename or "upload"
    try:
        text, fmt = extract_text(filename, raw)
    except ValueError as exc:
        raise HTTPException(status_code=415, detail=str(exc))
    except ImportError as exc:
        raise HTTPException(status_code=501, detail=str(exc))

    if not text.strip():
        raise HTTPException(status_code=422, detail="Could not extract any text from the file.")

    doc_title = title or filename
    tag_list = [t.strip() for t in tags.split(",")] if tags else []

    doc_id = str(uuid.uuid4())
    vector = emb_svc.get_embedding(text[:8000])
    vector_id = vector_store.upsert(
        memory_id=doc_id,
        vector=vector,
        payload={"title": doc_title, "source": source, "type": "knowledge", "format": fmt},
    )

    tenant_id = get_request_tenant_id(request, current_user)

    doc = models.KnowledgeDoc(
        id=doc_id,
        title=doc_title,
        content=text,
        source=source or filename,
        tags=tag_list,
        vector_id=vector_id,
        tenant_id=tenant_id,
    )
    db.add(doc)

    chunk_count = 0
    if len(text) > 1000:
        chunks = chunk_markdown(text, chunk_size=500) if "##" in text else chunk_text(text, chunk_size=500, overlap=50)
        for i, chunk_content in enumerate(chunks):
            chunk_id = str(uuid.uuid4())
            chunk_vector = emb_svc.get_embedding(chunk_content[:8000])
            chunk_vector_id = vector_store.upsert(
                memory_id=chunk_id,
                vector=chunk_vector,
                payload={
                    "title": doc_title,
                    "source": source,
                    "type": "knowledge_chunk",
                    "parent_id": doc_id,
                    "chunk_index": i,
                },
            )
            db.add(models.KnowledgeDoc(
                id=chunk_id,
                parent_id=doc_id,
                chunk_index=i,
                title=f"{doc_title} [chunk {i+1}]",
                content=chunk_content,
                source=source or filename,
                tags=tag_list,
                vector_id=chunk_vector_id,
                tenant_id=tenant_id,
            ))
            chunk_count += 1

    db.commit()
    auth.log_audit_action(db, current_user.id, "upload_knowledge_file", "knowledge_doc", doc.id,
                          {"title": doc.title, "format": fmt, "chunks": chunk_count}, request=request)
    return {
        "id": doc.id,
        "title": doc.title,
        "format": fmt,
        "characters": len(text),
        "chunks": chunk_count,
        "created_at": doc.created_at,
    }


@router.post("", status_code=201)
def create_knowledge(
    data: KnowledgeCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
    request: Request = None,
):
    """Upload a knowledge document. Auto-chunks large documents for better RAG retrieval."""
    from app.services import embedding as emb_svc, vector_store
    from app.services.chunker import chunk_text, chunk_markdown

    doc_id = str(uuid.uuid4())

    # Generate embedding for the main document (first 8000 chars)
    vector = emb_svc.get_embedding(data.content[:8000])
    vector_id = vector_store.upsert(
        memory_id=doc_id,
        vector=vector,
        payload={"title": data.title, "source": data.source, "type": "knowledge"},
    )

    tenant_id = get_request_tenant_id(request, current_user)

    doc = models.KnowledgeDoc(
        id=doc_id,
        title=data.title,
        content=data.content,
        source=data.source,
        tags=data.tags,
        vector_id=vector_id,
        tenant_id=tenant_id,
    )
    db.add(doc)

    # Auto-chunk large documents for better retrieval
    chunk_count = 0
    if len(data.content) > 1000:
        # Use markdown-aware chunking if content has headers
        if "##" in data.content:
            chunks = chunk_markdown(data.content, chunk_size=500)
        else:
            chunks = chunk_text(data.content, chunk_size=500, overlap=50)

        for i, chunk_text_content in enumerate(chunks):
            chunk_id = str(uuid.uuid4())
            chunk_vector = emb_svc.get_embedding(chunk_text_content[:8000])
            chunk_vector_id = vector_store.upsert(
                memory_id=chunk_id,
                vector=chunk_vector,
                payload={
                    "title": data.title,
                    "source": data.source,
                    "type": "knowledge_chunk",
                    "parent_id": doc_id,
                    "chunk_index": i,
                },
            )
            chunk_doc = models.KnowledgeDoc(
                id=chunk_id,
                parent_id=doc_id,
                chunk_index=i,
                title=f"{data.title} [chunk {i+1}]",
                content=chunk_text_content,
                source=data.source,
                tags=data.tags,
                vector_id=chunk_vector_id,
                tenant_id=tenant_id,
            )
            db.add(chunk_doc)
            chunk_count += 1

    db.commit()
    auth.log_audit_action(db, current_user.id, "create_knowledge_doc", "knowledge_doc", doc.id,
                          {"title": doc.title, "chunks": chunk_count}, request=request)
    return {
        "id": doc.id,
        "title": doc.title,
        "chunks": chunk_count,
        "created_at": doc.created_at,
    }


@router.post("/search")
def search_knowledge(
    data: KnowledgeSearchRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
    request: Request = None,
):
    """
    Semantic RAG search over the knowledge base.
    Returns top-k relevant document chunks ranked by vector similarity,
    with optional cross-encoder reranking and adjacent-chunk context expansion.
    """
    from app.services import embedding as emb_svc, vector_store
    from app.services.reranker import rerank

    tenant_id = get_request_tenant_id(request, current_user)

    query_vec = emb_svc.get_embedding(data.query)
    search_limit = max(data.top_k * 4, 20)
    raw = vector_store.search(query_vector=query_vec, top_k=search_limit, for_reranking=True)

    if not raw:
        return {"results": [], "query": data.query}

    results = []
    seen_parents: set = set()

    for r in raw:
        sim = r.get("similarity", 0)
        if sim < data.min_similarity:
            continue

        doc = db.query(models.KnowledgeDoc).filter(
            models.KnowledgeDoc.id == r.get("memory_id")
        ).first()
        if not doc:
            continue
        # Skip docs from other tenants
        if tenant_id and doc.tenant_id and doc.tenant_id != tenant_id:
            continue

        content = doc.content[:2000]
        parent_title = None
        parent_id = doc.parent_id or doc.id

        if doc.parent_id:
            parent = db.query(models.KnowledgeDoc).filter(
                models.KnowledgeDoc.id == doc.parent_id
            ).first()
            if parent:
                parent_title = parent.title

            # Expand context with adjacent chunks
            if doc.chunk_index is not None:
                adjacent = (
                    db.query(models.KnowledgeDoc)
                    .filter(
                        models.KnowledgeDoc.parent_id == doc.parent_id,
                        models.KnowledgeDoc.chunk_index.in_([
                            doc.chunk_index - 1,
                            doc.chunk_index + 1,
                        ]),
                    )
                    .order_by(models.KnowledgeDoc.chunk_index)
                    .all()
                )
                before = [a.content[:400] for a in adjacent if a.chunk_index < doc.chunk_index]
                after  = [a.content[:400] for a in adjacent if a.chunk_index > doc.chunk_index]
                content = (
                    ("...\n" + before[0] + "\n---\n" if before else "")
                    + doc.content[:2000]
                    + ("\n---\n" + after[0] + "\n..." if after else "")
                ).strip()

        results.append({
            "id":          doc.id,
            "parent_id":   doc.parent_id,
            "title":       parent_title or doc.title,
            "source":      doc.source,
            "tags":        doc.tags,
            "content":     content,
            "similarity":  round(sim, 4),
            "is_chunk":    doc.parent_id is not None,
            "chunk_index": doc.chunk_index,
        })
        seen_parents.add(parent_id)

    # Rerank and trim
    results = rerank(query=data.query, documents=results, top_n=data.top_k)
    return {"results": results, "query": data.query, "total": len(results)}


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
def delete_knowledge(
    doc_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
    request: Request = None,
):
    """Delete a knowledge document, its chunks, and all associated vectors."""
    from app.services import vector_store

    doc = db.query(models.KnowledgeDoc).filter(models.KnowledgeDoc.id == doc_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    # Tenant gate: non-superusers cannot delete documents from other tenants
    tenant_id = get_request_tenant_id(request, current_user)
    if tenant_id and doc.tenant_id and doc.tenant_id != tenant_id:
        raise HTTPException(status_code=403, detail="Access denied: tenant mismatch")

    doc_title = doc.title
    # Collect all vector IDs (parent + chunks) BEFORE deleting any rows.
    chunks = db.query(models.KnowledgeDoc).filter(
        models.KnowledgeDoc.parent_id == doc_id
    ).all()
    vector_ids = [vid for vid in [doc.vector_id, *(c.vector_id for c in chunks)] if vid]

    # Delete children BEFORE the parent. knowledge_docs.parent_id is a
    # self-referential FK (NO ACTION, not CASCADE) with no mapped ORM
    # relationship, so SQLAlchemy's unit-of-work does NOT guarantee that the
    # per-chunk db.delete() flush precedes the parent db.delete() — emitting the
    # parent DELETE first raises IntegrityError 1451, which 500s the request for
    # every doc that has chunks (i.e. any doc > 1000 chars). Explicit bulk
    # deletes execute in the exact order written. Same FK-order fix as
    # delete_workflow.
    db.query(models.KnowledgeDoc).filter(
        models.KnowledgeDoc.parent_id == doc_id
    ).delete(synchronize_session=False)
    db.query(models.KnowledgeDoc).filter(
        models.KnowledgeDoc.id == doc_id
    ).delete(synchronize_session=False)
    db.commit()
    auth.log_audit_action(db, current_user.id, "delete_knowledge_doc", "knowledge_doc", doc_id,
                          {"title": doc_title, "vectors_removed": len(vector_ids)}, request=request)

    # Remove vectors from the vector store (best-effort, non-blocking)
    if vector_ids:
        try:
            vector_store.delete_many(vector_ids)
        except Exception:
            pass  # DB record already deleted; vector orphan cleanup can run separately
