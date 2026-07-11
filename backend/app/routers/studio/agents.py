"""
Agent Definition CRUD API — create and manage custom agent definitions.
"""
import base64
import json
import mimetypes
import re
import uuid
import zipfile
from datetime import datetime
from io import BytesIO
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app import auth
from app.auth import get_current_user
from app.db import get_db

router = APIRouter(prefix="/api/v1/agents", tags=["agents"])
EXPORT_VERSION = "1.0"
_ICON_EXTS = {".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif"}


class AgentDefinitionCreate(BaseModel):
    name: str
    description: str | None = None
    agent_type: str
    department: str | None = None
    division: str | None = None
    category: str | None = None
    figure_url: str | None = None
    system_prompt_override: str | None = None
    skills: list[str] | None = None
    allowed_tools: list[str] | None = None
    model_override: str | None = None
    max_steps: int | None = Field(None, ge=1, le=100)
    icon: str | None = None
    color: str | None = None
    name_i18n: dict | None = None
    # Access control
    visibility: str | None = "department"   # public | department | role_based | private
    allowed_roles: list[str] | None = None  # list of Role.id; used when visibility='role_based'
    # Communication channel fields
    display_name: str | None = None
    notification_channels: list[dict] | None = None
    escalation_contact: dict | None = None
    allowed_channels: list[str] | None = None
    channel_configs: dict | None = None
    dlp_bypass: bool | None = None


class AgentDefinitionUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    department: str | None = None
    division: str | None = None
    category: str | None = None
    figure_url: str | None = None
    system_prompt_override: str | None = None
    skills: list[str] | None = None
    allowed_tools: list[str] | None = None
    model_override: str | None = None
    max_steps: int | None = Field(None, ge=1, le=100)
    icon: str | None = None
    color: str | None = None
    is_active: bool | None = None
    name_i18n: dict | None = None
    # Access control
    visibility: str | None = None
    allowed_roles: list[str] | None = None
    # Communication channel fields
    display_name: str | None = None
    notification_channels: list[dict] | None = None
    escalation_contact: dict | None = None
    allowed_channels: list[str] | None = None
    channel_configs: dict | None = None
    dlp_bypass: bool | None = None


class AgentImportResult(BaseModel):
    id: str
    name: str
    imported_at: str
    action: str = "created"
    slug: str | None = None


class AgentBatchExportRequest(BaseModel):
    agent_ids: list[str] = Field(default_factory=list)


class BulkAssignItem(BaseModel):
    agent_id: str
    division: str | None = None
    department: str | None = None


class BulkAssignRequest(BaseModel):
    assignments: list[BulkAssignItem]


# ── Bulk-assign endpoints ─────────────────────────────────────────────────────

@router.post("/bulk-assign")
def bulk_assign_agents(
    payload: BulkAssignRequest,
    user=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Batch-set division and/or department for multiple agents.

    Only agents belonging to the current user's tenant are updated.
    Requires admin or superuser privileges.
    """
    if not (getattr(user, "is_superuser", False) or getattr(user, "role", "") == "admin"):
        raise HTTPException(status_code=403, detail="Admin privileges required")

    from app.services.org_service import apply_bulk_assign

    assignments = [
        {
            "agent_id": item.agent_id,
            "division": item.division,
            "department": item.department,
        }
        for item in payload.assignments
    ]
    result = apply_bulk_assign(assignments, db)
    return result


@router.post("/bulk-assign/csv")
def bulk_assign_agents_csv(
    file: UploadFile = File(...),
    user=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Batch-set division and department for agents via CSV upload.

    CSV must have columns: agent_id, division, department
    Encoding: UTF-8 (BOM OK) or CP932 (Shift-JIS for Japanese HR systems).
    Requires admin or superuser privileges.
    """
    if not (getattr(user, "is_superuser", False) or getattr(user, "role", "") == "admin"):
        raise HTTPException(status_code=403, detail="Admin privileges required")

    from app.services.org_service import apply_bulk_assign, parse_bulk_assign_csv

    content = file.file.read()
    assignments = parse_bulk_assign_csv(content)
    if not assignments:
        raise HTTPException(status_code=422, detail="No valid rows found in CSV")

    result = apply_bulk_assign(assignments, db)
    result["parsed_rows"] = len(assignments)
    return result


@router.get("/mcp-tool-options")
def list_mcp_tool_options(db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Live MCP capability options for the agent "授权工具" selector.

    Sourced directly from ``mcp_capabilities`` (active capabilities on enabled,
    non-deleted servers), NOT from the ``tools`` table — so a freshly-synced
    capability shows up immediately. Names use the runtime form
    ``<server.code>__<capability_name>`` that goes into ``allowed_tools``."""
    from app.models_studio import MCPCapability, MCPServer
    rows = (
        db.query(MCPServer.code, MCPCapability.capability_name, MCPCapability.description)
        .join(MCPCapability, MCPCapability.server_id == MCPServer.id)
        .filter(
            MCPCapability.status == "active",
            MCPServer.status == "enabled",
            MCPServer.deleted_at.is_(None),
        )
        .order_by(MCPServer.code, MCPCapability.capability_name)
        .all()
    )
    return {
        "tools": [
            {"name": f"{code}__{cap_name}", "description": desc or "", "server": code}
            for code, cap_name, desc in rows
        ]
    }


@router.get("/base-types")
def list_base_types(user = Depends(get_current_user)):
    """Return all built-in agent types available as base for custom agents."""
    from app.agent.subagent_config import SUBAGENT_TYPES
    return {
        "agent_types": [
            {
                "key": k,
                "label": v.get("label", k),
                "icon": v.get("icon"),
                "color": v.get("color"),
                "max_steps": v.get("max_steps"),
                "tools": v.get("tools", []),
            }
            for k, v in SUBAGENT_TYPES.items()
        ]
    }


def _skills_root() -> Path:
    """Return the directory that holds skill definitions (``<id>/SKILL.md``).

    Skills are owned by the goku-core runtime and live at ``goku/core/skills/``.
    This Studio service is a sibling checkout of goku-core
    (``…/goku/studio`` ↔ ``…/goku/core``), so by default we resolve to the
    sibling ``core/skills``. In container deployments where goku-core's skills are
    mounted elsewhere, set ``SKILLS_ROOT`` to point at that path.

    NOTE on depth: this module lives at backend/app/routers/studio/agents.py, so
    ``parents[4]`` is this repo's root (``…/goku/studio``) and ``parents[5]`` is
    ``…/goku``. A previous bug used ``parents[3] / "skills"`` (→ nonexistent
    ``backend/skills``), making _discover_skills() return [] and silently wiping
    every agent's skills on save (see 海报设计师 incident, 2026-06-10).
    """
    import os
    # Plan A: when a canonical git skills repo is configured, read from the
    # writable clone Studio maintains (it is the sole committer). Falls through to
    # the legacy sibling/SKILLS_ROOT path when git is disabled.
    try:
        from app.services import skills_repo
        clone = skills_repo.clone_path_or_none()
        if clone is not None:
            return clone
    except Exception:
        pass
    override = os.environ.get("SKILLS_ROOT")
    if override:
        return Path(override)
    return Path(__file__).resolve().parents[5] / "core" / "skills"


def _icons_root() -> Path:
    """Return the persistent icons directory.

    Uses the agent workspace volume so custom icons survive Docker image updates.
    Falls back to frontend/public/icons for local dev environments without AGENT_WORKSPACE.
    """
    import os
    workspace = os.environ.get("AGENT_WORKSPACE")
    if workspace:
        return Path(workspace) / "icons"
    return Path(__file__).resolve().parents[3] / "frontend" / "public" / "icons"


def _slugify_filename(text: str) -> str:
    safe = re.sub(r"[^\w\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff-]+", "-", (text or "").strip(), flags=re.UNICODE)
    safe = re.sub(r"-{2,}", "-", safe).strip("-_.")
    return safe or "agent"


def _make_unique_agent_slug(db: Session, model, name: str, agent_id: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-") or agent_id[:8]
    base = base[:100].strip("-") or agent_id[:8]
    candidate = base
    counter = 1
    while db.query(model).filter(model.slug == candidate).first():
        suffix = agent_id[:8] if counter == 1 else f"{agent_id[:8]}-{counter}"
        candidate = f"{base[: max(1, 99 - len(suffix))]}-{suffix}".strip("-")
        counter += 1
    return candidate


def _attachment_disposition(filename: str) -> str:
    fallback = re.sub(r"[^A-Za-z0-9._-]+", "-", filename).strip("-_.") or "agent.agent.json"
    encoded = quote(filename, safe="")
    return f'attachment; filename="{fallback}"; filename*=UTF-8\'\'{encoded}'


def _uploads_root() -> Path:
    """Return the workspace/uploads directory (mirrors UPLOAD_DIR in uploads router)."""
    from app.routers.studio.uploads import UPLOAD_DIR  # lazy import to avoid circular deps
    return Path(UPLOAD_DIR)


def _persist_figure_to_icons(figure_url: str | None, agent_slug: str) -> str | None:
    """
    Copy a workspace upload into the persistent icons directory and return a
    stable /icons/<uuid>.<ext> URL.

    Using the upload UUID (not the agent slug) as the filename means:
    - No CJK / special-character encoding problems in filenames.
    - Renaming the agent never orphans the icon file.
    - Idempotent: re-saving the same agent leaves the file unchanged.

    Returns the original URL unchanged when it already starts with /icons/,
    is an Ant Design icon name, or is None.
    """
    if not figure_url or not figure_url.startswith("/api/v1/uploads/"):
        return figure_url
    # Extract the UUID from /api/v1/uploads/{uuid}/public  (or /api/v1/uploads/{uuid})
    parts = figure_url.rstrip("/").split("/")
    if len(parts) < 2:
        return figure_url
    file_id = parts[-2] if parts[-1] == "public" else parts[-1]
    uploads_dir = _uploads_root()
    matches = list(uploads_dir.glob(f"{file_id}.*"))
    if not matches:
        return figure_url  # upload not found — keep the upload URL as-is
    src = matches[0]
    ext = src.suffix.lower()
    if ext not in _ICON_EXTS:
        return figure_url
    icons_root = _icons_root()
    icons_root.mkdir(parents=True, exist_ok=True)
    # Filename = upload UUID, independent of agent name/slug
    target_name = f"{file_id}{ext}"
    target = icons_root / target_name
    import shutil
    shutil.copy2(src, target)
    return f"/icons/{target_name}"


def _resolve_figure_path(figure_url: str | None) -> Path | None:
    """Return the local filesystem Path for a figure_url, or None if not resolvable."""
    if not figure_url:
        return None
    if figure_url.startswith("/icons/"):
        path = _icons_root() / figure_url.rsplit("/", 1)[-1]
        return path if path.exists() else None
    if figure_url.startswith("/api/v1/uploads/"):
        # /api/v1/uploads/{uuid}/public  →  workspace/uploads/{uuid}.*
        parts = figure_url.rstrip("/").split("/")
        file_id = parts[-2] if parts[-1] == "public" else parts[-1]
        matches = list(_uploads_root().glob(f"{file_id}.*"))
        return matches[0] if matches else None
    return None


def _build_export_payload(agent) -> dict:
    figure_asset = None
    figure_path = _resolve_figure_path(getattr(agent, "figure_url", None))
    if figure_path and figure_path.suffix.lower() in _ICON_EXTS:
        mime_type = mimetypes.guess_type(figure_path.name)[0] or "application/octet-stream"
        figure_asset = {
            "filename": figure_path.name,
            "content_type": mime_type,
            "base64": base64.b64encode(figure_path.read_bytes()).decode("ascii"),
        }
    return {
        "schema": "aios.agent-export",
        "version": EXPORT_VERSION,
        "exported_at": datetime.utcnow().isoformat() + "Z",
        "agent": {
            "name": agent.name,
            "slug": getattr(agent, "slug", None),
            "description": agent.description,
            "agent_type": agent.agent_type,
            "department": agent.department,
            "division": getattr(agent, "division", None),
            "category": getattr(agent, "category", None),
            "figure_url": agent.figure_url,
            "system_prompt_override": agent.system_prompt_override,
            "skills": agent.skills or [],
            "allowed_tools": agent.allowed_tools,
            "model_override": agent.model_override,
            "max_steps": agent.max_steps,
            "icon": agent.icon,
            "color": agent.color,
            "is_active": agent.is_active,
            "visibility": getattr(agent, "visibility", None) or "department",
            "allowed_roles": getattr(agent, "allowed_roles", None) or [],
        },
        "figure_asset": figure_asset,
    }


def _load_import_payload(file: UploadFile) -> dict:
    raw = file.file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Uploaded import file is empty")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid import JSON: {exc}") from exc
    if payload.get("schema") != "aios.agent-export":
        raise HTTPException(status_code=400, detail="Unsupported import schema")
    if not isinstance(payload.get("agent"), dict):
        raise HTTPException(status_code=400, detail="Import payload is missing agent data")
    return payload


def _write_imported_figure(agent_name: str, figure_asset: dict | None) -> str | None:
    if not figure_asset:
        return None
    filename = figure_asset.get("filename") or "agent-icon"
    ext = Path(filename).suffix.lower()
    if ext not in _ICON_EXTS:
        raise HTTPException(status_code=400, detail=f"Unsupported figure asset type: {ext or 'unknown'}")
    try:
        content = base64.b64decode(figure_asset.get("base64") or "", validate=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid figure asset encoding: {exc}") from exc
    icons_root = _icons_root()
    icons_root.mkdir(parents=True, exist_ok=True)
    # Always use a fresh UUID so the filename is encoding-safe and never collides,
    # regardless of the agent name/slug.
    target_name = f"{uuid.uuid4().hex}{ext}"
    target = icons_root / target_name
    target.write_bytes(content)
    return f"/icons/{target_name}"


def _discover_skills() -> list[dict]:
    root = _skills_root()
    if not root.exists():
        return []
    skills = []
    for skill_md in sorted(root.glob("*/SKILL.md")):
        skill_id = skill_md.parent.name
        text = skill_md.read_text(encoding="utf-8", errors="ignore")
        name = skill_id
        description = ""
        if text.startswith("---"):
            parts = text.split("---", 2)
            if len(parts) >= 3:
                for line in parts[1].splitlines():
                    if line.startswith("name:"):
                        name = line.split(":", 1)[1].strip()
                    elif line.startswith("description:"):
                        description = line.split(":", 1)[1].strip()
        skills.append({
            "id": skill_id,
            "name": name,
            "description": description,
            "path": str(skill_md),
        })
    return skills


def _valid_skill_ids() -> set[str]:
    return {skill["id"] for skill in _discover_skills()}


def _filter_valid_skills(skills) -> list[str]:
    """Filter submitted skill ids against the discoverable skill set — fail-safe.

    If the skill directory is missing or misconfigured (empty valid set), return
    the submitted ids UNCHANGED rather than wiping them. This Studio service does
    not own the skill files (the goku-core runtime does), so an empty discovery
    means "cannot validate here", not "all skills are invalid". Silently stripping
    would destroy every agent's skill bindings on every save — exactly the
    海报设计师 regression. Validation is best-effort; never destructive.
    """
    submitted = [s for s in (skills or []) if s]
    valid = _valid_skill_ids()
    if not valid:
        return submitted
    return [s for s in submitted if s in valid]


def _filter_allowed_tools(tools, base_tools=None):
    """Normalize the submitted allowed_tools: drop blanks and duplicates but
    otherwise store the value as-is. The agent editor already constrains choices
    to registry tools, MCP capabilities (``<server>__<capability>``) and
    directives (``@mcp:none``); unknown names are harmless (ignored at execution).
    Replaces the old "subset of base-type tools" rule, which silently dropped MCP
    capabilities and cross-type tools."""
    seen, out = set(), []
    for t in (tools or []):
        if isinstance(t, str) and t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


@router.get("/email-pending-counts")
def get_email_pending_counts(
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """
    Return a mapping of {agent_slug: pending_email_count} for all agents
    that have draft_ready incoming emails awaiting approval.
    Used to show notification badges on Agent tiles.
    """
    from sqlalchemy import func

    from app.models import IncomingEmail, IncomingEmailStatus

    rows = (
        db.query(IncomingEmail.assigned_agent, func.count(IncomingEmail.id))
        .filter(IncomingEmail.status == IncomingEmailStatus.DRAFT_READY)
        .group_by(IncomingEmail.assigned_agent)
        .all()
    )
    return {"counts": {slug: count for slug, count in rows if slug}}


@router.get("/skills")
def list_agent_skills(user = Depends(get_current_user)):
    """Return skills available for Agent binding from the shared skills directory."""
    return {
        "root": str(_skills_root()),
        "skills": _discover_skills(),
    }


def _agent_access_filter(query, user, db):
    """Apply access control to an AgentDefinition query.

    Resolution order (non-superuser only):
      Layer A — legacy visibility field:
        1. public     — always visible
        2. private    — visible only to creator (user_id match)
        3. department — visible if user's department(s) match agent's department
        4. role_based — visible if user holds at least one of agent's allowed_roles

      Layer B — agent_access_policies table (DefaultDeny override):
        If ANY active policy grants can_view=True to the user (directly, via
        team, department or tenant-wide), the agent is visible regardless of
        the visibility field above.

    Superusers bypass all checks and see every agent.
    """
    from datetime import datetime

    from sqlalchemy import or_

    from app.models import AgentAccessPolicy, AgentDefinition, UserDepartment, UserRole

    if user.is_superuser:
        return query  # no filter

    # Tenant isolation
    user_tenant = getattr(user, "tenant_id", None)
    if user_tenant:
        query = query.filter(AgentDefinition.tenant_id == user_tenant)

    # Collect user's departments
    user_depts = [ud.department for ud in db.query(UserDepartment).filter(
        UserDepartment.user_id == user.id).all()]
    if not user_depts:
        legacy = getattr(user, "department", None)
        if legacy:
            user_depts = [legacy]

    # Collect user's role IDs
    user_role_ids = [ur.role_id for ur in db.query(UserRole).filter(
        UserRole.user_id == user.id).all()]

    # ── Layer A: legacy visibility clauses ────────────────────────────────────
    clauses = [
        # 1. public — visible to everyone in the tenant
        AgentDefinition.visibility == 'public',
        # 2. private — only creator sees it
        AgentDefinition.user_id == user.id,
    ]

    # 3. department — user is in the agent's department
    if user_depts:
        clauses.append(
            (AgentDefinition.visibility == 'department') &
            AgentDefinition.department.in_(user_depts)
        )
    else:
        # No department assigned: user sees department agents only if
        # the agent has no department set (legacy null = anyone)
        clauses.append(
            (AgentDefinition.visibility == 'department') &
            AgentDefinition.department.is_(None)
        )

    # 4. role_based — user holds at least one of the allowed roles
    if user_role_ids:
        role_clauses = []
        for rid in user_role_ids:
            role_clauses.append(
                (AgentDefinition.visibility == 'role_based') &
                AgentDefinition.allowed_roles.contains([rid])
            )
        if role_clauses:
            clauses.append(or_(*role_clauses))

    # ── Layer B: agent_access_policies — per-principal grant (DefaultDeny) ────
    # Build principal list: (type, id) pairs covering user / team / dept / tenant
    principal_checks = [("user", user.id)]
    if getattr(user, "team_id", None):
        principal_checks.append(("team", user.team_id))
    for dept in user_depts:
        principal_checks.append(("department", dept))
    if user_tenant:
        principal_checks.append(("tenant", user_tenant))

    from sqlalchemy import and_
    now = datetime.utcnow()
    policy_clauses = []
    for ptype, pid in principal_checks:
        policy_clauses.append(
            and_(
                AgentAccessPolicy.principal_type == ptype,
                AgentAccessPolicy.principal_id == pid,
                AgentAccessPolicy.can_view == True,  # noqa: E712
                or_(
                    AgentAccessPolicy.expires_at.is_(None),
                    AgentAccessPolicy.expires_at > now,
                ),
            )
        )

    if policy_clauses:
        # Agents that have an active policy granting view to this user
        policy_sq = (
            db.query(AgentAccessPolicy.agent_id)
            .filter(or_(*policy_clauses))
            .subquery()
        )
        clauses.append(AgentDefinition.id.in_(policy_sq))

    query = query.filter(or_(*clauses))
    return query


def _user_principals(user, db):
    """Return the list of (principal_type, principal_id) pairs identifying a user
    for agent_access_policies resolution: self, team, each department, tenant."""
    from app.models import UserDepartment

    user_depts = [ud.department for ud in db.query(UserDepartment).filter(
        UserDepartment.user_id == user.id).all()]
    if not user_depts:
        legacy = getattr(user, "department", None)
        if legacy:
            user_depts = [legacy]

    principals = [("user", user.id)]
    if getattr(user, "team_id", None):
        principals.append(("team", user.team_id))
    for dept in user_depts:
        principals.append(("department", dept))
    if getattr(user, "tenant_id", None):
        principals.append(("tenant", user.tenant_id))
    return principals


def _policy_flag_sets(agent_ids, user, db):
    """Batch-resolve which of the given agents grant can_use / can_config to the
    user via an active policy. Returns (use_set, config_set)."""
    from datetime import datetime as _dt

    from sqlalchemy import and_, or_

    from app.models import AgentAccessPolicy

    use_set: set[str] = set()
    config_set: set[str] = set()
    if not agent_ids:
        return use_set, config_set

    now = _dt.utcnow()
    principal_clauses = [
        and_(AgentAccessPolicy.principal_type == ptype,
             AgentAccessPolicy.principal_id == pid)
        for ptype, pid in _user_principals(user, db)
    ]
    rows = db.query(
        AgentAccessPolicy.agent_id,
        AgentAccessPolicy.can_use,
        AgentAccessPolicy.can_config,
    ).filter(
        AgentAccessPolicy.agent_id.in_(agent_ids),
        or_(*principal_clauses),
        or_(AgentAccessPolicy.expires_at.is_(None),
            AgentAccessPolicy.expires_at > now),
    ).all()
    for aid, can_use, can_config in rows:
        if can_use:
            use_set.add(aid)
        if can_config:
            config_set.add(aid)
    return use_set, config_set


def _user_can_config(user, agent, db) -> bool:
    """Whether the user may edit/delete this agent.

    True for superusers, the agent's creator, or any user holding an active
    policy with can_config=True via self / team / department / tenant. This is
    the enforcement counterpart to the can_config field — the gallery exposes
    agents for use, but editing stays gated here (see DefaultDeny model)."""
    if getattr(user, "is_superuser", False):
        return True
    if getattr(agent, "user_id", None) and agent.user_id == user.id:
        return True
    _, config_set = _policy_flag_sets([agent.id], user, db)
    return agent.id in config_set


@router.get("")
def list_agents(
    page: int = 1,
    size: int = 50,
    is_active: bool | None = None,
    favorites_only: bool = False,
    db: Session = Depends(get_db),
    user = Depends(get_current_user),
):
    from app.models import AgentDefinition, UserAgentFavorite
    query = db.query(AgentDefinition)
    if is_active is not None:
        query = query.filter(AgentDefinition.is_active == is_active)

    # Apply visibility-based access control
    query = _agent_access_filter(query, user, db)

    if favorites_only:
        fav_ids = [f.agent_id for f in db.query(UserAgentFavorite).filter(
            UserAgentFavorite.user_id == user.id).all()]
        query = query.filter(AgentDefinition.id.in_(fav_ids))

    query = query.order_by(AgentDefinition.created_at.desc())
    total = query.count()
    items = query.offset((page - 1) * size).limit(size).all()

    # Attach favorite flag
    fav_set = {f.agent_id for f in db.query(UserAgentFavorite).filter(
        UserAgentFavorite.user_id == user.id).all()}

    # Resolve per-user can_use / can_config flags (for the agent gallery) in one
    # batch query rather than N policy lookups.
    is_super = bool(getattr(user, "is_superuser", False))
    use_set, config_set = (set(), set()) if is_super else _policy_flag_sets(
        [a.id for a in items], user, db)

    result = []
    for a in items:
        s = _serialize(a)
        s['is_favorite'] = a.id in fav_set
        is_creator = bool(a.user_id) and a.user_id == user.id
        # Legacy visibility (public/department/role) granted full use; only the
        # policy layer introduces view-only. Private agents rely on a use grant.
        legacy_usable = (s.get('visibility') in ('public', 'department', 'role_based'))
        s['can_use'] = is_super or is_creator or legacy_usable or a.id in use_set
        s['can_config'] = is_super or is_creator or a.id in config_set
        result.append(s)

    return {"total": total, "items": result}


# ── Favorites endpoints ────────────────────────────────────────────────────────

@router.post("/{agent_id}/favorite", status_code=200)
def toggle_favorite(
    agent_id: str,
    db: Session = Depends(get_db),
    user = Depends(get_current_user),
):
    """Toggle pin/unpin an agent for the current user.
    Returns {"favorited": true/false}."""
    from datetime import datetime as _dt

    from app.models import AgentDefinition, UserAgentFavorite

    # Verify agent exists and user can see it
    q = db.query(AgentDefinition).filter(AgentDefinition.id == agent_id)
    q = _agent_access_filter(q, user, db)
    agent = q.first()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found or not accessible")

    existing = db.query(UserAgentFavorite).filter(
        UserAgentFavorite.user_id == user.id,
        UserAgentFavorite.agent_id == agent_id,
    ).first()

    if existing:
        db.delete(existing)
        db.commit()
        return {"favorited": False, "agent_id": agent_id}
    else:
        db.add(UserAgentFavorite(user_id=user.id, agent_id=agent_id, pinned_at=_dt.utcnow()))
        db.commit()
        return {"favorited": True, "agent_id": agent_id}


@router.get("/favorites")
def list_favorites(
    db: Session = Depends(get_db),
    user = Depends(get_current_user),
):
    """Return the current user's pinned agents (sorted by pinned_at desc)."""
    from app.models import AgentDefinition, UserAgentFavorite
    rows = (
        db.query(UserAgentFavorite)
        .filter(UserAgentFavorite.user_id == user.id)
        .order_by(UserAgentFavorite.pinned_at.desc())
        .all()
    )
    agent_ids = [r.agent_id for r in rows]
    if not agent_ids:
        return {"items": []}

    agents = db.query(AgentDefinition).filter(AgentDefinition.id.in_(agent_ids)).all()
    agent_map = {a.id: a for a in agents}
    result = []
    for r in rows:
        a = agent_map.get(r.agent_id)
        if a:
            s = _serialize(a)
            s['is_favorite'] = True
            s['pinned_at'] = r.pinned_at.isoformat() if r.pinned_at else None
            result.append(s)
    return {"items": result}


@router.post("")
def create_agent(
    data: AgentDefinitionCreate,
    db: Session = Depends(get_db),
    user = Depends(get_current_user),
):
    from app.agent.subagent_config import SUBAGENT_TYPES
    from app.models import AgentDefinition

    if data.agent_type not in SUBAGENT_TYPES:
        raise HTTPException(status_code=400, detail=f"Unknown base agent type: {data.agent_type}")

    base = SUBAGENT_TYPES[data.agent_type]
    # allowed_tools must be a subset of the base type's tools
    if data.allowed_tools is not None:
        data.allowed_tools = _filter_allowed_tools(data.allowed_tools, base["tools"])
    if data.skills is not None:
        data.skills = _filter_valid_skills(data.skills)

    # If the icon field holds an image path (starts with '/'), normalise: move it to
    # figure_url and reset icon to a sensible Ant Design name.  This prevents the
    # recurring bug where image URLs end up in the wrong field on export/import.
    if data.icon and data.icon.startswith("/"):
        if not data.figure_url:
            data.figure_url = data.icon
        data.icon = None  # will fall back to base.get("icon") below

    # Generate slug from name (used as seed key — NOT used for icon filenames any more)
    new_agent_id = str(uuid.uuid4())
    from app.models import AgentDefinition as _AD
    agent_slug = _make_unique_agent_slug(db, _AD, data.name, new_agent_id)

    # Persist uploaded icon to git-tracked /icons/ dir so it survives git pull
    persisted_figure_url = _persist_figure_to_icons(data.figure_url, agent_slug)

    now = datetime.utcnow()
    agent = AgentDefinition(
        id=new_agent_id,
        slug=agent_slug,
        name=data.name,
        description=data.description,
        agent_type=data.agent_type,
        department=data.department,
        division=data.division,
        category=data.category,
        figure_url=persisted_figure_url,
        system_prompt_override=data.system_prompt_override,
        skills=data.skills,
        allowed_tools=data.allowed_tools,
        model_override=data.model_override,
        max_steps=data.max_steps,
        icon=data.icon or base.get("icon"),
        color=data.color or base.get("color"),
        name_i18n=data.name_i18n,
        is_active=True,
        visibility=getattr(data, "visibility", None) or "department",
        allowed_roles=getattr(data, "allowed_roles", None) or [],
        user_id=user.id,
        display_name=data.display_name,
        notification_channels=data.notification_channels,
        escalation_contact=data.escalation_contact,
        allowed_channels=data.allowed_channels,
        channel_configs=data.channel_configs,
        dlp_bypass=bool(data.dlp_bypass),
        created_at=now,
        updated_at=now,
    )
    db.add(agent)
    db.commit()
    db.refresh(agent)
    _write_agent_seed(agent)
    auth.log_audit_action(db, user.id, "create_agent", "agent", agent.id, {"name": agent.name, "type": agent.agent_type})
    return _serialize(agent)


@router.get("/knowledge")
def list_knowledge(
    agent_type: str | None = None,
    limit: int = 50,
    db: Session = Depends(get_db),
    user = Depends(get_current_user),
):
    """Return cross-agent knowledge items stored by specialist subagents."""
    try:
        from app.services.knowledge_relay import list_knowledge as _list_knowledge
        items = _list_knowledge(db, agent_type=agent_type, limit=limit)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to load knowledge: {exc}") from exc
    return {
        "items": [
            {
                **item,
                "created_at": item["created_at"].isoformat() if item.get("created_at") else None,
            }
            for item in items
        ],
        "total": len(items),
    }


class KnowledgeCreate(BaseModel):
    content: str = Field(..., min_length=5, max_length=500)
    agent_type: str = Field(default="manual")
    domain: str = Field(default="")


@router.post("/knowledge", status_code=201)
def create_knowledge(
    data: KnowledgeCreate,
    db: Session = Depends(get_db),
    user = Depends(get_current_user),
):
    """Manually create a cross-agent knowledge item."""
    from app.models import MemoryType
    from app.services import memory as mem_svc
    from app.services.knowledge_relay import KNOWLEDGE_TAG

    tags = [KNOWLEDGE_TAG, f"agent_type:{data.agent_type}"]
    if data.domain:
        tags.append(f"domain:{data.domain}")

    result = mem_svc.create(
        content=data.content,
        memory_type=MemoryType.LONG.value,
        tags=tags,
        db=db,
    )
    db.commit()

    # Re-fetch to return full item shape
    from app.models import Memory
    mem = db.query(Memory).filter(Memory.id == result.get("memory_id", "")).first()
    if not mem:
        raise HTTPException(status_code=500, detail="Failed to retrieve created knowledge")
    return {
        "id": mem.id,
        "content": mem.content,
        "agent_type": data.agent_type,
        "domain": data.domain,
        "tags": mem.tags or [],
        "created_at": mem.created_at.isoformat() if mem.created_at else None,
    }


@router.delete("/knowledge/{knowledge_id}")
def delete_knowledge(
    knowledge_id: str,
    db: Session = Depends(get_db),
    user = Depends(get_current_user),
):
    """Delete a cross-agent knowledge item by its Memory ID."""
    from app.models import Memory
    mem = db.query(Memory).filter(Memory.id == knowledge_id).first()
    if not mem:
        raise HTTPException(status_code=404, detail="Knowledge item not found")
    from app.services.knowledge_relay import KNOWLEDGE_TAG
    if KNOWLEDGE_TAG not in (mem.tags or []):
        raise HTTPException(status_code=400, detail="Not a knowledge item")
    db.delete(mem)
    db.commit()
    return {"success": True}


# ── Prompt Optimize Endpoint ──────────────────────────────────────────────────

class OptimizePromptRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=8000)


class OptimizePromptResponse(BaseModel):
    optimized: str
    original_tokens: int
    optimized_tokens: int
    original_chars: int
    optimized_chars: int


@router.post("/optimize-prompt", response_model=OptimizePromptResponse)
async def optimize_prompt(
    body: OptimizePromptRequest,
    request: Request,
    user=Depends(get_current_user),
):
    """
    Compress and translate a CJK (or verbose) system prompt into concise English.
    Studio is the management plane and does not own an LLM provider. Forward
    the request to goku-core, which performs the model call and returns both
    original and optimized token estimates.
    """
    from app.services import core_runtime_proxy

    payload = body.model_dump(mode="json") if hasattr(body, "model_dump") else body.dict()
    return await core_runtime_proxy.post_to_core(
        request,
        "/api/v1/agents/optimize-prompt",
        payload,
    )


@router.get("/{agent_id}")
def get_agent(
    agent_id: str,
    db: Session = Depends(get_db),
    user = Depends(get_current_user),
):
    from app.models import AgentDefinition
    q = db.query(AgentDefinition).filter(AgentDefinition.id == agent_id)
    agent = _agent_access_filter(q, user, db).first()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    return _serialize(agent)


@router.get("/{agent_id}/export")
def export_agent(
    agent_id: str,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    from app.models import AgentDefinition
    agent = db.query(AgentDefinition).filter(AgentDefinition.id == agent_id).first()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    # Export yields the full editable seed JSON (system prompt, tools) — config-level.
    if not _user_can_config(user, agent, db):
        raise HTTPException(status_code=403, detail="No export permission for this agent")
    payload = _build_export_payload(agent)
    filename = f"{_slugify_filename(agent.name)}.agent.json"
    auth.log_audit_action(db, user.id, "export_agent", "agent", agent.id, {"name": agent.name})
    content = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    return StreamingResponse(
        BytesIO(content),
        media_type="application/json",
        headers={"Content-Disposition": _attachment_disposition(filename)},
    )


@router.post("/export")
def export_agents_batch(
    data: AgentBatchExportRequest,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    from app.models import AgentDefinition

    agent_ids = [agent_id for agent_id in data.agent_ids if agent_id]
    if not agent_ids:
        raise HTTPException(status_code=400, detail="agent_ids is required")

    agents = db.query(AgentDefinition).filter(AgentDefinition.id.in_(agent_ids)).all()
    if not agents:
        raise HTTPException(status_code=404, detail="No matching agents found")

    # Restrict to agents the caller may configure — export reveals the editable
    # definition (system prompt, tools), so it is gated at config level.
    if not bool(getattr(user, "is_superuser", False)):
        _, config_set = _policy_flag_sets([a.id for a in agents], user, db)
        agents = [a for a in agents if (a.user_id and a.user_id == user.id) or a.id in config_set]
    if not agents:
        raise HTTPException(status_code=404, detail="No matching agents found")

    agents_by_id = {agent.id: agent for agent in agents}
    ordered_agents = [agents_by_id[agent_id] for agent_id in agent_ids if agent_id in agents_by_id]
    if not ordered_agents:
        raise HTTPException(status_code=404, detail="No matching agents found")

    archive = BytesIO()
    manifest = {
        "schema": "aios.agent-export-batch",
        "version": EXPORT_VERSION,
        "exported_at": datetime.utcnow().isoformat() + "Z",
        "count": len(ordered_agents),
        "agents": [],
    }
    used_names: set[str] = set()

    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for agent in ordered_agents:
            payload = _build_export_payload(agent)
            base_name = _slugify_filename(agent.name)
            file_name = f"{base_name}.agent.json"
            if file_name in used_names:
                file_name = f"{base_name}-{agent.id[:8]}.agent.json"
            used_names.add(file_name)
            zf.writestr(file_name, json.dumps(payload, ensure_ascii=False, indent=2))
            manifest["agents"].append({
                "id": agent.id,
                "name": agent.name,
                "file": file_name,
                "figure_url": agent.figure_url,
            })
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))

    auth.log_audit_action(
        db,
        user.id,
        "export_agents_batch",
        "agent",
        None,
        {"count": len(ordered_agents), "agent_ids": [agent.id for agent in ordered_agents]},
    )
    archive.seek(0)
    filename = f"agents-export-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}.zip"
    return StreamingResponse(
        archive,
        media_type="application/zip",
        headers={"Content-Disposition": _attachment_disposition(filename)},
    )


@router.post("/import", response_model=AgentImportResult)
def import_agent(
    file: UploadFile = File(...),
    mode: str = Query("upsert", pattern="^(upsert|copy)$"),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    from app.agent.subagent_config import SUBAGENT_TYPES
    from app.models import AgentDefinition

    payload = _load_import_payload(file)
    agent_data = payload["agent"]
    agent_type = agent_data.get("agent_type")
    if agent_type not in SUBAGENT_TYPES:
        raise HTTPException(status_code=400, detail=f"Unknown base agent type: {agent_type}")

    base = SUBAGENT_TYPES[agent_type]
    name = (agent_data.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Imported agent is missing a name")

    skills = _filter_valid_skills(agent_data.get("skills") or [])

    allowed_tools = agent_data.get("allowed_tools")
    if allowed_tools is not None:
        allowed_tools = _filter_allowed_tools(allowed_tools, base["tools"])

    imported_figure_url = _write_imported_figure(name, payload.get("figure_asset"))
    figure_url = imported_figure_url or agent_data.get("figure_url")
    # Accept /icons/ (workspace) and /api/v1/uploads/ (workspace uploads); drop anything else.
    if figure_url and not (figure_url.startswith("/icons/") or figure_url.startswith("/api/v1/uploads/")):
        figure_url = None

    now = datetime.utcnow()
    stable_slug = (agent_data.get("slug") or "").strip()
    existing = None
    if mode == "upsert" and stable_slug:
        existing = db.query(AgentDefinition).filter(AgentDefinition.slug == stable_slug).first()
    if mode == "upsert" and existing is None:
        existing = db.query(AgentDefinition).filter(AgentDefinition.name == name).first()

    if existing is not None:
        if not _user_can_config(user, existing, db):
            raise HTTPException(status_code=403, detail="No edit permission for existing agent")
        existing.name = name
        existing.description = agent_data.get("description")
        existing.agent_type = agent_type
        existing.department = agent_data.get("department")
        existing.division = agent_data.get("division")
        existing.category = agent_data.get("category")
        existing.figure_url = figure_url
        existing.system_prompt_override = agent_data.get("system_prompt_override")
        existing.skills = skills
        existing.allowed_tools = allowed_tools
        existing.model_override = agent_data.get("model_override")
        existing.max_steps = agent_data.get("max_steps")
        existing.icon = agent_data.get("icon") or base.get("icon")
        existing.color = agent_data.get("color") or base.get("color")
        existing.is_active = bool(agent_data.get("is_active", True))
        existing.visibility = agent_data.get("visibility") or ("public" if not agent_data.get("department") else "department")
        existing.allowed_roles = agent_data.get("allowed_roles") or []
        existing.updated_at = now
        db.commit()
        db.refresh(existing)
        _write_agent_seed(existing)
        auth.log_audit_action(db, user.id, "import_agent_upsert", "agent", existing.id, {"name": existing.name, "source_file": file.filename})
        return {
            "id": existing.id,
            "name": existing.name,
            "slug": existing.slug,
            "action": "updated",
            "imported_at": now.isoformat() + "Z",
        }

    final_name = name
    if mode == "copy" and db.query(AgentDefinition).filter(AgentDefinition.name == final_name).first():
        final_name = f"{name} (Imported)"
        if db.query(AgentDefinition).filter(AgentDefinition.name == final_name).first():
            final_name = f"{name} (Imported {datetime.utcnow().strftime('%Y%m%d%H%M%S')})"

    new_agent_id = str(uuid.uuid4())
    if mode == "upsert" and stable_slug and not db.query(AgentDefinition).filter(AgentDefinition.slug == stable_slug).first():
        agent_slug = stable_slug
    else:
        agent_slug = _make_unique_agent_slug(db, AgentDefinition, final_name, new_agent_id)
    agent = AgentDefinition(
        id=new_agent_id,
        slug=agent_slug,
        name=final_name,
        description=agent_data.get("description"),
        agent_type=agent_type,
        department=agent_data.get("department"),
        division=agent_data.get("division"),
        category=agent_data.get("category"),
        figure_url=figure_url,
        system_prompt_override=agent_data.get("system_prompt_override"),
        skills=skills,
        allowed_tools=allowed_tools,
        model_override=agent_data.get("model_override"),
        max_steps=agent_data.get("max_steps"),
        icon=agent_data.get("icon") or base.get("icon"),
        color=agent_data.get("color") or base.get("color"),
        is_active=bool(agent_data.get("is_active", True)),
        visibility=agent_data.get("visibility") or ("public" if not agent_data.get("department") else "department"),
        allowed_roles=agent_data.get("allowed_roles") or [],
        user_id=user.id,
        tenant_id=getattr(user, "tenant_id", None),
        created_at=now,
        updated_at=now,
    )
    db.add(agent)
    db.commit()
    db.refresh(agent)
    _write_agent_seed(agent)
    auth.log_audit_action(db, user.id, "import_agent", "agent", agent.id, {"name": agent.name, "source_file": file.filename})
    return {
        "id": agent.id,
        "name": agent.name,
        "slug": agent.slug,
        "action": "created",
        "imported_at": now.isoformat() + "Z",
    }


@router.put("/{agent_id}")
def update_agent(
    agent_id: str,
    data: AgentDefinitionUpdate,
    db: Session = Depends(get_db),
    user = Depends(get_current_user),
):
    from app.agent.subagent_config import SUBAGENT_TYPES
    from app.models import AgentDefinition

    agent = db.query(AgentDefinition).filter(AgentDefinition.id == agent_id).first()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    if not _user_can_config(user, agent, db):
        raise HTTPException(status_code=403, detail="No edit permission for this agent")

    if data.name is not None:
        agent.name = data.name
    if data.description is not None:
        agent.description = data.description
    if data.department is not None:
        agent.department = data.department
    if data.division is not None:
        agent.division = data.division
    if data.category is not None:
        agent.category = data.category
    if getattr(data, "visibility", None) is not None:
        agent.visibility = data.visibility
    if getattr(data, "allowed_roles", None) is not None:
        agent.allowed_roles = data.allowed_roles
    if data.figure_url is not None:
        agent.figure_url = _persist_figure_to_icons(data.figure_url, agent.slug or agent.id[:8])
    if data.icon is not None:
        # Normalise: if icon looks like an image path, move it to figure_url instead
        if data.icon.startswith("/"):
            if not agent.figure_url:
                agent.figure_url = data.icon
            # leave agent.icon unchanged (keep existing Ant Design icon name)
        else:
            agent.icon = data.icon
    if data.system_prompt_override is not None:
        agent.system_prompt_override = data.system_prompt_override
    if data.skills is not None:
        agent.skills = _filter_valid_skills(data.skills)
    if data.model_override is not None:
        agent.model_override = data.model_override
    if data.max_steps is not None:
        agent.max_steps = data.max_steps
    if data.color is not None:
        agent.color = data.color
    if data.is_active is not None:
        agent.is_active = data.is_active
    if data.allowed_tools is not None:
        base_tools = SUBAGENT_TYPES.get(agent.agent_type, {}).get("tools", [])
        agent.allowed_tools = _filter_allowed_tools(data.allowed_tools, base_tools)
    if data.name_i18n is not None:
        agent.name_i18n = data.name_i18n
    if data.display_name is not None:
        agent.display_name = data.display_name
    if data.notification_channels is not None:
        agent.notification_channels = data.notification_channels
    if data.escalation_contact is not None:
        agent.escalation_contact = data.escalation_contact
    if data.allowed_channels is not None:
        agent.allowed_channels = data.allowed_channels
    if data.channel_configs is not None:
        agent.channel_configs = data.channel_configs
    if data.dlp_bypass is not None:
        agent.dlp_bypass = data.dlp_bypass
    agent.updated_at = datetime.utcnow()

    db.commit()
    db.refresh(agent)
    _write_agent_seed(agent)
    auth.log_audit_action(db, user.id, "update_agent", "agent", agent.id, {"name": agent.name})
    return _serialize(agent)


@router.delete("/{agent_id}")
def delete_agent(
    agent_id: str,
    db: Session = Depends(get_db),
    user = Depends(get_current_user),
):
    from app.models import AgentDefinition
    agent = db.query(AgentDefinition).filter(AgentDefinition.id == agent_id).first()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    if not _user_can_config(user, agent, db):
        raise HTTPException(status_code=403, detail="No delete permission for this agent")
    agent_name = agent.name
    agent_slug = getattr(agent, "slug", None)
    auth.log_audit_action(db, user.id, "delete_agent", "agent", agent.id, {"name": agent_name})
    db.delete(agent)
    db.commit()
    # Remove seed file so the agent is not re-imported on next deploy
    if agent_slug:
        seed_path = _SEEDS_DIR / f"{agent_slug}.json"
        if seed_path.exists():
            seed_path.unlink()
    return {"success": True}


_SEEDS_DIR = Path(__file__).resolve().parents[2] / "seeds" / "agents"


def _write_agent_seed(agent) -> None:
    """Write (or update) the seed file for an agent after any DB mutation."""
    try:
        _SEEDS_DIR.mkdir(parents=True, exist_ok=True)
        slug = getattr(agent, "slug", None)
        name = getattr(agent, "name", "") or ""
        if not slug:
            slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or str(agent.id)[:8]
        filename = f"{slug}.json"

        def _as_list(val):
            if val is None:
                return val
            if isinstance(val, list):
                return val
            try:
                return json.loads(val)
            except Exception:
                return val

        figure_url = getattr(agent, "figure_url", None)
        row = {
            "id": agent.id,
            "name": name,
            "slug": getattr(agent, "slug", None),
            "agent_type": agent.agent_type,
            "description": agent.description,
            "system_prompt_override": agent.system_prompt_override,
            "allowed_tools": _as_list(agent.allowed_tools),
            "skills": _as_list(agent.skills),
            "is_active": int(bool(agent.is_active)),
            "tenant_id": agent.tenant_id,
            "user_id": agent.user_id,
            "max_steps": agent.max_steps,
            "model_override": agent.model_override,
            "name_i18n": agent.name_i18n if isinstance(agent.name_i18n, dict) else (
                json.loads(agent.name_i18n) if isinstance(agent.name_i18n, str) else None
            ),
            "icon": agent.icon,
            "color": agent.color,
            "figure_url": figure_url,
            "display_name": agent.display_name,
            "division": getattr(agent, "division", None),
            "department": agent.department,
            "category": getattr(agent, "category", None),
            "visibility": getattr(agent, "visibility", None) or "department",
            "allowed_roles": getattr(agent, "allowed_roles", None) or [],
            "created_at": agent.created_at.isoformat() if agent.created_at else None,
            "updated_at": agent.updated_at.isoformat() if agent.updated_at else None,
        }
        seed_path = _SEEDS_DIR / filename
        seed_path.write_text(json.dumps(row, indent=2, ensure_ascii=False))
        # Auto-stage new icon files so they are included in the next git commit
        if figure_url and figure_url.startswith("/icons/"):
            icon_path = _icons_root() / figure_url.rsplit("/", 1)[-1]
            if icon_path.exists():
                import subprocess
                import threading
                repo_root = Path(__file__).resolve().parents[3]
                _seed_path = seed_path  # capture for closure
                _icon_path = str(icon_path)

                def _git_add():
                    try:
                        subprocess.run(
                            ["git", "add", _icon_path, str(_seed_path)],
                            cwd=repo_root, capture_output=True, timeout=10,
                        )
                    except Exception:
                        pass

                threading.Thread(target=_git_add, daemon=True).start()
    except Exception:
        pass  # seed write is best-effort, never break the API response


_EMAIL_CONFIG_KEY_PREFIX = "agent_inbox_"

_DEFAULT_EMAIL_CONFIG = {
    "enabled": False,
    "monitored_addresses": [],   # list of email addresses this agent watches
    "reply_from": "",            # From address for outgoing replies; falls back to recipient_to then SMTP_FROM
    "poll_interval_minutes": 5,  # how often the heartbeat checks (informational)
    "subject_blocklist": [],     # keywords in subject → skip
    "sender_blocklist": [],      # exact sender addresses to ignore
}


@router.get("/{agent_id}/email-config")
def get_agent_email_config(
    agent_id: str,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Return per-agent inbox configuration stored in system_configs."""
    from app.models import AgentDefinition, SystemConfig

    agent = db.query(AgentDefinition).filter(AgentDefinition.id == agent_id).first()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    slug = agent.slug or agent.id
    cfg_row = db.query(SystemConfig).filter(
        SystemConfig.key == f"{_EMAIL_CONFIG_KEY_PREFIX}{slug}"
    ).first()

    if cfg_row and isinstance(cfg_row.value, dict):
        config = {**_DEFAULT_EMAIL_CONFIG, **cfg_row.value}
    else:
        config = dict(_DEFAULT_EMAIL_CONFIG)

    return {"slug": slug, "config": config}


@router.put("/{agent_id}/email-config")
def update_agent_email_config(
    agent_id: str,
    body: dict,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Save per-agent inbox configuration to system_configs."""
    from app.models import AgentDefinition, SystemConfig

    agent = db.query(AgentDefinition).filter(AgentDefinition.id == agent_id).first()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    if not _user_can_config(user, agent, db):
        raise HTTPException(status_code=403, detail="No edit permission for this agent")

    slug = agent.slug or agent.id
    key  = f"{_EMAIL_CONFIG_KEY_PREFIX}{slug}"

    # Merge with defaults to ensure all fields are present
    merged = {**_DEFAULT_EMAIL_CONFIG, **body}
    # Sanitise list fields
    for field in ("monitored_addresses", "subject_blocklist", "sender_blocklist"):
        merged[field] = [str(v).strip() for v in merged.get(field, []) if str(v).strip()]
    # Sanitise scalar fields
    merged["reply_from"] = str(merged.get("reply_from") or "").strip()

    cfg_row = db.query(SystemConfig).filter(SystemConfig.key == key).first()
    if cfg_row:
        cfg_row.value      = merged
        cfg_row.updated_at = __import__("datetime").datetime.utcnow()
    else:
        import uuid as _uuid

        from app.models import SystemConfig as SC
        cfg_row = SC(id=str(_uuid.uuid4()), key=key, value=merged)
        db.add(cfg_row)

    db.commit()
    auth.log_audit_action(db, user.id, "update_agent_email_config", "agent", agent.id, {"slug": slug})
    return {"slug": slug, "config": merged}


def _serialize(agent) -> dict:
    from app.agent.subagent_config import SUBAGENT_TYPES
    base = SUBAGENT_TYPES.get(agent.agent_type, {})
    return {
        "id": agent.id,
        "slug": agent.slug,
        "name": agent.name,
        "name_i18n": getattr(agent, "name_i18n", None) or {},
        "description": agent.description,
        "agent_type": agent.agent_type,
        "agent_type_label": base.get("label", agent.agent_type),
        "department": agent.department,
        "division": agent.division,
        "category": getattr(agent, "category", None),
        "figure_url": agent.figure_url,
        "system_prompt_override": agent.system_prompt_override,
        "skills": agent.skills,
        "allowed_tools": agent.allowed_tools,
        "effective_tools": agent.allowed_tools if agent.allowed_tools is not None else base.get("tools", []),
        "model_override": agent.model_override,
        "max_steps": agent.max_steps,
        "effective_max_steps": agent.max_steps if agent.max_steps is not None else base.get("max_steps"),
        "icon": agent.icon or base.get("icon"),
        "color": agent.color or base.get("color"),
        "is_active": agent.is_active,
        "visibility": getattr(agent, "visibility", "department") or "department",
        "allowed_roles": getattr(agent, "allowed_roles", None) or [],
        "user_id": agent.user_id,
        "tenant_id": agent.tenant_id,
        "display_name": agent.display_name,
        "notification_channels": agent.notification_channels,
        "escalation_contact": agent.escalation_contact,
        "allowed_channels": agent.allowed_channels,
        "channel_configs": agent.channel_configs,
        "dlp_bypass": bool(getattr(agent, "dlp_bypass", False)),
        "created_at": agent.created_at.isoformat() if agent.created_at else None,
        "updated_at": agent.updated_at.isoformat() if agent.updated_at else None,
    }
