import uuid
import json
import threading
from datetime import datetime
from io import BytesIO
from urllib.parse import quote
import hashlib
from fastapi import APIRouter, Depends, HTTPException, Query, Request, UploadFile, File
from fastapi.responses import StreamingResponse
from sqlalchemy import func
from sqlalchemy.orm import Session, load_only
from app.db import get_db
from app import models, schemas, auth
from app.services import encryption
from app.services.webhook_security import (
    check_and_store_replay,
    validate_timestamp,
    verify_timestamped_hmac,
)

router = APIRouter(prefix="/api/v1/workflows", tags=["workflows"])

_WORKFLOW_WEBHOOK_SECRET_MASK = "已配置 webhook secret"


def _find_webhook_trigger(triggers: list[dict] | None) -> dict | None:
    for trigger in triggers or []:
        if trigger.get("type") == "webhook":
            return trigger
    return None


def _workflow_query(db: Session):
    return db.query(models.Workflow).options(
        load_only(
            models.Workflow.id,
            models.Workflow.name,
            models.Workflow.description,
            models.Workflow.dag,
            models.Workflow.triggers,
            models.Workflow.variables,
            models.Workflow.version,
            models.Workflow.agent_id,
            models.Workflow.created_at,
        )
    )


def _sanitize_workflow_triggers(triggers: list[dict] | None) -> list[dict]:
    sanitized: list[dict] = []
    for trigger in triggers or []:
        item = dict(trigger)
        secret_enc = item.pop("secret_enc", None)
        item.pop("secret", None)
        if item.get("type") == "webhook":
            item["secret_configured"] = bool(secret_enc)
            if secret_enc:
                item["secret_display"] = _WORKFLOW_WEBHOOK_SECRET_MASK
        sanitized.append(item)
    return sanitized


def _prepare_workflow_triggers(
    triggers: list[dict] | None,
    *,
    existing_triggers: list[dict] | None = None,
) -> list[dict]:
    prepared: list[dict] = []
    existing_webhook = _find_webhook_trigger(existing_triggers)
    existing_secret_enc = existing_webhook.get("secret_enc") if existing_webhook else None

    for trigger in triggers or []:
        item = dict(trigger)
        if item.get("type") != "webhook":
            prepared.append(item)
            continue

        plaintext = item.pop("secret", None)
        item.pop("secret_display", None)
        item.pop("secret_configured", None)

        if plaintext:
            item["secret_enc"] = encryption.encrypt_secret(plaintext)
        elif existing_secret_enc:
            item["secret_enc"] = existing_secret_enc

        if not item.get("secret_enc"):
            raise HTTPException(
                status_code=422,
                detail="Webhook triggers require a per-workflow secret before they can be enabled",
            )

        prepared.append(item)

    return prepared


def _verify_workflow_webhook_request(trigger: dict, request_body: bytes, request: Request) -> None:
    secret_enc = trigger.get("secret_enc")
    if not secret_enc:
        raise HTTPException(status_code=403, detail="Workflow webhook secret is not configured")

    timestamp = request.headers.get("X-AIOS-Timestamp")
    signature = request.headers.get("X-AIOS-Signature")
    if not timestamp or not signature:
        raise HTTPException(status_code=403, detail="Missing webhook signature headers")
    if not validate_timestamp(timestamp):
        raise HTTPException(status_code=403, detail="Stale or invalid webhook timestamp")

    secret_value = encryption.decrypt_secret(secret_enc)
    if not verify_timestamped_hmac(
        secret_value,
        timestamp=timestamp,
        body=request_body,
        provided_signature=signature,
    ):
        raise HTTPException(status_code=403, detail="Invalid webhook signature")

    replay_fingerprint = hashlib.sha256(
        timestamp.encode("utf-8") + b":" + signature.encode("utf-8") + b":" + request_body
    ).hexdigest()
    replay_key = f"workflow:{request.url.path}:{replay_fingerprint}"
    if not check_and_store_replay(cache_key=replay_key):
        raise HTTPException(status_code=409, detail="Webhook request replay detected")


def _require_request_user(request: Request, db: Session) -> models.User:
    token = auth.get_access_token_from_request(request)
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")
    payload = auth.verify_token(token, "access")
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token payload")
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="User not found or inactive")
    return user


@router.get("")
def list_workflows(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """List all workflows with pagination."""
    query = _workflow_query(db)
    total = db.query(func.count(models.Workflow.id)).scalar() or 0
    items = query.order_by(models.Workflow.created_at.desc()).offset((page - 1) * size).limit(size).all()
    return {
        "total": total,
        "items": [
            {
                "id": w.id,
                "name": w.name,
                "description": w.description,
                "version": w.version,
                "created_at": w.created_at,
            }
            for w in items
        ],
    }


@router.post("", response_model=schemas.WorkflowResponse, status_code=201)
def create_workflow(workflow_data: schemas.WorkflowCreate, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)):
    stored_triggers = _prepare_workflow_triggers(workflow_data.triggers)
    workflow_id = str(uuid.uuid4())
    created_at = datetime.utcnow()
    version = "1.0.0"
    db.execute(
        models.Workflow.__table__.insert().values(
            id=workflow_id,
            name=workflow_data.name,
            description=workflow_data.description,
            dag=workflow_data.dag,
            triggers=stored_triggers,
            variables=workflow_data.variables,
            version=version,
            agent_id=workflow_data.agent_id,
            created_at=created_at,
        )
    )
    db.commit()
    # Reload cron schedules so newly-created workflows with cron triggers take effect immediately.
    try:
        from app.tasks.scheduler import reload_schedules
        reload_schedules()
    except Exception:
        pass
    return {"workflow_id": workflow_id, "version": version, "created_at": created_at}


@router.get("/{workflow_id}")
def get_workflow(
    workflow_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Get a single workflow with full DAG details."""
    workflow = _workflow_query(db).filter(models.Workflow.id == workflow_id).first()
    if not workflow:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return {
        "id": workflow.id,
        "name": workflow.name,
        "description": workflow.description,
        "dag": workflow.dag,
        "triggers": _sanitize_workflow_triggers(workflow.triggers),
        "variables": workflow.variables,
        "version": workflow.version,
        "agent_id": workflow.agent_id,
        "created_at": workflow.created_at,
    }


def _build_workflow_export_payload(workflow, db: Session) -> dict:
    """Build a portable, environment-agnostic workflow definition.

    The DB stores ``agent_id`` as a per-environment UUID, which is meaningless in
    another environment. Export resolves it to the agent's stable ``slug`` so import
    can re-bind to the matching agent in the target environment (fixes the
    cross-env agent_id mismatch that breaks ``report_recipients`` injection).
    Webhook secrets are masked by ``_sanitize_workflow_triggers`` — they are not
    exported and must be reconfigured after import.
    """
    agent_slug = None
    agent_id = getattr(workflow, "agent_id", None)
    if agent_id:
        agent = db.query(models.AgentDefinition).filter(
            models.AgentDefinition.id == agent_id
        ).first()
        if agent:
            agent_slug = agent.slug
    return {
        "schema": "aios.workflow-export",
        "version": "1.0",
        "exported_at": datetime.utcnow().isoformat() + "Z",
        "workflow": {
            "name": workflow.name,
            "description": workflow.description,
            "dag": workflow.dag,
            "triggers": _sanitize_workflow_triggers(workflow.triggers),
            "variables": workflow.variables,
            "agent_slug": agent_slug,
        },
    }


@router.get("/{workflow_id}/export")
def export_workflow(
    workflow_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Export a workflow as a portable JSON file (DAG + agent slug, no secrets)."""
    workflow = _workflow_query(db).filter(models.Workflow.id == workflow_id).first()
    if not workflow:
        raise HTTPException(status_code=404, detail="Workflow not found")
    payload = _build_workflow_export_payload(workflow, db)
    auth.log_audit_action(db, current_user.id, "export_workflow", "workflow", workflow.id, {"name": workflow.name})
    safe_name = (workflow.name or "workflow").replace("/", "_").replace(" ", "_")
    filename = f"{safe_name}.workflow.json"
    content = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    # RFC 5987: ASCII fallback + UTF-8 filename* so non-latin-1 names (e.g. Chinese) don't break the latin-1 header.
    disposition = "attachment; filename=\"workflow.json\"; filename*=UTF-8''" + quote(filename)
    return StreamingResponse(
        BytesIO(content),
        media_type="application/json",
        headers={"Content-Disposition": disposition},
    )


@router.post("/import", status_code=201)
def import_workflow(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Create a workflow from an exported JSON file.

    Always creates a NEW workflow (fresh id); a name collision is suffixed with
    " (Imported)". ``agent_slug`` is resolved to this environment's agent id so the
    workflow binds to the local agent — this is what makes export/import portable.
    """
    try:
        raw = file.file.read()
        payload = json.loads(raw)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid workflow file: not valid JSON") from None

    if payload.get("schema") != "aios.workflow-export":
        raise HTTPException(status_code=400, detail="Unrecognized file: expected schema 'aios.workflow-export'")

    wf_data = payload.get("workflow")
    if not isinstance(wf_data, dict) or not wf_data.get("dag"):
        raise HTTPException(status_code=400, detail="Import payload is missing workflow.dag")

    name = (wf_data.get("name") or "Imported Workflow").strip()
    if db.query(models.Workflow).filter(models.Workflow.name == name).first():
        name = f"{name} (Imported)"

    # Resolve agent_slug → this environment's agent id (portable re-binding).
    agent_id = None
    agent_slug = wf_data.get("agent_slug")
    agent_missing = False
    if agent_slug:
        agent = db.query(models.AgentDefinition).filter(
            models.AgentDefinition.slug == agent_slug
        ).first()
        if agent:
            agent_id = agent.id
        else:
            agent_missing = True

    workflow_id = str(uuid.uuid4())
    created_at = datetime.utcnow()
    db.execute(
        models.Workflow.__table__.insert().values(
            id=workflow_id,
            name=name,
            description=wf_data.get("description"),
            dag=wf_data["dag"],
            triggers=_prepare_workflow_triggers(wf_data.get("triggers") or []),
            variables=wf_data.get("variables") or {},
            version="1.0.0",
            agent_id=agent_id,
            created_at=created_at,
        )
    )
    db.commit()
    auth.log_audit_action(db, current_user.id, "import_workflow", "workflow", workflow_id, {"name": name, "source_file": file.filename})
    try:
        from app.tasks.scheduler import reload_schedules
        reload_schedules()
    except Exception:
        pass
    return {
        "workflow_id": workflow_id,
        "name": name,
        "agent_slug": agent_slug,
        "agent_bound": agent_id is not None,
        "agent_missing": agent_missing,
        "imported_at": created_at.isoformat() + "Z",
    }


@router.put("/{workflow_id}")
def update_workflow(
    workflow_id: str,
    data: schemas.WorkflowCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Update an existing workflow's name, description, DAG, triggers, and variables."""
    workflow = _workflow_query(db).filter(models.Workflow.id == workflow_id).first()
    if not workflow:
        raise HTTPException(status_code=404, detail="Workflow not found")

    if data.name is not None:
        workflow.name = data.name
    if data.description is not None:
        workflow.description = data.description
    if data.dag is not None:
        workflow.dag = data.dag
    if data.triggers is not None:
        workflow.triggers = _prepare_workflow_triggers(
            data.triggers,
            existing_triggers=workflow.triggers,
        )
    if data.variables is not None:
        workflow.variables = data.variables
    # Only touch agent binding when the client explicitly sends the field (so a DAG-only
    # save doesn't unbind). Sending agent_id=null is a deliberate unbind.
    _fields_set = getattr(data, "model_fields_set", None) or getattr(data, "__fields_set__", set())
    if "agent_id" in _fields_set:
        workflow.agent_id = data.agent_id

    workflow_pk = workflow.id

    # Bump version
    try:
        major, minor = workflow.version.rsplit(".", 1)
        workflow.version = f"{major}.{int(minor) + 1}"
    except Exception:
        workflow.version = "1.1"

    response_data = {
        "id": workflow.id,
        "name": workflow.name,
        "description": workflow.description,
        "dag": workflow.dag,
        "triggers": _sanitize_workflow_triggers(workflow.triggers),
        "variables": workflow.variables,
        "version": workflow.version,
        "agent_id": workflow.agent_id,
        "created_at": workflow.created_at,
    }

    db.commit()
    auth.log_audit_action(db, current_user.id, "update_workflow", "workflow", workflow_pk, {"name": response_data["name"]})

    # Reload cron schedules so trigger updates take effect immediately.
    try:
        from app.tasks.scheduler import reload_schedules
        reload_schedules()
    except Exception:
        pass

    return response_data


@router.post("/{workflow_id}/execute", response_model=schemas.WorkflowExecuteResponse)
def execute_workflow(workflow_id: str, execute_data: schemas.WorkflowExecute, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)):
    from app.services import workflow as wf_svc
    workflow = _workflow_query(db).filter(models.Workflow.id == workflow_id).first()
    if not workflow:
        raise HTTPException(status_code=404, detail="Workflow not found")
    validation = wf_svc.validate(workflow.dag)
    if not validation["valid"]:
        raise HTTPException(status_code=422, detail=f"Invalid DAG: {'; '.join(validation['errors'])}")
    variables = dict(workflow.variables or {})
    variables.update(execute_data.variables or {})
    workflow_dag = workflow.dag
    execution = models.WorkflowExecution(id=str(uuid.uuid4()), workflow_id=workflow_id, variables=variables)
    db.add(execution)
    db.flush()
    execution_id = execution.id
    started_at = execution.started_at
    db.commit()
    if not execute_data.dry_run:
        threading.Thread(target=wf_svc.start_execution, args=(workflow_id, workflow_dag, variables, execution_id), daemon=True).start()
    return {"execution_id": execution_id, "status": "running" if not execute_data.dry_run else "dry_run", "started_at": started_at}


@router.post("/{workflow_id}/executions/{execution_id}/resume")
def resume_workflow(
    workflow_id: str,
    execution_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Resume a workflow execution that was paused at an approval node."""
    from app.services.workflow_engine import run_dag

    workflow = _workflow_query(db).filter(models.Workflow.id == workflow_id).first()
    if not workflow:
        raise HTTPException(status_code=404, detail="Workflow not found")

    execution = db.query(models.WorkflowExecution).filter(
        models.WorkflowExecution.id == execution_id
    ).first()
    if not execution:
        raise HTTPException(status_code=404, detail="Execution not found")
    if execution.status != "waiting_approval":
        raise HTTPException(status_code=422, detail=f"Execution is not waiting for approval (status={execution.status})")

    # Get saved state
    saved_vars = dict(execution.variables or {})
    resume_layer = saved_vars.pop("_resume_from_layer", 0)

    # Resume DAG execution in background
    def _resume():
        try:
            result = run_dag(
                dag=workflow.dag,
                variables=saved_vars,
                execution_id=execution_id,
                resume_from_layer=resume_layer,
            )
            from app.db import SessionLocal
            rdb = SessionLocal()
            try:
                ex = rdb.query(models.WorkflowExecution).filter(
                    models.WorkflowExecution.id == execution_id
                ).first()
                if ex:
                    if result["status"] == "waiting_approval":
                        ex.status = "waiting_approval"
                        ex.variables = {**result.get("output", {}), "_resume_from_layer": result.get("resume_from_layer", 0)}
                    else:
                        ex.status = result["status"]
                        from datetime import datetime
                        ex.completed_at = datetime.utcnow()
                    rdb.commit()
            finally:
                rdb.close()
        except Exception:
            pass

    threading.Thread(target=_resume, daemon=True).start()

    return {"execution_id": execution_id, "status": "resuming"}


@router.delete("/{workflow_id}", status_code=204)
def delete_workflow(
    workflow_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Delete a workflow definition."""
    workflow = _workflow_query(db).filter(models.Workflow.id == workflow_id).first()
    if not workflow:
        raise HTTPException(status_code=404, detail="Workflow not found")
    auth.log_audit_action(db, current_user.id, "delete_workflow", "workflow", workflow.id, {"name": workflow.name})
    # Delete child execution records first to avoid FK constraint violation
    db.execute(
        models.WorkflowExecution.__table__.delete().where(
            models.WorkflowExecution.workflow_id == workflow_id
        )
    )
    db.execute(
        models.Workflow.__table__.delete().where(
            models.Workflow.id == workflow_id
        )
    )
    db.commit()


@router.post("/{workflow_id}/trigger")
async def trigger_workflow(
    workflow_id: str,
    request: Request,
    payload: dict = None,
    db: Session = Depends(get_db),
):
    """Trigger a workflow execution via webhook. No auth required if workflow has webhook trigger."""
    from app.services import workflow as wf_svc

    workflow = _workflow_query(db).filter(models.Workflow.id == workflow_id).first()
    if not workflow:
        raise HTTPException(status_code=404, detail="Workflow not found")

    # Verify webhook trigger is configured
    triggers = workflow.triggers or []
    webhook_trigger = _find_webhook_trigger(triggers)
    if not webhook_trigger:
        raise HTTPException(status_code=403, detail="Workflow does not have a webhook trigger configured")

    request_body = await request.body()
    _verify_workflow_webhook_request(webhook_trigger, request_body, request)

    validation = wf_svc.validate(workflow.dag)
    if not validation["valid"]:
        raise HTTPException(status_code=422, detail=f"Invalid DAG: {'; '.join(validation['errors'])}")

    variables = dict(workflow.variables or {})
    if payload:
        variables.update(payload)
    variables["_trigger"] = "webhook"
    workflow_dag = workflow.dag

    execution = models.WorkflowExecution(
        id=str(uuid.uuid4()),
        workflow_id=workflow_id,
        variables=variables,
    )
    db.add(execution)
    db.flush()
    execution_id = execution.id
    started_at = execution.started_at
    db.commit()

    threading.Thread(
        target=wf_svc.start_execution,
        args=(workflow_id, workflow_dag, variables, execution_id),
        daemon=True,
    ).start()

    return {"execution_id": execution_id, "status": "running", "started_at": started_at}


# ─── Execution monitoring endpoints ──────────────────────────────────────────

@router.get("/{workflow_id}/executions")
def list_executions(
    workflow_id: str,
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """List execution history for a workflow."""
    workflow = _workflow_query(db).filter(models.Workflow.id == workflow_id).first()
    if not workflow:
        raise HTTPException(status_code=404, detail="Workflow not found")
    query = db.query(models.WorkflowExecution).filter(models.WorkflowExecution.workflow_id == workflow_id)
    total = query.count()
    items = query.order_by(models.WorkflowExecution.started_at.desc()).offset((page - 1) * size).limit(size).all()
    return {
        "total": total,
        "items": [
            {
                "id": ex.id,
                "status": ex.status,
                "resume_from_layer": ex.resume_from_layer,
                "error_message": ex.error_message,
                "started_at": ex.started_at,
                "completed_at": ex.completed_at,
            }
            for ex in items
        ],
    }


@router.get("/{workflow_id}/executions/{execution_id}")
def get_execution_detail(
    workflow_id: str,
    execution_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Get execution detail with all node statuses."""
    execution = db.query(models.WorkflowExecution).filter(
        models.WorkflowExecution.id == execution_id,
        models.WorkflowExecution.workflow_id == workflow_id,
    ).first()
    if not execution:
        raise HTTPException(status_code=404, detail="Execution not found")

    node_executions = db.query(models.WorkflowNodeExecution).filter(
        models.WorkflowNodeExecution.execution_id == execution_id
    ).order_by(models.WorkflowNodeExecution.layer_index, models.WorkflowNodeExecution.started_at).all()

    return {
        "id": execution.id,
        "workflow_id": execution.workflow_id,
        "status": execution.status,
        "resume_from_layer": execution.resume_from_layer,
        "error_message": execution.error_message,
        "started_at": execution.started_at,
        "completed_at": execution.completed_at,
        "node_executions": [
            {
                "id": ne.id,
                "node_id": ne.node_id,
                "node_type": ne.node_type,
                "status": ne.status,
                "layer_index": ne.layer_index,
                "input_data": ne.input_data,
                "output_data": ne.output_data,
                "error_message": ne.error_message,
                "started_at": ne.started_at,
                "completed_at": ne.completed_at,
            }
            for ne in node_executions
        ],
    }


@router.get("/{workflow_id}/executions/{execution_id}/events")
async def stream_execution_events(
    workflow_id: str,
    execution_id: str,
    request: Request,
    db: Session = Depends(get_db),
):
    """SSE stream for real-time execution monitoring."""
    from fastapi.responses import StreamingResponse
    from app.services import event_bus
    import asyncio
    import json

    _require_request_user(request, db)

    async def event_generator():
        queue = asyncio.Queue()
        event_bus.subscribe(execution_id, queue)
        try:
            yield f"data: {json.dumps({'type': 'connected', 'execution_id': execution_id})}\n\n"
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30)
                    yield f"data: {json.dumps(event, default=str)}\n\n"
                    if event.get("type") in ("execution_completed", "execution_failed", "execution_cancelled"):
                        break
                except asyncio.TimeoutError:
                    yield "data: {\"type\":\"heartbeat\"}\n\n"
        finally:
            event_bus.unsubscribe(execution_id, queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/{workflow_id}/executions/{execution_id}/cancel")
def cancel_execution(
    workflow_id: str,
    execution_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Cancel a running workflow execution."""
    from app.services import event_bus
    execution = db.query(models.WorkflowExecution).filter(
        models.WorkflowExecution.id == execution_id,
        models.WorkflowExecution.workflow_id == workflow_id,
    ).first()
    if not execution:
        raise HTTPException(status_code=404, detail="Execution not found")
    if execution.status not in ("running", "waiting_approval"):
        raise HTTPException(status_code=422, detail=f"Cannot cancel execution with status={execution.status}")

    execution.status = "cancelling"
    execution.cancelled_at = datetime.utcnow()
    db.commit()

    event_bus.publish(execution_id, {"type": "execution_cancelled", "execution_id": execution_id})
    return {"execution_id": execution_id, "status": "cancelling"}


@router.post("/{workflow_id}/executions/{execution_id}/retry-from-layer")
def retry_from_layer(
    workflow_id: str,
    execution_id: str,
    body: dict = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Retry a failed workflow execution from a specific layer checkpoint."""
    from app.services import workflow as wf_svc

    workflow = _workflow_query(db).filter(models.Workflow.id == workflow_id).first()
    if not workflow:
        raise HTTPException(status_code=404, detail="Workflow not found")

    old_exec = db.query(models.WorkflowExecution).filter(
        models.WorkflowExecution.id == execution_id,
        models.WorkflowExecution.workflow_id == workflow_id,
    ).first()
    if not old_exec:
        raise HTTPException(status_code=404, detail="Execution not found")

    body = body or {}
    layer = body.get("layer", old_exec.resume_from_layer or 0)

    # Create new execution starting from checkpoint
    workflow_dag = workflow.dag
    new_exec = models.WorkflowExecution(
        id=str(uuid.uuid4()),
        workflow_id=workflow_id,
        status="running",
        variables=old_exec.variables,
        resume_from_layer=layer,
    )
    db.add(new_exec)
    db.flush()
    new_execution_id = new_exec.id
    db.commit()

    threading.Thread(
        target=wf_svc.start_execution,
        args=(workflow_id, workflow_dag, old_exec.variables or {}, new_execution_id),
        kwargs={"resume_from_layer": layer},
        daemon=True,
    ).start()

    return {"new_execution_id": new_execution_id, "status": "running", "resume_from_layer": layer}
