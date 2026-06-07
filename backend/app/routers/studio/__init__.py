"""Studio domain router — /api/studio/v1/*

Scope: AI application construction only.
  Agents, Workflows, Tools, MCP, Knowledge, Memory, Skills, Plugins,
  Connectors, Docs, Uploads, Instructions, External Memory.

Rule: no imports from app.agent.executor or any core runtime service.
"""
from fastapi import APIRouter

from app.routers.studio import (
    agents, workflows, tools, knowledge, memory, auto_skills,
    plugins, connectors, connector_config, docs, uploads,
    ai_tools_mcp, external_memory, mcp_servers,
    mcp_external_connections, instructions, auth,
)

router = APIRouter()

router.include_router(auth.router)
router.include_router(auth.router_me)
router.include_router(agents.router)
router.include_router(workflows.router)
router.include_router(tools.router)
router.include_router(knowledge.router)
router.include_router(memory.router)
router.include_router(auto_skills.router)
router.include_router(plugins.router)
router.include_router(connectors.router)
router.include_router(connector_config.router)
router.include_router(docs.router)
router.include_router(uploads.router)
router.include_router(uploads._workspace_router)
router.include_router(ai_tools_mcp.router)
router.include_router(external_memory.router)
router.include_router(mcp_servers.router)
router.include_router(mcp_external_connections.router)
router.include_router(instructions.router)
