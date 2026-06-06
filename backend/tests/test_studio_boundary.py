"""
Boundary tests for goku-studio.

Verify that the Studio service:
1. Boots cleanly with Studio-only models in scope.
2. Registers the expected Studio routes.
3. Does NOT import Core runtime (executor, stateful_runtime, action_guard).
4. Does NOT import from app.routers.core or app.routers.admin.
"""
from __future__ import annotations

import ast
import importlib
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
APP_DIR = BACKEND_DIR / "app"
ROUTERS_STUDIO_DIR = APP_DIR / "routers" / "studio"


# ── helpers ────────────────────────────────────────────────────────────────────

def _py_files(directory: Path) -> list[Path]:
    return [p for p in directory.rglob("*.py") if "__pycache__" not in p.parts]


def _collect_imports(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    imports: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.append(alias.name)
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                imports.append(node.module)
    return imports


# ── test 1: app boots ──────────────────────────────────────────────────────────

def test_studio_app_loads():
    """FastAPI app must import without error."""
    from app.main import app  # noqa: F401
    assert app is not None


def test_studio_router_registers_routes():
    """Studio router must register a non-trivial number of routes."""
    from app.main import app
    api_routes = [r for r in app.routes if hasattr(r, "path") and "/v1/" in r.path]
    assert len(api_routes) >= 50, (
        f"Expected >= 50 Studio API routes, got {len(api_routes)}"
    )


def test_agent_routes_present():
    """Core Studio routes (agents, workflows, tools) must be registered."""
    from app.main import app
    paths = {r.path for r in app.routes if hasattr(r, "path")}
    for expected in ["/api/v1/agents", "/api/v1/workflows", "/api/v1/tools"]:
        assert any(p.startswith(expected) for p in paths), (
            f"Expected route starting with {expected!r} not found"
        )


# ── test 2: boundary — no Core runtime imports ─────────────────────────────────

FORBIDDEN_IN_STUDIO = [
    "app.agent.executor",
    "app.services.stateful_runtime",
    "app.services.action_guard",
    "app.routers.core",
    "app.routers.admin",
    "app.routers.channels",
]


def test_studio_routers_do_not_import_core_runtime():
    """Studio router files must not import the Core ReAct executor or runtime services."""
    violations: list[str] = []
    for py in _py_files(ROUTERS_STUDIO_DIR):
        imports = _collect_imports(py)
        for forbidden in FORBIDDEN_IN_STUDIO:
            if any(forbidden in imp for imp in imports):
                violations.append(f"  {py.name}: imports '{forbidden}'")

    assert not violations, (
        "\n[studio boundary] Forbidden Core imports found in Studio routers:\n"
        + "\n".join(violations)
    )


# ── test 3: models_studio exports ─────────────────────────────────────────────

def test_studio_models_export_key_classes():
    """models_studio.py must export the core Studio ORM classes."""
    from app.models_studio import (
        AgentDefinition,
        Workflow,
        MCPServer,
        KnowledgeDoc,
        ImprovementProposal,
        ToolCallStat,
    )
    assert AgentDefinition.__tablename__ == "agent_definitions"
    assert Workflow.__tablename__ == "workflows"
    assert MCPServer.__tablename__ == "mcp_servers"


# ── test 4: goku-shared imports work ──────────────────────────────────────────

def test_goku_shared_imports():
    """goku_shared package must be importable and functional."""
    from goku_shared.db import Base, get_db
    from goku_shared.auth import create_access_token, verify_token, hash_password
    from goku_shared.schemas import PaginatedResponse, TokenResponse

    token = create_access_token({"sub": "studio-test"})
    payload = verify_token(token)
    assert payload["sub"] == "studio-test"
    assert hash_password("pw").startswith("$2b$")
