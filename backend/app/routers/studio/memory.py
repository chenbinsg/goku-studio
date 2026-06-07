from typing import Optional, List
from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from app.db import get_db
from app import models, schemas, auth

router = APIRouter(prefix="/api/v1/memory", tags=["memory"])

_AUTO_TAG = "auto_summary"


class MemoryUpdate(BaseModel):
    content: Optional[str] = None
    tags: Optional[List[str]] = None
    ttl: Optional[int] = None


@router.get("")
def list_memories(
    type: Optional[str] = None,
    tag: Optional[str] = Query(None, description="Filter by tag (e.g. '__pref__' for user preferences)"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """List all memory records with pagination.
    Non-superusers see only their own memories.
    Superusers see all memories (useful for admin inspection).
    Filter by ?tag=__pref__ to list user preferences.
    """
    query = db.query(models.Memory)
    # User-scoped isolation: each user sees only their own records
    if not current_user.is_superuser:
        query = query.filter(
            (models.Memory.user_id == current_user.id) | (models.Memory.user_id == None)  # noqa: E711
        )
    if type:
        query = query.filter(models.Memory.type == type)
    if tag:
        query = query.filter(models.Memory.tags.contains([tag]))
    total = query.count()
    items = query.order_by(models.Memory.created_at.desc()).offset((page - 1) * size).limit(size).all()
    return {
        "total": total,
        "items": [
            {
                "id": m.id,
                "type": m.type,
                "content": m.content[:200] if m.content else "",
                "tags": m.tags,
                "ttl": m.ttl,
                "created_at": m.created_at,
            }
            for m in items
        ],
    }


@router.get("/timeline")
def memory_timeline(
    page: int = Query(1, ge=1),
    size: int = Query(30, ge=1, le=100),
    domain: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """
    Return auto-sedimented long-term memories in reverse-chronological order.
    These are the one-sentence insights distilled from completed tasks (P3-3).
    Optional filter: domain=email|calendar|search|code|files|messaging|data
    """
    base_filter = [
        models.Memory.tags.contains([_AUTO_TAG]),
        models.Memory.type == models.MemoryType.LONG,
    ]
    # User-scoped: non-superusers see only their own auto-summaries
    if not current_user.is_superuser:
        from sqlalchemy import or_
        base_filter.append(
            or_(models.Memory.user_id == current_user.id, models.Memory.user_id == None)  # noqa: E711
        )

    query = db.query(models.Memory).filter(*base_filter)
    if domain:
        query = query.filter(models.Memory.tags.contains([f"domain:{domain}"]))

    total = query.count()
    items = (
        query
        .order_by(models.Memory.created_at.desc())
        .offset((page - 1) * size)
        .limit(size)
        .all()
    )

    # Stats: count per domain for the full dataset
    all_auto = (
        db.query(models.Memory)
        .filter(*base_filter)
        .with_entities(models.Memory.tags)
        .all()
    )
    domain_counts: dict = {}
    for (tags,) in all_auto:
        for t in (tags or []):
            if t.startswith("domain:"):
                d = t[7:]
                domain_counts[d] = domain_counts.get(d, 0) + 1

    return {
        "total": total,
        "domain_counts": domain_counts,
        "items": [
            {
                "id": m.id,
                "content": m.content,
                "tags": m.tags,
                "created_at": m.created_at,
            }
            for m in items
        ],
    }


@router.post("/consolidate")
def trigger_consolidation(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """
    Manually trigger a memory consolidation pass:
    merges near-duplicate auto-summaries and expires orphaned old ones.
    Runs synchronously (may take a few seconds for large memory stores).
    """
    from app.services.memory_consolidator import consolidate_memories
    from app.db import SessionLocal
    result = consolidate_memories(SessionLocal)
    return result


@router.post("", response_model=schemas.MemoryResponse, status_code=201)
def create_memory(
    memory_data: schemas.MemoryCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    from app.services import memory as memory_svc
    result = memory_svc.create(
        content=memory_data.content,
        memory_type=memory_data.type,
        tags=memory_data.tags,
        ttl=memory_data.ttl,
        db=db,
        user_id=current_user.id,
        tenant_id=getattr(current_user, "tenant_id", None),
    )
    auth.log_audit_action(db, current_user.id, "create_memory", "memory", result.get("memory_id"),
                          {"type": memory_data.type})
    return result


@router.post("/search", response_model=schemas.MemorySearchResponse)
def search_memory(search_data: schemas.MemorySearch, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)):
    from app.services import memory as memory_svc
    results = memory_svc.search(query=search_data.query, memory_type=search_data.type, top_k=search_data.top_k, filters=search_data.filters, db=db)
    return {"results": results}


@router.get("/{memory_id}")
def get_memory(
    memory_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Retrieve a single memory record by ID."""
    m = db.query(models.Memory).filter(models.Memory.id == memory_id).first()
    if not m:
        raise HTTPException(status_code=404, detail="Memory not found")
    if not current_user.is_superuser and m.user_id and m.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Access denied")
    return {
        "id": m.id,
        "type": m.type,
        "content": m.content,
        "tags": m.tags,
        "ttl": m.ttl,
        "vector_id": m.vector_id,
        "created_at": m.created_at,
    }


@router.put("/{memory_id}")
def update_memory(
    memory_id: str,
    data: MemoryUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Update content, tags, or TTL of a memory entry.
    Re-embeds the content if changed so search results stay accurate.
    """
    m = db.query(models.Memory).filter(models.Memory.id == memory_id).first()
    if not m:
        raise HTTPException(status_code=404, detail="Memory not found")
    if not current_user.is_superuser and m.user_id and m.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Access denied")

    content_changed = data.content is not None and data.content != m.content
    if data.content is not None:
        m.content = data.content
    if data.tags is not None:
        m.tags = data.tags
    if data.ttl is not None:
        m.ttl = data.ttl

    db.commit()
    auth.log_audit_action(db, current_user.id, "update_memory", "memory", memory_id,
                          {"content_changed": content_changed, "tags_changed": data.tags is not None})

    # Re-embed if content changed so vector store stays in sync
    if content_changed and m.vector_id:
        try:
            from app.services import embedding as emb_svc, vector_store as vs
            vector = emb_svc.get_embedding(m.content)
            vs.upsert(m.vector_id, vector, {
                "content": m.content[:500],
                "type": m.type.value if hasattr(m.type, "value") else str(m.type),
                "tags": m.tags or [],
            })
        except Exception:
            pass  # vector update is best-effort

    return {
        "id": m.id,
        "type": m.type,
        "content": m.content,
        "tags": m.tags,
        "ttl": m.ttl,
        "created_at": m.created_at,
    }


@router.delete("/{memory_id}", status_code=204)
def delete_memory(
    memory_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Delete a memory record and its vector embedding."""
    m = db.query(models.Memory).filter(models.Memory.id == memory_id).first()
    if not m:
        raise HTTPException(status_code=404, detail="Memory not found")
    if not current_user.is_superuser and m.user_id and m.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Access denied")

    vector_id = m.vector_id
    db.delete(m)
    db.commit()
    auth.log_audit_action(db, current_user.id, "delete_memory", "memory", memory_id, {})

    if vector_id:
        try:
            from app.services import vector_store as vs
            vs.delete(vector_id)
        except Exception:
            pass  # best-effort vector cleanup
