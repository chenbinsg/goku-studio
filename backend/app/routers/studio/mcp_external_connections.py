"""MCP external connection management API.

Platform-managed external connection configs under the MCP module —
CRUD + enable/disable + test. Secrets are always masked in responses;
the only plaintext path is the backend-runtime service function, never
an endpoint.

Permissions follow the project convention (same as routers/mcp_servers.py):
  - Read endpoints:  ``mcp_external_connections.read``
  - Write endpoints: ``mcp_external_connections.write``
  Superusers bypass via auth.require_permission.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app import auth, models
from app.db import get_db
from app.schemas import (
    MCPConnectionTestOutcome,
    MCPExternalConnectionCreate,
    MCPExternalConnectionDetail,
    MCPExternalConnectionListItem,
    MCPExternalConnectionListResponse,
    MCPExternalConnectionUpdate,
    MCPTransferImportResult,
)
from app.services import core_runtime_proxy
from app.services import mcp_external_connections as svc
from app.services import mcp_transfer as transfer

logger = __import__("logging").getLogger(__name__)

router = APIRouter(prefix="/api/v1/mcp-external-connections", tags=["mcp-external-connections"])

_READ = "mcp_external_connections.read"
_WRITE = "mcp_external_connections.write"


@router.get("", response_model=MCPExternalConnectionListResponse)
def list_connections(
    connection_type: Optional[str] = Query(None),
    enabled: Optional[bool] = Query(None),
    keyword: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission(_READ)),
) -> MCPExternalConnectionListResponse:
    """List external connections. Filters: connection_type / enabled / keyword."""
    total, items = svc.list_connections(
        db, connection_type=connection_type, enabled=enabled, keyword=keyword,
    )
    return MCPExternalConnectionListResponse(
        total=total,
        items=[MCPExternalConnectionListItem(**it) for it in items],
    )


@router.post("", response_model=MCPExternalConnectionDetail, status_code=201)
def create_connection(
    payload: MCPExternalConnectionCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission(_WRITE)),
) -> MCPExternalConnectionDetail:
    """Create a connection. Secret values are encrypted before insert;
    the response carries masked secrets only."""
    return MCPExternalConnectionDetail(
        **svc.create_connection(db, payload, user_id=current_user.id, request=request)
    )


@router.get("/export")
def export_connections(
    codes: Optional[str] = Query(
        None, description="逗号分隔的 code 列表;省略则导出全部",
    ),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission(_READ)),
):
    """Download active connections — a single connection is one JSON; a
    multi-connection selection / all is a zip of one self-contained JSON per
    connection (mirrors the MCP-server export). Secret values are replaced by
    an explanatory placeholder.

    Registered BEFORE ``/{connection_id}`` so the literal path wins.
    """
    code_list = [c.strip() for c in codes.split(",") if c.strip()] if codes else None
    stamp = f"{datetime.utcnow():%Y%m%d-%H%M%S}"
    resolved = transfer.resolve_export_connection_codes(db, code_list)
    if len(resolved) != 1:
        data = transfer.export_connections_zip(db, resolved)
        from fastapi.responses import Response
        return Response(
            content=data,
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="mcp-connections-{stamp}.zip"'},
        )
    bundle = transfer.export_connections(db, codes=resolved)
    return JSONResponse(
        content=bundle,
        headers={"Content-Disposition": f'attachment; filename="mcp-conn-{resolved[0]}-{stamp}.json"'},
    )


@router.get("/check-code")
def check_connection_codes(
    codes: str = Query(..., description="逗号分隔的 code 列表"),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission(_READ)),
) -> dict:
    """Code-uniqueness probe for the create drawer / import conflict
    dialog: returns which of the given codes are already taken by an
    active connection. Registered BEFORE ``/{connection_id}``."""
    code_list = [c.strip() for c in codes.split(",") if c.strip()]
    return {"existing": transfer.existing_connection_codes(db, code_list)}


@router.post("/import", response_model=MCPTransferImportResult)
def import_connections(
    bundle: dict,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission(_WRITE)),
) -> MCPTransferImportResult:
    """Create connections from an export bundle. Create-only: items
    whose ``code`` already exists are skipped (never modified) and
    reported; placeholder secret values are dropped."""
    return MCPTransferImportResult(
        **transfer.import_connections(
            db, bundle, user_id=current_user.id, request=request,
        )
    )


@router.get("/{connection_id}", response_model=MCPExternalConnectionDetail)
def get_connection(
    connection_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission(_READ)),
) -> MCPExternalConnectionDetail:
    """Connection detail. Secret values are masked, never plaintext."""
    return MCPExternalConnectionDetail(**svc.get_connection(db, connection_id))


@router.patch("/{connection_id}", response_model=MCPExternalConnectionDetail)
def update_connection(
    connection_id: str,
    payload: MCPExternalConnectionUpdate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission(_WRITE)),
) -> MCPExternalConnectionDetail:
    """Patch a connection. A masked secret value keeps the stored ciphertext."""
    return MCPExternalConnectionDetail(
        **svc.update_connection(db, connection_id, payload,
                                user_id=current_user.id, request=request)
    )


@router.post("/{connection_id}/enable", response_model=MCPExternalConnectionDetail)
def enable_connection(
    connection_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission(_WRITE)),
) -> MCPExternalConnectionDetail:
    return MCPExternalConnectionDetail(
        **svc.enable_connection(db, connection_id, user_id=current_user.id, request=request)
    )


@router.post("/{connection_id}/disable", response_model=MCPExternalConnectionDetail)
def disable_connection(
    connection_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission(_WRITE)),
) -> MCPExternalConnectionDetail:
    return MCPExternalConnectionDetail(
        **svc.disable_connection(db, connection_id, user_id=current_user.id, request=request)
    )


@router.post("/{connection_id}/test", response_model=MCPConnectionTestOutcome)
def test_connection(
    connection_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission(_WRITE)),
) -> MCPConnectionTestOutcome:
    """Test a connection; persists test_status / last_tested_at / last_test_error."""
    return MCPConnectionTestOutcome(
        **svc.test_connection(db, connection_id, user_id=current_user.id, request=request)
    )


@router.get("/{connection_id}/usage")
def connection_usage(
    connection_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission(_READ)),
) -> dict:
    """Which active MCP servers bind this connection — drives the pre-delete
    confirmation dialog. ``{"servers": [{id, code, name, binding_keys}]}``."""
    return {"servers": svc.connection_usage(db, connection_id)}


@router.delete("/{connection_id}", status_code=204)
async def delete_connection(
    connection_id: str,
    request: Request,
    unbind: bool = Query(
        False, description="确认解除正在使用此连接的 MCP 服务的绑定后再删除",
    ),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission(_WRITE)),
):
    """Soft-delete a connection. Runtime treats deleted connections as unusable.

    If MCP servers bind this connection, the caller must pass ``unbind=true``
    (409 otherwise, listing them). On delete those servers are unbound + marked
    "binding lost"; we then fire a best-effort connection test on each so their
    health status reflects the now-missing connection (result discarded)."""
    affected = svc.soft_delete_connection(
        db, connection_id, user_id=current_user.id, request=request,
        unbind_servers=unbind,
    )
    for srv in affected:
        try:
            await core_runtime_proxy.post_to_core(
                request, f"/api/v1/mcp-servers/{srv['id']}/test"
            )
        except Exception as e:  # status refresh is best-effort, never fatal
            logger.warning(
                "post-delete connection test failed for server %s: %s",
                srv.get("code"), e,
            )
