from datetime import datetime, timedelta
from typing import Optional
import uuid
import hashlib
import os
import threading
import jwt
from passlib.context import CryptContext
from fastapi import HTTPException, status, Depends, Request, Security, Response
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials, APIKeyHeader
from sqlalchemy.orm import Session
from app.db import get_db
from app.models import User, AuditLog
from app.middleware.trace import get_trace_id

api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)

SECRET_KEY = os.environ.get("SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError("SECRET_KEY environment variable is required and must not be empty")

# Warn if SECRET_KEY is shorter than recommended 32 bytes for HMAC-SHA256
if len(SECRET_KEY) < 32:
    import warnings
    warnings.warn("SECRET_KEY is shorter than 32 characters — generate a 32+ char secret for secure JWT signing")

ALGORITHM = "HS256"
# Access token lifetime: 2 hours by default (down from 8h).
# SSE/WebSocket connections cache the token at connect time; the frontend
# re-authenticates via the refresh token on the next page load or on 401.
# Override with ACCESS_TOKEN_EXPIRE_MINUTES env var if needed.
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.environ.get("ACCESS_TOKEN_EXPIRE_MINUTES", "120"))
REFRESH_TOKEN_EXPIRE_DAYS = int(os.environ.get("REFRESH_TOKEN_EXPIRE_DAYS", "30"))
AUTH_COOKIE_SECURE = os.environ.get("AUTH_COOKIE_SECURE", "").lower() in {"1", "true", "yes", "on"}
# SameSite=Strict prevents cookies from being sent in any cross-site requests,
# eliminating CSRF risk for cookie-based auth flows. Lax is kept as an option
# for OAuth redirect flows where Strict would drop the cookie on the return leg.
AUTH_COOKIE_SAMESITE = os.environ.get("AUTH_COOKIE_SAMESITE", "strict")
ACCESS_COOKIE_NAME = "aios_access_token"
REFRESH_COOKIE_NAME = "aios_refresh_token"

security = HTTPBearer()
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# ── Account lockout (in-memory, survives within a single process) ─────────────
_LOCKOUT_MAX_FAILURES = int(os.environ.get("LOGIN_MAX_FAILURES", "5"))
_LOCKOUT_WINDOW_MINUTES = int(os.environ.get("LOGIN_LOCKOUT_MINUTES", "15"))
_lockout_store: dict = {}   # key → {"failures": int, "locked_until": datetime|None}
_lockout_lock = threading.Lock()


def _lockout_key(username: str, ip: str) -> tuple[str, str]:
    return f"user:{username.lower()}", f"ip:{ip}"


def check_login_locked(username: str, ip: str) -> tuple[bool, int]:
    """Return (is_locked, seconds_remaining). Checks both username and IP."""
    now = datetime.utcnow()
    with _lockout_lock:
        for key in _lockout_key(username, ip):
            entry = _lockout_store.get(key)
            if entry and entry.get("locked_until"):
                if now < entry["locked_until"]:
                    remaining = int((entry["locked_until"] - now).total_seconds())
                    return True, remaining
                else:
                    # Lock expired — reset
                    _lockout_store.pop(key, None)
    return False, 0


def record_login_failure(username: str, ip: str) -> int:
    """Record a failed attempt. Returns current failure count for the username key."""
    now = datetime.utcnow()
    count = 0
    with _lockout_lock:
        for key in _lockout_key(username, ip):
            entry = _lockout_store.setdefault(key, {"failures": 0, "locked_until": None})
            # Reset counter if a previous lock just expired
            if entry.get("locked_until") and now >= entry["locked_until"]:
                entry["failures"] = 0
                entry["locked_until"] = None
            entry["failures"] += 1
            if entry["failures"] >= _LOCKOUT_MAX_FAILURES:
                entry["locked_until"] = now + timedelta(minutes=_LOCKOUT_WINDOW_MINUTES)
            if key.startswith("user:"):
                count = entry["failures"]
    return count


def clear_login_failures(username: str, ip: str) -> None:
    """Reset failure counters after a successful login."""
    with _lockout_lock:
        for key in _lockout_key(username, ip):
            _lockout_store.pop(key, None)


def set_auth_cookies(response: Response, access_token: str, refresh_token: str) -> None:
    """Set HttpOnly auth cookies for browser flows such as SSE/EventSource."""
    response.set_cookie(
        ACCESS_COOKIE_NAME,
        access_token,
        httponly=True,
        secure=AUTH_COOKIE_SECURE,
        samesite=AUTH_COOKIE_SAMESITE,
        max_age=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        path="/",
    )
    response.set_cookie(
        REFRESH_COOKIE_NAME,
        refresh_token,
        httponly=True,
        secure=AUTH_COOKIE_SECURE,
        samesite=AUTH_COOKIE_SAMESITE,
        max_age=REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60,
        path="/",
    )


def clear_auth_cookies(response: Response) -> None:
    response.delete_cookie(ACCESS_COOKIE_NAME, path="/")
    response.delete_cookie(REFRESH_COOKIE_NAME, path="/")


def get_access_token_from_request(request: Request) -> Optional[str]:
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        return auth_header[7:].strip()
    return request.cookies.get(ACCESS_COOKIE_NAME)


def get_refresh_token_from_request(request: Request) -> Optional[str]:
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        return auth_header[7:].strip()
    return request.cookies.get(REFRESH_COOKIE_NAME)


def hash_password(password: str) -> str:
    """Hash password using bcrypt"""
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify password against bcrypt hash (with SHA-256 legacy fallback)"""
    # Try bcrypt first
    try:
        return pwd_context.verify(plain_password, hashed_password)
    except Exception:
        pass
    # Legacy SHA-256+salt fallback for old hashes
    try:
        salt, stored_hash = hashed_password.split("$")
        import hashlib
        pwdhash = hashlib.sha256((plain_password + salt).encode()).hexdigest()
        return pwdhash == stored_hash
    except Exception:
        return False

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    """Create JWT access token"""
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)

    to_encode.update({"exp": expire, "type": "access"})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt

def create_refresh_token(data: dict):
    """Create JWT refresh token"""
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    to_encode.update({"exp": expire, "type": "refresh"})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt

def _token_jti(token: str) -> str:
    """Derive a unique identifier (JTI) for a token by hashing it."""
    return hashlib.sha256(token.encode()).hexdigest()


# ── Revocation cache — avoids a DB hit on every authenticated request ─────────
# Maps jti → True (revoked) or False (not revoked, negative cache).
# Max 4096 entries; oldest entry evicted when full (simple bounded dict via
# collections.OrderedDict). TTL matches the shorter access token lifetime so
# revoked tokens never survive in cache past their natural expiry.
import collections as _collections  # noqa: E402
_REVOKE_CACHE_MAX = int(os.environ.get("REVOKE_CACHE_MAX", "4096"))
_revoke_cache: "_collections.OrderedDict[str, bool]" = _collections.OrderedDict()
_revoke_cache_lock = threading.Lock()


def _revoke_cache_get(jti: str) -> "bool | None":
    with _revoke_cache_lock:
        if jti in _revoke_cache:
            _revoke_cache.move_to_end(jti)
            return _revoke_cache[jti]
    return None


def _revoke_cache_set(jti: str, revoked: bool) -> None:
    with _revoke_cache_lock:
        _revoke_cache[jti] = revoked
        _revoke_cache.move_to_end(jti)
        if len(_revoke_cache) > _REVOKE_CACHE_MAX:
            _revoke_cache.popitem(last=False)


def _revoke_cache_invalidate(jti: str) -> None:
    with _revoke_cache_lock:
        _revoke_cache.pop(jti, None)


def is_token_revoked(token: str) -> bool:
    """Check if a token has been revoked (blacklisted).

    Results are cached in-process to avoid a DB round-trip on every request.
    Cache is invalidated immediately when a token is revoked.
    """
    jti = _token_jti(token)
    cached = _revoke_cache_get(jti)
    if cached is not None:
        return cached
    try:
        from app.db import SessionLocal
        from app.models import TokenBlacklist
        db = SessionLocal()
        try:
            revoked = db.query(TokenBlacklist).filter(TokenBlacklist.jti == jti).first() is not None
            _revoke_cache_set(jti, revoked)
            return revoked
        finally:
            db.close()
    except Exception:
        return False  # if blacklist check fails, allow (DB might not have table yet)


def revoke_token(token: str, user_id: str = None):
    """Add a token to the blacklist so it can no longer be used."""
    jti = _token_jti(token)
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM], options={"verify_exp": False})
        from datetime import datetime
        from app.db import SessionLocal
        from app.models import TokenBlacklist
        db = SessionLocal()
        try:
            entry = TokenBlacklist(
                id=str(uuid.uuid4()),
                jti=jti,
                user_id=user_id,
                expires_at=datetime.utcfromtimestamp(payload.get("exp", 0)),
            )
            db.add(entry)
            db.commit()
        finally:
            db.close()
    except Exception:
        pass  # best-effort
    # Immediately mark as revoked in cache regardless of DB success
    _revoke_cache_set(jti, True)


def verify_token(token: str, token_type: str = "access") -> dict:
    """Verify JWT token"""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        if payload.get("type") != token_type:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=f"Invalid token type, expected {token_type}"
            )
        # Check revocation
        if is_token_revoked(token):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token has been revoked"
            )
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has expired"
        )
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token"
        )

async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db)
) -> User:
    """Get current authenticated user"""
    token = credentials.credentials
    payload = verify_token(token, "access")
    user_id = payload.get("sub")

    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload"
        )

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found"
        )

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User is inactive"
        )

    return user

async def get_user_from_api_key(
    api_key: Optional[str] = Security(api_key_header),
    db: Session = Depends(get_db),
) -> Optional[User]:
    """Resolve an X-API-Key to the tenant's admin user, or None if key not provided."""
    if not api_key:
        return None
    from app.models import Tenant
    tenant = db.query(Tenant).filter(Tenant.api_key == api_key).first()
    if not tenant:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid API key")
    # Return the first active user belonging to this tenant (or superuser)
    user = (
        db.query(User)
        .filter(User.tenant_id == tenant.id, User.is_active)
        .first()
    )
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No active user for this API key")
    return user


async def get_current_active_user(current_user: User = Depends(get_current_user)) -> User:
    """Get current active user"""
    if not current_user.is_active:
        raise HTTPException(status_code=400, detail="Inactive user")
    return current_user

def require_permission(permission: str):
    """Decorator to require specific permission. Uses the permission service."""
    async def permission_checker(
        current_user: User = Depends(get_current_user),
        db: Session = Depends(get_db),
    ):
        if current_user.is_superuser:
            return current_user

        # Check permissions via roles in the database
        from app.models import Role, UserRole
        user_roles = db.query(UserRole).filter(UserRole.user_id == current_user.id).all()
        role_ids = [ur.role_id for ur in user_roles]
        if role_ids:
            roles = db.query(Role).filter(Role.id.in_(role_ids)).all()
            for role in roles:
                if role.permissions and permission in role.permissions:
                    return current_user

        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Permission '{permission}' required"
        )
    return permission_checker

def log_audit_action(
    db: Session,
    user_id: Optional[str],
    action: str,
    resource_type: str,
    resource_id: Optional[str] = None,
    details: Optional[dict] = None,
    request: Optional[Request] = None,
    tenant_id: Optional[str] = None,
):
    """Log an audit action"""
    effective_tenant_id = tenant_id
    if effective_tenant_id is None and request is not None:
        effective_tenant_id = getattr(request.state, "tenant_id", None)
    if effective_tenant_id is None and user_id:
        try:
            user = db.query(User).filter(User.id == user_id).first()
            effective_tenant_id = getattr(user, "tenant_id", None) if user else None
        except Exception:
            effective_tenant_id = None

    trace_id = None
    if request is not None:
        trace_id = getattr(request.state, "trace_id", None)
    if not trace_id:
        trace_id = get_trace_id() or None

    audit_log = AuditLog(
        id=str(uuid.uuid4()),
        user_id=user_id,
        tenant_id=effective_tenant_id,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        details=details,
        trace_id=trace_id,
        ip_address=request.client.host if request else None,
        user_agent=request.headers.get("user-agent") if request else None
    )
    try:
        db.add(audit_log)
        db.commit()
    except Exception as exc:
        try:
            db.rollback()
        except Exception:
            pass
        import logging as _logging
        _logging.getLogger(__name__).warning("Audit log write failed (non-fatal): %s", exc)
