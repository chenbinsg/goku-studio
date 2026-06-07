"""
External Memory Sources API — manage Notion / Obsidian connections and trigger syncs.

Endpoints:
  GET    /api/v1/external-memory/sources              — list all sources for current user
  POST   /api/v1/external-memory/sources              — create Obsidian source
  DELETE /api/v1/external-memory/sources/{id}         — delete source + its knowledge_docs
  POST   /api/v1/external-memory/sources/{id}/sync    — trigger manual sync
  GET    /api/v1/external-memory/notion/auth-url      — get Notion OAuth URL
  POST   /api/v1/external-memory/notion/callback      — exchange OAuth code → create source
"""
import logging
import secrets
import uuid
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import auth, models
from app.db import get_db

router = APIRouter(prefix="/api/v1/external-memory", tags=["external-memory"])
logger = logging.getLogger(__name__)


# ── Schemas ────────────────────────────────────────────────────────────────────

class ObsidianSourceCreate(BaseModel):
    vault_path: str
    name: str | None = None


class NotionCallbackRequest(BaseModel):
    code: str
    redirect_uri: str


class SourceOut(BaseModel):
    id: str
    provider: str
    name: str
    status: str
    last_synced_at: str | None
    doc_count: int
    error_message: str | None
    created_at: str
    # Notion only
    workspace_name: str | None = None
    # Obsidian only
    vault_path: str | None = None


def _to_out(src: models.ExternalMemorySource) -> SourceOut:
    cfg = src.config or {}
    return SourceOut(
        id=src.id,
        provider=src.provider,
        name=src.name,
        status=src.status,
        last_synced_at=src.last_synced_at.isoformat() if src.last_synced_at else None,
        doc_count=src.doc_count or 0,
        error_message=src.error_message,
        created_at=src.created_at.isoformat() if src.created_at else "",
        workspace_name=cfg.get("workspace_name"),
        vault_path=cfg.get("vault_path"),
    )


# ── List ───────────────────────────────────────────────────────────────────────

@router.get("/sources")
def list_sources(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    sources = (
        db.query(models.ExternalMemorySource)
        .filter(models.ExternalMemorySource.user_id == str(current_user.id))
        .order_by(models.ExternalMemorySource.created_at.desc())
        .all()
    )
    return [_to_out(s) for s in sources]


# ── Create Obsidian source ─────────────────────────────────────────────────────

@router.post("/sources", status_code=201)
def create_obsidian_source(
    body: ObsidianSourceCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    from pathlib import Path

    vault = Path(body.vault_path).expanduser().resolve()
    if not vault.is_dir():
        raise HTTPException(status_code=400, detail=f"Vault path not found: {vault}")

    tenant_id = str(current_user.tenant_id) if current_user.tenant_id else None
    src = models.ExternalMemorySource(
        id=str(uuid.uuid4()),
        tenant_id=tenant_id,
        user_id=str(current_user.id),
        provider="obsidian",
        name=body.name or vault.name,
        status="active",
        config={"vault_path": str(vault)},
    )
    db.add(src)
    db.commit()
    db.refresh(src)

    background_tasks.add_task(_run_sync, str(src.id))
    return _to_out(src)


# ── Delete source ──────────────────────────────────────────────────────────────

@router.delete("/sources/{source_id}", status_code=204)
def delete_source(
    source_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    src = _get_owned(source_id, current_user, db)

    # Delete all knowledge docs belonging to this source
    child_ids = [
        row.id for row in
        db.query(models.KnowledgeDoc.id)
        .filter(models.KnowledgeDoc.external_source_id == source_id,
                models.KnowledgeDoc.parent_id.is_(None))
        .all()
    ]
    if child_ids:
        db.query(models.KnowledgeDoc).filter(
            models.KnowledgeDoc.parent_id.in_(child_ids)
        ).delete(synchronize_session=False)
        db.query(models.KnowledgeDoc).filter(
            models.KnowledgeDoc.external_source_id == source_id
        ).delete(synchronize_session=False)

    db.delete(src)
    db.commit()


# ── Manual sync ────────────────────────────────────────────────────────────────

@router.post("/sources/{source_id}/sync")
def trigger_sync(
    source_id: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    src = _get_owned(source_id, current_user, db)
    if src.status == "syncing":
        raise HTTPException(status_code=409, detail="Sync already in progress")

    src.status = "syncing"
    db.commit()

    background_tasks.add_task(_run_sync, source_id)
    return {"status": "syncing"}


# ── Notion OAuth ───────────────────────────────────────────────────────────────

@router.get("/notion/auth-url")
def notion_auth_url(
    redirect_uri: str,
    current_user: models.User = Depends(auth.get_current_user),
):
    from app.services.notion_sync import get_authorization_url

    state = secrets.token_urlsafe(16)
    try:
        url = get_authorization_url(redirect_uri, state)
    except ValueError as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc

    return {"authorization_url": url, "state": state}


@router.post("/notion/callback", status_code=201)
def notion_callback(
    body: NotionCallbackRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    from app.services.notion_sync import exchange_code

    try:
        workspace = exchange_code(body.code, body.redirect_uri)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Notion OAuth failed: {exc}") from exc

    tenant_id = str(current_user.tenant_id) if current_user.tenant_id else None
    src = models.ExternalMemorySource(
        id=str(uuid.uuid4()),
        tenant_id=tenant_id,
        user_id=str(current_user.id),
        provider="notion",
        name=workspace.get("workspace_name", "Notion"),
        status="active",
        config=workspace,
    )
    db.add(src)
    db.commit()
    db.refresh(src)

    background_tasks.add_task(_run_sync, str(src.id))
    return _to_out(src)


# ── Background sync task ───────────────────────────────────────────────────────

def _run_sync(source_id: str) -> None:
    from app.db import SessionLocal
    from app.services import notion_sync, obsidian_sync

    db = SessionLocal()
    try:
        src = db.query(models.ExternalMemorySource).filter(
            models.ExternalMemorySource.id == source_id
        ).first()
        if not src:
            return

        src.status = "syncing"
        db.commit()

        if src.provider == "notion":
            count = notion_sync.sync_source(src, db)
        elif src.provider == "obsidian":
            count = obsidian_sync.sync_source(src, db)
        else:
            raise ValueError(f"Unknown provider: {src.provider}")

        src.status = "active"
        src.last_synced_at = datetime.utcnow()
        src.doc_count = count
        src.error_message = None
        db.commit()
        logger.info("external_memory sync complete: source=%s provider=%s docs=%d",
                    source_id, src.provider, count)
    except Exception as exc:
        logger.exception("external_memory sync failed: source=%s: %s", source_id, exc)
        try:
            src = db.query(models.ExternalMemorySource).filter(
                models.ExternalMemorySource.id == source_id
            ).first()
            if src:
                src.status = "error"
                src.error_message = str(exc)[:490]
                db.commit()
        except Exception:
            pass
    finally:
        db.close()


# ── Helper ─────────────────────────────────────────────────────────────────────

def _get_owned(source_id: str, user: models.User, db: Session) -> models.ExternalMemorySource:
    src = db.query(models.ExternalMemorySource).filter(
        models.ExternalMemorySource.id == source_id,
        models.ExternalMemorySource.user_id == str(user.id),
    ).first()
    if not src:
        raise HTTPException(status_code=404, detail="Source not found")
    return src


# ── Scheduled sync (called from main.py) ──────────────────────────────────────

def run_scheduled_sync() -> None:
    """Called by APScheduler every 30 minutes — syncs all active sources."""
    from app.db import SessionLocal

    db = SessionLocal()
    try:
        sources = (
            db.query(models.ExternalMemorySource)
            .filter(models.ExternalMemorySource.status == "active")
            .all()
        )
        for src in sources:
            try:
                _run_sync(str(src.id))
            except Exception as exc:
                logger.warning("scheduled sync failed for %s: %s", src.id, exc)
    finally:
        db.close()
