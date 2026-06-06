"""
models_channels.py — Channels / integrations ORM models.

Owner: 智能体技术 (Goku Core team)
Tables: channel_accounts, channel_messages, channel_actions, channel_bind_codes,
        incoming_email, email_archive, CS (customer service), shareholder/market
        intelligence, push subscriptions (shared with admin).

These models underpin the UniCall unified messaging layer and all inbound
channel integrations. They are read/written only by routers/channels/ and
the UniCall service — never by Studio routers.
"""
from datetime import datetime
from sqlalchemy import (
    Column, Integer, String, DateTime, Text, Float, Boolean,
    ForeignKey, JSON, Enum, Index, UniqueConstraint,
)
from app.db import Base
import enum


# ── Incoming email ────────────────────────────────────────────────────────────

class IncomingEmailStatus(str, enum.Enum):
    NEW         = "new"
    PROCESSING  = "processing"
    DRAFT_READY = "draft_ready"
    SENT        = "sent"
    REJECTED    = "rejected"
    ERROR       = "error"


class IncomingEmail(Base):
    __tablename__ = "incoming_emails"

    id               = Column(String(36),   primary_key=True)
    source_type      = Column(String(50),   nullable=False, server_default="email", index=True)
    source_metadata  = Column(JSON,         nullable=True)
    message_id       = Column(String(200),  nullable=True)
    recipient_to     = Column(String(200),  nullable=True, index=True)
    sender_from      = Column(String(200),  nullable=True)
    sender_name      = Column(String(200),  nullable=True)
    subject          = Column(String(1000), nullable=True)
    body_text        = Column(Text,         nullable=True)
    body_html        = Column(Text,         nullable=True)
    received_at      = Column(DateTime,     nullable=True)
    assigned_agent   = Column(String(100),  nullable=True, index=True)
    status           = Column(
        Enum(IncomingEmailStatus, values_callable=lambda x: [e.value for e in x]),
        default=IncomingEmailStatus.NEW,
    )
    draft_subject    = Column(String(1000), nullable=True)
    draft_body       = Column(Text,         nullable=True)
    draft_summary    = Column(String(500),  nullable=True)
    approval_id      = Column(String(36),   ForeignKey("approvals.id"), nullable=True)
    thread_id        = Column(String(200),  nullable=True)
    resolved_at      = Column(DateTime,     nullable=True)
    sent_at          = Column(DateTime,     nullable=True)
    error_message    = Column(Text,         nullable=True)
    tenant_id        = Column(String(36),   nullable=True, index=True)
    created_at       = Column(DateTime,     default=datetime.utcnow)
    updated_at       = Column(DateTime,     default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        Index("ix_incoming_emails_queue", "assigned_agent", "status", "received_at"),
        Index("ix_incoming_emails_dedup", "message_id",     "tenant_id"),
    )


class EmailArchive(Base):
    __tablename__ = "email_archive"

    id             = Column(String(36),   primary_key=True)
    assigned_agent = Column(String(100),  nullable=True, index=True)
    sender_from    = Column(String(200),  nullable=True)
    subject        = Column(String(1000), nullable=True)
    status         = Column(String(20),   nullable=True)
    approval_id    = Column(String(36),   nullable=True)
    received_at    = Column(DateTime,     nullable=True)
    resolved_at    = Column(DateTime,     nullable=True)
    draft_summary  = Column(String(500),  nullable=True)
    tenant_id      = Column(String(36),   nullable=True, index=True)
    archived_at    = Column(DateTime,     default=datetime.utcnow)


# ── UniCall channel accounts & messages ───────────────────────────────────────

class ChannelAccount(Base):
    """External channel identity bound to an AIOS user."""
    __tablename__ = "channel_accounts"

    id                    = Column(String(36),  primary_key=True)
    tenant_id             = Column(String(36),  ForeignKey("tenants.id"), nullable=True, index=True)
    user_id               = Column(String(36),  ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    channel               = Column(String(50),  nullable=False)
    external_user_id      = Column(String(255), nullable=False)
    external_display_name = Column(String(255), nullable=True)
    status                = Column(String(20),  nullable=False, default="active", server_default="active")
    bound_at              = Column(DateTime,    default=datetime.utcnow)
    last_seen_at          = Column(DateTime,    nullable=True)
    metadata_json         = Column("metadata",  JSON, nullable=True)

    __table_args__ = (
        UniqueConstraint("channel", "external_user_id", name="uq_channel_account_external"),
        UniqueConstraint("tenant_id", "user_id", "channel", "external_user_id", name="uq_channel_account_user_external"),
        Index("ix_channel_accounts_user_channel", "user_id", "channel"),
    )


class ChannelMessage(Base):
    """Unified inbound/outbound message log for UniCall channels."""
    __tablename__ = "channel_messages"

    id                  = Column(String(36),  primary_key=True)
    tenant_id           = Column(String(36),  ForeignKey("tenants.id"),      nullable=True, index=True)
    channel             = Column(String(50),  nullable=False, index=True)
    direction           = Column(String(20),  nullable=False)
    external_message_id = Column(String(255), nullable=True, index=True)
    user_id             = Column(String(36),  ForeignKey("users.id"),         nullable=True, index=True)
    conversation_id     = Column(String(36),  ForeignKey("conversations.id"), nullable=True, index=True)
    task_id             = Column(String(36),  ForeignKey("tasks.id"),         nullable=True, index=True)
    message_type        = Column(String(50),  nullable=False, default="text")
    payload             = Column(JSON,        nullable=True)
    raw_payload         = Column(JSON,        nullable=True)
    status              = Column(String(20),  nullable=False, default="received", server_default="received")
    error               = Column(Text,        nullable=True)
    created_at          = Column(DateTime,    default=datetime.utcnow, index=True)

    __table_args__ = (
        Index("ix_channel_messages_tenant_created",          "tenant_id", "created_at"),
        Index("ix_channel_messages_channel_status_created",  "channel",   "status", "created_at"),
    )


class ChannelAction(Base):
    """Idempotent user action triggered from a mobile/channel card."""
    __tablename__ = "channel_actions"

    id              = Column(String(36),  primary_key=True)
    tenant_id       = Column(String(36),  ForeignKey("tenants.id"), nullable=True, index=True)
    user_id         = Column(String(36),  ForeignKey("users.id"),   nullable=False, index=True)
    channel         = Column(String(50),  nullable=False, index=True)
    action_type     = Column(String(50),  nullable=False)
    target_type     = Column(String(50),  nullable=False)
    target_id       = Column(String(255), nullable=False)
    payload         = Column(JSON,        nullable=True)
    idempotency_key = Column(String(255), nullable=False, unique=True)
    status          = Column(String(20),  nullable=False, default="pending", server_default="pending")
    error           = Column(Text,        nullable=True)
    created_at      = Column(DateTime,    default=datetime.utcnow)
    completed_at    = Column(DateTime,    nullable=True)

    __table_args__ = (
        Index("ix_channel_actions_tenant_created", "tenant_id", "created_at"),
        Index("ix_channel_actions_target",         "target_type", "target_id"),
    )


class ChannelBindCode(Base):
    """Short-lived one-time code for linking a channel account to an AIOS user."""
    __tablename__ = "channel_bind_codes"

    code         = Column(String(16),  primary_key=True)
    user_id      = Column(String(36),  ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    tenant_id    = Column(String(36),  nullable=True)
    channel_hint = Column(String(50),  nullable=True)
    expires_at   = Column(DateTime,    nullable=False)
    used_at      = Column(DateTime,    nullable=True)
    created_at   = Column(DateTime,    default=datetime.utcnow, nullable=False)


# ── Customer service (CS) ─────────────────────────────────────────────────────

class CsCustomer(Base):
    __tablename__ = "cs_customers"

    id               = Column(String(36),  primary_key=True)
    customer_no      = Column(String(32),  unique=True, nullable=False, index=True)
    name             = Column(String(100), nullable=False)
    email            = Column(String(254), unique=True, nullable=False, index=True)
    phone            = Column(String(32),  nullable=True, index=True)
    status           = Column(String(20),  nullable=False, default="active")
    membership_level = Column(String(20),  nullable=False, default="standard")
    notes_internal   = Column(Text,        nullable=True)
    registered_at    = Column(DateTime,    nullable=False, default=datetime.utcnow)
    updated_at       = Column(DateTime,    nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)


class CsOrder(Base):
    __tablename__ = "cs_orders"

    id               = Column(String(36),  primary_key=True)
    order_no         = Column(String(32),  unique=True, nullable=False, index=True)
    customer_id      = Column(String(36),  ForeignKey("cs_customers.id"), nullable=False, index=True)
    status           = Column(String(20),  nullable=False, default="paid")
    items            = Column(JSON,        nullable=False, default=list)
    total_amount     = Column(Float,       nullable=False, default=0.0)
    currency         = Column(String(8),   nullable=False, default="JPY")
    payment_method   = Column(String(50),  nullable=True)
    payment_status   = Column(String(20),  nullable=False, default="paid")
    shipping_address = Column(JSON,        nullable=True)
    tracking_no      = Column(String(100), nullable=True)
    notes_internal   = Column(Text,        nullable=True)
    created_at       = Column(DateTime,    nullable=False, default=datetime.utcnow)
    updated_at       = Column(DateTime,    nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)


class CsRefundRequest(Base):
    __tablename__ = "cs_refund_requests"

    id              = Column(String(36),  primary_key=True)
    refund_no       = Column(String(32),  unique=True, nullable=False, index=True)
    order_id        = Column(String(36),  ForeignKey("cs_orders.id"),    nullable=False, index=True)
    customer_id     = Column(String(36),  ForeignKey("cs_customers.id"), nullable=False, index=True)
    ticket_id       = Column(String(50),  nullable=True, index=True)
    amount          = Column(Float,       nullable=False)
    currency        = Column(String(8),   nullable=False, default="JPY")
    reason          = Column(String(500), nullable=False)
    status          = Column(String(20),  nullable=False, default="pending")
    processor_notes = Column(Text,        nullable=True)
    created_at      = Column(DateTime,    nullable=False, default=datetime.utcnow)
    processed_at    = Column(DateTime,    nullable=True)


class CsVerificationCode(Base):
    __tablename__ = "cs_verification_codes"

    id         = Column(String(36), primary_key=True)
    email      = Column(String(254), nullable=False, index=True)
    code       = Column(String(6),   nullable=False)
    attempts   = Column(Integer,     nullable=False, default=0)
    sent_at    = Column(DateTime,    nullable=False)
    expires_at = Column(DateTime,    nullable=False)
    used       = Column(Boolean,     nullable=False, default=False)


# ── Shareholder & market intelligence ────────────────────────────────────────

class ShareholderPost(Base):
    __tablename__ = "shareholder_posts"

    id                   = Column(String(36),  primary_key=True)
    source               = Column(String(100), nullable=False, index=True)
    ticker               = Column(String(20),  nullable=False, index=True)
    post_id              = Column(String(255), nullable=False, index=True)
    author               = Column(String(200), nullable=True)
    posted_at            = Column(DateTime,    nullable=True, index=True)
    url                  = Column(Text,        nullable=True)
    raw_text             = Column(Text,        nullable=False)
    clean_text           = Column(Text,        nullable=True)
    detected_language    = Column(String(20),  nullable=True)
    engagement_signals   = Column(JSON,        nullable=True)
    related_event_hint   = Column(String(200), nullable=True)
    dedupe_hash          = Column(String(64),  nullable=True, index=True)
    captured_at          = Column(DateTime,    default=datetime.utcnow, index=True)
    created_at           = Column(DateTime,    default=datetime.utcnow)
    updated_at           = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)


class ShareholderPostAnalysis(Base):
    __tablename__ = "shareholder_post_analysis"

    id                   = Column(String(36),  primary_key=True)
    post_id              = Column(String(36),  ForeignKey("shareholder_posts.id"), nullable=False, index=True)
    topic_tags           = Column(JSON,        default=list)
    sentiment            = Column(String(50),  nullable=True, index=True)
    confidence           = Column(Float,       nullable=True)
    misunderstanding_flag = Column(Boolean,    default=False)
    risk_flag            = Column(Boolean,     default=False)
    summary              = Column(Text,        nullable=True)
    representative_quote = Column(Text,        nullable=True)
    analysis_version     = Column(String(50),  nullable=True)
    created_at           = Column(DateTime,    default=datetime.utcnow)
    updated_at           = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)


class IRShareholderReport(Base):
    __tablename__ = "ir_shareholder_reports"

    id           = Column(String(36),  primary_key=True)
    ticker       = Column(String(20),  nullable=False, index=True)
    report_type  = Column(String(50),  nullable=False, index=True)
    period_start = Column(DateTime,    nullable=True, index=True)
    period_end   = Column(DateTime,    nullable=True, index=True)
    title        = Column(String(300), nullable=False)
    summary      = Column(Text,        nullable=True)
    body_markdown = Column(Text,       nullable=True)
    body_html    = Column(Text,        nullable=True)
    status       = Column(String(50),  default="draft", index=True)
    sample_count = Column(Integer,     default=0)
    source_count = Column(Integer,     default=0)
    report_meta  = Column(JSON,        nullable=True)
    emailed_at   = Column(DateTime,    nullable=True)
    created_at   = Column(DateTime,    default=datetime.utcnow)
    updated_at   = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)


class MarketSourceItem(Base):
    __tablename__ = "market_source_items"

    id           = Column(String(36),  primary_key=True)
    source_name  = Column(String(100), nullable=False, index=True)
    source_type  = Column(String(50),  nullable=False, index=True)
    title        = Column(String(500), nullable=False)
    summary      = Column(Text,        nullable=True)
    content      = Column(Text,        nullable=True)
    url          = Column(Text,        nullable=True)
    published_at = Column(DateTime,    nullable=True, index=True)
    collected_at = Column(DateTime,    default=datetime.utcnow, index=True)
    language     = Column(String(20),  nullable=True)
    raw_hash     = Column(String(64),  nullable=True, index=True)
    topic_hint   = Column(String(200), nullable=True)
    query_term   = Column(String(200), nullable=True)
    created_at   = Column(DateTime,    default=datetime.utcnow)
    updated_at   = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)


class MarketItemAnalysis(Base):
    __tablename__ = "market_item_analysis"

    id                   = Column(String(36),  primary_key=True)
    source_item_id       = Column(String(36),  ForeignKey("market_source_items.id"), nullable=False, index=True)
    topic_tags           = Column(JSON,        default=list)
    importance_level     = Column(String(20),  nullable=True, index=True)
    business_relevance   = Column(Integer,     default=0)
    sales_relevance      = Column(Integer,     default=0)
    marketing_relevance  = Column(Integer,     default=0)
    management_relevance = Column(Integer,     default=0)
    opportunity_flag     = Column(Boolean,     default=False)
    risk_flag            = Column(Boolean,     default=False)
    ai_summary           = Column(Text,        nullable=True)
    analysis_version     = Column(String(50),  nullable=True)
    created_at           = Column(DateTime,    default=datetime.utcnow)
    updated_at           = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)


class MarketDailyReport(Base):
    __tablename__ = "market_daily_reports"

    id                   = Column(String(36),  primary_key=True)
    report_date          = Column(DateTime,    nullable=False, index=True)
    language             = Column(String(10),  nullable=False, default="ja", index=True)
    title                = Column(String(300), nullable=False)
    summary              = Column(Text,        nullable=True)
    markdown_path        = Column(Text,        nullable=True)
    source_count         = Column(Integer,     default=0)
    high_priority_count  = Column(Integer,     default=0)
    metadata_json        = Column(JSON,        nullable=True)
    emailed_at           = Column(DateTime,    nullable=True)
    created_at           = Column(DateTime,    default=datetime.utcnow)
    updated_at           = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)
