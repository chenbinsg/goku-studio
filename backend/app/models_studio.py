"""
models_studio.py — Studio domain ORM models.

Owner: 智能体应用 (Goku Studio team)
Tables: agent_definitions, workflows, tools, MCP servers/capabilities,
        knowledge, memory, skills, plugins, docs, IRA, improvement proposals.

Core reads these tables as READ-ONLY (agent config at task-start time).
Core must NEVER write to these tables directly — use Studio API endpoints.

Cross-domain FK note: tasks.agent_id and conversations.agent_id are string
columns pointing at agent_definitions.id. The MySQL FK constraint exists but
the SQLAlchemy relationship() is defined here (Studio side) only.
"""
from datetime import datetime
from sqlalchemy import (
    Column, Integer, String, DateTime, Text, Float, Boolean,
    ForeignKey, JSON, Index, UniqueConstraint,
)
from sqlalchemy.dialects.mysql import MEDIUMTEXT
from sqlalchemy.orm import relationship
from app.db import Base


# ── Agent definitions ─────────────────────────────────────────────────────────

class AgentDefinition(Base):
    __tablename__ = "agent_definitions"

    id                     = Column(String(36),  primary_key=True)
    name                   = Column(String(200), nullable=False)
    description            = Column(Text,        nullable=True)
    agent_type             = Column(String(50),  nullable=False)
    system_prompt_override = Column(Text,        nullable=True)
    skills                 = Column(JSON,        nullable=True)
    allowed_tools          = Column(JSON,        nullable=True)
    model_override         = Column(String(100), nullable=True)
    max_steps              = Column(Integer,     nullable=True)
    icon                   = Column(String(100), nullable=True)
    color                  = Column(String(20),  nullable=True)
    department             = Column(String(100), nullable=True)
    division               = Column(String(100), nullable=True)
    category               = Column(String(50),  nullable=True)
    figure_url             = Column(Text,        nullable=True)
    slug                   = Column(String(100), unique=True, nullable=True)
    name_i18n              = Column(JSON,        nullable=True)
    is_active              = Column(Boolean,     default=True)
    user_id                = Column(String(36),  ForeignKey("users.id"),    nullable=True)
    tenant_id              = Column(String(36),  ForeignKey("tenants.id"),  nullable=True)
    visibility             = Column(String(20),  nullable=False, default='department')
    allowed_roles          = Column(JSON,        nullable=True)
    display_name           = Column(String(200), nullable=True)
    notification_channels  = Column(JSON,        nullable=True)
    escalation_contact     = Column(JSON,        nullable=True)
    allowed_channels       = Column(JSON,        nullable=True)
    channel_configs        = Column(JSON,        nullable=True)
    dlp_bypass             = Column(Boolean,     default=False, nullable=False)
    auto_send_drafts       = Column(Boolean,     default=False, nullable=False)
    created_at             = Column(DateTime,    default=datetime.utcnow)
    updated_at             = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)

    favorites       = relationship("UserAgentFavorite", back_populates="agent", cascade="all, delete-orphan")
    access_policies = relationship("AgentAccessPolicy", back_populates="agent", cascade="all, delete-orphan")

    __table_args__ = (
        Index("ix_agent_defs_tenant_created", "tenant_id", "created_at"),
        Index("ix_agent_defs_user_created",   "user_id",   "created_at"),
    )


class AgentAccessPolicy(Base):
    """Fine-grained per-principal access policy for an Agent."""
    __tablename__ = "agent_access_policies"

    id             = Column(String(36),  primary_key=True)
    tenant_id      = Column(String(36),  ForeignKey("tenants.id",        ondelete="CASCADE"), nullable=True, index=True)
    agent_id       = Column(String(36),  ForeignKey("agent_definitions.id", ondelete="CASCADE"), nullable=False, index=True)
    principal_type = Column(String(20),  nullable=False)
    principal_id   = Column(String(36),  nullable=False)
    can_view       = Column(Boolean,     nullable=False, default=True)
    can_use        = Column(Boolean,     nullable=False, default=True)
    can_config     = Column(Boolean,     nullable=False, default=False)
    granted_by     = Column(String(36),  ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    expires_at     = Column(DateTime,    nullable=True)
    created_at     = Column(DateTime,    default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("agent_id", "principal_type", "principal_id", name="uq_agent_policy_principal"),
        Index("ix_aap_agent_id",  "agent_id"),
        Index("ix_aap_principal", "principal_type", "principal_id"),
    )

    agent = relationship("AgentDefinition", back_populates="access_policies")


class UserAgentFavorite(Base):
    """User-scoped agent pin / favorite."""
    __tablename__ = "user_agent_favorites"

    user_id   = Column(String(36), ForeignKey("users.id",            ondelete="CASCADE"), primary_key=True)
    agent_id  = Column(String(36), ForeignKey("agent_definitions.id", ondelete="CASCADE"), primary_key=True)
    pinned_at = Column(DateTime,   default=datetime.utcnow)

    user  = relationship("User",            back_populates="agent_favorites")
    agent = relationship("AgentDefinition", back_populates="favorites")


# ── Workflows ─────────────────────────────────────────────────────────────────

class Workflow(Base):
    __tablename__ = "workflows"

    id          = Column(String(36),  primary_key=True)
    name        = Column(String(200), nullable=False)
    description = Column(Text,        nullable=True)
    dag         = Column(JSON,        nullable=False)
    triggers    = Column(JSON,        default=list)
    variables   = Column(JSON,        default=dict)
    version     = Column(String(20),  default="1.0.0")
    agent_id    = Column(String(36),  nullable=True)
    created_at  = Column(DateTime,    default=datetime.utcnow)


class WorkflowExecution(Base):
    __tablename__ = "workflow_executions"

    id                = Column(String(36),  primary_key=True)
    workflow_id       = Column(String(36),  ForeignKey("workflows.id"), nullable=False)
    status            = Column(String(50),  default="running")
    variables         = Column(JSON,        nullable=True)
    started_at        = Column(DateTime,    default=datetime.utcnow)
    completed_at      = Column(DateTime,    nullable=True)
    error_message     = Column(Text,        nullable=True)
    resume_from_layer = Column(Integer,     default=0)
    cancelled_at      = Column(DateTime,    nullable=True)


class WorkflowNodeExecution(Base):
    __tablename__ = "workflow_node_executions"

    id           = Column(String(36),  primary_key=True)
    execution_id = Column(String(36),  ForeignKey("workflow_executions.id"), nullable=False, index=True)
    node_id      = Column(String(100), nullable=False)
    node_type    = Column(String(50),  nullable=True)
    status       = Column(String(50),  default="pending")
    layer_index  = Column(Integer,     nullable=True)
    input_data   = Column(JSON,        nullable=True)
    output_data  = Column(JSON,        nullable=True)
    error_message = Column(Text,       nullable=True)
    started_at   = Column(DateTime,    nullable=True)
    completed_at = Column(DateTime,    nullable=True)


# ── Tool registry ─────────────────────────────────────────────────────────────

class Tool(Base):
    __tablename__ = "tools"

    id               = Column(String(36),  primary_key=True)
    name             = Column(String(100), unique=True, nullable=False)
    description      = Column(Text,        nullable=False)
    handler          = Column(String(255), nullable=False)
    schema           = Column(JSON,        nullable=False)
    permission_level = Column(Integer,     default=0)
    created_at       = Column(DateTime,    default=datetime.utcnow)


class AutoSkill(Base):
    """LLM-extracted reusable skill procedures."""
    __tablename__ = "auto_skills"

    id                  = Column(String(36),  primary_key=True)
    name                = Column(String(120), nullable=False, unique=True)
    description         = Column(Text,        nullable=False)
    trigger_keywords    = Column(JSON,        nullable=True)
    tools_required      = Column(JSON,        nullable=True)
    workflow_md         = Column(Text,        nullable=False)
    source_task_ids     = Column(JSON,        nullable=True)
    use_count           = Column(Integer,     default=0)
    success_count       = Column(Integer,     default=0)
    fail_count          = Column(Integer,     default=0)
    embedding           = Column(JSON,        nullable=True)
    is_approved         = Column(Boolean,     default=False)
    approval_status     = Column(String(20),  default="pending")
    tenant_id           = Column(String(36),  nullable=True)
    last_used_at        = Column(DateTime,    nullable=True)
    baseline_steps      = Column(Float,       nullable=True)
    assisted_steps_sum  = Column(Integer,     nullable=True, default=0)
    assisted_count      = Column(Integer,     nullable=True, default=0)
    created_at          = Column(DateTime,    default=datetime.utcnow)
    updated_at          = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)

    @property
    def avg_success_rate(self) -> float:
        total = (self.success_count or 0) + (self.fail_count or 0)
        return 0.0 if total == 0 else round((self.success_count or 0) / total, 4)

    @property
    def avg_speedup(self) -> float | None:
        n = self.assisted_count or 0
        if n < 3 or not self.baseline_steps or not self.assisted_steps_sum:
            return None
        avg_assisted = self.assisted_steps_sum / n
        return None if avg_assisted <= 0 else round(self.baseline_steps / avg_assisted, 2)


class Plugin(Base):
    __tablename__ = "plugins"

    id                   = Column(String(36),  primary_key=True)
    name                 = Column(String(100), nullable=False)
    version              = Column(String(50),  nullable=False)
    description          = Column(Text,        nullable=True)
    config               = Column(JSON,        default=dict)
    status               = Column(String(50),  default="installed")
    installed_at         = Column(DateTime,    default=datetime.utcnow)
    author               = Column(String(100), nullable=True)
    category             = Column(String(50),  nullable=True)
    permissions_required = Column(JSON,        default=list)
    security_audit       = Column(JSON,        nullable=True)
    source_url           = Column(String(500), nullable=True)
    uninstalled_at       = Column(DateTime,    nullable=True)


# ── MCP ───────────────────────────────────────────────────────────────────────

class MCPServer(Base):
    __tablename__ = "mcp_servers"

    id                        = Column(String(36),  primary_key=True)
    name                      = Column(String(255), nullable=False)
    code                      = Column(String(100), nullable=False, unique=True)
    service_category          = Column(String(50),  nullable=False)
    description               = Column(Text,        nullable=True)
    owner                     = Column(String(255), nullable=True)
    connection_type           = Column(String(20),  nullable=False)
    service_url               = Column(String(500), nullable=True)
    start_command             = Column(Text,        nullable=True)
    work_dir                  = Column(String(500), nullable=True)
    timeout_seconds           = Column(Integer,     default=60, server_default="60", nullable=False)
    retry_count               = Column(Integer,     default=0,  server_default="0",  nullable=False)
    auth_type                 = Column(String(40),  nullable=True)
    auth_header_name          = Column(String(100), nullable=True)
    auth_secret               = Column(Text,        nullable=True)
    env_config                = Column(Text,        nullable=True)
    status                    = Column(String(20),  default="enabled", server_default="enabled", nullable=False)
    health_status             = Column(String(20),  default="unchecked", server_default="unchecked", nullable=False)
    last_checked_at           = Column(DateTime,    nullable=True)
    last_response_time        = Column(Integer,     nullable=True)
    last_sync_status          = Column(String(20),  nullable=True)
    last_synced_at            = Column(DateTime,    nullable=True)
    last_sync_error_message   = Column(Text,        nullable=True)
    auto_sync_enabled         = Column(Boolean,     default=False, server_default="0", nullable=False)
    sync_frequency            = Column(String(50),  nullable=True)
    sync_scope                = Column(JSON,        nullable=True)
    conflict_strategy         = Column(String(50),  nullable=True)
    offline_strategy          = Column(String(50),  nullable=True)
    allow_agent_auto_invoke   = Column(Boolean,     default=False, server_default="0", nullable=False)
    high_risk_confirm_required = Column(Boolean,    default=True,  server_default="1", nullable=False)
    rate_limit_config         = Column(JSON,        nullable=True)
    circuit_breaker_config    = Column(JSON,        nullable=True)
    audit_enabled             = Column(Boolean,     default=True,  server_default="1", nullable=False)
    created_by                = Column(String(36),  nullable=True)
    created_at                = Column(DateTime,    default=datetime.utcnow, nullable=False)
    updated_by                = Column(String(36),  nullable=True)
    updated_at                = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
    deleted_at                = Column(DateTime,    nullable=True, index=True)

    __table_args__ = (
        Index("ix_mcp_servers_category", "service_category"),
        Index("ix_mcp_servers_status",   "status"),
        Index("ix_mcp_servers_health",   "health_status"),
    )


class MCPCapability(Base):
    __tablename__ = "mcp_capabilities"

    id                 = Column(String(36),  primary_key=True)
    server_id          = Column(String(36),  ForeignKey("mcp_servers.id", ondelete="CASCADE"), nullable=False, index=True)
    capability_name    = Column(String(255), nullable=False)
    description        = Column(Text,        nullable=True)
    input_schema       = Column(JSON,        nullable=True)
    output_schema      = Column(JSON,        nullable=True)
    status             = Column(String(20),  default="active", server_default="active", nullable=False)
    quota_enabled      = Column(Boolean,     default=False, server_default="0", nullable=False)
    quota_limit        = Column(Integer,     nullable=True)
    quota_period       = Column(String(20),  nullable=True)
    quota_used         = Column(Integer,     default=0, server_default="0", nullable=False)
    quota_reset_at     = Column(DateTime,    nullable=True)
    rate_limit         = Column(Integer,     nullable=True)
    rate_used          = Column(Integer,     default=0, server_default="0", nullable=False)
    rate_reset_at      = Column(DateTime,    nullable=True)
    authorization_mode = Column(String(16),  default="required", server_default="required", nullable=False, index=True)
    last_synced_at     = Column(DateTime,    nullable=True)
    last_called_at     = Column(DateTime,    nullable=True)
    created_at         = Column(DateTime,    default=datetime.utcnow, nullable=False)
    updated_at         = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    __table_args__ = (
        Index("ix_mcp_capabilities_status", "server_id", "status"),
    )


class MCPResource(Base):
    __tablename__ = "mcp_resources"

    id         = Column(String(36),  primary_key=True)
    server_id  = Column(String(36),  ForeignKey("mcp_servers.id", ondelete="CASCADE"), nullable=False, index=True)
    uri        = Column(String(500), nullable=False)
    name       = Column(String(255), nullable=True)
    mime_type  = Column(String(100), nullable=True)
    description = Column(Text,       nullable=True)
    created_at = Column(DateTime,    default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
    deleted_at = Column(DateTime,    nullable=True, index=True)

    __table_args__ = (
        Index("ix_mcp_resources_server_uri", "server_id", "uri"),
    )


class MCPPrompt(Base):
    __tablename__ = "mcp_prompts"

    id             = Column(String(36),  primary_key=True)
    server_id      = Column(String(36),  ForeignKey("mcp_servers.id", ondelete="CASCADE"), nullable=False, index=True)
    name           = Column(String(255), nullable=False)
    description    = Column(Text,        nullable=True)
    arguments_json = Column(JSON,        nullable=True)
    created_at     = Column(DateTime,    default=datetime.utcnow, nullable=False)
    updated_at     = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
    deleted_at     = Column(DateTime,    nullable=True, index=True)

    __table_args__ = (
        Index("ix_mcp_prompts_server_name", "server_id", "name"),
    )


class MCPPermission(Base):
    __tablename__ = "mcp_permissions"

    id             = Column(String(36), primary_key=True)
    server_id      = Column(String(36), ForeignKey("mcp_servers.id", ondelete="CASCADE"), nullable=False, index=True)
    principal_type = Column(String(20), nullable=False)
    principal_id   = Column(String(64), nullable=False)
    scope          = Column(JSON,       nullable=True)
    granted_by     = Column(String(36), nullable=True)
    granted_at     = Column(DateTime,   default=datetime.utcnow, nullable=False)
    deleted_at     = Column(DateTime,   nullable=True, index=True)

    __table_args__ = (
        Index("ix_mcp_perms_server_principal", "server_id", "principal_type", "principal_id"),
    )


class MCPHealthRecord(Base):
    __tablename__ = "mcp_health_records"

    id             = Column(String(36), primary_key=True)
    server_id      = Column(String(36), ForeignKey("mcp_servers.id", ondelete="CASCADE"), nullable=False, index=True)
    status         = Column(String(20), nullable=False)
    response_time  = Column(Integer,    nullable=True)
    error_type     = Column(String(40), nullable=True)
    error_message  = Column(Text,       nullable=True)
    checked_at     = Column(DateTime,   default=datetime.utcnow, nullable=False, index=True)


class MCPCallLog(Base):
    __tablename__ = "mcp_call_logs"

    id                          = Column(String(36),  primary_key=True)
    mcp_server_id               = Column(String(36),  ForeignKey("mcp_servers.id",       ondelete="CASCADE"),  nullable=False, index=True)
    mcp_server_name             = Column(String(255), nullable=True)
    mcp_capability_id           = Column(String(36),  ForeignKey("mcp_capabilities.id",  ondelete="SET NULL"), nullable=True,  index=True)
    mcp_capability_name         = Column(String(255), nullable=False)
    principal_type              = Column(String(20),  nullable=True)
    principal_id                = Column(String(36),  nullable=True)
    principal_name              = Column(String(255), nullable=True)
    ai_tool_id                  = Column(String(36),  nullable=True)
    ai_tool_name                = Column(String(255), nullable=True)
    user_id                     = Column(String(36),  nullable=True, index=True)
    session_id                  = Column(String(64),  nullable=True)
    invoke_type                 = Column(String(40),  nullable=False)
    input_summary               = Column(JSON,        nullable=True)
    output_summary              = Column(Text,        nullable=True)
    result                      = Column(String(20),  nullable=False)
    response_time               = Column(Integer,     nullable=True)
    error_type                  = Column(String(40),  nullable=True)
    error_message               = Column(Text,        nullable=True)
    authorization_id            = Column(String(36),  nullable=True, index=True)
    authorization_check_result  = Column(String(20),  nullable=True)
    quota_check_result          = Column(String(20),  nullable=True)
    quota_period                = Column(String(20),  nullable=True)
    quota_limit                 = Column(Integer,     nullable=True)
    quota_used_before           = Column(Integer,     nullable=True)
    quota_used_after            = Column(Integer,     nullable=True)
    error_code                  = Column(String(60),  nullable=True)
    tenant_id                   = Column(String(36),  nullable=True, index=True)
    called_at                   = Column(DateTime,    default=datetime.utcnow, nullable=False, index=True)


class MCPCapabilityAuthorization(Base):
    __tablename__ = "mcp_capability_authorizations"

    id                      = Column(String(36),  primary_key=True)
    principal_type          = Column(String(20),  nullable=False)
    principal_id            = Column(String(36),  nullable=False)
    mcp_server_id           = Column(String(36),  ForeignKey("mcp_servers.id",      ondelete="CASCADE"), nullable=False, index=True)
    mcp_capability_id       = Column(String(36),  ForeignKey("mcp_capabilities.id", ondelete="CASCADE"), nullable=False, index=True)
    enabled                 = Column(Boolean,     default=True, server_default="1", nullable=False)
    allocated_quota         = Column(Integer,     nullable=True)
    quota_period            = Column(String(20),  nullable=True)
    quota_used              = Column(Integer,     default=0, server_default="0", nullable=False)
    quota_reset_at          = Column(DateTime,    nullable=True)
    parameter_mapping_json  = Column(JSON,        nullable=True)
    parameter_defaults_json = Column(JSON,        nullable=True)
    created_by              = Column(String(36),  nullable=True)
    created_at              = Column(DateTime,    default=datetime.utcnow, nullable=False)
    updated_by              = Column(String(36),  nullable=True)
    updated_at              = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
    deleted_at              = Column(DateTime,    nullable=True)

    __table_args__ = (
        Index("ix_mcp_authz_principal",        "principal_type", "principal_id"),
        Index("ix_ai_tool_mcp_authz_enabled",  "enabled"),
        UniqueConstraint("principal_type", "principal_id", "mcp_capability_id",
                         "deleted_at", name="uq_mcp_authz_principal_cap_deleted"),
    )


class MCPCapabilityBlacklist(Base):
    __tablename__ = "mcp_capability_blacklists"

    id                = Column(String(36),  primary_key=True)
    mcp_capability_id = Column(String(36),  ForeignKey("mcp_capabilities.id", ondelete="CASCADE"), nullable=False, index=True)
    principal_type    = Column(String(20),  nullable=False)
    principal_id      = Column(String(36),  nullable=False)
    principal_name    = Column(String(200), nullable=True)
    reason            = Column(String(500), nullable=True)
    created_by        = Column(String(36),  nullable=True)
    created_at        = Column(DateTime,    default=datetime.utcnow, nullable=False)

    __table_args__ = (
        UniqueConstraint("mcp_capability_id", "principal_type", "principal_id",
                         name="uq_mcp_cap_bl_cap_principal"),
    )


class MCPExternalConnection(Base):
    __tablename__ = "mcp_external_connections"

    id                  = Column(String(36),  primary_key=True)
    code                = Column(String(100), nullable=False, unique=True)
    name                = Column(String(200), nullable=False)
    connection_type     = Column(String(20),  nullable=False, index=True)
    enabled             = Column(Boolean,     default=True, server_default="1", nullable=False, index=True)
    config_json         = Column(JSON,        nullable=True)
    secret_json         = Column(JSON,        nullable=True)
    allowed_scopes_json = Column(JSON,        nullable=True)
    test_status         = Column(String(20),  nullable=True)
    last_tested_at      = Column(DateTime,    nullable=True)
    last_test_error     = Column(Text,        nullable=True)
    created_by          = Column(String(36),  nullable=True)
    updated_by          = Column(String(36),  nullable=True)
    created_at          = Column(DateTime,    default=datetime.utcnow, nullable=False)
    updated_at          = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
    deleted_at          = Column(DateTime,    nullable=True)


# ── Knowledge & memory ────────────────────────────────────────────────────────

class KnowledgeDoc(Base):
    __tablename__ = "knowledge_docs"

    id                  = Column(String(36),  primary_key=True)
    tenant_id           = Column(String(36),  ForeignKey("tenants.id"), nullable=True)
    parent_id           = Column(String(36),  ForeignKey("knowledge_docs.id"), nullable=True)
    chunk_index         = Column(Integer,     nullable=True)
    title               = Column(String(500), nullable=False)
    content             = Column(MEDIUMTEXT,  nullable=False)
    source              = Column(String(500), nullable=True)
    tags                = Column(JSON,        default=list)
    vector_id           = Column(String(100), nullable=True)
    external_source_id  = Column(String(36),  nullable=True, index=True)
    created_at          = Column(DateTime,    default=datetime.utcnow)

    __table_args__ = (
        Index("ix_knowledge_docs_tenant_created", "tenant_id", "created_at"),
    )


class ExternalMemorySource(Base):
    """Tracks connected external memory sources (Notion / Obsidian)."""
    __tablename__ = "external_memory_sources"

    id             = Column(String(36),  primary_key=True)
    tenant_id      = Column(String(36),  ForeignKey("tenants.id"), nullable=True, index=True)
    user_id        = Column(String(36),  ForeignKey("users.id"),   nullable=True, index=True)
    provider       = Column(String(20),  nullable=False)
    name           = Column(String(200), nullable=False)
    status         = Column(String(20),  nullable=False, default="active")
    config         = Column(JSON,        nullable=False, default=dict)
    last_synced_at = Column(DateTime,    nullable=True)
    sync_cursor    = Column(String(500), nullable=True)
    doc_count      = Column(Integer,     nullable=False, default=0)
    error_message  = Column(String(500), nullable=True)
    created_at     = Column(DateTime,    default=datetime.utcnow)


# ── Document center ───────────────────────────────────────────────────────────

class DocPage(Base):
    __tablename__ = "doc_pages"

    id          = Column(String(36),  primary_key=True)
    tenant_id   = Column(String(36),  ForeignKey("tenants.id"), nullable=True)
    category    = Column(String(50),  nullable=False, index=True)
    title       = Column(String(500), nullable=False)
    content     = Column(MEDIUMTEXT,  nullable=False, default="")
    title_zh    = Column(String(500), nullable=True)
    content_zh  = Column(MEDIUMTEXT,  nullable=True)
    title_ja    = Column(String(500), nullable=True)
    content_ja  = Column(MEDIUMTEXT,  nullable=True)
    version     = Column(String(50),  nullable=True)
    order_index = Column(Integer,     default=0)
    created_by  = Column(String(36),  ForeignKey("users.id"), nullable=True)
    created_at  = Column(DateTime,    default=datetime.utcnow)
    updated_at  = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)


# ── IRA (Investor Relations Assistant) ───────────────────────────────────────

class IraInvestor(Base):
    __tablename__ = "ira_investors"

    id               = Column(String(36),  primary_key=True)
    name             = Column(String(200), nullable=False, index=True)
    investor_type    = Column(String(50),  nullable=False)
    organization     = Column(String(200), nullable=True)
    title            = Column(String(200), nullable=True)
    email            = Column(String(200), nullable=True, index=True)
    phone            = Column(String(100), nullable=True)
    country          = Column(String(100), nullable=True)
    language         = Column(String(10),  default="zh")
    importance_level = Column(Integer,     default=3)
    status           = Column(String(20),  default="active")
    notes            = Column(Text,        nullable=True)
    tags             = Column(JSON,        default=list)
    created_at       = Column(DateTime,    default=datetime.utcnow)
    updated_at       = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        Index("ix_ira_investors_status_level", "status", "importance_level"),
    )


class IraEvent(Base):
    __tablename__ = "ira_events"

    id                 = Column(String(36),   primary_key=True)
    title              = Column(String(500),  nullable=False)
    event_type         = Column(String(50),   nullable=False)
    start_time         = Column(DateTime,     nullable=False, index=True)
    end_time           = Column(DateTime,     nullable=True)
    description        = Column(Text,         nullable=True)
    location           = Column(String(500),  nullable=True)
    online_meeting_url = Column(String(1000), nullable=True)
    owner_name         = Column(String(200),  nullable=True)
    status             = Column(String(20),   default="planned")
    created_at         = Column(DateTime,     default=datetime.utcnow)
    updated_at         = Column(DateTime,     default=datetime.utcnow, onupdate=datetime.utcnow)


class IraEventParticipant(Base):
    __tablename__ = "ira_event_participants"

    id                  = Column(String(36),  primary_key=True)
    event_id            = Column(String(36),  ForeignKey("ira_events.id",    ondelete="CASCADE"), nullable=False, index=True)
    investor_id         = Column(String(36),  ForeignKey("ira_investors.id", ondelete="CASCADE"), nullable=False, index=True)
    assigned_owner_name = Column(String(200), nullable=True)
    invitation_status   = Column(String(20),  default="not_sent")
    attendance_status   = Column(String(20),  default="unknown")
    response_status     = Column(String(20),  default="pending")
    notes               = Column(Text,         nullable=True)
    created_at          = Column(DateTime,    default=datetime.utcnow)
    updated_at          = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        Index("ix_ira_ep_event_investor", "event_id", "investor_id", unique=True),
    )


class IraEmailTemplate(Base):
    __tablename__ = "ira_email_templates"

    id               = Column(String(36),   primary_key=True)
    name             = Column(String(200),  nullable=False, unique=True)
    template_type    = Column(String(50),   nullable=False)
    subject_template = Column(String(1000), nullable=False)
    body_template    = Column(Text,          nullable=False)
    language         = Column(String(10),   default="zh")
    variables_json   = Column(JSON,         default=list)
    created_at       = Column(DateTime,     default=datetime.utcnow)


class IraEmailQueue(Base):
    __tablename__ = "ira_email_queue"

    id              = Column(String(36),   primary_key=True)
    event_id        = Column(String(36),   ForeignKey("ira_events.id"),         nullable=True, index=True)
    investor_id     = Column(String(36),   ForeignKey("ira_investors.id"),       nullable=True)
    template_id     = Column(String(36),   ForeignKey("ira_email_templates.id"), nullable=True)
    recipient_email = Column(String(200),  nullable=True)
    recipient_name  = Column(String(200),  nullable=True)
    subject         = Column(String(1000), nullable=True)
    body            = Column(Text,          nullable=True)
    status          = Column(String(20),   default="pending", index=True)
    scheduled_at    = Column(DateTime,     nullable=True)
    sent_at         = Column(DateTime,     nullable=True)
    error_message   = Column(Text,          nullable=True)
    created_at      = Column(DateTime,     default=datetime.utcnow)


class IraCommunication(Base):
    __tablename__ = "ira_communications"

    id                  = Column(String(36),  primary_key=True)
    channel             = Column(String(50),  nullable=False)
    direction           = Column(String(20),  default="outbound")
    investor_id         = Column(String(36),  ForeignKey("ira_investors.id"), nullable=True, index=True)
    event_id            = Column(String(36),  ForeignKey("ira_events.id"),    nullable=True)
    subject             = Column(String(500), nullable=True)
    content_summary     = Column(Text,         nullable=True)
    owner_name          = Column(String(200), nullable=True)
    next_action         = Column(Text,         nullable=True)
    next_action_due_at  = Column(DateTime,    nullable=True)
    created_at          = Column(DateTime,    default=datetime.utcnow)


class IraFollowupTask(Base):
    __tablename__ = "ira_tasks"

    id          = Column(String(36),  primary_key=True)
    title       = Column(String(500), nullable=False)
    description = Column(Text,         nullable=True)
    priority    = Column(String(20),  default="medium")
    status      = Column(String(20),  default="open", index=True)
    owner_name  = Column(String(200), nullable=True)
    due_at      = Column(DateTime,    nullable=True)
    investor_id = Column(String(36),  ForeignKey("ira_investors.id"), nullable=True)
    event_id    = Column(String(36),  ForeignKey("ira_events.id"),    nullable=True)
    created_at  = Column(DateTime,    default=datetime.utcnow)
    updated_at  = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)


class IraAgentAction(Base):
    __tablename__ = "ira_agent_actions"

    id            = Column(String(36),  primary_key=True)
    agent_name    = Column(String(200), nullable=False)
    action        = Column(String(200), nullable=False)
    target_type   = Column(String(50),  nullable=True)
    target_id     = Column(String(36),  nullable=True)
    input_json    = Column(JSON,         nullable=True)
    output_json   = Column(JSON,         nullable=True)
    status        = Column(String(20),  default="success")
    error_message = Column(Text,         nullable=True)
    created_at    = Column(DateTime,    default=datetime.utcnow)

    __table_args__ = (
        Index("ix_ira_agent_actions_agent_action", "agent_name", "action", "created_at"),
    )


class IraInvestorGroup(Base):
    __tablename__ = "ira_investor_groups"

    id          = Column(String(36),  primary_key=True)
    name        = Column(String(200), nullable=False, unique=True)
    description = Column(Text,         nullable=True)
    created_at  = Column(DateTime,    default=datetime.utcnow)


class IraInvestorGroupMember(Base):
    __tablename__ = "ira_investor_group_members"

    group_id    = Column(String(36), ForeignKey("ira_investor_groups.id", ondelete="CASCADE"), primary_key=True)
    investor_id = Column(String(36), ForeignKey("ira_investors.id",       ondelete="CASCADE"), primary_key=True)
    created_at  = Column(DateTime,   default=datetime.utcnow)


class IraApprovalRecord(Base):
    __tablename__ = "ira_approvals"

    id                = Column(String(36),  primary_key=True)
    object_type       = Column(String(50),  nullable=False)
    object_id         = Column(String(36),  nullable=False)
    requester_name    = Column(String(200), nullable=True)
    comments          = Column(Text,         nullable=True)
    approval_status   = Column(String(20),  default="pending", index=True)
    approver_name     = Column(String(200), nullable=True)
    approver_comments = Column(Text,         nullable=True)
    created_at        = Column(DateTime,    default=datetime.utcnow)
    updated_at        = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)


class IraMaterial(Base):
    __tablename__ = "ira_materials"

    id           = Column(String(36),   primary_key=True)
    file_name    = Column(String(500),  nullable=False)
    file_url     = Column(String(2000), nullable=False)
    file_type    = Column(String(50),   default="other")
    mime_type    = Column(String(200),  nullable=True)
    language     = Column(String(10),   default="zh")
    related_type = Column(String(50),   nullable=True)
    related_id   = Column(String(36),   nullable=True, index=True)
    created_at   = Column(DateTime,     default=datetime.utcnow)


# ── Self-evolution (proposals owned by Studio — config side) ──────────────────

class ImprovementProposal(Base):
    """Supervisor-generated improvement proposals for self-evolution."""
    __tablename__ = "improvement_proposals"

    id               = Column(String(36),  primary_key=True)
    tenant_id        = Column(String(36),  nullable=True, index=True)
    task_id          = Column(String(36),  ForeignKey("tasks.id",             ondelete="SET NULL"), nullable=True, index=True)
    agent_id         = Column(String(36),  ForeignKey("agent_definitions.id", ondelete="SET NULL"), nullable=True, index=True)
    risk_level       = Column(String(10),  nullable=False, default="LOW")
    proposal_type    = Column(String(30),  nullable=False)
    trigger_reason   = Column(String(100), nullable=True)
    step_count       = Column(Integer,     nullable=True)
    replan_count     = Column(Integer,     nullable=True, default=0)
    analysis_summary = Column(Text,        nullable=False)
    payload          = Column(JSON,        nullable=False, default=dict)
    status           = Column(String(20),  nullable=False, default="pending")
    applied_by       = Column(String(36),  nullable=True)
    reject_reason    = Column(Text,        nullable=True)
    created_at       = Column(DateTime,    nullable=False, default=datetime.utcnow)
    applied_at       = Column(DateTime,    nullable=True)

    __table_args__ = (
        Index("ix_proposals_status_risk",  "status",   "risk_level"),
        Index("ix_proposals_agent_status", "agent_id", "status"),
    )


class ProposalOutcome(Base):
    __tablename__ = "proposal_outcomes"

    id                    = Column(String(36),  primary_key=True)
    proposal_id           = Column(String(36),  ForeignKey("improvement_proposals.id", ondelete="CASCADE"), nullable=False, index=True)
    agent_id              = Column(String(36),  nullable=True, index=True)
    tenant_id             = Column(String(36),  nullable=True)
    baseline_success_rate = Column(Float,       nullable=True)
    baseline_task_count   = Column(Integer,     nullable=True)
    post_task_ids         = Column(JSON,        nullable=False, default=list)
    post_success_count    = Column(Integer,     nullable=False, default=0)
    post_fail_count       = Column(Integer,     nullable=False, default=0)
    verdict               = Column(String(20),  nullable=True)
    auto_rolled_back      = Column(Boolean,     nullable=False, default=False)
    rollback_reason       = Column(Text,        nullable=True)
    monitoring_started_at = Column(DateTime,    nullable=False, default=datetime.utcnow)
    verdict_at            = Column(DateTime,    nullable=True)

    __table_args__ = (
        Index("ix_proposal_outcomes_proposal", "proposal_id"),
        Index("ix_proposal_outcomes_verdict",  "verdict"),
    )


class PromptExperiment(Base):
    __tablename__ = "prompt_experiments"

    id                   = Column(String(36),  primary_key=True)
    proposal_id          = Column(String(36),  ForeignKey("improvement_proposals.id", ondelete="SET NULL"), nullable=True,  index=True)
    agent_id             = Column(String(36),  ForeignKey("agent_definitions.id",     ondelete="CASCADE"),  nullable=False, index=True)
    tenant_id            = Column(String(36),  nullable=True, index=True)
    control_prompt       = Column(Text,        nullable=False)
    treatment_prompt     = Column(Text,        nullable=False)
    control_tasks        = Column(Integer,     nullable=False, default=0)
    control_success      = Column(Integer,     nullable=False, default=0)
    treatment_tasks      = Column(Integer,     nullable=False, default=0)
    treatment_success    = Column(Integer,     nullable=False, default=0)
    status               = Column(String(20),  nullable=False, default="running")
    winner               = Column(String(20),  nullable=True)
    min_tasks_per_variant = Column(Integer,    nullable=False, default=20)
    started_at           = Column(DateTime,    nullable=False, default=datetime.utcnow)
    concluded_at         = Column(DateTime,    nullable=True)

    __table_args__ = (
        Index("ix_prompt_exp_agent_status", "agent_id", "status"),
    )


class ToolCallStat(Base):
    """Aggregated per-tool call statistics for failure pattern detection."""
    __tablename__ = "tool_call_stats"

    id               = Column(String(36),  primary_key=True)
    tool_name        = Column(String(120), nullable=False)
    agent_id         = Column(String(36),  nullable=True, index=True)
    tenant_id        = Column(String(36),  nullable=True, index=True)
    window_date      = Column(String(10),  nullable=False)
    call_count       = Column(Integer,     nullable=False, default=0)
    success_count    = Column(Integer,     nullable=False, default=0)
    error_count      = Column(Integer,     nullable=False, default=0)
    timeout_count    = Column(Integer,     nullable=False, default=0)
    total_latency_ms = Column(Integer,     nullable=False, default=0)
    created_at       = Column(DateTime,    default=datetime.utcnow)
    updated_at       = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        Index("ix_tool_stats_tool_date",  "tool_name", "window_date"),
        Index("ix_tool_stats_agent_date", "agent_id",  "window_date"),
    )
