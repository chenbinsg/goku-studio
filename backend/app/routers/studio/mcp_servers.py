"""MCP server admin API: list / stats / detail / CRUD / enable / disable.

Thin HTTP layer over :mod:`app.services.mcp_servers`. Owns no business
logic — the service module enforces soft-delete filtering, encrypts
secrets, runs reference checks, and writes audit log entries.

Routes live under ``/api/v1/mcp-servers`` (hyphenated). MCP server
configuration is DB-backed; the old file-backed management API has
been retired.

Permissions
  - Read endpoints: ``mcp_servers.read``
  - Write endpoints: ``mcp_servers.write``
  Superusers bypass via :func:`auth.require_permission` (existing
  behavior in app/auth.py).
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from app import auth, models
from app.db import get_db
from app.schemas import (
    MCPAuthorizationCreate,
    MCPAuthorizationItem,
    MCPAuthorizedPrincipalListResponse,
    MCPAuthorizationSummaryResponse,
    MCPAuthorizationUpdate,
    MCPCallLogListResponse,
    MCPCapabilityDetail,
    MCPCapabilityInvokeRequest,
    MCPCapabilityInvokeResponse,
    MCPCapabilityListResponse,
    MCPCapabilityAuthorizationModeUpdate,
    MCPCapabilityAuthorizationModeView,
    MCPCapabilityBlacklistCreate,
    MCPCapabilityBlacklistItem,
    MCPCapabilityBlacklistListResponse,
    MCPCapabilityQuotaConfig,
    MCPCapabilityQuotaUpdate,
    MCPChangeLogListResponse,
    MCPConnectionTestResult,
    MCPHealthRecordListResponse,
    MCPPromptListResponse,
    MCPResourceListResponse,
    MCPServerCreate,
    MCPServerDetail,
    MCPServerHealthState,
    MCPServerListResponse,
    MCPServerStats,
    MCPServerUpdate,
    MCPSyncResult,
    MCPTransferImportResult,
)
from datetime import datetime
from fastapi.responses import JSONResponse
from app.services import mcp_transfer as transfer
from app.services import mcp_authorizations as authz
from app.services import mcp_capabilities as caps
from app.services import mcp_observability as observe
from app.services import core_runtime_proxy
from app.services import mcp_servers as svc


router = APIRouter(prefix="/api/v1/mcp-servers", tags=["mcp-servers"])


@router.get("/stats", response_model=MCPServerStats)
def get_mcp_servers_stats(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.read")),
) -> MCPServerStats:
    """Header counts for the admin list page."""
    return svc.get_stats(db)


@router.get("", response_model=MCPServerListResponse)
def list_mcp_servers(
    keyword: Optional[str] = Query(None, max_length=200, description="Name or code substring"),
    serviceCategory: Optional[str] = Query(None, alias="serviceCategory"),
    status: Optional[str] = Query(None, description="enabled | disabled"),
    healthStatus: Optional[str] = Query(None, alias="healthStatus", description="healthy | unhealthy | unchecked"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.read")),
) -> MCPServerListResponse:
    """Paginated list with optional keyword / category / status / health filters.

    Query-param names match the frontend convention (camelCase for the
    multi-word filters, plain for ``page`` / ``size`` / ``keyword``).
    """
    total, items = svc.list_servers(
        db,
        keyword=keyword,
        service_category=serviceCategory,
        status_filter=status,
        health_status=healthStatus,
        page=page,
        size=size,
    )
    return MCPServerListResponse(total=total, items=items)


@router.get("/export")
def export_mcp_servers(
    codes: Optional[str] = Query(
        None, description="逗号分隔的 code 列表;省略则导出全部",
    ),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.read")),
) -> JSONResponse:
    """Download active servers as a JSON bundle — one, a selection
    (``?codes=a,b``), or all (no param). Secret values are replaced by
    an explanatory placeholder — the file is safe to share; credentials
    must be re-entered after import.

    Registered BEFORE ``/{server_id}`` so the literal path wins.
    """
    code_list = [c.strip() for c in codes.split(",") if c.strip()] if codes else None
    bundle = transfer.export_servers(db, codes=code_list)
    stem = code_list[0] if code_list and len(code_list) == 1 else "servers"
    filename = f"mcp-{stem}-{datetime.utcnow():%Y%m%d-%H%M%S}.json"
    return JSONResponse(
        content=bundle,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/check-code")
def check_mcp_server_codes(
    codes: str = Query(..., description="逗号分隔的 code 列表"),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.read")),
) -> dict:
    """Code-uniqueness probe for the create drawer / import conflict
    dialog: returns which of the given codes are already taken by an
    active server. Registered BEFORE ``/{server_id}``."""
    code_list = [c.strip() for c in codes.split(",") if c.strip()]
    return {"existing": transfer.existing_server_codes(db, code_list)}


@router.post("/import", response_model=MCPTransferImportResult)
def import_mcp_servers(
    bundle: dict,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.write")),
) -> MCPTransferImportResult:
    """Create servers from an export bundle. Create-only: items whose
    ``code`` already exists are skipped (never modified) and reported;
    per-item failures land in ``errors`` without aborting the file.
    """
    return MCPTransferImportResult(
        **transfer.import_servers(
            db, bundle, user_id=current_user.id, request=request,
        )
    )


@router.get("/{server_id}", response_model=MCPServerDetail)
def get_mcp_server(
    server_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.read")),
) -> MCPServerDetail:
    """Full detail (config + masked secrets view). 404 if soft-deleted
    or absent.
    """
    return svc.get_detail(db, server_id)


@router.post("", response_model=MCPServerDetail, status_code=201)
def create_mcp_server(
    payload: MCPServerCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.write")),
) -> MCPServerDetail:
    """Create a server. Code uniqueness is enforced including
    soft-deleted rows (no reuse of historical codes).
    """
    server = svc.create_server(
        db, payload, user_id=current_user.id, request=request,
    )
    return svc.to_detail(server)


@router.put("/{server_id}", response_model=MCPServerDetail)
def update_mcp_server(
    server_id: str,
    payload: MCPServerUpdate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.write")),
) -> MCPServerDetail:
    """Partial update. Unset fields keep their stored value; secret
    fields whose value still looks like the mask sentinel from a
    previous GET are also treated as "unchanged".
    """
    server = svc.update_server(
        db, server_id, payload, user_id=current_user.id, request=request,
    )
    return svc.to_detail(server)


@router.delete("/{server_id}", status_code=204)
def delete_mcp_server(
    server_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.write")),
):
    """Soft-delete. Refuses on:
      - status == ``enabled`` → disable first
      - active dependents (tools / resources / prompts / permissions)

    Call logs are preserved by design — the soft-delete leaves the
    parent row in the DB so the FK keeps resolving.
    """
    svc.soft_delete_server(db, server_id, user_id=current_user.id, request=request)
    return None


@router.post("/{server_id}/enable", response_model=MCPServerDetail)
def enable_mcp_server(
    server_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.write")),
) -> MCPServerDetail:
    server = svc.enable_server(db, server_id, user_id=current_user.id, request=request)
    return svc.to_detail(server)


@router.post("/{server_id}/test", response_model=MCPConnectionTestResult)
async def test_mcp_server_connection(
    server_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.write")),
) -> MCPConnectionTestResult:
    """Run a one-off connection probe — executed by the goku-core runtime.

    Proxied to core's identical endpoint (see
    :mod:`app.services.core_runtime_proxy` for why Studio must not probe
    locally). Core appends the ``mcp_health_records`` row, mirrors
    status / last_checked_at / last_response_time onto the shared
    ``mcp_servers`` row, and writes the ``mcp_server.connection_test``
    audit-log entry — no local side effects here.
    """
    svc._get_by_id_strict(db, server_id)  # local 404 before the network hop
    data = await core_runtime_proxy.post_to_core(
        request, f"/api/v1/mcp-servers/{server_id}/test"
    )
    return MCPConnectionTestResult(**data)


@router.post("/{server_id}/sync", response_model=MCPSyncResult)
async def sync_mcp_server_capabilities(
    server_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.write")),
) -> MCPSyncResult:
    """Sync Tools / Resources / Prompts from the server into the DB.

    For each capability:
      - added:   in upstream, not in DB
      - updated: in both, content changed
      - synced:  in both, no change
      - removed: in DB, not in upstream → soft-deleted (kept around so
                 historical call logs still resolve names)

    Each capability is enumerated independently — one failing won't
    poison the others. Aggregate status (``mcp_servers.last_sync_status``)
    is success / partial_success / failed.

    Proxied to the goku-core runtime's identical endpoint (see
    :mod:`app.services.core_runtime_proxy`). Core persists the synced
    capabilities / resources / prompts, the sync status on the shared
    ``mcp_servers`` row, and the ``mcp_server.capability_sync``
    audit-log entry — no local side effects here.
    """
    svc._get_by_id_strict(db, server_id)  # local 404 before the network hop
    data = await core_runtime_proxy.post_to_core(
        request, f"/api/v1/mcp-servers/{server_id}/sync"
    )
    return MCPSyncResult(**data)


@router.post("/{server_id}/disable", response_model=MCPServerDetail)
def disable_mcp_server(
    server_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.write")),
) -> MCPServerDetail:
    server = svc.disable_server(db, server_id, user_id=current_user.id, request=request)
    return svc.to_detail(server)


# ─── MCP Capabilities (and Resources / Prompts) ───────────────────────
#
# "Capability" = the executable endpoint an MCP server exposes (what
# the MCP protocol calls a "tool"). Goku reserves "Tool" for entries
# in its separate AI Tool registry under "AI 能力 > 工具管理".

@router.get("/{server_id}/capabilities", response_model=MCPCapabilityListResponse)
def list_mcp_server_capabilities(
    server_id: str,
    keyword: Optional[str] = Query(None, max_length=200),
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.read")),
) -> MCPCapabilityListResponse:
    """Currently-exposed MCP capabilities for this server.

    Populated by ``POST /sync`` from the upstream server. Rows whose
    ``status='inactive'`` are filtered out so the list reflects the
    server's current surface area, not its full history.
    """
    total, items = caps.list_capabilities(
        db, server_id, keyword=keyword, page=page, size=size,
    )
    return MCPCapabilityListResponse(total=total, items=items)


# NOTE: this static route MUST be declared before "/{capability_id}" below,
# otherwise FastAPI captures "usage" as a capability_id.
@router.get("/{server_id}/capabilities/usage")
def preview_mcp_server_capabilities_usage(
    server_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.read")),
) -> dict:
    """Impact preview: which of this server's capabilities are in use
    (bound by an agent's allowed_tools) or authorized. Informational —
    call before deleting the server or disabling capabilities."""
    server = caps._get_server_or_404(db, server_id)
    return caps.capability_usage(db, server)


@router.post("/{server_id}/capabilities/{capability_id}/disable")
def disable_mcp_server_capability(
    server_id: str,
    capability_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.write")),
) -> dict:
    """Manually disable a capability (status → 'disabled'). Survives
    re-sync; drops out of the tool pool + knowledge catalog. Independent
    of deletion. Returns the new status + usage impact."""
    return caps.set_capability_status(
        db, server_id, capability_id, disabled=True,
        user_id=current_user.id, request=request,
    )


@router.post("/{server_id}/capabilities/{capability_id}/enable")
def enable_mcp_server_capability(
    server_id: str,
    capability_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.write")),
) -> dict:
    """Re-enable a manually disabled capability (status → 'active')."""
    return caps.set_capability_status(
        db, server_id, capability_id, disabled=False,
        user_id=current_user.id, request=request,
    )


@router.get(
    "/{server_id}/capabilities/{capability_id}",
    response_model=MCPCapabilityDetail,
)
def get_mcp_server_capability(
    server_id: str,
    capability_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.read")),
) -> MCPCapabilityDetail:
    return caps.get_capability_detail(db, server_id, capability_id)


@router.post(
    "/{server_id}/capabilities/{capability_id}/test-invoke",
    response_model=MCPCapabilityInvokeResponse,
)
async def test_invoke_mcp_server_capability(
    server_id: str,
    capability_id: str,
    payload: MCPCapabilityInvokeRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.write")),
) -> MCPCapabilityInvokeResponse:
    """Invoke a capability live via the goku-core runtime pool.

    Proxied to core's identical endpoint (see
    :mod:`app.services.core_runtime_proxy`) — the live MCP connection pool
    lives in core, and the invocation there writes the sanitized
    ``mcp_call_logs`` row (``invoke_type='mcp_test'``) into the shared DB.

    Server must be ``status='enabled'`` and capability must be
    ``status='active'`` — core gates these as 400 / 404.
    """
    svc._get_by_id_strict(db, server_id)  # local 404 before the network hop
    data = await core_runtime_proxy.post_to_core(
        request,
        f"/api/v1/mcp-servers/{server_id}/capabilities/{capability_id}/test-invoke",
        json_body={"arguments": payload.arguments},
    )
    return MCPCapabilityInvokeResponse(**data)


@router.get("/{server_id}/resources", response_model=MCPResourceListResponse)
def list_mcp_server_resources(
    server_id: str,
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.read")),
) -> MCPResourceListResponse:
    total, items = caps.list_resources(db, server_id, page=page, size=size)
    return MCPResourceListResponse(total=total, items=items)


@router.get("/{server_id}/prompts", response_model=MCPPromptListResponse)
def list_mcp_server_prompts(
    server_id: str,
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.read")),
) -> MCPPromptListResponse:
    total, items = caps.list_prompts(db, server_id, page=page, size=size)
    return MCPPromptListResponse(total=total, items=items)


# ─── Capability total-quota settings ──────────────────────────────────

@router.patch(
    "/{server_id}/capabilities/{capability_id}/quota",
    response_model=MCPCapabilityQuotaConfig,
)
def update_mcp_capability_quota(
    server_id: str,
    capability_id: str,
    payload: MCPCapabilityQuotaUpdate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.write")),
) -> MCPCapabilityQuotaConfig:
    """Set / clear a capability's TOTAL quota.

    Returns the updated quota view (freshly-recomputed
    ``authorized_quota_sum`` + ``remaining_authorizable_quota`` from
    current enabled authorizations). Writes
    ``mcp_capability.quota_update`` to ``audit_logs``.
    """
    return authz.update_capability_quota(
        db, server_id, capability_id, payload,
        user_id=current_user.id, request=request,
    )


# ─── Capability authorization mode + blacklist ────────────────────────

@router.patch(
    "/{server_id}/capabilities/{capability_id}/authorization-mode",
    response_model=MCPCapabilityAuthorizationModeView,
)
def update_capability_authorization_mode(
    server_id: str,
    capability_id: str,
    payload: MCPCapabilityAuthorizationModeUpdate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.write")),
) -> MCPCapabilityAuthorizationModeView:
    """Switch a capability between 'required' (default-deny) and 'public'
    (allow-all + optional blacklist)."""
    return MCPCapabilityAuthorizationModeView(
        **authz.update_capability_authorization_mode(
            db, server_id, capability_id, payload.mode,
            user_id=current_user.id, request=request,
        )
    )


@router.get(
    "/{server_id}/capabilities/{capability_id}/blacklist",
    response_model=MCPCapabilityBlacklistListResponse,
)
def list_capability_blacklist(
    server_id: str,
    capability_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.read")),
) -> MCPCapabilityBlacklistListResponse:
    """List a capability's blacklist (active in 'public' mode only)."""
    total, items = authz.list_capability_blacklist(db, server_id, capability_id)
    return MCPCapabilityBlacklistListResponse(
        total=total,
        items=[MCPCapabilityBlacklistItem(**it) for it in items],
    )


@router.post(
    "/{server_id}/capabilities/{capability_id}/blacklist",
    response_model=MCPCapabilityBlacklistItem,
    status_code=201,
)
def add_capability_blacklist(
    server_id: str,
    capability_id: str,
    payload: MCPCapabilityBlacklistCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.write")),
) -> MCPCapabilityBlacklistItem:
    """Add a Principal to a capability's blacklist (denied in 'public' mode)."""
    row = authz.add_capability_blacklist(
        db, server_id, capability_id,
        payload.principal_type, payload.principal_id, payload.reason,
        user_id=current_user.id, request=request,
    )
    return MCPCapabilityBlacklistItem(**row)


@router.delete(
    "/{server_id}/capabilities/{capability_id}/blacklist/{blacklist_id}",
    status_code=204,
)
def remove_capability_blacklist(
    server_id: str,
    capability_id: str,
    blacklist_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.write")),
):
    """Remove a Principal from a capability's blacklist."""
    authz.remove_capability_blacklist(
        db, server_id, capability_id, blacklist_id,
        user_id=current_user.id, request=request,
    )


# ─── MCP Capability ↔ AI Tool authorizations ──────────────────────────

@router.get(
    "/{server_id}/authorization-summary",
    response_model=MCPAuthorizationSummaryResponse,
)
def get_authorization_summary(
    server_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.read")),
) -> MCPAuthorizationSummaryResponse:
    """Per-capability quota + authorization rollup (spec §10.1):
    total limit, used, authorized_quota_sum, remaining_authorizable_quota,
    authorized_principal_count."""
    return authz.get_authorization_summary(db, server_id)


@router.get(
    "/{server_id}/authorized-principals",
    response_model=MCPAuthorizedPrincipalListResponse,
)
def list_authorized_principals(
    server_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.read")),
) -> MCPAuthorizedPrincipalListResponse:
    """All authorizations under this MCP server (spec §10.2)."""
    total, items = authz.list_authorized_principals(db, server_id)
    return MCPAuthorizedPrincipalListResponse(total=total, items=items)


@router.post(
    "/{server_id}/authorized-principals",
    response_model=MCPAuthorizationItem,
    status_code=201,
)
def create_authorized_principal(
    server_id: str,
    payload: MCPAuthorizationCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.write")),
) -> MCPAuthorizationItem:
    """Grant a Principal (AI Tool / Agent / workflow / system_job) the
    right to call an MCP capability (spec §8.4):

      - Principal + capability exist; capability belongs to this server
      - no existing non-deleted authorization for (principal, capability)
      - allocated_quota fits remaining_authorizable_quota
      - quota_period matches the capability's period
    """
    return authz.create_authorization(
        db, server_id, payload, user_id=current_user.id, request=request,
    )


@router.patch(
    "/{server_id}/authorized-principals/{authorization_id}",
    response_model=MCPAuthorizationItem,
)
def update_authorized_principal(
    server_id: str,
    authorization_id: str,
    payload: MCPAuthorizationUpdate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.write")),
) -> MCPAuthorizationItem:
    """Edit an authorization (spec §9). allocated_quota is validated with
    THIS authorization's own slice excluded from the sum."""
    return authz.update_authorization(
        db, server_id, authorization_id, payload,
        user_id=current_user.id, request=request,
    )


@router.post(
    "/{server_id}/authorized-principals/{authorization_id}/enable",
    response_model=MCPAuthorizationItem,
)
def enable_authorized_principal(
    server_id: str,
    authorization_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.write")),
) -> MCPAuthorizationItem:
    """Enable an authorization (spec §10.5)."""
    return authz.set_authorization_enabled(
        db, server_id, authorization_id, True,
        user_id=current_user.id, request=request,
    )


@router.post(
    "/{server_id}/authorized-principals/{authorization_id}/disable",
    response_model=MCPAuthorizationItem,
)
def disable_authorized_principal(
    server_id: str,
    authorization_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.write")),
) -> MCPAuthorizationItem:
    """Disable an authorization (spec §10.6)."""
    return authz.set_authorization_enabled(
        db, server_id, authorization_id, False,
        user_id=current_user.id, request=request,
    )


@router.delete(
    "/{server_id}/authorized-principals/{authorization_id}",
    status_code=204,
)
def delete_authorized_principal(
    server_id: str,
    authorization_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.write")),
):
    """Soft-delete an authorization (spec §10.7). The Principal can no
    longer call the capability; call-log history still resolves."""
    authz.delete_authorization(
        db, server_id, authorization_id,
        user_id=current_user.id, request=request,
    )
    return None


# ─── Task 4: read-only observability ──────────────────────────────────


@router.get("/{server_id}/health", response_model=MCPServerHealthState)
def get_mcp_server_health(
    server_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.read")),
) -> MCPServerHealthState:
    """Current health snapshot for the detail page header.

    Combines the cheap mirrored columns on ``mcp_servers`` with
    ``consecutive_failures`` and ``last_recovered_at`` derived from a
    short scan of recent ``mcp_health_records``.
    """
    return observe.get_health_state(db, server_id)


@router.get(
    "/{server_id}/health-records",
    response_model=MCPHealthRecordListResponse,
)
def list_mcp_server_health_records(
    server_id: str,
    status: Optional[str] = Query(None, description="normal | abnormal"),
    start: Optional[datetime] = Query(None, description="inclusive lower bound on checked_at"),
    end: Optional[datetime] = Query(None, description="inclusive upper bound on checked_at"),
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.read")),
) -> MCPHealthRecordListResponse:
    """Paginated probe history. Newest-first by ``checked_at``."""
    total, items = observe.list_health_records(
        db, server_id,
        status=status, start=start, end=end,
        offset=offset, limit=limit,
    )
    return MCPHealthRecordListResponse(total=total, items=items)


@router.get(
    "/{server_id}/call-logs",
    response_model=MCPCallLogListResponse,
)
def list_mcp_server_call_logs(
    server_id: str,
    start: Optional[datetime] = Query(None, description="inclusive lower bound on called_at"),
    end: Optional[datetime] = Query(None, description="inclusive upper bound on called_at"),
    user_id: Optional[str] = Query(None),
    ai_tool_id: Optional[str] = Query(None),
    capability_id: Optional[str] = Query(None, description="filter by mcp_capability_id"),
    result: Optional[str] = Query(None, description="success | failed"),
    invoke_type: Optional[str] = Query(None, description="agent_auto | user_confirmed | mcp_test"),
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.read")),
) -> MCPCallLogListResponse:
    """Paginated + filtered invocation log scoped to this server.

    All filters AND together. ``input_summary`` / ``output_summary``
    are already sanitized at insert time (secrets redacted, long
    values truncated, full response body never stored).
    """
    total, items = observe.list_call_logs(
        db, server_id,
        start=start, end=end,
        user_id=user_id, ai_tool_id=ai_tool_id, capability_id=capability_id,
        result=result, invoke_type=invoke_type,
        offset=offset, limit=limit,
    )
    return MCPCallLogListResponse(total=total, items=items)


@router.get(
    "/{server_id}/changes",
    response_model=MCPChangeLogListResponse,
)
def list_mcp_server_changes(
    server_id: str,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.require_permission("mcp_servers.read")),
) -> MCPChangeLogListResponse:
    """Paginated audit-log view scoped to this server.

    Union of three audit sources: ``mcp_server`` rows for this server,
    ``mcp_capability`` rows for any of its capabilities (quota edits),
    and ``mcp_capability_authorization`` rows for any of its
    authorizations.
    """
    total, items = observe.list_change_logs(
        db, server_id, offset=offset, limit=limit,
    )
    return MCPChangeLogListResponse(total=total, items=items)
