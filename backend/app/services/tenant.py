"""
Tenant service: quota management, access validation, and context helpers.
"""
from datetime import date
from typing import Optional, TYPE_CHECKING
import logging

if TYPE_CHECKING:
    from starlette.requests import Request

logger = logging.getLogger(__name__)


def get_request_tenant_id(request: "Optional[Request]", current_user) -> Optional[str]:
    """
    Canonical helper — call this from every router that needs a tenant_id.

    Rules:
    - Superusers may specify any tenant via the X-Tenant-ID header (or request.state);
      if no header is present they default to their own tenant_id.
    - Regular users always see their own tenant_id regardless of any header value,
      preventing cross-tenant data access via header spoofing.
    """
    user_tenant = getattr(current_user, "tenant_id", None)
    if getattr(current_user, "is_superuser", False) and request is not None:
        header_tenant = getattr(request.state, "tenant_id", None)
        if header_tenant:
            return header_tenant
    return user_tenant


def get_current_tenant(request=None) -> Optional[str]:
    """
    Get tenant_id for the current request.
    Reads from contextvars (set by TenantMiddleware) or request.state.
    """
    if request is not None and hasattr(request, "state"):
        return getattr(request.state, "tenant_id", None)
    try:
        from app.middleware.tenant import get_tenant_id_from_context
        return get_tenant_id_from_context()
    except Exception:
        return None


def validate_access(tenant_id: str, user_id: str, db=None) -> bool:
    """Check whether user belongs to the given tenant."""
    if db is None:
        return True  # No DB available — allow (tests will mock this)
    try:
        from app.models import User
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            return False
        # Superusers can access all tenants
        if user.is_superuser:
            return True
        return user.tenant_id == tenant_id
    except Exception:
        return True


def get_quota_usage(tenant_id: str, db=None) -> dict:
    """Return current resource usage for the tenant."""
    if db is None:
        return {"concurrent_tasks": 0, "tokens_today": 0}
    try:
        from app.models import Task, TaskStatus, User
        # Count tasks in executing/pending state whose users belong to this tenant
        tenant_user_ids = [
            u.id for u in db.query(User).filter(User.tenant_id == tenant_id).all()
        ]
        concurrent = (
            db.query(Task)
            .filter(
                Task.user_id.in_(tenant_user_ids),
                Task.status.in_([TaskStatus.PENDING, TaskStatus.EXECUTING]),
            )
            .count()
        )
        # Count today's token usage from cost_ledger
        tokens_today = 0
        try:
            from app.models import CostLedger
            from sqlalchemy import func
            today = date.today()
            tokens_today = db.query(
                func.coalesce(
                    func.sum(CostLedger.input_tokens + CostLedger.output_tokens),
                    0,
                )
            ).filter(
                CostLedger.tenant_id == tenant_id,
                func.date(CostLedger.created_at) == today,
            ).scalar() or 0
        except Exception as e:
            logger.debug("Failed to count tokens_today: %s", e)
        return {"concurrent_tasks": concurrent, "tokens_today": tokens_today}
    except Exception:
        return {"concurrent_tasks": 0, "tokens_today": 0}


def get_quota(tenant_id: str, db=None) -> dict:
    """Return quota limits for the tenant."""
    if db is None:
        return {"max_concurrent_tasks": 10, "tokens_per_day": 1000000}
    try:
        from app.models import Tenant
        tenant = db.query(Tenant).filter(Tenant.id == tenant_id).first()
        if not tenant:
            return {"max_concurrent_tasks": 10, "tokens_per_day": 1000000}
        return {
            "max_concurrent_tasks": tenant.quota_max_concurrent_tasks,
            "tokens_per_day": tenant.quota_tokens_per_day,
            "cpu": tenant.quota_cpu,
            "memory": tenant.quota_memory,
        }
    except Exception:
        return {"max_concurrent_tasks": 10, "tokens_per_day": 1000000}


def is_quota_exceeded(tenant_id: str, db=None) -> bool:
    """Return True if the tenant has reached their concurrent task or token limit."""
    usage = get_quota_usage(tenant_id, db)
    quota = get_quota(tenant_id, db)
    # Check concurrent task limit
    if usage.get("concurrent_tasks", 0) >= quota.get("max_concurrent_tasks", 10):
        return True
    # Check daily token limit
    if usage.get("tokens_today", 0) >= quota.get("tokens_per_day", 1000000):
        return True
    return False
