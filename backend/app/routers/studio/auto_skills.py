"""
REST API for managing auto-extracted skills.

Endpoints:
  GET    /api/v1/auto-skills                  — list (with filters: page, size, approval_status)
  GET    /api/v1/auto-skills/{id}             — get one
  PATCH  /api/v1/auto-skills/{id}             — edit name/description/trigger/approval_status
  DELETE /api/v1/auto-skills/{id}             — delete
  POST   /api/v1/auto-skills/search           — hybrid semantic + BM25 search
  POST   /api/v1/auto-skills/{id}/approve     — quick approve shortcut
  GET    /api/v1/auto-skills/_/stats          — aggregate health stats
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import AutoSkill
from app.auth import get_current_user

router = APIRouter(prefix="/api/v1/auto-skills", tags=["auto-skills"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class AutoSkillUpdate(BaseModel):
    name:             Optional[str]       = None
    description:      Optional[str]       = None
    trigger_pattern:  Optional[str]       = None   # alias exposed to frontend
    trigger_keywords: Optional[list[str]] = None
    tools_required:   Optional[list[str]] = None
    workflow_md:      Optional[str]       = None
    approval_status:  Optional[str]       = None   # pending | approved | rejected
    # legacy
    is_approved:      Optional[bool]      = None


class SearchRequest(BaseModel):
    query:        str
    top_k:        int  = 5
    approved_only: bool = False


class AutoSkillBulkDelete(BaseModel):
    """Bulk-delete selector. Provide `ids` for an explicit set (used by
    'delete selected' / 'delete this page'), or set `all=True` to delete every
    auto-skill matching the optional `approval_status` filter ('delete all')."""
    ids:             Optional[list[str]] = None
    approval_status: Optional[str]       = None   # pending | approved | rejected
    all:             bool                = False


# ── Helpers ───────────────────────────────────────────────────────────────────

def _skill_or_404(skill_id: str, db: Session) -> AutoSkill:
    s = db.query(AutoSkill).filter(AutoSkill.id == skill_id).first()
    if not s:
        raise HTTPException(404, detail="AutoSkill not found")
    return s


def _to_out(s: AutoSkill) -> dict:
    # Derive approval_status: prefer new column, fall back to is_approved
    approval_status = getattr(s, "approval_status", None)
    if not approval_status:
        approval_status = "approved" if s.is_approved else "pending"

    success_count = getattr(s, "success_count", 0) or 0
    fail_count    = getattr(s, "fail_count",    0) or 0
    total         = success_count + fail_count
    avg_success   = round(success_count / total, 4) if total else 0.0

    return {
        "id":               s.id,
        "name":             s.name,
        "description":      s.description,
        "trigger_pattern":  s.name,      # convenience alias for frontend form
        "trigger_keywords": s.trigger_keywords  or [],
        "tools_used":       s.tools_required    or [],   # frontend uses tools_used
        "tools_required":   s.tools_required    or [],
        "workflow_md":      s.workflow_md        or "",
        "steps_template":   [],                          # placeholder for frontend
        "source_task_ids":  s.source_task_ids    or [],
        "use_count":        s.use_count          or 0,
        "success_count":    success_count,
        "fail_count":       fail_count,
        "avg_success_rate": avg_success,
        "approval_status":  approval_status,
        "is_approved":      approval_status == "approved",
        "tenant_id":        s.tenant_id,
        "last_used_at":     getattr(s, "last_used_at", None),
        "created_at":       s.created_at,
        "updated_at":       s.updated_at,
        # Speedup tracking (migration 0040)
        "avg_speedup":      getattr(s, "avg_speedup", None),   # property: None until ≥3 uses
        "assisted_count":   getattr(s, "assisted_count", 0) or 0,
        "baseline_steps":   getattr(s, "baseline_steps", None),
    }


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/_/stats")
def skill_stats(db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Aggregate health statistics for the skill library."""
    from app.services.skill_feedback import get_skill_stats
    return get_skill_stats(db)


@router.get("")
def list_skills(
    page:            int            = Query(1,     ge=1),
    size:            int            = Query(20,    ge=1, le=200),
    approval_status: Optional[str]  = Query(None),
    approved_only:   bool           = Query(False),
    db:              Session        = Depends(get_db),
    user=Depends(get_current_user),
):
    q = db.query(AutoSkill)

    if approval_status:
        q = q.filter(AutoSkill.approval_status == approval_status)
    elif approved_only:
        q = q.filter(AutoSkill.approval_status == "approved")

    total  = q.count()
    offset = (page - 1) * size
    items  = (
        q.order_by(AutoSkill.use_count.desc(), AutoSkill.created_at.desc())
         .offset(offset)
         .limit(size)
         .all()
    )
    pending_count = db.query(AutoSkill).filter(
        AutoSkill.approval_status == "pending"
    ).count()

    return {
        "items":          [_to_out(s) for s in items],
        "total":          total,
        "pending_review": pending_count,
        "page":           page,
        "size":           size,
    }


@router.get("/{skill_id}")
def get_skill(skill_id: str, db: Session = Depends(get_db), user=Depends(get_current_user)):
    return _to_out(_skill_or_404(skill_id, db))


@router.patch("/{skill_id}")
def update_skill(skill_id: str, payload: AutoSkillUpdate, db: Session = Depends(get_db), user=Depends(get_current_user)):
    s = _skill_or_404(skill_id, db)
    data = payload.model_dump(exclude_none=True)

    # Handle approval_status — keep is_approved in sync for backward compat
    if "approval_status" in data:
        status = data.pop("approval_status")
        if status in ("pending", "approved", "rejected"):
            s.approval_status = status
            s.is_approved     = (status == "approved")

    # Handle legacy is_approved flag
    if "is_approved" in data:
        is_app = data.pop("is_approved")
        s.is_approved     = is_app
        s.approval_status = "approved" if is_app else "pending"

    # trigger_pattern is an alias for name from the frontend edit form
    if "trigger_pattern" in data:
        data.pop("trigger_pattern")  # ignore — name is separate field

    for field, value in data.items():
        if hasattr(s, field):
            setattr(s, field, value)

    s.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(s)
    return _to_out(s)


@router.post("/bulk-delete")
def bulk_delete_skills(payload: AutoSkillBulkDelete, db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Delete many auto-skills in one call. Mirror of core (studio/core 双份同改).

    - Pass `ids` to delete a specific set (selected rows / current page).
    - Pass `all=true` (optionally with `approval_status`) to delete every match.

    Approved skills promoted to the git skills-repo are removed best-effort.
    Refuses to run when neither `ids` nor `all` is supplied.
    """
    if not payload.ids and not payload.all:
        raise HTTPException(
            status_code=400,
            detail="Provide `ids` or set `all=true` (optionally with approval_status).",
        )

    q = db.query(AutoSkill)
    if payload.ids:
        q = q.filter(AutoSkill.id.in_(payload.ids))
    elif payload.approval_status:  # all=True + optional status filter
        q = q.filter(AutoSkill.approval_status == payload.approval_status)

    rows = q.all()
    deleted_ids = [s.id for s in rows]
    approved_names = [
        s.name for s in rows
        if getattr(s, "approval_status", None) == "approved" or s.is_approved
    ]
    deleted = len(rows)

    for s in rows:
        db.delete(s)
    db.commit()

    git_removed = 0
    try:
        from app.services import skills_repo
        if skills_repo.is_enabled():
            for name in approved_names:
                try:
                    skills_repo.remove_skill(
                        skills_repo.auto_skill_id(name),
                        message=f"bulk-delete auto-skill: {name} (by {getattr(user, 'username', 'studio')})",
                    )
                    git_removed += 1
                except Exception:
                    pass  # per-skill git cleanup is best-effort
    except Exception:
        pass  # skills-repo unavailable — DB rows already gone

    return {"deleted": deleted, "ids": deleted_ids, "git_removed": git_removed}


@router.delete("/{skill_id}")
def delete_skill(skill_id: str, db: Session = Depends(get_db), user=Depends(get_current_user)):
    s = _skill_or_404(skill_id, db)
    db.delete(s)
    db.commit()
    return {"deleted": True, "id": skill_id}


@router.post("/search")
def search_skills(req: SearchRequest, db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Hybrid BM25 + vector semantic search over the skill library."""
    from app.services.skill_extractor import search_relevant_skills
    results = search_relevant_skills(
        prompt=req.query,
        db=db,
        top_k=req.top_k,
        approved_only=req.approved_only,
    )
    return {"items": results, "count": len(results)}


@router.post("/{skill_id}/approve")
def approve_skill(skill_id: str, db: Session = Depends(get_db), user=Depends(get_current_user)):
    s = _skill_or_404(skill_id, db)
    s.is_approved     = True
    s.approval_status = "approved"
    s.updated_at      = datetime.utcnow()
    db.commit()

    # Plan A (option A): an auto-extracted skill lives in the DB as a *candidate*
    # until approved. On approval, promote it to the canonical git skills repo so
    # the goku-core runtime can pick it up. Best-effort — surface git errors but
    # keep the DB approval (it can be re-pushed).
    promoted = None
    try:
        from app.services import skills_repo
        if skills_repo.is_enabled():
            sid = skills_repo.auto_skill_id(s.name)
            promoted = skills_repo.write_skill(
                sid,
                {"SKILL.md": skills_repo.build_skill_md(s)},
                message=f"approve auto-skill: {s.name} (by {getattr(user, 'username', 'studio')})",
            )
    except Exception as e:  # noqa: BLE001
        import logging
        logging.getLogger(__name__).error("Promote auto-skill '%s' to git failed: %s", s.name, e)
        promoted = {"ok": False, "error": str(e)[:200]}

    return {"approved": True, "id": skill_id, "name": s.name, "promoted": promoted}
