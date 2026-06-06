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

from typing import Optional

from fastapi import APIRouter, Depends, Query, Request
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
)
from app.services import mcp_external_connections as svc

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


@router.delete("/{connection_id}", status_code=204)
def delete_connection(
    connection_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission(_WRITE)),
):
    """Soft-delete a connection. Runtime treats deleted connections as unusable."""
    svc.soft_delete_connection(db, connection_id, user_id=current_user.id, request=request)
