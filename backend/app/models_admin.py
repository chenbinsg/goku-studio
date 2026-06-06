"""
models_admin.py — Admin domain ORM models.

Owner: 智能体技术 (Goku Core team)
Tables: users, tenants, departments, teams, roles, org, auth, SSO,
        system config, billing, notifications, push, external API keys.

These tables belong to the platform layer. Studio and Core read them
for auth/tenancy context but never write them directly.
"""
from datetime import datetime
from sqlalchemy import (
    Column, Integer, String, DateTime, Text, Float, Boolean,
    ForeignKey, JSON, Enum, Index, UniqueConstraint,
)
from sqlalchemy.orm import relationship
from app.db import Base
import enum


# ── Enums ─────────────────────────────────────────────────────────────────────

class SSOProtocol(str, enum.Enum):
    OIDC = "oidc"
    LDAP = "ldap"
    SAML = "saml"


class SSOMappingType(str, enum.Enum):
    DEPARTMENT = "department"
    TEAM       = "team"
    ROLE       = "role"


# ── Org structure ─────────────────────────────────────────────────────────────

class UserDepartment(Base):
    """Many-to-many mapping: one user can belong to multiple departments."""
    __tablename__ = "user_departments"

    user_id    = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    department = Column(String(100), primary_key=True)


class Tenant(Base):
    __tablename__ = "tenants"

    id                         = Column(String(36),  primary_key=True)
    name                       = Column(String(200), nullable=False)
    admin_email                = Column(String(200), nullable=False)
    api_key                    = Column(String(255), unique=True, nullable=False)
    quota_cpu                  = Column(Float,       default=4.0)
    quota_memory               = Column(Float,       default=8.0)
    quota_tokens_per_day       = Column(Integer,     default=1000000)
    quota_max_concurrent_tasks = Column(Integer,     default=10)
    settings                   = Column(JSON,        default=dict)
    created_at                 = Column(DateTime,    default=datetime.utcnow)

    users = relationship("User", back_populates="tenant")


class Department(Base):
    """Canonical department master data — admins pre-define names here."""
    __tablename__ = "departments"

    id          = Column(String(36),  primary_key=True)
    name        = Column(String(100), nullable=False)
    description = Column(String(500), nullable=True)
    tenant_id   = Column(String(36),  ForeignKey("tenants.id", ondelete="SET NULL"), nullable=True)
    created_at  = Column(DateTime,    default=datetime.utcnow)
    updated_at  = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("name", "tenant_id", name="uq_department_name_tenant"),
    )

    teams = relationship("Team", back_populates="department_obj", cascade="all, delete-orphan")


class Team(Base):
    """Third-level org unit: Tenant → Department → Team → User."""
    __tablename__ = "teams"

    id            = Column(String(36),  primary_key=True)
    tenant_id     = Column(String(36),  ForeignKey("tenants.id",     ondelete="SET NULL"), nullable=True, index=True)
    department_id = Column(String(36),  ForeignKey("departments.id", ondelete="SET NULL"), nullable=True, index=True)
    name          = Column(String(128), nullable=False)
    slug          = Column(String(64),  nullable=False)
    description   = Column(Text,        nullable=True)
    is_active     = Column(Boolean,     nullable=False, default=True)
    created_at    = Column(DateTime,    default=datetime.utcnow)
    updated_at    = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("tenant_id", "slug", name="uq_team_slug_tenant"),
    )

    department_obj = relationship("Department", back_populates="teams")
    members        = relationship("User", back_populates="team", foreign_keys="User.team_id")


class User(Base):
    __tablename__ = "users"

    id              = Column(String(36),  primary_key=True)
    username        = Column(String(100), unique=True, nullable=False)
    email           = Column(String(200), unique=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    is_active       = Column(Boolean,     default=True)
    is_superuser    = Column(Boolean,     default=False)
    mfa_secret      = Column(String(100), nullable=True)
    mfa_backup_codes = Column(JSON,       nullable=True)
    tenant_id       = Column(String(36),  ForeignKey("tenants.id"), nullable=True)
    department      = Column(String(100), nullable=True)   # kept for backward compat
    team_id         = Column(String(36),  ForeignKey("teams.id", ondelete="SET NULL"), nullable=True, index=True)
    full_name       = Column(String(200), nullable=True)
    mobile          = Column(String(32),  nullable=True)
    employee_id     = Column(String(64),  nullable=True, index=True)
    sso_config_id   = Column(String(36),  ForeignKey("sso_configurations.id", ondelete="SET NULL"), nullable=True)
    unicall_prefs   = Column(JSON,        nullable=True)
    created_at      = Column(DateTime,    default=datetime.utcnow)
    updated_at      = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)

    tenant           = relationship("Tenant",           back_populates="users")
    tasks            = relationship("Task",             back_populates="user")
    team             = relationship("Team",             back_populates="members", foreign_keys=[team_id])
    user_departments = relationship("UserDepartment",   cascade="all, delete-orphan", foreign_keys="UserDepartment.user_id")
    agent_favorites  = relationship("UserAgentFavorite", back_populates="user", cascade="all, delete-orphan")


class Role(Base):
    __tablename__ = "roles"

    id          = Column(String(36),  primary_key=True)
    name        = Column(String(100), unique=True, nullable=False)
    permissions = Column(JSON,        default=list)
    max_level   = Column(Integer,     default=0)
    tools       = Column(JSON,        default=list)
    created_at  = Column(DateTime,    default=datetime.utcnow)


class UserRole(Base):
    __tablename__ = "user_roles"

    id        = Column(String(36), primary_key=True)
    user_id   = Column(String(36), nullable=False)
    role_id   = Column(String(36), nullable=False)
    tenant_id = Column(String(36), nullable=True)
    created_at = Column(DateTime,  default=datetime.utcnow)


# ── Auth ──────────────────────────────────────────────────────────────────────

class TokenBlacklist(Base):
    """Revoked JWT tokens. Checked on every authenticated request."""
    __tablename__ = "token_blacklist"

    id         = Column(String(36), primary_key=True)
    jti        = Column(String(64), unique=True, nullable=False, index=True)
    user_id    = Column(String(36), ForeignKey("users.id"), nullable=True)
    expires_at = Column(DateTime,   nullable=False)
    revoked_at = Column(DateTime,   default=datetime.utcnow)


# ── SSO ───────────────────────────────────────────────────────────────────────

class SSOConfiguration(Base):
    """Enterprise SSO provider configuration (OIDC / LDAP / SAML)."""
    __tablename__ = "sso_configurations"

    id           = Column(String(36),  primary_key=True)
    tenant_id    = Column(String(36),  ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    name         = Column(String(128), nullable=False)
    protocol     = Column(Enum(SSOProtocol, values_callable=lambda e: [x.value for x in e]), nullable=False)
    is_enabled   = Column(Boolean,     nullable=False, default=True)
    discovery_url       = Column(String(500), nullable=True)
    client_id           = Column(String(256), nullable=True)
    client_secret       = Column(String(512), nullable=True)
    scope               = Column(String(256), nullable=True, default="openid profile email")
    groups_claim        = Column(String(64),  nullable=True, default="groups")
    ldap_url            = Column(String(300), nullable=True)
    ldap_bind_dn        = Column(String(300), nullable=True)
    ldap_bind_password  = Column(String(512), nullable=True)
    ldap_user_base      = Column(String(300), nullable=True)
    ldap_user_filter    = Column(String(300), nullable=True, default="(mail={email})")
    ldap_group_attribute = Column(String(64), nullable=True, default="memberOf")
    created_at  = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at  = Column(DateTime, nullable=True,  onupdate=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("tenant_id", "name", name="uq_sso_config_tenant_name"),
    )

    group_mappings = relationship("SSOGroupMapping", back_populates="sso_config", cascade="all, delete-orphan")


class SSOGroupMapping(Base):
    """Maps an SSO groups-claim value to an AIOS department, team, or role."""
    __tablename__ = "sso_group_mappings"

    id            = Column(String(36),  primary_key=True)
    tenant_id     = Column(String(36),  ForeignKey("tenants.id",           ondelete="CASCADE"), nullable=False, index=True)
    sso_config_id = Column(String(36),  ForeignKey("sso_configurations.id", ondelete="CASCADE"), nullable=False, index=True)
    sso_group     = Column(String(256), nullable=False)
    mapping_type  = Column(Enum(SSOMappingType, values_callable=lambda e: [x.value for x in e]), nullable=False)
    department_id = Column(String(36),  ForeignKey("departments.id", ondelete="SET NULL"), nullable=True)
    team_id       = Column(String(36),  ForeignKey("teams.id",       ondelete="SET NULL"), nullable=True)
    role_value    = Column(String(64),  nullable=True)
    created_at    = Column(DateTime, nullable=False, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("sso_config_id", "sso_group", name="uq_sso_group_config"),
    )

    sso_config  = relationship("SSOConfiguration", back_populates="group_mappings")
    department  = relationship("Department")
    team        = relationship("Team")


# ── System config & billing ───────────────────────────────────────────────────

class SystemConfig(Base):
    __tablename__ = "system_configs"

    id         = Column(String(36), primary_key=True)
    key        = Column(String(100), unique=True, nullable=False)
    value      = Column(JSON,        nullable=False)
    updated_at = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)


class TenantBillingQuota(Base):
    """Per-tenant monthly token quota and overage policy."""
    __tablename__ = "tenant_billing_quotas"

    id                  = Column(String(36),   primary_key=True)
    tenant_id           = Column(String(36),   nullable=False, unique=True, index=True)
    monthly_token_limit = Column(Integer,      nullable=True)
    alert_threshold_pct = Column(Integer,      default=80)
    throttle_on_exceed  = Column(Boolean,      default=False)
    router_tenant_id    = Column(String(128),  nullable=True)
    created_at          = Column(DateTime,     default=datetime.utcnow)
    updated_at          = Column(DateTime,     default=datetime.utcnow, onupdate=datetime.utcnow)


class AlertRule(Base):
    __tablename__ = "alert_rules"

    id         = Column(String(36),  primary_key=True)
    name       = Column(String(200), nullable=False)
    metric     = Column(String(100), nullable=False)
    condition  = Column(String(50),  nullable=False)
    threshold  = Column(Float,       nullable=False)
    channels   = Column(JSON,        default=list)
    status     = Column(String(50),  default="active")
    created_at = Column(DateTime,    default=datetime.utcnow)


# ── Notifications & push ──────────────────────────────────────────────────────

class Notification(Base):
    __tablename__ = "notifications"

    id         = Column(String(36),  primary_key=True)
    user_id    = Column(String(36),  ForeignKey("users.id"), nullable=False, index=True)
    sender_id  = Column(String(36),  nullable=True)
    title      = Column(String(200), nullable=False)
    content    = Column(Text,        nullable=False)
    is_read    = Column(Boolean,     default=False)
    created_at = Column(DateTime,    default=datetime.utcnow)


class NotificationDelivery(Base):
    """Per-channel delivery audit for a notification or UniCall outbound card."""
    __tablename__ = "notification_deliveries"

    id                  = Column(String(36),  primary_key=True)
    tenant_id           = Column(String(36),  ForeignKey("tenants.id"), nullable=True, index=True)
    user_id             = Column(String(36),  ForeignKey("users.id"),   nullable=False, index=True)
    notification_id     = Column(String(36),  ForeignKey("notifications.id"), nullable=True, index=True)
    channel             = Column(String(50),  nullable=False, index=True)
    priority            = Column(String(20),  nullable=False, default="normal", server_default="normal")
    title               = Column(String(255), nullable=False)
    body                = Column(Text,        nullable=True)
    payload             = Column(JSON,        nullable=True)
    status              = Column(String(20),  nullable=False, default="queued", server_default="queued")
    retry_count         = Column(Integer,     nullable=False, default=0, server_default="0")
    provider_message_id = Column(String(255), nullable=True)
    error               = Column(Text,        nullable=True)
    created_at          = Column(DateTime,    default=datetime.utcnow)
    sent_at             = Column(DateTime,    nullable=True)

    __table_args__ = (
        Index("ix_notification_deliveries_tenant_created", "tenant_id", "created_at"),
        Index("ix_notification_deliveries_user_status",    "user_id",   "status"),
    )


class PushSubscription(Base):
    """Web Push (VAPID) subscriptions for PWA push notifications."""
    __tablename__ = "push_subscriptions"

    id                = Column(String(36),  primary_key=True)
    user_id           = Column(String(36),  ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    tenant_id         = Column(String(36),  ForeignKey("tenants.id"), nullable=True, index=True)
    endpoint          = Column(String(500), nullable=False, unique=True)
    subscription_json = Column(JSON,        nullable=False)
    user_agent        = Column(String(300), nullable=True)
    created_at        = Column(DateTime,    default=datetime.utcnow)
    last_push_at      = Column(DateTime,    nullable=True)
    is_active         = Column(Boolean,     default=True, nullable=False)


# ── External API keys ─────────────────────────────────────────────────────────

class ExternalApiKey(Base):
    """API keys issued to external applications for Agent access."""
    __tablename__ = "external_api_keys"

    id            = Column(String(36),  primary_key=True)
    tenant_id     = Column(String(36),  ForeignKey("tenants.id"), nullable=True, index=True)
    created_by    = Column(String(36),  ForeignKey("users.id"),   nullable=True)
    name          = Column(String(200), nullable=False)
    key_prefix    = Column(String(8),   nullable=False, index=True)
    key_hash      = Column(String(64),  nullable=False, unique=True)
    qps_limit     = Column(Integer,     default=10)
    monthly_quota = Column(Integer,     default=100000)
    tokens_used   = Column(Integer,     default=0)
    requests_used = Column(Integer,     default=0)
    webhook_url   = Column(String(500), nullable=True)
    is_active     = Column(Boolean,     default=True, nullable=False)
    expires_at    = Column(DateTime,    nullable=True)
    last_used_at  = Column(DateTime,    nullable=True)
    created_at    = Column(DateTime,    default=datetime.utcnow)
    updated_at    = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)


class ExternalTool(Base):
    """Webhook-backed tools registered by external apps via the SDK."""
    __tablename__ = "external_tools"

    id          = Column(String(36),  primary_key=True)
    tenant_id   = Column(String(36),  ForeignKey("tenants.id"), nullable=True, index=True)
    api_key_id  = Column(String(36),  ForeignKey("external_api_keys.id", ondelete="CASCADE"), nullable=False, index=True)
    name        = Column(String(100), nullable=False)
    description = Column(Text,        nullable=False)
    parameters  = Column(JSON,        nullable=False)
    handler_url = Column(String(500), nullable=False)
    is_active   = Column(Boolean,     default=True, nullable=False)
    created_at  = Column(DateTime,    default=datetime.utcnow)
    updated_at  = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("api_key_id", "name", name="uq_external_tool_key_name"),
    )


# ── Heartbeat scheduler ───────────────────────────────────────────────────────

class Heartbeat(Base):
    """Proactive scheduling — agent tasks that run automatically on a cron schedule."""
    __tablename__ = "heartbeats"

    id                   = Column(String(36),  primary_key=True)
    name                 = Column(String(200), nullable=False)
    description          = Column(Text,        nullable=True)
    cron_expression      = Column(String(100), nullable=False)
    prompt               = Column(Text,        nullable=False)
    context              = Column(JSON,        default=dict)
    enabled              = Column(Boolean,     default=True)
    user_id              = Column(String(36),  ForeignKey("users.id"), nullable=True)
    tenant_id            = Column(String(36),  nullable=True)
    last_run_at          = Column(DateTime,    nullable=True)
    next_run_at          = Column(DateTime,    nullable=True)
    last_status          = Column(String(50),  nullable=True)
    run_count            = Column(Integer,     default=0)
    consecutive_failures = Column(Integer,     default=0, nullable=False)
    last_error           = Column(Text,        nullable=True)
    cron_error           = Column(Text,        nullable=True)
    workflow_id          = Column(String(36),  nullable=True)
    created_at           = Column(DateTime,    default=datetime.utcnow)
    updated_at           = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)


# ── Audit log ─────────────────────────────────────────────────────────────────

class AuditLog(Base):
    __tablename__ = "audit_logs"

    id            = Column(String(36),  primary_key=True)
    user_id       = Column(String(36),  ForeignKey("users.id"),    nullable=True)
    tenant_id     = Column(String(36),  ForeignKey("tenants.id"),  nullable=True, index=True)
    action        = Column(String(100), nullable=False)
    resource_type = Column(String(100), nullable=False)
    resource_id   = Column(String(36),  nullable=True)
    details       = Column(JSON,        nullable=True)
    trace_id      = Column(String(100), nullable=True, index=True)
    ip_address    = Column(String(50),  nullable=True)
    user_agent    = Column(String(500), nullable=True)
    created_at    = Column(DateTime,    default=datetime.utcnow)

    __table_args__ = (
        Index("ix_audit_logs_user_created",     "user_id",   "created_at"),
        Index("ix_audit_logs_action_resource",  "action",    "resource_type", "created_at"),
    )
