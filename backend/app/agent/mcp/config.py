"""
MCP server runtime config types + variable substitution helpers.

Historically this module also read/wrote ``{WORKSPACE}/.mcp.json`` (Claude
Code-compatible format). That fallback path is gone — DB (``mcp_servers``
table, filtered by ``status='enabled' AND deleted_at IS NULL``) is the
single source of truth for runtime MCP configs. See
:func:`app.services.mcp_runtime.get_active_runtime_configs` for the live
loader.

What stays here:

* :class:`MCPServerConfig` — the in-memory dataclass that
  :mod:`app.services.mcp_runtime` builds from DB rows and that
  :class:`app.agent.mcp.client.MCPClientManager` consumes.
* :func:`_build_substitutions` / :func:`_interpolate` /
  :func:`_interpolate_obj` — variable substitution applied to the
  DB-stored command / args / env templates so that placeholders like
  ``${VENV_PYTHON}``, ``${BACKEND_DIR}``, ``${AGENT_WORKSPACE}``,
  ``${NPX}`` resolve at runtime rather than being hard-coded into the
  DB row.

Supported substitutions:
  ``${REPO_ROOT}``       — repo root directory (parent of backend/)
  ``${BACKEND_DIR}``     — backend/ source directory
  ``${BACKEND_ENV}``     — path to backend/.env
  ``${AGENT_WORKSPACE}`` — value of AGENT_WORKSPACE env var
  ``${VENV_PYTHON}``     — Python interpreter currently running (sys.executable)
  ``${NPX}``             — npx executable resolved from PATH
"""
import logging
import os
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict

logger = logging.getLogger(__name__)

WORKSPACE = os.environ.get("AGENT_WORKSPACE", "/tmp/agent_workspace")


def _build_substitutions() -> Dict[str, str]:
    """Build the variable substitution table for DB-stored MCP config templates."""
    # REPO_ROOT = directory containing backend/, frontend/, workspace/, etc.
    # Resolved as: parent of the directory that contains this config.py file
    # (config.py lives at backend/app/agent/mcp/config.py → parents[3] = repo root)
    backend_dir = str(Path(__file__).resolve().parents[3])
    repo_root = str(Path(backend_dir).parent)
    backend_env = os.path.join(backend_dir, ".env")
    npx = shutil.which("npx") or "npx"
    return {
        "REPO_ROOT":       repo_root,
        "BACKEND_DIR":     backend_dir,
        "BACKEND_ENV":     backend_env,
        "AGENT_WORKSPACE": WORKSPACE,
        "VENV_PYTHON":     sys.executable,
        "NPX":             npx,
    }


def _interpolate(value: str, subs: Dict[str, str]) -> str:
    """Replace ${VAR} placeholders with resolved values."""
    for var, resolved in subs.items():
        value = value.replace(f"${{{var}}}", resolved)
    return value


def _interpolate_obj(obj, subs: Dict[str, str]):
    """Recursively interpolate strings in dicts/lists."""
    if isinstance(obj, str):
        return _interpolate(obj, subs)
    if isinstance(obj, list):
        return [_interpolate_obj(item, subs) for item in obj]
    if isinstance(obj, dict):
        return {k: _interpolate_obj(v, subs) for k, v in obj.items()}
    return obj


@dataclass
class MCPServerConfig:
    """Configuration for a single MCP server."""
    name: str
    type: str = "stdio"                          # "stdio" | "http" (Streamable HTTP)
    command: str = ""                            # stdio: executable path
    args: list = field(default_factory=list)     # stdio: command arguments
    env: Dict[str, str] = field(default_factory=dict)  # stdio: subprocess env; http: request headers
    url: str = ""                                # http: server URL
