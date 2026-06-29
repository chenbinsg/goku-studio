"""
goku-studio — Studio domain API service.

Owns: agent_definitions, workflows, tools, MCP servers, knowledge,
      external_memory_sources, IRA, improvement_proposals, prompt_experiments.

Does NOT own: tasks, conversations, approvals, users, tenants, channels.
Core runtime (task execution, ReAct loop) lives in goku-core.

During the monorepo transition period, Studio is also mounted inside the
monorepo's main.py (app/routers/studio). This standalone main.py is used
only when Studio is deployed as a separate service.
"""
from __future__ import annotations

import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Importing this configures JSON logging as a side effect.  Keep it before the
# router import so logs emitted while the routers import are JSON too.
from app import logging_config  # noqa: F401

# ── Lazy: only import Studio router + Studio models ───────────────────────────
# This import boundary is the whole point of the extraction.
from app.routers.studio import router as studio_router  # type: ignore[import]

app = FastAPI(
    title="Goku Studio API",
    version="1.9.49",
    description="AI application construction API — agents, workflows, tools, MCP, knowledge.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("ALLOWED_ORIGINS", "http://localhost:5106,http://localhost:5107").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Sub-routers already carry "/api/v1/" in their individual prefixes
# (e.g. agents.router has prefix="/api/v1/agents").  Mounting the aggregate
# at "" keeps routes at /api/v1/... which is backward-compatible with the
# Console frontend during the transition period.
#
# Phase 5 follow-on: strip "/api/v1/" from individual sub-router files and
# re-mount the aggregate at prefix="/api/studio/v1" for the final URL split.
app.include_router(studio_router)
