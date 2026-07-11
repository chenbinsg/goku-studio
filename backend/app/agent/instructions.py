"""
Project instructions loader for Studio.

Studio owns the editor for the global Agent Soul. The runtime consumes the
editable file at AGENT_WORKSPACE/.agent/INSTRUCTIONS.md, while this loader also
falls back to the bundled core/SOUL.md so a fresh workspace has a visible base
Soul before the first save.
"""
import glob as glob_mod
import logging
import os
from pathlib import Path
import re as _re

logger = logging.getLogger(__name__)

WORKSPACE = os.environ.get("AGENT_WORKSPACE", "/tmp/agent_workspace")
MAX_INSTRUCTIONS_LEN = 5000
MAX_RULE_LEN = 2000


def _read_text_if_exists(path: str | Path, limit: int | None = None) -> str:
    try:
        p = Path(path)
        if not p.is_file():
            return ""
        content = p.read_text(encoding="utf-8")
        return content[:limit] if limit else content
    except Exception as e:
        logger.debug("Failed to read %s: %s", path, e)
        return ""


def _bundled_soul_candidates() -> list[Path]:
    here = Path(__file__).resolve()
    repo_studio = here.parents[3]
    repo_root = repo_studio.parent
    return [
        repo_studio / "SOUL.md",
        repo_root / "core" / "SOUL.md",
    ]


def load_project_instructions() -> str:
    """Load the editable .agent/INSTRUCTIONS.md, falling back to bundled SOUL.md."""
    path = os.path.join(WORKSPACE, ".agent", "INSTRUCTIONS.md")
    content = _read_text_if_exists(path, MAX_INSTRUCTIONS_LEN)
    if content:
        return content
    for soul_path in _bundled_soul_candidates():
        content = _read_text_if_exists(soul_path, MAX_INSTRUCTIONS_LEN)
        if content:
            return content
    return ""


def load_tenant_instructions(tenant_id: str | None) -> str:
    if not tenant_id:
        return ""
    path = os.path.join(WORKSPACE, ".agent", "tenants", str(tenant_id), "INSTRUCTIONS.md")
    return _read_text_if_exists(path, MAX_INSTRUCTIONS_LEN)


def load_rules(file_paths: list[str] = None) -> list[dict]:
    rules_dir = os.path.join(WORKSPACE, ".agent", "rules")
    if not os.path.isdir(rules_dir):
        return []

    results = []
    for md_path in sorted(glob_mod.glob(os.path.join(rules_dir, "*.md"))):
        rule_name = os.path.splitext(os.path.basename(md_path))[0]
        if file_paths:
            relevant = any(rule_name in fp or fp.startswith(rule_name) for fp in file_paths)
            if not relevant:
                continue
        content = _read_text_if_exists(md_path, MAX_RULE_LEN)
        if content:
            results.append({"name": rule_name, "content": content})
    return results


def _parse_soul_md(content: str) -> dict:
    sections: dict = {}
    current_section = None
    lines_buf: list[str] = []
    for line in content.splitlines():
        h2 = _re.match(r"^##\s+(.+)$", line)
        if h2:
            if current_section is not None:
                sections[current_section] = "\n".join(lines_buf).strip()
            current_section = h2.group(1).strip()
            lines_buf = []
        elif _re.match(r"^#\s+", line):
            pass
        else:
            if current_section is not None:
                lines_buf.append(line)
    if current_section is not None:
        sections[current_section] = "\n".join(lines_buf).strip()
    return sections


def import_soul_content(soul_content: str) -> dict:
    """Parse SOUL.md and write it as INSTRUCTIONS.md in the agent workspace."""
    sections = _parse_soul_md(soul_content)
    md_parts = ["# Agent Soul\n"]
    ordered_keys = [
        (("Name", "名称"), "名称"),
        (("Role", "角色定位"), "角色定位"),
        (("Personality", "Personality & Style", "人格风格"), "人格风格"),
        (("Language", "Working Language", "工作语言"), "工作语言"),
        (("Core Rules", "核心规则"), "核心规则"),
        (("Forbidden Behaviors", "Prohibited Behaviors", "禁止行为"), "禁止行为"),
        (("Custom Instructions", "System Prompt Supplements", "系统提示补充"), "系统提示补充"),
    ]
    summary: dict[str, str] = {}
    written: set = set()
    for aliases, cn_key in ordered_keys:
        value = next((sections.get(key) for key in aliases if sections.get(key)), "")
        if value:
            md_parts.append(f"\n## {cn_key}\n{value}\n")
            written.update(aliases)
            written.add(cn_key)
            summary[cn_key] = value[:80] + ("..." if len(value) > 80 else "")
    standard_all = {key for aliases, cn_key in ordered_keys for key in (*aliases, cn_key)}
    for key, val in sections.items():
        if key not in standard_all and val:
            md_parts.append(f"\n## {key}\n{val}\n")
            summary[key] = val[:80] + ("..." if len(val) > 80 else "")
    final_md = "".join(md_parts).strip()
    agent_dir = os.path.join(WORKSPACE, ".agent")
    os.makedirs(agent_dir, exist_ok=True)
    path = os.path.join(agent_dir, "INSTRUCTIONS.md")
    Path(path).write_text(final_md, encoding="utf-8")
    return summary
