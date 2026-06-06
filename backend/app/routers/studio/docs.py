"""
Document Center API — CRUD for tech standards, manuals, release notes, etc.
"""
import uuid
from datetime import datetime
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import asc

from app.db import get_db
from app import models, auth
from app.services.tenant import get_request_tenant_id

router = APIRouter(prefix="/api/v1/docs", tags=["docs"])

CATEGORIES = {
    "tech_standards":    "Tech Standards",
    "user_manual":       "User Manual",
    "installation":      "Installation Guide",
    "release_notes":     "Release Notes",
    "agent_manual":      "Agent Management Manual",
    "other":             "Other",
}


# ── Schemas ────────────────────────────────────────────────────────────────────

class DocPageCreate(BaseModel):
    category: str
    title: str
    content: str = ""
    title_zh: Optional[str] = None
    content_zh: Optional[str] = None
    title_ja: Optional[str] = None
    content_ja: Optional[str] = None
    version: Optional[str] = None
    order_index: int = 0


class DocPageUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    title_zh: Optional[str] = None
    content_zh: Optional[str] = None
    title_ja: Optional[str] = None
    content_ja: Optional[str] = None
    version: Optional[str] = None
    order_index: Optional[int] = None
    category: Optional[str] = None


class DocPageOut(BaseModel):
    id: str
    category: str
    title: str
    content: str
    title_zh: Optional[str]
    content_zh: Optional[str]
    title_ja: Optional[str]
    content_ja: Optional[str]
    version: Optional[str]
    order_index: int
    created_by: Optional[str]
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# ── Helpers ────────────────────────────────────────────────────────────────────

def _get_tenant(db, current_user):
    return get_request_tenant_id(current_user, db)


def _find_doc(db, doc_id: str, tenant_id: Optional[str]) -> models.DocPage:
    q = db.query(models.DocPage).filter(models.DocPage.id == doc_id)
    if tenant_id:
        q = q.filter(
            (models.DocPage.tenant_id == tenant_id) | (models.DocPage.tenant_id.is_(None))
        )
    doc = q.first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    return doc


# ── Routes ─────────────────────────────────────────────────────────────────────

@router.get("/categories")
def list_categories():
    """Return available document categories."""
    return [{"key": k, "label": v} for k, v in CATEGORIES.items()]


@router.get("", response_model=List[DocPageOut])
def list_docs(
    category: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    tenant_id = _get_tenant(db, current_user)
    q = db.query(models.DocPage)
    if tenant_id:
        q = q.filter(
            (models.DocPage.tenant_id == tenant_id) | (models.DocPage.tenant_id.is_(None))
        )
    if category:
        q = q.filter(models.DocPage.category == category)
    return q.order_by(asc(models.DocPage.category), asc(models.DocPage.order_index), asc(models.DocPage.title)).all()


@router.get("/{doc_id}", response_model=DocPageOut)
def get_doc(
    doc_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    tenant_id = _get_tenant(db, current_user)
    return _find_doc(db, doc_id, tenant_id)


@router.post("", response_model=DocPageOut, status_code=201)
def create_doc(
    body: DocPageCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    if body.category not in CATEGORIES:
        raise HTTPException(status_code=400, detail=f"Unknown category '{body.category}'")
    tenant_id = _get_tenant(db, current_user)
    doc = models.DocPage(
        id=str(uuid.uuid4()),
        tenant_id=tenant_id,
        category=body.category,
        title=body.title,
        content=body.content,
        version=body.version,
        order_index=body.order_index,
        created_by=current_user.id,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)
    return doc


@router.put("/{doc_id}", response_model=DocPageOut)
def update_doc(
    doc_id: str,
    body: DocPageUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    tenant_id = _get_tenant(db, current_user)
    doc = _find_doc(db, doc_id, tenant_id)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(doc, field, value)
    doc.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(doc)
    return doc


@router.delete("/{doc_id}", status_code=204)
def delete_doc(
    doc_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    tenant_id = _get_tenant(db, current_user)
    doc = _find_doc(db, doc_id, tenant_id)
    db.delete(doc)
    db.commit()
