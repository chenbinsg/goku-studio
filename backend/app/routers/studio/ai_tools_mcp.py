"""AI-Tool-side MCP invocation endpoint.

A separate router file (rather than extending ``routers/tools.py``) so
the AI Tool registry CRUD and the MCP invocation surface stay
independently mountable.

Route:
  POST /api/v1/ai-tools/{tool_id}/invoke
        AI-Tool-side invocation entry point. Runs the spec §11
        authorization + quota check chain, applies the authorization's
        parameter glue, calls the live MCP capability, consumes quota
        on success, and writes a fully-attributed mcp_call_logs row.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app import auth, models
from app.db import get_db
from app.schemas import AIToolInvokeRequest, AIToolInvokeResponse
from app.services import mcp_authorizations as authz


router = APIRouter(prefix="/api/v1/ai-tools", tags=["ai-tools-mcp"])


@router.post("/{tool_id}/invoke", response_model=AIToolInvokeResponse)
def invoke_ai_tool(
    tool_id: str,
    payload: AIToolInvokeRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.write")),
) -> AIToolInvokeResponse:
    """Call an MCP Capability as an AI Tool, gated by authorization.

    Runs the spec §11 check chain. On any failure a structured error is
    raised (HTTP 403) carrying one of:
      MCP_CAPABILITY_NOT_AUTHORIZED   — no authorization / server / cap
      MCP_AUTHORIZATION_DISABLED      — authorization exists but disabled
      MCP_AUTHORIZED_QUOTA_EXCEEDED   — this tool's allocated quota spent
      MCP_CAPABILITY_QUOTA_EXCEEDED   — capability total quota spent
    Every outcome (success or denial) is recorded in mcp_call_logs.

    On success returns the call-log id + a short sanitized output
    preview. The full response body is never returned here.
    """
    call_log, _response = authz.invoke_principal_via_mcp(
        db, "ai_tool", tool_id, payload.mcp_capability_id,
        input_data=payload.input,
        user_id=current_user.id,
        session_id=payload.session_id,
        invoke_type=payload.invoke_type,
        request=request,
    )
    return AIToolInvokeResponse(
        call_log_id=call_log.id,
        result=call_log.result,
        response_time_ms=call_log.response_time,
        output_summary=call_log.output_summary,
        error_type=call_log.error_type,
        error_message=call_log.error_message,
    )
