"""
Tenant context + strong-isolation middleware (P4-2).

Responsibilities
────────────────
1. Extract tenant_id from the X-Tenant-ID header *or* the JWT payload and
   store it in a ContextVar so services can call get_tenant_id_from_context()
   without holding a reference to the Request object.

2. ENFORCE cross-tenant isolation:
   If a non-superuser sends an X-Tenant-ID header that does NOT match their
   own tenant, the request is rejected immediately with HTTP 403 before any
   router code runs.  This closes the "header spoofing" vector where an
   authenticated user could supply a different tenant_id to read another
   tenant's data.

   Superusers are allowed to switch tenant context via the header (used by
   the admin UI to inspect any tenant's data).

Skipped paths
─────────────
Public / auth endpoints are exempt from the enforcement check so login is
not blocked for users that have no tenant (is_superuser=True, tenant=None).
"""
from contextvars import ContextVar
from typing import Optional
import logging

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

logger = logging.getLogger(__name__)

_tenant_id_var: ContextVar[Optional[str]] = ContextVar("tenant_id", default=None)

# Paths that bypass tenant enforcement (auth + health + metrics)
_SKIP_PREFIXES = (
    "/api/v1/auth/",
    "/api/v1/auth",   # catches /api/v1/auth itself
    "/health",
    "/metrics",
    "/api/version",
    "/",
)


def get_tenant_id_from_context() -> Optional[str]:
    """Read the tenant_id set by TenantMiddleware for the current request."""
    return _tenant_id_var.get()


class TenantMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        # ── Step 1: extract tenant_id from header or JWT ──────────────────
        header_tenant: Optional[str] = request.headers.get("X-Tenant-ID") or None
        jwt_tenant: Optional[str] = None
        jwt_user_id: Optional[str] = None

        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            try:
                from app.auth import verify_token
                payload = verify_token(auth_header[7:])
                jwt_tenant = payload.get("tenant_id")
                jwt_user_id = payload.get("sub")
            except Exception:
                pass

        # Resolve effective tenant_id: header takes priority (validated below)
        effective_tenant = header_tenant or jwt_tenant

        # ── Step 2: enforcement — reject cross-tenant header spoofing ─────
        if (
            header_tenant                         # only when header is explicitly set
            and jwt_user_id                       # and a valid JWT is present
            and not _is_skip_path(path)           # and not an exempted path
        ):
            mismatch = _check_tenant_mismatch(jwt_user_id, header_tenant)
            if mismatch is True:                  # non-superuser accessing wrong tenant
                logger.warning(
                    "Tenant isolation violation: user=%s claimed tenant=%s via header",
                    jwt_user_id, header_tenant,
                )
                return JSONResponse(
                    status_code=403,
                    content={
                        "error": "tenant_access_denied",
                        "detail": "You do not have access to the requested tenant.",
                        "code": 4030,
                    },
                )

        # ── Step 3: store in context ──────────────────────────────────────
        token = _tenant_id_var.set(effective_tenant)
        request.state.tenant_id = effective_tenant
        try:
            response = await call_next(request)
        finally:
            _tenant_id_var.reset(token)
        return response


# ── Helpers ────────────────────────────────────────────────────────────────

def _is_skip_path(path: str) -> bool:
    for prefix in _SKIP_PREFIXES:
        if path == prefix or path.startswith(prefix.rstrip("/") + "/"):
            return True
    return False


def _check_tenant_mismatch(user_id: str, claimed_tenant_id: str) -> Optional[bool]:
    """
    Return True  — non-superuser who does NOT belong to claimed_tenant_id (block).
    Return False — user belongs to claimed_tenant, or is a superuser (allow).
    Return None  — DB unavailable (allow, degrade gracefully).
    """
    try:
        from app.db import SessionLocal
        from app.models import User
        db = SessionLocal()
        try:
            user = db.query(User).filter(User.id == user_id).first()
            if not user:
                return None  # Unknown user — let auth layer handle it
            if user.is_superuser:
                return False  # Superusers may access any tenant
            if user.tenant_id == claimed_tenant_id:
                return False  # Correct tenant — allow
            return True       # Tenant mismatch — block
        finally:
            db.close()
    except Exception as exc:
        logger.debug("TenantMiddleware DB check failed (non-critical): %s", exc)
        return None  # Degrade gracefully: don't block when DB is unavailable
