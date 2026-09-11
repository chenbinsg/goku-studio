"""What MCP an agent needs, and whether it has it.

Studio's copy of goku-core's app/services/agent_permissions.py — the checks the
agent page and the workflow designer show. Requesting and granting through the
approval centre live in core only; studio forwards those requests there.

An agent's MCP needs come from two declared places: the MCP capabilities in its
own tool list, and the MCP capabilities called by the workflows it is configured
to run — runs execute as the calling agent, so their MCP calls are authorized
against it.
"""
from __future__ import annotations

from app import models
from app.services.mcp_authorizations import (
    ERR_AUTHZ_QUOTA,
    ERR_CAPABILITY_QUOTA,
    ERR_CAPABILITY_RATE,
    AuthorizationError,
    check_principal_authorization,
)

GRANT_PERMISSION = "mcp_authorization.write"


def mcp_tools_in_dag(dag: dict | None) -> list[str]:
    """MCP capabilities a DAG calls directly from tool_call nodes
    (``<server_code>__<capability_name>``), in node order, without duplicates."""
    seen, out = set(), []
    for node in (dag or {}).get("nodes") or []:
        if node.get("type") != "tool_call":
            continue
        tool = str((node.get("config") or {}).get("tool") or "")
        if "__" in tool and tool not in seen:
            seen.add(tool)
            out.append(tool)
    return out


def user_has_permission(db, user, permission: str) -> bool:
    """Same rule as auth.require_permission, asked as a question."""
    if getattr(user, "is_superuser", False):
        return True
    role_ids = [ur.role_id for ur in
                db.query(models.UserRole).filter(models.UserRole.user_id == user.id).all()]
    if not role_ids:
        return False
    return any(
        r.permissions and permission in r.permissions
        for r in db.query(models.Role).filter(models.Role.id.in_(role_ids)).all()
    )


def _lookup_capability(db, tool: str):
    """(capability, server) for ``<server_code>__<capability_name>``, or None."""
    server_code, _, cap_name = tool.partition("__")
    return (
        db.query(models.MCPCapability, models.MCPServer)
        .join(models.MCPServer, models.MCPCapability.server_id == models.MCPServer.id)
        .filter(models.MCPServer.code == server_code,
                models.MCPCapability.capability_name == cap_name)
        .first()
    )


def capability_status(db, agent_id: str, tool: str) -> dict:
    """Authorization state of one MCP capability for ``agent_id``.

    ``status`` is one of authorized / unauthorized / quota_exceeded / disabled /
    unregistered. A switched-off server or capability is reported as disabled
    rather than unauthorized: granting would not fix it.
    """
    item = {"tool": tool, "server_id": None, "capability_id": None}
    row = _lookup_capability(db, tool)
    if row is None:
        return {**item, "status": "unregistered", "reason": "能力未注册或未同步"}
    cap, server = row
    item.update(server_id=server.id, capability_id=cap.id)
    if getattr(server, "deleted_at", None) is not None or server.status != "enabled" \
            or cap.status != "active":
        return {**item, "status": "disabled", "reason": "MCP 服务或能力已停用"}
    try:
        check_principal_authorization(db, "agent", agent_id, cap.id)
    except AuthorizationError as exc:
        code = getattr(exc, "code", "")
        if code == ERR_CAPABILITY_RATE:
            # A burst guard, not an access decision: the agent is authorized.
            return {**item, "status": "authorized", "reason": ""}
        detail = exc.detail if isinstance(exc.detail, dict) else {}
        status = "quota_exceeded" if code in (ERR_AUTHZ_QUOTA, ERR_CAPABILITY_QUOTA) else "unauthorized"
        return {**item, "status": status, "reason": detail.get("message") or code}
    return {**item, "status": "authorized", "reason": ""}


def agent_permission_check(db, agent) -> list[dict]:
    """Every MCP capability ``agent`` needs, where each need comes from, and
    whether it is met."""
    needs: dict[str, list[dict]] = {}
    for tool in agent.allowed_tools or []:
        if isinstance(tool, str) and "__" in tool:
            needs.setdefault(tool, []).append({"type": "tools"})
    wf_ids = [w for w in (agent.allowed_workflows or []) if isinstance(w, str) and w]
    if wf_ids:
        for wf in db.query(models.Workflow).filter(models.Workflow.id.in_(wf_ids)).all():
            for tool in mcp_tools_in_dag(wf.dag):
                needs.setdefault(tool, []).append(
                    {"type": "workflow", "workflow_id": wf.id, "workflow_name": wf.name})
    return [{**capability_status(db, agent.id, tool), "sources": sources}
            for tool, sources in needs.items()]


_SCHEDULE_TRIGGER_TYPES = ("cron", "schedule", "scheduled")


def workflow_permission_warnings(db, workflow) -> list[dict]:
    """Agents that will run ``workflow`` but lack what it needs: every agent
    configured for it, and — when it is scheduled — its bound agent, flagged
    also when it runs the workflow without having it in its own list."""
    tools = mcp_tools_in_dag(workflow.dag)
    scheduled = any(isinstance(t, dict) and t.get("type") in _SCHEDULE_TRIGGER_TYPES
                    for t in (workflow.triggers or []))
    runners: dict[str, object] = {}
    for agent in db.query(models.AgentDefinition).all():
        if workflow.id in (agent.allowed_workflows or []):
            runners[agent.id] = agent
    bound_unconfigured = None
    if scheduled and workflow.agent_id and workflow.agent_id not in runners:
        bound_unconfigured = workflow.agent_id
        runners[workflow.agent_id] = (
            db.query(models.AgentDefinition)
            .filter(models.AgentDefinition.id == workflow.agent_id)
            .first()
        )

    warnings = []
    for agent_id, agent in runners.items():
        missing = [s for s in (capability_status(db, agent_id, t) for t in tools)
                   if s["status"] != "authorized"]
        not_configured = agent_id == bound_unconfigured
        if missing or not_configured:
            warnings.append({
                "agent_id": agent_id,
                "agent_name": getattr(agent, "name", None) or agent_id,
                "missing": missing,
                "scheduled_but_not_configured": not_configured,
            })
    return warnings
