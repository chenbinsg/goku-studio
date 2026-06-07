"""
Skill packaging service — pack, distribute, and install tool bundles.

Supports:
  - pack_skill(skill_id)       → bytes (zip archive)
  - install_from_package(zip_bytes, db) → dict
  - install_from_url(url, db)  → dict

Package format
--------------
  manifest.json          — package metadata (required)
  tools/<name>.py        — one or more tool source files
  tools/install_hook.py  — optional post-install hook (not executed automatically)
"""

from __future__ import annotations

import io
import json
import logging
import re
import uuid
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

logger = logging.getLogger(__name__)

# Root of the tools directory (where tool .py files live)
_TOOLS_DIR = Path(__file__).parent.parent / "agent" / "tools"

# ── Dangerous code patterns (basic safety filter) ─────────────────────────────
# We reject packages whose tool files contain obvious dangerous direct calls.
# This is intentionally NOT exhaustive — just a first-pass filter to catch
# the most blatant attack vectors.  Controlled use of subprocess (e.g. calling
# ffmpeg) is allowed; what we block is shell=True execution and __import__ tricks.
_DANGEROUS_PATTERNS: List[str] = [
    r"__import__\s*\(\s*['\"]os['\"]\s*\)\s*\.\s*system",   # __import__('os').system
    r"__import__\s*\(\s*['\"]subprocess",                   # __import__('subprocess'...
    r"os\s*\.\s*system\s*\(",                               # os.system(
    r"subprocess\s*\.\s*(?:call|run|Popen|check_output)\s*\([^)]*shell\s*=\s*True",  # subprocess.*(shell=True)
    r"eval\s*\(",                                           # eval(
    r"exec\s*\(",                                           # exec(
    r"ctypes\s*\.\s*",                                      # ctypes.
    r"shutil\s*\.\s*rmtree\s*\(",                           # shutil.rmtree(
]
_DANGEROUS_RE = [re.compile(p) for p in _DANGEROUS_PATTERNS]


def _check_code_safety(code: str, filename: str) -> List[str]:
    """Return a list of safety violations found in *code*."""
    violations: List[str] = []
    for pat in _DANGEROUS_RE:
        if pat.search(code):
            violations.append(f"{filename}: matched dangerous pattern '{pat.pattern[:60]}'")
    return violations


# ── Manifest helpers ───────────────────────────────────────────────────────────

def _make_manifest(skill_info: dict) -> dict:
    """Build a manifest.json dict from a BUILTIN_SKILLS entry."""
    tool_files = skill_info.get("tool_files", [])
    tools = [
        {"name": tf.replace(".py", ""), "file": f"tools/{tf}"}
        for tf in tool_files
    ]
    return {
        "$schema": "https://aios.spec/v1/manifest.schema.json",
        "id": skill_info["id"],
        "name": skill_info["name"],
        "version": skill_info.get("latest_version", "1.0.0"),
        "description": skill_info.get("description", ""),
        "author": skill_info.get("author", "system"),
        "category": skill_info.get("category", ""),
        "license": skill_info.get("license", "MIT"),
        "aios_version_min": "1.0.0",
        "tools": tools,
        "dependencies": skill_info.get("dependencies", []),
        "system_dependencies": skill_info.get("system_dependencies", []),
        "permissions_required": skill_info.get("permissions_required", []),
        "platforms": ["linux", "darwin", "win32"],
        "python_version_min": "3.10",
        "packaged_at": datetime.utcnow().isoformat() + "Z",
    }


# ── pack_skill ─────────────────────────────────────────────────────────────────

def pack_skill(skill_id: str) -> bytes:
    """
    Pack a skill into a zip archive and return the raw bytes.

    The archive layout:
        manifest.json
        tools/<tool_name>.py   (one per tool listed in tool_files)

    Raises ValueError if the skill is unknown or not marked packable.
    Raises FileNotFoundError if a required tool file is missing on disk.
    """
    from app.services.skill_marketplace import BUILTIN_SKILLS

    skill_info = next((s for s in BUILTIN_SKILLS if s["id"] == skill_id), None)
    if skill_info is None:
        raise ValueError(f"Skill '{skill_id}' not found in registry")
    if not skill_info.get("packable", False):
        raise ValueError(f"Skill '{skill_id}' is not marked as packable")

    tool_files: List[str] = skill_info.get("tool_files", [])
    if not tool_files:
        raise ValueError(f"Skill '{skill_id}' has no tool_files defined")

    manifest = _make_manifest(skill_info)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        # 1. Write manifest
        zf.writestr("manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False))

        # 2. Write each tool file
        for tf in tool_files:
            src_path = _TOOLS_DIR / tf
            if not src_path.exists():
                raise FileNotFoundError(
                    f"Tool file '{tf}' not found at {src_path}"
                )
            zf.write(src_path, arcname=f"tools/{tf}")

        # 3. Write a minimal install_hook.py stub (so the entry_point always resolves)
        hook_stub = (
            '"""Auto-generated install hook stub."""\n\n'
            "def on_install(manifest: dict) -> None:\n"
            "    \"\"\"Called after the package tools are copied to disk.\"\"\"\n"
            "    pass\n"
        )
        zf.writestr("tools/install_hook.py", hook_stub)

    return buf.getvalue()


# ── install_from_package ───────────────────────────────────────────────────────

def install_from_package(zip_bytes: bytes, db) -> dict:
    """
    Install a skill from a raw zip archive.

    Steps:
      1. Parse manifest.json
      2. Safety-check every tool/*.py file
      3. Copy tool files to _TOOLS_DIR
      4. Record installation in DB Plugin table
      5. Return installation summary

    NOTE: Dynamic tool registration (live reloading) is not possible without a
    backend restart.  The response includes a ``restart_required`` flag and a
    human-readable notice.
    """
    from app.models import Plugin

    # ── 1. Open archive ──────────────────────────────────────────────────────
    try:
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            names = zf.namelist()

            if "manifest.json" not in names:
                return {"status": "error", "error": "manifest.json not found in package"}

            try:
                manifest: dict = json.loads(zf.read("manifest.json"))
            except json.JSONDecodeError as exc:
                return {"status": "error", "error": f"Invalid manifest.json: {exc}"}

            # ── 2. Validate manifest fields ───────────────────────────────────
            required_fields = ["id", "name", "version", "tools"]
            missing = [f for f in required_fields if f not in manifest]
            if missing:
                return {
                    "status": "error",
                    "error": f"manifest.json missing required fields: {', '.join(missing)}",
                }

            tool_entries: List[Dict[str, Any]] = manifest.get("tools", [])
            if not tool_entries:
                return {"status": "error", "error": "Package contains no tools"}

            # ── 3. Safety scan ────────────────────────────────────────────────
            all_violations: List[str] = []
            tool_contents: Dict[str, bytes] = {}

            for entry in tool_entries:
                file_path: str = entry.get("file", "")
                if not file_path:
                    continue
                # Normalise: strip leading /
                file_path = file_path.lstrip("/")
                if file_path not in names:
                    return {
                        "status": "error",
                        "error": f"Tool file '{file_path}' listed in manifest but not in archive",
                    }
                raw = zf.read(file_path)
                tool_contents[file_path] = raw
                try:
                    code = raw.decode("utf-8")
                except UnicodeDecodeError:
                    return {
                        "status": "error",
                        "error": f"Tool file '{file_path}' is not valid UTF-8",
                    }
                violations = _check_code_safety(code, file_path)
                all_violations.extend(violations)

            if all_violations:
                return {
                    "status": "blocked",
                    "error": "Security scan failed — package contains dangerous code patterns",
                    "violations": all_violations,
                }

    except zipfile.BadZipFile:
        return {"status": "error", "error": "Uploaded file is not a valid zip archive"}

    # ── 4. Copy tool files to tools directory ─────────────────────────────────
    _TOOLS_DIR.mkdir(parents=True, exist_ok=True)
    installed_files: List[str] = []

    for file_path, raw_bytes in tool_contents.items():
        # file_path is like "tools/some_tool.py" — we only want the filename
        dest_name = Path(file_path).name
        dest = _TOOLS_DIR / dest_name
        dest.write_bytes(raw_bytes)
        installed_files.append(dest_name)
        logger.info("Installed tool file: %s", dest)

    # ── 5. Record in DB ───────────────────────────────────────────────────────
    skill_id: str = manifest["id"]
    skill_name: str = manifest["name"]
    version: str = manifest.get("version", "0.0.0")

    # Check for existing record (avoid duplicates)
    existing = db.query(Plugin).filter(
        Plugin.source_url.like(f"package://{skill_id}%"),
        Plugin.status == "installed",
    ).first()
    if existing:
        return {
            "status": "error",
            "error": (
                f"Package '{skill_name}' is already installed (id: {existing.id[:8]}). "
                "Uninstall it first before reinstalling."
            ),
        }

    audit_result = {
        "risk_level": "low",
        "is_builtin": False,
        "scanned_files": installed_files,
        "warnings": ["Third-party package — review source before using"],
        "audited_at": datetime.utcnow().isoformat(),
    }

    plugin = Plugin(
        id=str(uuid.uuid4()),
        name=skill_name,
        version=version,
        description=manifest.get("description", ""),
        config={},
        status="installed",
        author=manifest.get("author", "unknown"),
        category=manifest.get("category", ""),
        permissions_required=manifest.get("permissions_required", []),
        security_audit=audit_result,
        source_url=f"package://{skill_id}@{version}",
    )
    db.add(plugin)
    db.commit()

    logger.info(
        "Package installed: %s v%s (plugin id: %s, files: %s)",
        skill_name, version, plugin.id[:8], installed_files,
    )

    tools_provided = [e.get("name", "") for e in tool_entries]

    return {
        "status": "installed",
        "installation_id": plugin.id,
        "name": skill_name,
        "version": version,
        "tools_provided": tools_provided,
        "installed_files": installed_files,
        "installed_at": plugin.installed_at.isoformat() if plugin.installed_at else None,
        "restart_required": True,
        "notice": (
            "Tool files have been copied to disk and the plugin has been recorded in the "
            "database. To make the new tools available to the agent, please restart the "
            "backend service (e.g. `uvicorn` / `gunicorn`). The tools will be auto-discovered "
            "on the next startup."
        ),
    }


# ── install_from_url ───────────────────────────────────────────────────────────

def install_from_url(url: str, db) -> dict:
    """
    Download a skill package from *url* and install it.

    The URL is expected to point to a raw zip file — typically the
    ``GET /api/v1/plugins/packages/{skill_id}`` endpoint of another AIOS instance.

    Raises ValueError for non-http(s) URLs.
    """
    import urllib.request
    import urllib.error

    url = url.strip()
    if not url.lower().startswith(("http://", "https://")):
        return {"status": "error", "error": "Only http:// and https:// URLs are supported"}

    logger.info("Downloading skill package from: %s", url)

    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "AIOS-SkillPackager/1.0"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            zip_bytes = resp.read()
    except urllib.error.HTTPError as exc:
        return {"status": "error", "error": f"HTTP {exc.code} while fetching package: {exc.reason}"}
    except urllib.error.URLError as exc:
        return {"status": "error", "error": f"Network error fetching package: {exc.reason}"}
    except Exception as exc:
        return {"status": "error", "error": f"Failed to download package: {exc}"}

    if not zip_bytes:
        return {"status": "error", "error": "Downloaded package is empty"}

    logger.info("Downloaded %d bytes from %s, installing…", len(zip_bytes), url)
    result = install_from_package(zip_bytes, db)
    result["source_url"] = url
    return result
