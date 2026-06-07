"""
models_core.py — Core runtime ORM models.

Owner: 智能体技术 (Goku Core team)
Tables: tasks, task_steps, conversations, conversation_messages, approvals,
        memory, stateful (reimbursement/procurement/contract/incident/policy/transition),
        agent_sessions, cost_ledger, reactions.

Cross-domain FK note:
  - tasks.agent_id        → agent_definitions.id   (Studio-owned)
  - conversations.agent_id → agent_definitions.id  (Studio-owned)
  - improvement_proposals.task_id → tasks.id       (Core-owned)
  The MySQL FK constraints are real; SQLAlchemy relationship() to Studio models
  is intentionally absent here — load AgentDefinition via a separate query in
  the Studio model file when needed.
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

class TaskStatus(str, enum.Enum):
    PENDING          = "pending"
    PLANNING         = "planning"
    EXECUTING        = "executing"
    COMPLETED        = "completed"
    FAILED           = "failed"
    CANCELLED        = "cancelled"
    RETRYING         = "retrying"
    WAITING_FOR_INPUT = "waiting_for_input"


class ApprovalStatus(str, enum.Enum):
    PENDING  = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


class MemoryType(str, enum.Enum):
    SHORT = "short"
    LONG  = "long"


# ── Tasks ─────────────────────────────────────────────────────────────────────

class Task(Base):
    __tablename__ = "tasks"

    id              = Column(String(36),  primary_key=True)
    request_id      = Column(String(36),  unique=True, nullable=True)
    user_id         = Column(String(36),  ForeignKey("users.id"), nullable=False)
    tenant_id       = Column(String(36),  ForeignKey("tenants.id"), nullable=True, index=True)
    prompt          = Column(Text,        nullable=False)
    context         = Column(JSON,        default=dict)
    status          = Column(Enum(TaskStatus, values_callable=lambda x: [e.value for e in x]), default=TaskStatus.PENDING)
    priority        = Column(Integer,     default=5)
    timeout         = Column(Integer,     default=300)
    max_retry       = Column(Integer,     default=0)
    retry_count     = Column(Integer,     default=0)
    result          = Column(JSON,        nullable=True)
    error_message   = Column(Text,        nullable=True)
    # Cross-domain FK: agent_definitions is Studio-owned. No relationship() here.
    agent_id        = Column(String(36),  ForeignKey("agent_definitions.id"), nullable=True)
    conversation_id = Column(String(36),  ForeignKey("conversations.id"), nullable=True, index=True)
    cancelled_at    = Column(DateTime,    nullable=True)
    cancelled_reason = Column(String(500), nullable=True)
    created_at      = Column(DateTime,    default=datetime.utcnow)
    updated_at      = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)
    started_at      = Column(DateTime,    nullable=True)
    completed_at    = Column(DateTime,    nullable=True)
    last_heartbeat  = Column(DateTime,    nullable=True, index=True)
    is_zombie       = Column(Boolean,     default=False, nullable=False)

    __table_args__ = (
        Index("ix_tasks_user_status_created", "user_id", "status", "created_at"),
        Index("ix_tasks_status_created",      "status",  "created_at"),
    )

    user         = relationship("User",         back_populates="tasks")
    conversation = relationship("Conversation", back_populates="tasks")
    steps        = relationship("TaskStep",     back_populates="task",
                                order_by="TaskStep.step_number", cascade="all, delete-orphan")


class TaskStep(Base):
    __tablename__ = "task_steps"

    id            = Column(String(36),  primary_key=True)
    task_id       = Column(String(36),  ForeignKey("tasks.id"), nullable=False)
    step_number   = Column(Integer,     nullable=False)
    action        = Column(String(100), nullable=False)
    input_data    = Column(JSON,        nullable=True)
    output_data   = Column(JSON,        nullable=True)
    status        = Column(String(50),  default="pending")
    started_at    = Column(DateTime,    nullable=True)
    completed_at  = Column(DateTime,    nullable=True)
    error_message = Column(Text,        nullable=True)

    __table_args__ = (
        Index("ix_task_steps_task_id_step", "task_id", "step_number"),
    )

    task = relationship("Task", back_populates="steps")


# ── Conversations ─────────────────────────────────────────────────────────────

class Conversation(Base):
    __tablename__ = "conversations"

    id             = Column(String(36),  primary_key=True)
    user_id        = Column(String(36),  ForeignKey("users.id"),    nullable=False)
    tenant_id      = Column(String(36),  ForeignKey("tenants.id"),  nullable=True)
    title          = Column(String(500), default="New conversation")
    thinking_level = Column(String(20),  default="medium")
    model_override = Column(String(100), nullable=True)
    # Cross-domain FK: agent_definitions is Studio-owned. No relationship() here.
    agent_id       = Column(String(36),  ForeignKey("agent_definitions.id"), nullable=True)
    created_at     = Column(DateTime,    default=datetime.utcnow)
    updated_at     = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)

    messages = relationship("ConversationMessage", back_populates="conversation",
                            order_by="ConversationMessage.created_at")
    tasks    = relationship("Task", back_populates="conversation",
                            order_by="Task.created_at")

    __table_args__ = (
        Index("ix_conversations_tenant_created", "tenant_id", "created_at"),
        Index("ix_conversations_user_created",   "user_id",   "created_at"),
        Index("ix_conversations_agent_created",  "agent_id",  "created_at"),
    )


class ConversationMessage(Base):
    __tablename__ = "conversation_messages"

    id              = Column(String(36),  primary_key=True)
    conversation_id = Column(String(36),  ForeignKey("conversations.id"), nullable=False)
    role            = Column(String(20),  nullable=False)
    content         = Column(Text,        nullable=True)
    tool_calls      = Column(JSON,        nullable=True)
    tool_results    = Column(JSON,        nullable=True)
    attachments     = Column(JSON,        nullable=True)
    token_count     = Column(Integer,     nullable=True)
    agent_id        = Column(String(36),  nullable=True)
    created_at      = Column(DateTime,    default=datetime.utcnow)

    conversation = relationship("Conversation", back_populates="messages")

    __table_args__ = (
        Index("ix_conv_messages_conv_created", "conversation_id", "created_at"),
    )


class AgentSession(Base):
    __tablename__ = "agent_sessions"

    id             = Column(String(36),  primary_key=True)
    parent_task_id = Column(String(36),  ForeignKey("tasks.id"), nullable=True, index=True)
    agent_type     = Column(String(50),  nullable=False)
    prompt_summary = Column(String(300), nullable=True)
    status         = Column(String(50),  default="running")
    result_summary = Column(Text,        nullable=True)
    steps_used     = Column(Integer,     default=0)
    started_at     = Column(DateTime,    default=datetime.utcnow)
    completed_at   = Column(DateTime,    nullable=True)
    caller_id      = Column(String(128), nullable=True, index=True)
    channel        = Column(String(50),  nullable=True)
    queued_at      = Column(DateTime,    nullable=True)
    answered_at    = Column(DateTime,    nullable=True)
    continuation_of = Column(String(36), ForeignKey("agent_sessions.id"), nullable=True)
    instance_slot  = Column(Integer,     nullable=True)


# ── Approvals ─────────────────────────────────────────────────────────────────

class Approval(Base):
    __tablename__ = "approvals"

    id               = Column(String(36),  primary_key=True)
    task_id          = Column(String(36),  nullable=True)
    requester_id     = Column(String(36),  nullable=True)
    tenant_id        = Column(String(36),  nullable=True)
    operation        = Column(String(200), nullable=False)
    risk_level       = Column(Integer,     nullable=False)
    description      = Column(Text,        nullable=False)
    status           = Column(Enum(ApprovalStatus), default=ApprovalStatus.PENDING)
    approver_id      = Column(String(36),  nullable=True)
    comment          = Column(String(500), nullable=True)
    executed_at      = Column(DateTime,    nullable=True)
    created_at       = Column(DateTime,    default=datetime.utcnow)
    escalation_level = Column(Integer,     default=0, server_default="0", nullable=False)
    escalation_count = Column(Integer,     default=0, server_default="0", nullable=False)

    __table_args__ = (
        Index("ix_approvals_task_status",             "task_id",   "status"),
        Index("ix_approvals_tenant_status_created",   "tenant_id", "status", "created_at"),
    )


# ── Memory ────────────────────────────────────────────────────────────────────

class Memory(Base):
    __tablename__ = "memories"

    id        = Column(String(36),  primary_key=True)
    type      = Column(Enum(MemoryType), nullable=False)
    content   = Column(Text,        nullable=False)
    vector_id = Column(String(100), nullable=True)
    tags      = Column(JSON,        default=list)
    ttl       = Column(Integer,     nullable=True)
    user_id   = Column(String(36),  nullable=True, index=True)
    tenant_id = Column(String(36),  nullable=True, index=True)
    created_at = Column(DateTime,   default=datetime.utcnow)

    __table_args__ = (
        Index("ix_memories_tenant_type_created", "tenant_id", "type", "created_at"),
        Index("ix_memories_user_created",        "user_id",   "created_at"),
    )


# ── Cost tracking ─────────────────────────────────────────────────────────────

class CostLedger(Base):
    __tablename__ = "cost_ledger"

    id             = Column(String(36),  primary_key=True)
    tenant_id      = Column(String(36),  ForeignKey("tenants.id"), nullable=True)
    task_id        = Column(String(36),  ForeignKey("tasks.id"),   nullable=True)
    agent_id       = Column(String(36),  nullable=True, index=True)
    step_number    = Column(Integer,     nullable=True)
    provider       = Column(String(50),  nullable=True)
    model          = Column(String(100), nullable=True)
    input_tokens   = Column(Integer,     default=0)
    output_tokens  = Column(Integer,     default=0)
    cost_estimate  = Column(Float,       default=0.0)
    source         = Column(String(20),  nullable=False, default="local", server_default="local")
    created_at     = Column(DateTime,    default=datetime.utcnow)

    __table_args__ = (
        Index("ix_cost_ledger_tenant_created", "tenant_id", "created_at"),
        Index("ix_cost_ledger_agent_created",  "agent_id",  "created_at"),
    )


# ── Stateful runtime ──────────────────────────────────────────────────────────

class StatefulActionPolicy(Base):
    __tablename__ = "stateful_action_policies"

    id                     = Column(String(36),  primary_key=True)
    tenant_id              = Column(String(36),  nullable=True, index=True)
    agent_id               = Column(String(36),  nullable=True, index=True)
    entity_kind            = Column(String(100), nullable=False)
    action_name            = Column(String(100), nullable=False)
    policy_mode            = Column(String(50),  nullable=False)
    allow_idempotent_retry = Column(Boolean,     nullable=False, default=False)
    reason                 = Column(String(500), nullable=True)
    created_by             = Column(String(36),  nullable=True)
    updated_by             = Column(String(36),  nullable=True)
    created_at             = Column(DateTime,    default=datetime.utcnow)
    updated_at             = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("tenant_id", "agent_id", "entity_kind", "action_name",
                         name="uq_stateful_action_policies_scope"),
    )


class StatefulTransition(Base):
    __tablename__ = "stateful_transitions"

    id                  = Column(String(36),  primary_key=True)
    task_id             = Column(String(36),  nullable=True, index=True)
    entity_kind         = Column(String(100), nullable=False)
    entity_id           = Column(String(255), nullable=False)
    previous_state      = Column(String(100), nullable=False)
    action_name         = Column(String(100), nullable=False)
    resulting_state     = Column(String(100), nullable=False)
    expected_next_state = Column(String(100), nullable=True)
    matched_expected    = Column(Boolean,     nullable=True)
    result_code         = Column(String(100), nullable=True)
    message             = Column(Text,        nullable=True)
    reason              = Column(Text,        nullable=True)
    policy_mode         = Column(String(50),  nullable=False, default="auto")
    actor_user_id       = Column(String(36),  nullable=True)
    actor_tenant_id     = Column(String(36),  nullable=True)
    stop_reason         = Column(String(100), nullable=True)
    needs_human_review  = Column(Boolean,     nullable=False, default=False)
    created_at          = Column(DateTime,    default=datetime.utcnow)

    __table_args__ = (
        Index("ix_stateful_transitions_entity", "entity_kind", "entity_id", "created_at"),
        Index("ix_stateful_transitions_task",   "task_id",     "created_at"),
    )


class Reimbursement(Base):
    __tablename__ = "reimbursements"

    id                 = Column(String(36),   primary_key=True)
    tenant_id          = Column(String(36),   nullable=True,  index=True)
    requester_id       = Column(String(36),   nullable=False, index=True)
    reviewer_id        = Column(String(36),   nullable=True)
    status             = Column(String(50),   nullable=False, default="draft")
    amount             = Column(Float,        nullable=False, default=0.0)
    currency           = Column(String(10),   nullable=False, default="JPY")
    description        = Column(String(500),  nullable=False, default="")
    receipts_attached  = Column(Boolean,      nullable=False, default=False)
    supplement_notes   = Column(Text,         nullable=True)
    payment_reference  = Column(String(200),  nullable=True)
    created_at         = Column(DateTime,     default=datetime.utcnow)
    updated_at         = Column(DateTime,     default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        Index("ix_reimbursements_tenant_status", "tenant_id", "status"),
        {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )


class ProcurementRequest(Base):
    __tablename__ = "procurement_requests"

    id             = Column(String(36),  primary_key=True)
    tenant_id      = Column(String(36),  nullable=True,  index=True)
    requester_id   = Column(String(36),  nullable=False, index=True)
    approver_id    = Column(String(36),  nullable=True)
    status         = Column(String(50),  nullable=False, default="draft")
    title          = Column(String(500), nullable=False, default="")
    amount         = Column(Float,       nullable=False, default=0.0)
    currency       = Column(String(10),  nullable=False, default="JPY")
    po_number      = Column(String(200), nullable=True)
    revision_notes = Column(Text,        nullable=True)
    created_at     = Column(DateTime,    default=datetime.utcnow)
    updated_at     = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        Index("ix_procurement_requests_tenant_status", "tenant_id", "status"),
        {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )


class ContractReview(Base):
    __tablename__ = "contract_reviews"

    id              = Column(String(36),  primary_key=True)
    tenant_id       = Column(String(36),  nullable=True,  index=True)
    requester_id    = Column(String(36),  nullable=False, index=True)
    reviewer_id     = Column(String(36),  nullable=True)
    status          = Column(String(50),  nullable=False, default="draft")
    title           = Column(String(500), nullable=False, default="")
    counterparty    = Column(String(500), nullable=False, default="")
    contract_value  = Column(Float,       nullable=False, default=0.0)
    currency        = Column(String(10),  nullable=False, default="JPY")
    change_notes    = Column(Text,        nullable=True)
    signed_at       = Column(DateTime,    nullable=True)
    created_at      = Column(DateTime,    default=datetime.utcnow)
    updated_at      = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        Index("ix_contract_reviews_tenant_status", "tenant_id", "status"),
        {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )


class Incident(Base):
    __tablename__ = "incidents"

    id                = Column(String(36),  primary_key=True)
    tenant_id         = Column(String(36),  nullable=True,  index=True)
    reported_by       = Column(String(36),  nullable=False, index=True)
    assignee_id       = Column(String(36),  nullable=True)
    status            = Column(String(50),  nullable=False, default="open")
    title             = Column(String(500), nullable=False, default="")
    severity          = Column(String(50),  nullable=False, default="medium")
    resolution_notes  = Column(Text,        nullable=True)
    escalation_reason = Column(Text,        nullable=True)
    created_at        = Column(DateTime,    default=datetime.utcnow)
    updated_at        = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        Index("ix_incidents_tenant_status", "tenant_id", "status"),
        {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )


# ── Message reactions ─────────────────────────────────────────────────────────

REACTION_SENTIMENT: dict[str, str] = {
    "dianzan":         "positive",
    "fengshen":        "positive",
    "xianshangpantao": "positive",
    "kandebuxiaqu":    "negative",
    "wodetian":        "neutral",
    "xiaodaoerming":   "neutral",
}


class MessageReaction(Base):
    __tablename__ = "message_reactions"

    id         = Column(String(36),  primary_key=True)
    message_id = Column(String(36),  ForeignKey("conversation_messages.id", ondelete="CASCADE"), nullable=False, index=True)
    task_id    = Column(String(36),  ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True, index=True)
    user_id    = Column(String(36),  ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    tenant_id  = Column(String(36),  nullable=True, index=True)
    emoji_id   = Column(String(50),  nullable=False)
    sentiment  = Column(String(10),  nullable=False, default="neutral")
    created_at = Column(DateTime,    default=datetime.utcnow)

    __table_args__ = (
        Index("ix_msg_reactions_msg_user", "message_id", "user_id"),
        Index("ix_msg_reactions_task",     "task_id"),
    )
