import re
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel as _PydBaseModel
from pydantic import ConfigDict, EmailStr, Field, field_validator


def _utc_z_serializer(dt: datetime) -> str:
    """Serialize naive UTC datetimes with an explicit Z suffix so frontend
    dayjs converts them to local time correctly.

    Pydantic v2's model_dump_json bypasses FastAPI's ENCODERS_BY_TYPE patch
    in main.py — fields would otherwise emit `2026-05-19T02:02:11` (no
    timezone), which dayjs parses as local time and shows 9h off in JST.
    """
    return dt.isoformat() + ("Z" if dt.tzinfo is None else "")


class BaseModel(_PydBaseModel):
    """Project-wide Pydantic v2 base with a UTC-Z datetime JSON serializer.

    All schemas in this module inherit from this implicit override (the name
    BaseModel resolves here, not pydantic.BaseModel). New schemas only need
    to ``class Foo(BaseModel):`` to get the timezone fix for free.
    """

    model_config = ConfigDict(json_encoders={datetime: _utc_z_serializer})


def _validate_password(v: str) -> str:
    """Enforce minimum password strength: 8+ chars, at least one digit, one letter."""
    if len(v) < 8:
        raise ValueError("Password must be at least 8 characters")
    if not re.search(r"[A-Za-z]", v):
        raise ValueError("Password must contain at least one letter")
    if not re.search(r"\d", v):
        raise ValueError("Password must contain at least one digit")
    return v


class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=100)
    email: EmailStr
    password: str
    is_superuser: bool = False
    departments: list[str] = Field(default_factory=list)

    @field_validator("password")
    @classmethod
    def password_strength(cls, v: str) -> str:
        return _validate_password(v)


class UserUpdate(BaseModel):
    email: EmailStr | None = None
    is_active: bool | None = None
    is_superuser: bool | None = None
    departments: list[str] | None = None
    team_id: str | None = None
    full_name: str | None = None
    mobile: str | None = None
    employee_id: str | None = None


class UserPasswordReset(BaseModel):
    new_password: str

    @field_validator("new_password")
    @classmethod
    def password_strength(cls, v: str) -> str:
        return _validate_password(v)


class UserSelfPasswordChange(BaseModel):
    """Used by the self-service change-password endpoint (requires old password)."""

    current_password: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def password_strength(cls, v: str) -> str:
        return _validate_password(v)


class AdminPasswordReset(BaseModel):
    username: str = "admin"
    new_password: str

    @field_validator("new_password")
    @classmethod
    def password_strength(cls, v: str) -> str:
        return _validate_password(v)


class UserListResponse(BaseModel):
    total: int
    items: list[dict[str, Any]]


class UserRegister(BaseModel):
    username: str = Field(min_length=3, max_length=100)
    email: EmailStr
    password: str
    role: str | None = None

    @field_validator("password")
    @classmethod
    def password_strength(cls, v: str) -> str:
        return _validate_password(v)


class UserRegisterResponse(BaseModel):
    id: str
    username: str
    email: str


class UserLogin(BaseModel):
    username: str
    password: str
    mfa_code: str | None = None


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    expires_in: int
    user: dict[str, Any] | None = None


class SSOLogin(BaseModel):
    code: str
    state: str
    provider: str


class KeycloakExchange(BaseModel):
    keycloak_token: str


class KeycloakLogout(BaseModel):
    keycloak_refresh_token: str


class UserInfo(BaseModel):
    id: str
    username: str
    email: str
    is_active: bool
    is_superuser: bool
    tenant_id: str | None = None
    department: str | None = None
    created_at: datetime

    class Config:
        from_attributes = True


class TaskCreate(BaseModel):
    prompt: str
    context: dict[str, Any] = Field(default_factory=dict)
    priority: int = Field(default=5, ge=1, le=10)
    timeout: int = Field(default=300, ge=1)
    model: str | None = None  # explicit model selection for this task
    attachments: list[dict[str, Any]] | None = (
        None  # [{"file_id": ..., "path": ..., "content_type": ...}]
    )
    agent_id: str | None = None  # optional custom agent definition to use


class TaskResponse(BaseModel):
    task_id: str
    status: str
    created_at: datetime | None = None
    cancelled_at: datetime | None = None
    new_task_id: str | None = None
    rollback_task_id: str | None = None


class TaskDetail(BaseModel):
    id: str
    user_id: str
    prompt: str
    context: dict[str, Any]
    status: str
    priority: int
    timeout: int
    result: dict[str, Any] | None = None
    error_message: str | None = None
    cancelled_at: datetime | None = None
    cancelled_reason: str | None = None
    created_at: datetime
    updated_at: datetime
    steps: list[dict[str, Any]] = []
    logs: list[dict[str, Any]] = []

    class Config:
        from_attributes = True


class TaskDetailResponse(BaseModel):
    task: dict[str, Any]
    steps: list[dict[str, Any]] = []
    logs: list[dict[str, Any]] = []


class TaskList(BaseModel):
    total: int
    items: list[TaskDetail]


class TaskCancel(BaseModel):
    reason: str


class TaskRetry(BaseModel):
    from_step: int | None = None
    force: bool = False


class TaskRollback(BaseModel):
    to_step: int
    reason: str


class UserInputSubmit(BaseModel):
    answer: str


class ToolExecute(BaseModel):
    parameters: dict[str, Any] = Field(default_factory=dict)
    timeout: int = Field(default=60, ge=10)
    approval_token: str | None = None


class ToolResponse(BaseModel):
    result: dict[str, Any]
    exit_code: int
    logs: list[str]


class ToolInfo(BaseModel):
    # id is None for built-in registry tools (not DB-backed). DB tools
    # carry their tools.id — needed by callers that bind a tool by id,
    # e.g. MCP capability authorization (mcp_capability_authorizations.principal_id
    # with principal_type='ai_tool').
    id: str | None = None
    name: str
    description: str
    parameters: dict[str, Any]
    permission_level: int


class ToolList(BaseModel):
    tools: list[ToolInfo]


class ToolRegister(BaseModel):
    # Avoid shadowing Pydantic BaseModel.schema().
    # Accept the existing API payload field "schema", but expose it internally
    # as tool_schema.
    model_config = ConfigDict(populate_by_name=True)

    name: str
    description: str
    handler: str
    tool_schema: dict[str, Any] = Field(alias="schema")
    permission_level: int = Field(default=0, ge=0, le=3)


class ToolRegisterResponse(BaseModel):
    tool_id: str
    status: str


class ApprovalCreate(BaseModel):
    task_id: str
    operation: str
    risk_level: int = Field(ge=1, le=3)
    description: str


class ApprovalAction(BaseModel):
    action: str  # approve or reject
    comment: str | None = None
    edited_body: str | None = None  # staff-edited email body (email_reply approvals only)


class ApprovalResponse(BaseModel):
    approval_id: str
    status: str
    approvers: list[str] = []
    executed_at: datetime | None = None


class ApprovalDetail(BaseModel):
    id: str
    task_id: str | None = None
    operation: str
    risk_level: int
    description: str
    status: str
    approver_id: str | None = None
    comment: str | None = None
    executed_at: datetime | None = None
    created_at: datetime
    escalation_level: int = 0
    escalation_count: int = 0

    class Config:
        from_attributes = True


class ApprovalList(BaseModel):
    total: int
    items: list[ApprovalDetail]


class StatefulDebugStepRequest(BaseModel):
    action_name: str
    payload: dict[str, Any] = Field(default_factory=dict)
    reason: str | None = None
    bypass_policy: bool = False


class StatefulDebugSimulateResponse(BaseModel):
    state: dict[str, Any]
    available_actions: list[dict[str, Any]]


class StatefulDebugStepResponse(BaseModel):
    before_state: dict[str, Any]
    available_actions: list[dict[str, Any]]
    decision: dict[str, Any]
    execution: dict[str, Any]


class MemoryCreate(BaseModel):
    type: str  # short or long
    content: str
    tags: list[str] = Field(default_factory=list)
    ttl: int | None = None


class MemoryResponse(BaseModel):
    memory_id: str
    vector_id: str | None = None
    stored_at: datetime


class MemorySearch(BaseModel):
    query: str
    type: str | None = None
    top_k: int = Field(default=5, ge=1, le=20)
    filters: dict[str, Any] = Field(default_factory=dict)


class MemoryResult(BaseModel):
    memory_id: str
    content: str
    similarity: float
    timestamp: datetime


class MemorySearchResponse(BaseModel):
    results: list[MemoryResult]


class ModelRouteRequest(BaseModel):
    task_type: str
    complexity: float = Field(ge=0, le=1)
    cost_budget: float
    latency_requirement: int  # milliseconds


class ModelRouteResponse(BaseModel):
    model_id: str
    provider: str
    estimated_cost: float
    estimated_latency: int


class ModelInfo(BaseModel):
    id: str
    name: str
    provider: str
    capabilities: list[str]
    status: str
    cost_per_token: float
    priority: int = 50
    tier: str = "standard"

    class Config:
        from_attributes = True


class ModelList(BaseModel):
    models: list[ModelInfo]
    # Phase 1 shadow-mode: "router" when fetched from Goku-Router upstream,
    # "db" when fetched from the local AIOS models table. Frontend uses this
    # to hide write-mode CRUD buttons when the data is upstream-managed.
    source: str | None = None


class RoleCreate(BaseModel):
    name: str
    permissions: list[str] = Field(default_factory=list)
    max_level: int = Field(default=0, ge=0, le=3)
    tools: list[str] = Field(default_factory=list)


class RoleResponse(BaseModel):
    role_id: str
    created_at: datetime


class UserRoleAssign(BaseModel):
    role_ids: list[str]
    tenant_id: str | None = None


class UserRoleResponse(BaseModel):
    user_id: str
    roles: list[str]
    updated_at: datetime


class AuditLogQuery(BaseModel):
    start_time: datetime
    end_time: datetime
    user_id: str | None = None
    action: str | None = None
    page: int = Field(default=1, ge=1)
    size: int = Field(default=20, ge=1, le=100)


class AuditLogEntry(BaseModel):
    id: str
    user_id: str | None
    username: str | None = None  # joined from users table
    action: str
    resource_type: str
    resource_id: str | None
    details: dict[str, Any] | None
    ip_address: str | None
    user_agent: str | None
    created_at: datetime

    class Config:
        from_attributes = True


class AuditLogList(BaseModel):
    total: int
    items: list[AuditLogEntry]


class AuditExport(BaseModel):
    start_time: datetime
    end_time: datetime
    format: str  # pdf or csv
    filters: dict[str, Any] = Field(default_factory=dict)


class AuditExportResponse(BaseModel):
    download_url: str
    expires_at: datetime


class AuditReplayStep(BaseModel):
    timestamp: datetime
    action: str
    input: dict[str, Any]
    output: dict[str, Any]
    screenshot: str | None = None


class AuditReplayResponse(BaseModel):
    steps: list[AuditReplayStep]


class TenantCreate(BaseModel):
    name: str
    admin_email: str
    quota: dict[str, Any] = Field(default_factory=dict)
    settings: dict[str, Any] = Field(default_factory=dict)


class TenantResponse(BaseModel):
    tenant_id: str
    api_key: str
    created_at: datetime


class TenantQuota(BaseModel):
    quota: dict[str, Any]
    usage: dict[str, Any]
    remaining: dict[str, Any]


class TenantQuotaUpdate(BaseModel):
    cpu: float = Field(gt=0)
    memory: float = Field(gt=0)
    tokens_per_day: int = Field(gt=0)
    max_concurrent_tasks: int = Field(gt=0)


class TenantQuotaResponse(BaseModel):
    tenant_id: str
    updated_quota: dict[str, Any]
    effective_at: datetime


class WorkflowCreate(BaseModel):
    name: str
    description: str | None = None
    dag: dict[str, Any]
    triggers: list[dict[str, Any]] = Field(default_factory=list)
    variables: dict[str, Any] = Field(default_factory=dict)


class WorkflowResponse(BaseModel):
    workflow_id: str
    version: str
    created_at: datetime


class WorkflowExecute(BaseModel):
    variables: dict[str, Any] = Field(default_factory=dict)
    dry_run: bool = False


class WorkflowExecuteResponse(BaseModel):
    execution_id: str
    status: str
    started_at: datetime


class MetricsQuery(BaseModel):
    metric_names: list[str]
    start_time: datetime
    end_time: datetime
    granularity: str = "1m"


class MetricDatapoint(BaseModel):
    timestamp: datetime
    value: float


class MetricData(BaseModel):
    name: str
    datapoints: list[MetricDatapoint]


class MetricsResponse(BaseModel):
    metrics: list[MetricData]


class AlertRuleCreate(BaseModel):
    name: str
    metric: str
    condition: str  # gt, lt, eq, gte, lte
    threshold: float
    channels: list[str] = Field(default_factory=list)


class AlertRuleResponse(BaseModel):
    rule_id: str
    status: str
    created_at: datetime


class PluginInstall(BaseModel):
    plugin_id: str
    version: str
    config: dict[str, Any] = Field(default_factory=dict)


class PluginInstallResponse(BaseModel):
    installation_id: str
    status: str
    installed_at: datetime


class SystemConfigResponse(BaseModel):
    config: dict[str, Any]
    version: str
    updated_at: datetime


class SystemConfigUpdate(BaseModel):
    config: dict[str, Any]
    force_restart: bool = False


class SystemConfigUpdateResponse(BaseModel):
    status: str
    applied_at: datetime
    requires_restart: bool


class HealthComponent(BaseModel):
    name: str
    status: str
    latency: int


class HealthResponse(BaseModel):
    status: str
    components: list[HealthComponent]
    version: str


class ErrorResponse(BaseModel):
    error: str
    detail: str | None = None


# ── MCP Server Management ─────────────────────────────────────────────
# The ``service_category`` Literal is the source of truth for what
# values the API accepts. Frontend i18n maps each code to a localized
# label (文件处理 / 数据服务 / ...). Adding a new category here also
# requires a corresponding frontend i18n entry.

MCPServiceCategory = Literal[
    "file_processing",
    "data_service",
    "dev_tools",
    "office_collab",
    "project_mgmt",
    "knowledge_service",
    "search_service",
    "system_integration",
    "automation",
    "other",
]

MCPConnectionType = Literal["http", "stdio"]
MCPStatus = Literal["enabled", "disabled"]
MCPHealthStatus = Literal["normal", "abnormal", "unchecked"]


class MCPServerCreate(BaseModel):
    """Payload to create a new MCP server.

    ``code`` is the stable external identifier (downstream FKs use it).
    Validated to be ``[a-z0-9_-]+``, max 100 chars; service layer also
    enforces global uniqueness including soft-deleted rows.

    ``auth_secret`` and ``env_config`` are plaintext on the way in;
    the service layer encrypts before persisting. The API never echoes
    them back in plaintext on the way out.
    """

    name: str = Field(..., min_length=1, max_length=255)
    code: str = Field(..., min_length=1, max_length=100)
    service_category: MCPServiceCategory
    description: str | None = None
    owner: str | None = Field(None, max_length=255)

    connection_type: MCPConnectionType
    service_url: str | None = Field(None, max_length=500)
    start_command: str | None = None
    work_dir: str | None = Field(None, max_length=500)
    timeout_seconds: int = Field(60, ge=1, le=600)
    retry_count: int = Field(0, ge=0, le=10)

    auth_type: str | None = Field(None, max_length=40)
    auth_header_name: str | None = Field(None, max_length=100)
    auth_secret: str | None = None
    env_config: dict[str, str] | None = None  # plaintext dict; encrypted by service

    auto_sync_enabled: bool = False
    sync_frequency: str | None = Field(None, max_length=50)
    sync_scope: dict[str, Any] | None = None
    conflict_strategy: str | None = Field(None, max_length=50)
    offline_strategy: str | None = Field(None, max_length=50)

    allow_agent_auto_invoke: bool = False
    high_risk_confirm_required: bool = True
    rate_limit_config: dict[str, Any] | None = None
    circuit_breaker_config: dict[str, Any] | None = None
    audit_enabled: bool = True

    @field_validator("code")
    @classmethod
    def _validate_code(cls, v: str) -> str:
        if not re.match(r"^[a-z0-9][a-z0-9_-]*$", v):
            raise ValueError(
                "code must start with a lowercase letter or digit and contain "
                "only lowercase letters, digits, hyphens, or underscores"
            )
        return v


class MCPServerUpdate(BaseModel):
    """Payload to update an MCP server.

    All fields optional. Fields that are NOT in the request body are
    NOT modified (the service layer applies ``exclude_unset``).

    Secret-field semantics (intentionally strict):
      - Omitting ``auth_secret`` / ``env_config`` → keep stored value.
      - Sending an empty string / null / whitespace → treated the same
        as omitted (i.e. keep). This prevents an accidental clear from
        a form that round-tripped an empty field.
      - Sending the mask sentinel "已配置 ********" → keep stored value
        (defence-in-depth in the service layer).
      - To CLEAR a secret you MUST send the explicit boolean
        ``clear_auth_secret`` / ``clear_env_config`` set to ``true``.
        Without the explicit clear flag, no path leads to "secret
        becomes empty" — eliminates a whole class of "I didn't mean to
        wipe my token" mistakes.
    """

    name: str | None = Field(None, min_length=1, max_length=255)
    service_category: MCPServiceCategory | None = None
    description: str | None = None
    owner: str | None = Field(None, max_length=255)

    connection_type: MCPConnectionType | None = None
    service_url: str | None = Field(None, max_length=500)
    start_command: str | None = None
    work_dir: str | None = Field(None, max_length=500)
    timeout_seconds: int | None = Field(None, ge=1, le=600)
    retry_count: int | None = Field(None, ge=0, le=10)

    auth_type: str | None = Field(None, max_length=40)
    auth_header_name: str | None = Field(None, max_length=100)
    auth_secret: str | None = None
    env_config: dict[str, str] | None = None
    # Explicit clear flags — see class docstring for semantics.
    clear_auth_secret: bool = False
    clear_env_config: bool = False

    auto_sync_enabled: bool | None = None
    sync_frequency: str | None = Field(None, max_length=50)
    sync_scope: dict[str, Any] | None = None
    conflict_strategy: str | None = Field(None, max_length=50)
    offline_strategy: str | None = Field(None, max_length=50)

    allow_agent_auto_invoke: bool | None = None
    high_risk_confirm_required: bool | None = None
    rate_limit_config: dict[str, Any] | None = None
    circuit_breaker_config: dict[str, Any] | None = None
    audit_enabled: bool | None = None


class MCPServerSecretsView(BaseModel):
    """Per-server "is each secret configured?" view, with masked display.

    Returned inside :class:`MCPServerDetail` so the UI can render
    "已配置 ********" without ever seeing the real value.
    """

    auth_secret_configured: bool
    auth_secret_display: str  # MASK_DISPLAY or ""
    env_config_configured: bool
    env_config_display: str
    env_config_keys: list[str]  # safe to expose: key names only, values masked
    env_config_connection_id: str | None = (
        None  # external connection code bound via env_config.connection_id; not a secret, safe to surface so the edit drawer can pre-select the dropdown
    )
    env_config_server_auth_connection_id: str | None = (
        None  # external connection code bound via env_config.server_auth_connection_id (url type); supplies the Authorization header Goku uses to call this MCP server's HTTP endpoint
    )


class MCPServerListItem(BaseModel):
    """Compact row for the list page — no heavy JSON / secret fields.

    Aggregate counts (``capability_count`` / ``authorized_principal_count``)
    are computed in one batch GROUP BY at list time — list page should
    never fan out to per-row detail endpoints.
    """

    id: str
    name: str
    code: str
    service_category: str
    description: str | None = None
    owner: str | None = None
    connection_type: str
    status: str
    health_status: str
    last_checked_at: datetime | None = None
    last_synced_at: datetime | None = None
    # Count of capabilities with ``status='active'`` on this server.
    # Inactive (upstream-removed) capabilities are NOT counted.
    capability_count: int = 0
    # Distinct AI Tools (de-duped by ``ai_tool_id``) authorized to reach
    # this server via at least one enabled, non-deleted authorization to
    # one of its active capabilities. Same AI Tool authorized on three
    # capabilities counts as 1.
    authorized_principal_count: int = 0
    created_at: datetime
    updated_at: datetime
    # Derived: "ok" if the server doesn't need an external connection
    # OR has one bound; "incomplete" if its start_command flags it as
    # needs-connection but env_config.connection_id is missing. Lets the
    # UI demote a stale "正常" health tag when the server actually can't
    # work — transport health (process spawns, ListTools succeeds) is
    # different from functional health (can it actually call the
    # upstream API).
    configuration_status: str = "ok"


class MCPServerDetail(BaseModel):
    """Full server view returned by GET /mcp-servers/{id}.

    Secrets surface as :class:`MCPServerSecretsView` — never the raw
    ciphertext or plaintext.
    """

    id: str
    name: str
    code: str
    service_category: str
    description: str | None = None
    owner: str | None = None

    connection_type: str
    service_url: str | None = None
    start_command: str | None = None
    work_dir: str | None = None
    timeout_seconds: int
    retry_count: int

    auth_type: str | None = None
    auth_header_name: str | None = None
    secrets: MCPServerSecretsView

    status: str
    health_status: str
    last_checked_at: datetime | None = None
    last_response_time: int | None = None

    last_sync_status: str | None = None
    last_synced_at: datetime | None = None
    # Consolidated error text from the most recent partial/failed sync.
    # NULL on never-synced or fully successful sync.
    last_sync_error_message: str | None = None
    auto_sync_enabled: bool
    sync_frequency: str | None = None
    sync_scope: dict[str, Any] | None = None
    conflict_strategy: str | None = None
    offline_strategy: str | None = None

    # Same aggregate counts as MCPServerListItem so the detail page doesn't
    # have to round-trip back to /mcp-servers list to display them.
    capability_count: int = 0
    authorized_principal_count: int = 0
    # See MCPServerListItem.configuration_status for semantics.
    configuration_status: str = "ok"

    allow_agent_auto_invoke: bool
    high_risk_confirm_required: bool
    rate_limit_config: dict[str, Any] | None = None
    circuit_breaker_config: dict[str, Any] | None = None
    audit_enabled: bool

    created_by: str | None = None
    created_at: datetime
    updated_by: str | None = None
    updated_at: datetime


class MCPServerListResponse(BaseModel):
    """Goku list-response convention: {total, items}."""

    total: int
    items: list[MCPServerListItem]


class MCPConnectionTestResult(BaseModel):
    """Result returned by ``POST /mcp-servers/{id}/test``.

    Stable codes:
      ``status``       — ``normal`` / ``abnormal``
      ``error_type``   — ``unreachable`` / ``auth_failed`` / ``timeout``
                         / ``protocol_mismatch`` / ``discovery_failed``
                         (NULL when status == normal)

    ``error_message`` is the free-text error string surfaced for ops
    debugging; it has been UI-formatted (no stack traces) but is NOT
    further sanitized — callers must not echo it directly to an
    untrusted audience without quoting.
    """

    server_id: str
    status: str
    response_time_ms: int
    capabilities_discovered: int
    error_type: str | None = None
    error_message: str | None = None
    checked_at: datetime


class MCPSyncBucketCounts(BaseModel):
    """Per-bucket counts returned by ``POST /sync``.

    ``kind`` is one of ``'capabilities' | 'resources' | 'prompts'``.
    "capabilities" means MCP-side executable endpoints (what the MCP
    protocol calls "tools"; Goku reserves "Tool" for its own AI Tool
    registry).
    """

    kind: str
    ok: bool
    error: str | None = None
    added: int = 0
    updated: int = 0
    synced: int = 0
    removed: int = 0


class MCPSyncResult(BaseModel):
    """Full ``POST /mcp-servers/{id}/sync`` response.

    ``status`` is one of the stable codes
    ``success / partial_success / failed`` (also persisted to
    ``mcp_servers.last_sync_status``). On a ``failed`` initial-
    connection, ``error_type`` carries the same classifier as the
    connection-test endpoint and per-bucket counts are all zero.
    """

    server_id: str
    status: str
    capabilities: MCPSyncBucketCounts
    resources: MCPSyncBucketCounts
    prompts: MCPSyncBucketCounts
    synced_at: datetime
    error_type: str | None = None
    error_message: str | None = None


# ── MCP Capabilities (executable endpoints exposed by an MCP server) ──
#
# "Capability" intentionally NOT "Tool" — Goku has a separate AI Tool
# registry and we don't want naming collisions. AI Tool ↔ MCP
# Capability is a join target for AI Tool authorizations (see below).

MCPCapabilityStatus = Literal["active", "inactive"]


class MCPCapabilityListItem(BaseModel):
    """Compact row for the list page.

    ``status`` is the per-row "currently exposed by upstream?" flag:
    ``active`` (present at last sync) or ``inactive`` (last sync didn't
    find it). Sync history is on ``last_synced_at``.

    ``authorization_mode`` is the per-capability default-deny / allow-all
    toggle (see ``MCPCapabilityAuthorizationModeUpdate``).
    """

    id: str
    server_id: str
    capability_name: str
    description: str | None = None
    status: str
    authorization_mode: str = "required"
    # Total + rate quota — surfaced on the 能力 list so the quota editor
    # (which lives on the 能力 Tab) can pre-fill without an extra fetch.
    quota_enabled: bool = False
    quota_period: str | None = None
    quota_limit: int | None = None
    rate_limit: int | None = None
    last_synced_at: datetime | None = None
    last_called_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


MCPQuotaPeriod = Literal["minute", "hour", "day", "month"]


class MCPCapabilityQuotaConfig(BaseModel):
    """Per-capability TOTAL quota block nested inside detail responses.

    When ``enabled`` is False, ``limit`` / ``period`` may be NULL.
    When True both are set; the authorization service enforces
    SUM(allocated_quota) ≤ limit and a unified period.

    Field naming follows spec §6.3 (authorized_* not allocated_*).
    """

    enabled: bool
    period: str | None = None
    limit: int | None = None
    used: int = 0  # quota_used in current period
    reset_at: datetime | None = None
    # SUM(allocated_quota) of enabled, non-deleted authorizations.
    authorized_quota_sum: int = 0
    # limit - authorized_quota_sum (None when quota not enabled).
    remaining_authorizable_quota: int | None = None
    authorized_principal_count: int = 0
    # Rate limit — calls per minute, independent of the period quota.
    rate_limit: int | None = None  # None = no rate cap
    rate_used: int = 0  # calls in current minute
    rate_reset_at: datetime | None = None


class MCPCapabilityQuotaUpdate(BaseModel):
    """Body for ``PATCH /capabilities/{id}/quota``.

    ``rate_limit`` is independent of ``enabled`` (the period quota toggle)
    — a capability can have a rate cap with no period quota, or both.
    """

    enabled: bool
    limit: int | None = Field(None, ge=0)
    period: MCPQuotaPeriod | None = None
    rate_limit: int | None = Field(None, ge=0)  # calls/min; 0 or None clears it


MCPAuthorizationMode = Literal["required", "public"]


class MCPCapabilityAuthorizationModeUpdate(BaseModel):
    """Body for ``PATCH /capabilities/{id}/authorization-mode`` — flip the
    per-capability authorization mode.

      - ``required``: default-deny; grants via mcp_capability_authorizations
      - ``public``:   allow-all; denials via mcp_capability_blacklists
    """

    mode: MCPAuthorizationMode


class MCPCapabilityAuthorizationModeView(BaseModel):
    """Response for the mode endpoint + nested in capability detail."""

    mcp_capability_id: str
    capability_name: str
    authorization_mode: MCPAuthorizationMode
    blacklist_count: int = 0


class MCPCapabilityBlacklistCreate(BaseModel):
    """Body for ``POST /capabilities/{id}/blacklist``."""

    principal_type: str = Field(..., min_length=1)
    principal_id: str = Field(..., min_length=1)
    reason: str | None = Field(None, max_length=500)


class MCPCapabilityBlacklistItem(BaseModel):
    """One row from a capability's blacklist."""

    id: str
    mcp_capability_id: str
    principal_type: str
    principal_id: str
    principal_name: str | None = None
    reason: str | None = None
    created_at: datetime


class MCPCapabilityBlacklistListResponse(BaseModel):
    total: int
    items: list[MCPCapabilityBlacklistItem]


# ── MCP external connections ───────────────────────────────────────────
#
# Platform-managed external connection configs under the MCP module.
# secret_json values are stored encrypted (enc:v1:...) and NEVER returned
# in plaintext — read responses carry masked values; on write, a masked
# value means "keep the stored secret unchanged".

MCPConnectionType = Literal["s3", "sftp", "url", "local_path", "database", "github", "slack"]


class MCPExternalConnectionCreate(BaseModel):
    """Body for ``POST /mcp-external-connections``."""

    code: str = Field(..., min_length=1, max_length=100)
    name: str = Field(..., min_length=1, max_length=200)
    connection_type: MCPConnectionType
    enabled: bool = True
    config: dict[str, Any] = Field(default_factory=dict)
    secret: dict[str, Any] = Field(default_factory=dict)
    allowed_scopes: dict[str, Any] = Field(default_factory=dict)


class MCPExternalConnectionUpdate(BaseModel):
    """Body for ``PATCH /mcp-external-connections/{id}`` — all optional.

    For ``secret``: only the fields present are touched; a value equal to
    the mask sentinel keeps the stored ciphertext unchanged.
    """

    name: str | None = Field(None, min_length=1, max_length=200)
    enabled: bool | None = None
    config: dict[str, Any] | None = None
    secret: dict[str, Any] | None = None
    allowed_scopes: dict[str, Any] | None = None


class MCPExternalConnectionListItem(BaseModel):
    """Compact row for the list page."""

    id: str
    code: str
    name: str
    connection_type: str
    enabled: bool
    test_status: str | None = None
    last_tested_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class MCPExternalConnectionDetail(MCPExternalConnectionListItem):
    """Full view. ``secret`` values are masked, never plaintext."""

    config: dict[str, Any] = Field(default_factory=dict)
    secret: dict[str, Any] = Field(default_factory=dict)
    allowed_scopes: dict[str, Any] = Field(default_factory=dict)
    last_test_error: str | None = None


class MCPExternalConnectionListResponse(BaseModel):
    total: int
    items: list[MCPExternalConnectionListItem]


class MCPConnectionTestOutcome(BaseModel):
    """Result of ``POST /mcp-external-connections/{id}/test``."""

    test_status: str  # 'ok' | 'failed'
    last_tested_at: datetime | None = None
    last_test_error: str | None = None
    detail: str | None = None


class MCPCapabilityDetail(MCPCapabilityListItem):
    """Same as the list shape plus the schemas + quota block.

    ``input_schema`` is the MCP-side ``inputSchema`` (JSON Schema).
    ``output_schema`` is usually NULL — MCP rarely advertises one.

    ``quota`` is computed on read: ``authorized_quota_sum`` sums the
    ``allocated_quota`` of every enabled non-deleted authorization;
    ``remaining_authorizable_quota`` is ``limit - authorized_quota_sum``.
    """

    input_schema: dict[str, Any] | None = None
    output_schema: dict[str, Any] | None = None
    quota: MCPCapabilityQuotaConfig


# ── MCP Capability ↔ Principal authorizations ──────────────────────────
#
# An "authorization" grants one calling Principal the right to call one
# MCP Capability. A principal is (principal_type, principal_id) — type
# ∈ ai_tool / agent / workflow / system_job. Default-deny: no
# authorization → call rejected.

MCPPrincipalType = Literal["ai_tool", "agent", "workflow", "system_job"]


class MCPAuthorizationCreate(BaseModel):
    """Body for ``POST /mcp-servers/{sid}/authorized-principals``.

    The path parameter identifies the MCP server; this body carries
    the principal + capability + quota slice + parameter glue.
    """

    principal_type: MCPPrincipalType
    principal_id: str = Field(..., min_length=1)
    mcp_capability_id: str = Field(..., min_length=1)
    enabled: bool = True
    allocated_quota: int | None = Field(None, ge=0)
    quota_period: MCPQuotaPeriod | None = None
    parameter_mapping_json: dict[str, Any] | None = None
    parameter_defaults_json: dict[str, Any] | None = None


class MCPAuthorizationUpdate(BaseModel):
    """Body for ``PATCH .../authorized-principals/{authorization_id}``.

    ``principal_type`` / ``principal_id`` / ``mcp_capability_id`` are
    NOT editable — to re-point an authorization, delete it and create a
    new one. Keeps call-log / audit history unambiguous.
    """

    enabled: bool | None = None
    allocated_quota: int | None = Field(None, ge=0)
    quota_period: MCPQuotaPeriod | None = None
    parameter_mapping_json: dict[str, Any] | None = None
    parameter_defaults_json: dict[str, Any] | None = None


class MCPAuthorizationItem(BaseModel):
    """One authorization row, as returned by the list / mutation APIs."""

    authorization_id: str
    principal_type: str
    principal_id: str
    principal_name: str | None = None
    mcp_server_id: str
    mcp_server_name: str | None = None
    mcp_capability_id: str
    mcp_capability_name: str
    capability_status: str | None = None  # 'active' | 'inactive'
    enabled: bool
    quota_period: str | None = None
    allocated_quota: int | None = None
    quota_used: int = 0
    # allocated_quota - quota_used (None when no allocated_quota set).
    quota_remaining: int | None = None
    quota_reset_at: datetime | None = None
    parameter_mapping_json: dict[str, Any] | None = None
    parameter_defaults_json: dict[str, Any] | None = None
    created_at: datetime
    updated_at: datetime


class MCPAuthorizedPrincipalListResponse(BaseModel):
    total: int
    items: list[MCPAuthorizationItem]


class MCPCapabilityAuthorizationSummary(BaseModel):
    """One capability's quota + authorization rollup (spec §6.1)."""

    mcp_capability_id: str
    name: str
    status: str  # 'active' | 'inactive'
    authorization_mode: str = (
        "required"  # 'required' | 'public' — public caps need no per-principal grant
    )
    rate_limit: int | None = None  # calls/minute cap (None = no rate cap)
    quota_enabled: bool
    quota_period: str | None = None
    quota_limit: int | None = None
    quota_used: int = 0
    quota_reset_at: datetime | None = None
    authorized_quota_sum: int = 0
    remaining_authorizable_quota: int | None = None
    authorized_principal_count: int = 0


class MCPAuthorizationSummaryResponse(BaseModel):
    """``GET /mcp-servers/{sid}/authorization-summary`` — one row per
    capability of the server."""

    server_id: str
    capabilities: list[MCPCapabilityAuthorizationSummary]


AIToolInvokeType = Literal["agent_auto", "user_confirmed", "mcp_test"]


class AIToolInvokeRequest(BaseModel):
    """Body for ``POST /ai-tools/{id}/invoke`` — the AI-Tool-side
    invocation entry point.

    ``mcp_capability_id`` selects which capability to call — the
    authorization for (this AI Tool, that capability) gates the call.
    ``input`` is the AI Tool's own input shape; the authorization's
    ``parameter_mapping_json`` + ``parameter_defaults_json`` translate
    it into MCP Capability arguments before the live call.
    """

    mcp_capability_id: str = Field(..., min_length=1)
    input: dict[str, Any] = Field(default_factory=dict)
    session_id: str | None = None
    invoke_type: AIToolInvokeType = "agent_auto"


class AIToolInvokeResponse(BaseModel):
    """Result returned after an AI-Tool-side invocation."""

    call_log_id: str
    result: str  # 'success' | 'failed'
    response_time_ms: int | None = None
    output_summary: str | None = None
    error_type: str | None = None
    error_message: str | None = None


class MCPCapabilityListResponse(BaseModel):
    total: int
    items: list[MCPCapabilityListItem]


class MCPCapabilityInvokeRequest(BaseModel):
    """Body for ``POST .../capabilities/{id}/test-invoke``.

    ``arguments`` is forwarded verbatim to the MCP server; the call-
    log row stores a SANITIZED summary, but the live invocation
    carries the raw values upstream.
    """

    arguments: dict[str, Any] = Field(default_factory=dict)


class MCPCapabilityInvokeResponse(BaseModel):
    """Result returned to the admin after a test-invoke.

    ``output_summary`` is a sanitized + truncated preview suitable for
    UI display. The full response body is NEVER echoed back here — it
    can be large or contain sensitive data; the admin should run the
    capability through normal agent flows for downstream consumption.
    """

    call_log_id: str
    result: str  # 'success' | 'failed'
    response_time_ms: int | None = None
    output_summary: str | None = None
    error_type: str | None = None
    error_message: str | None = None


class MCPResourceListItem(BaseModel):
    id: str
    server_id: str
    uri: str
    name: str | None = None
    mime_type: str | None = None
    description: str | None = None
    created_at: datetime
    updated_at: datetime


class MCPResourceListResponse(BaseModel):
    total: int
    items: list[MCPResourceListItem]


class MCPPromptListItem(BaseModel):
    id: str
    server_id: str
    name: str
    description: str | None = None
    arguments_json: list[dict[str, Any]] | None = None
    created_at: datetime
    updated_at: datetime


class MCPPromptListResponse(BaseModel):
    total: int
    items: list[MCPPromptListItem]


class MCPServerStats(BaseModel):
    """Header counts for the server list page.

    Health-status buckets use the stable codes ``normal / abnormal /
    unchecked`` (per the spec's preferred English naming). Frontend
    i18n maps each to its localized label (正常 / 异常 / 未检测).
    """

    total: int
    enabled: int
    disabled: int
    normal: int
    abnormal: int
    unchecked: int


# ── Task 4: read-only observability views ─────────────────────────────
#
# Server detail page surfaces five read-only views. All endpoints
# require ``mcp_servers.read`` and return paginated ``{total, items}``
# shapes (where applicable). No state-modifying actions live here —
# edits go through the existing CRUD/authorization endpoints.


class MCPServerHealthState(BaseModel):
    """Current health snapshot for one MCP server.

    Cheap view backed by the mirrored columns on ``mcp_servers`` plus
    a small aggregate over recent ``mcp_health_records`` rows for
    ``consecutive_failures`` and ``last_recovered_at``. Intended for
    the detail page header; the time-series view lives in
    ``GET .../health-records``.
    """

    server_id: str
    health_status: MCPHealthStatus
    last_checked_at: datetime | None = None
    last_response_time: int | None = None  # ms
    last_sync_status: str | None = None
    last_error_type: str | None = None
    last_error_message: str | None = None
    # Run-length of consecutive 'abnormal' probes ending at the latest
    # record (0 when latest is 'normal' or when no probe has run).
    consecutive_failures: int = 0
    # Timestamp of the most recent ``abnormal → normal`` transition,
    # or None if never recovered (e.g. always-normal or always-abnormal).
    last_recovered_at: datetime | None = None


class MCPHealthRecordItem(BaseModel):
    """One probe row from ``mcp_health_records`` (time-series detail).

    ``status`` is the stable code ``normal / abnormal``; ``error_type``
    carries the same classifier set as the connection-test endpoint
    (``unreachable / auth_failed / timeout / protocol_mismatch /
    discovery_failed``) and is NULL when status == normal.
    """

    id: str
    server_id: str
    status: str
    response_time: int | None = None  # ms
    error_type: str | None = None
    error_message: str | None = None
    checked_at: datetime


class MCPHealthRecordListResponse(BaseModel):
    total: int
    items: list[MCPHealthRecordItem]


class MCPCallLogItem(BaseModel):
    """One row from ``mcp_call_logs``.

    Payload-bearing columns (``input_summary`` / ``output_summary``)
    are already sanitized at insert time — secret-keyed args are
    redacted and long values truncated. Endpoint surfaces them as-is
    for the UI.
    """

    id: str
    mcp_server_id: str
    mcp_server_name: str | None = None
    mcp_capability_id: str | None = None
    mcp_capability_name: str
    ai_tool_id: str | None = None
    ai_tool_name: str | None = None
    user_id: str | None = None
    user_name: str | None = None  # joined via users table
    session_id: str | None = None
    invoke_type: str
    input_summary: dict[str, Any] | None = None
    output_summary: str | None = None
    result: str  # 'success' | 'failed'
    response_time: int | None = None  # ms
    error_type: str | None = None
    error_message: str | None = None
    called_at: datetime


class MCPCallLogListResponse(BaseModel):
    total: int
    items: list[MCPCallLogItem]


class MCPChangeLogItem(BaseModel):
    """One row from the cross-table changes view (backed by audit_logs).

    Aggregates three sources for a given server:
      - resource_type='mcp_server' AND resource_id=server_id
        (server CRUD, enable/disable, connection_test, capability_sync)
      - resource_type='mcp_capability' AND resource_id IN (this server's
        capabilities) (quota edits)
      - resource_type='mcp_capability_authorization' AND resource_id IN
        (this server's authorizations)

    ``action`` carries the stable dotted-code (e.g.
    ``mcp_server.update`` / ``mcp_capability_authorization.create``) so the
    UI can branch without parsing ``details``. ``details`` is the raw
    audit JSON — typically includes ``changes`` (before/after diff) or
    a snapshot, depending on the source action.
    """

    id: str
    action: str
    resource_type: str  # 'mcp_server'|'mcp_capability'|'mcp_capability_authorization'
    resource_id: str | None = None
    user_id: str | None = None
    user_name: str | None = None
    details: dict[str, Any] | None = None
    ip_address: str | None = None
    created_at: datetime


class MCPChangeLogListResponse(BaseModel):
    total: int
    items: list[MCPChangeLogItem]
