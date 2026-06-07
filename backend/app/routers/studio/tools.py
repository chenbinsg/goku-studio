import uuid
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.db import get_db
from app import models, schemas, auth
from app.agent.tool_registry import get_tool_registry

router = APIRouter(prefix="/api/v1/tools", tags=["tools"])


@router.get("", response_model=schemas.ToolList)
def list_tools(db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)):
    """List all tools from database and built-in registry."""
    tools = db.query(models.Tool).all()
    tool_list = [{"id": t.id, "name": t.name, "description": t.description, "parameters": t.schema, "permission_level": t.permission_level} for t in tools]
    db_names = {t.name for t in tools}

    # Add built-in tools from registry (skip any already in DB to avoid duplicates)
    try:
        registry = get_tool_registry()
        for tool in registry.list_all():
            if tool.name not in db_names:
                tool_list.append({
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters,
                    "permission_level": tool.permission_level
                })
    except Exception:
        pass

    return {"tools": tool_list}


@router.get("/{tool_name}")
def get_tool(tool_name: str, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)):
    """Get a single tool by name."""
    tool = db.query(models.Tool).filter(models.Tool.name == tool_name).first()
    if tool:
        return {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.schema,
            "permission_level": tool.permission_level,
            "created_at": tool.created_at,
        }

    # Check built-in tools from registry
    try:
        registry = get_tool_registry()
        builtin_tool = registry.get(tool_name)
        if builtin_tool:
            return {
                "name": builtin_tool.name,
                "description": builtin_tool.description,
                "parameters": builtin_tool.parameters,
                "permission_level": builtin_tool.permission_level,
            }
    except Exception:
        pass

    raise HTTPException(status_code=404, detail=f"Tool '{tool_name}' not found")


@router.post("", response_model=schemas.ToolRegisterResponse, status_code=201)
def register_tool(tool_data: schemas.ToolRegister, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)):
    if not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="Admin required")
    tool = models.Tool(id=str(uuid.uuid4()), name=tool_data.name, description=tool_data.description, handler=tool_data.handler, schema=tool_data.tool_schema, permission_level=tool_data.permission_level)
    db.add(tool)
    db.commit()
    return {"tool_id": tool.id, "status": "registered"}


@router.post("/{tool_name}/execute", response_model=schemas.ToolResponse)
def execute_tool(tool_name: str, execute_data: schemas.ToolExecute, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)):
    from app.services import dlp, audit, sandbox as sandbox_service
    from app.agent.context import AgentContext

    # DLP check on input
    try:
        dlp_result = dlp.check_outbound(execute_data.parameters)
        if dlp_result.get("blocked"):
            raise HTTPException(status_code=403, detail=f"DLP blocked: {dlp_result.get('reason', 'Sensitive data detected')}")
    except HTTPException:
        raise
    except Exception:
        pass

    # Code execution via sandbox (special handling)
    if tool_name in ["code", "python"]:
        sb = sandbox_service.Sandbox()
        result_sb = sb.execute(execute_data.parameters.get("code", ""))
        if not result_sb.get("success", True):
            raise HTTPException(status_code=403, detail=result_sb.get("error", "Code execution blocked"))
        return {"result": result_sb, "exit_code": 0, "logs": []}

    # Execute tool via registry
    try:
        registry = get_tool_registry()
        ctx = AgentContext(
            user_id=str(current_user.id),
            username=getattr(current_user, "username", "") or "",
            task_id=None,
        )
        result = registry.execute(tool_name, execute_data.parameters, ctx, timeout=execute_data.timeout, db=db)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Tool '{tool_name}' not found")
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")
    except Exception as e:
        import logging as _log
        _log.getLogger(__name__).error("Tool execution error: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Tool execution failed")

    # DLP check on output
    try:
        result = dlp.process_output(result)
    except Exception:
        pass

    # Audit log
    try:
        audit.log("execute_tool", str(current_user.id), {"tool": tool_name, "parameters": execute_data.parameters})
    except Exception:
        try:
            audit.fallback_log("execute_tool", str(current_user.id), {"tool": tool_name})
        except Exception:
            pass

    exit_code = 1 if isinstance(result, dict) and result.get("error") else 0
    return {"result": result, "exit_code": exit_code, "logs": []}
