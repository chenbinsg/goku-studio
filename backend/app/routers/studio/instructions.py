"""
Project instructions API — manage .agent/INSTRUCTIONS.md and rules.
"""
import os
import re
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session
from app.db import get_db
from app import auth


def _require_admin(current_user) -> None:
    if not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="Admin required")

router = APIRouter(prefix="/api/v1/instructions", tags=["instructions"])

WORKSPACE = os.environ.get("AGENT_WORKSPACE", "/tmp/agent_workspace")


class InstructionsUpdate(BaseModel):
    content: str


class RuleUpdate(BaseModel):
    content: str


@router.get("")
def get_instructions(current_user=Depends(auth.get_current_user)):
    """Get project instructions and rules."""
    from app.agent.instructions import load_project_instructions, load_rules
    return {
        "instructions": load_project_instructions(),
        "rules": load_rules(),
    }


@router.put("")
def update_instructions(
    data: InstructionsUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    """Update the main INSTRUCTIONS.md file. Admin only."""
    _require_admin(current_user)
    agent_dir = os.path.join(WORKSPACE, ".agent")
    os.makedirs(agent_dir, exist_ok=True)
    path = os.path.join(agent_dir, "INSTRUCTIONS.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write(data.content)
    auth.log_audit_action(db, current_user.id, "update_instructions", "instructions", None,
                          {"length": len(data.content)})
    return {"status": "updated"}


@router.put("/rules/{rule_name}")
def update_rule(
    rule_name: str,
    data: RuleUpdate,
    current_user=Depends(auth.get_current_user),
):
    """Create or update a rule file. Admin only."""
    _require_admin(current_user)
    # Sanitize rule name
    safe_name = "".join(c for c in rule_name if c.isalnum() or c in "-_")
    if not safe_name:
        raise HTTPException(400, "Invalid rule name")

    rules_dir = os.path.join(WORKSPACE, ".agent", "rules")
    os.makedirs(rules_dir, exist_ok=True)
    path = os.path.join(rules_dir, f"{safe_name}.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write(data.content)
    return {"status": "updated", "name": safe_name}


@router.delete("/rules/{rule_name}")
def delete_rule(
    rule_name: str,
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    """Delete a rule file. Admin only."""
    _require_admin(current_user)
    safe_name = "".join(c for c in rule_name if c.isalnum() or c in "-_")
    rules_dir = os.path.join(WORKSPACE, ".agent", "rules")
    path = os.path.join(rules_dir, f"{safe_name}.md")
    if not os.path.isfile(path):
        raise HTTPException(404, "Rule not found")
    os.remove(path)
    auth.log_audit_action(db, current_user.id, "delete_rule", "instructions_rule", safe_name, {})
    return {"status": "deleted", "name": safe_name}


# ── SOUL.md export / import ────────────────────────────────────────────────────

def _parse_soul_md(content: str) -> dict:
    """Parse a SOUL.md Markdown file and return a dict of section name → content."""
    sections: dict = {}
    current_section: str | None = None
    lines_buf: list[str] = []

    for line in content.splitlines():
        h2 = re.match(r"^##\s+(.+)$", line)
        if h2:
            if current_section is not None:
                sections[current_section] = "\n".join(lines_buf).strip()
            current_section = h2.group(1).strip()
            lines_buf = []
        elif re.match(r"^#\s+", line):
            # Top-level heading — treat as document title, ignore for sections
            pass
        else:
            if current_section is not None:
                lines_buf.append(line)

    if current_section is not None:
        sections[current_section] = "\n".join(lines_buf).strip()

    return sections


def _import_soul_content(soul_content: str) -> dict:
    """Parse SOUL.md content and write it as INSTRUCTIONS.md. Returns summary dict."""
    sections = _parse_soul_md(soul_content)

    # Build a structured INSTRUCTIONS.md from the parsed sections
    md_parts = ["# Agent Soul\n"]


    written_cn_keys: set[str] = set()
    summary: dict[str, str] = {}

    # Process in a preferred order
    ordered_keys = [
        ("Name", "名称"),
        ("Role", "角色定位"),
        ("Personality", "人格风格"),
        ("Language", "工作语言"),
        ("Core Rules", "核心规则"),
        ("Forbidden Behaviors", "禁止行为"),
        ("Custom Instructions", "系统提示补充"),
    ]

    for en_key, cn_key in ordered_keys:
        # Check English key first, then Chinese key
        value = sections.get(en_key) or sections.get(cn_key) or ""
        if value:
            md_parts.append(f"\n## {cn_key}\n{value}\n")
            written_cn_keys.add(cn_key)
            summary[cn_key] = value[:80] + ("..." if len(value) > 80 else "")

    # Include any other sections not in the standard map
    standard_all = {k for pair in ordered_keys for k in pair}
    for key, val in sections.items():
        if key not in standard_all and val:
            md_parts.append(f"\n## {key}\n{val}\n")
            summary[key] = val[:80] + ("..." if len(val) > 80 else "")

    final_md = "".join(md_parts).strip()

    # Write to INSTRUCTIONS.md
    agent_dir = os.path.join(WORKSPACE, ".agent")
    os.makedirs(agent_dir, exist_ok=True)
    path = os.path.join(agent_dir, "INSTRUCTIONS.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write(final_md)

    return summary


@router.get("/export")
def export_soul_md(current_user=Depends(auth.get_current_user)):
    """Export current system instructions as SOUL.md content."""
    from app.agent.instructions import load_project_instructions
    existing = load_project_instructions()

    if existing and existing.strip():
        # Return the existing content as-is (it was likely saved in SOUL format)
        soul_content = existing
    else:
        # Generate a default SOUL.md skeleton
        soul_content = (
            "# AIOS Agent Identity\n\n"
            "## Name\nAIOS Assistant\n\n"
            "## Personality\n专业、高效、友善。\n\n"
            "## Language\nauto — 自动检测用户语言并用相同语言回复。\n\n"
            "## Core Rules\n- 优先完成用户交代的任务\n\n"
            "## Forbidden Behaviors\n- 不要虚构不存在的信息\n\n"
            "## Custom Instructions\n作为企业级 AI 助手，帮助团队完成日常工作。\n"
        )

    return Response(
        content=soul_content,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="SOUL.md"'},
    )


class SoulImport(BaseModel):
    content: str


@router.post("/import-soul")
def import_soul_md(
    payload: SoulImport,
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    """Import a SOUL.md file and save as system instructions. Admin only."""
    _require_admin(current_user)
    soul_content = payload.content
    if not soul_content or not soul_content.strip():
        raise HTTPException(400, "SOUL.md content is empty")

    try:
        summary = _import_soul_content(soul_content)
    except Exception as exc:
        raise HTTPException(500, f"Failed to import SOUL.md: {exc}")

    auth.log_audit_action(db, current_user.id, "import_soul_md", "instructions", None,
                          {"sections_imported": len(summary)})
    return {
        "status": "imported",
        "summary": summary,
        "sections_imported": len(summary),
    }
