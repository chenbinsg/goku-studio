"""Skill 库 endpoints — proxied to goku-core.

Unlike the other Studio domain routers, this one holds no logic of its own. The
Skill 库 has exactly one implementation (`skills_store` in core), and every rule
that matters lives inside it: code uniqueness among live rows, frontmatter
validation, the unbind-then-soft-delete sequence, append-only revisions.

A second copy here would be a second set of those rules to keep in step, and the
first one to drift would corrupt the shared table quietly — both services write
the same database. So Studio relays instead, exactly as it already does for the
MCP live-connection routes.

Auto Skill candidates keep their own local router (`auto_skills.py`); only the
library is proxied.

See docs/DESIGN-skill-management.md §15 (in goku-core).
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel

from app.auth import get_current_user
from app.services import core_runtime_proxy as proxy

router = APIRouter(prefix="/api/v1/skills", tags=["skills"])

_PURPOSE = "Skill 库读写"


class SkillCreate(BaseModel):
    code: str
    name: str
    content: str
    description: str = ""
    category: Optional[str] = None
    status: str = "active"
    auto_injectable: bool = False


class SkillUpdate(BaseModel):
    code: Optional[str] = None
    name: Optional[str] = None
    content: Optional[str] = None
    description: Optional[str] = None
    category: Optional[str] = None
    auto_injectable: Optional[bool] = None
    message: Optional[str] = None


class StatusIn(BaseModel):
    status: str


class ReviewIn(BaseModel):
    reason: str = ""


class ExportIn(BaseModel):
    ids: Optional[list[str]] = None
    all: bool = False
    include_deleted: bool = False


class ImportIn(BaseModel):
    skills: list[dict]
    on_conflict: str = "update"
    dry_run: bool = False


def _qs(**kw) -> str:
    parts = [f"{k}={v}" for k, v in kw.items() if v is not None and v != ""]
    return ("?" + "&".join(parts)) if parts else ""


# ── list / create ─────────────────────────────────────────────────────────────

@router.get("")
async def list_skills(
    request: Request,
    status: Optional[str] = Query(None),
    keyword: Optional[str] = None,
    category: Optional[str] = None,
    include_deleted: bool = False,
    user=Depends(get_current_user),
):
    q = _qs(status=status, keyword=keyword, category=category,
            include_deleted=str(include_deleted).lower())
    return await proxy.get_from_core(request, f"/api/v1/skills{q}", purpose=_PURPOSE)


@router.post("")
async def create_skill(payload: SkillCreate, request: Request, user=Depends(get_current_user)):
    return await proxy.post_to_core(
        request, "/api/v1/skills", payload.model_dump(), purpose=_PURPOSE
    )


# ── export / import (before /{skill_id} so they are not read as ids) ──────────

@router.post("/export")
async def export_skills(payload: ExportIn, request: Request, user=Depends(get_current_user)):
    return await proxy.post_to_core(
        request, "/api/v1/skills/export", payload.model_dump(), purpose=_PURPOSE
    )


@router.post("/import")
async def import_skills(payload: ImportIn, request: Request, user=Depends(get_current_user)):
    return await proxy.post_to_core(
        request, "/api/v1/skills/import", payload.model_dump(), purpose=_PURPOSE
    )


# ── single skill ──────────────────────────────────────────────────────────────

@router.get("/{skill_id}")
async def get_skill(skill_id: str, request: Request, user=Depends(get_current_user)):
    return await proxy.get_from_core(request, f"/api/v1/skills/{skill_id}", purpose=_PURPOSE)


@router.patch("/{skill_id}")
async def update_skill(
    skill_id: str, payload: SkillUpdate, request: Request, user=Depends(get_current_user)
):
    # exclude_none so a metadata-only edit does not arrive looking like a
    # content change — core bumps the version whenever `content` is present.
    return await proxy.patch_to_core(
        request, f"/api/v1/skills/{skill_id}",
        payload.model_dump(exclude_none=True), purpose=_PURPOSE,
    )


@router.post("/{skill_id}/status")
async def set_status(
    skill_id: str, payload: StatusIn, request: Request, user=Depends(get_current_user)
):
    return await proxy.post_to_core(
        request, f"/api/v1/skills/{skill_id}/status", payload.model_dump(), purpose=_PURPOSE
    )


@router.delete("/{skill_id}")
async def delete_skill(skill_id: str, request: Request, user=Depends(get_current_user)):
    """Soft delete. The receipt (which agents were unbound) is relayed back —
    the page needs it to say what the deletion cost."""
    return await proxy.delete_from_core(
        request, f"/api/v1/skills/{skill_id}", purpose=_PURPOSE
    )


@router.get("/{skill_id}/usage")
async def get_usage(skill_id: str, request: Request, user=Depends(get_current_user)):
    return await proxy.get_from_core(
        request, f"/api/v1/skills/{skill_id}/usage", purpose=_PURPOSE
    )


# ── revisions ─────────────────────────────────────────────────────────────────

@router.get("/{skill_id}/revisions")
async def list_revisions(skill_id: str, request: Request, user=Depends(get_current_user)):
    return await proxy.get_from_core(
        request, f"/api/v1/skills/{skill_id}/revisions", purpose=_PURPOSE
    )


@router.get("/{skill_id}/revisions/{version}")
async def get_revision(
    skill_id: str, version: int, request: Request, user=Depends(get_current_user)
):
    return await proxy.get_from_core(
        request, f"/api/v1/skills/{skill_id}/revisions/{version}", purpose=_PURPOSE
    )


@router.post("/{skill_id}/revisions/{version}/rollback")
async def rollback(
    skill_id: str, version: int, request: Request, user=Depends(get_current_user)
):
    return await proxy.post_to_core(
        request, f"/api/v1/skills/{skill_id}/revisions/{version}/rollback",
        None, purpose=_PURPOSE,
    )


@router.get("/{skill_id}/revisions/{version}/export")
async def export_revision(
    skill_id: str, version: int, request: Request, user=Depends(get_current_user)
):
    return await proxy.get_from_core(
        request, f"/api/v1/skills/{skill_id}/revisions/{version}/export", purpose=_PURPOSE
    )


# ── review ────────────────────────────────────────────────────────────────────
# Held-back versions are decided in Core; these exist so the Studio host serves
# the same surface. A route missing here is not a degraded feature — the page
# calls it and gets a 404, so the review simply cannot be completed in
# production while it works locally against Core.

@router.post("/{skill_id}/review/{version}/approve")
async def approve_review(
    skill_id: str, version: int, request: Request, user=Depends(get_current_user)
):
    return await proxy.post_to_core(
        request, f"/api/v1/skills/{skill_id}/review/{version}/approve",
        None, purpose=_PURPOSE,
    )


@router.post("/{skill_id}/review/{version}/reject")
async def reject_review(
    skill_id: str, version: int, payload: ReviewIn, request: Request,
    user=Depends(get_current_user),
):
    return await proxy.post_to_core(
        request, f"/api/v1/skills/{skill_id}/review/{version}/reject",
        payload.model_dump(), purpose=_PURPOSE,
    )


@router.post("/{skill_id}/review/{version}/withdraw")
async def withdraw_review(
    skill_id: str, version: int, request: Request, user=Depends(get_current_user)
):
    return await proxy.post_to_core(
        request, f"/api/v1/skills/{skill_id}/review/{version}/withdraw",
        None, purpose=_PURPOSE,
    )
