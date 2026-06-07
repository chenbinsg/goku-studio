"""Studio auth endpoints — token refresh and verify.

Studio does not own user accounts; JWT is issued by goku-core.
These endpoints let the Studio frontend refresh/verify tokens that
Core issued, using the shared SECRET_KEY.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from sqlalchemy.orm import Session
from fastapi import Depends

from app.auth import (
    create_access_token,
    verify_token,
    get_refresh_token_from_request,
    get_current_user,
)
from app.db import get_db
from app.models import User, Role, UserRole

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


class RefreshRequest(BaseModel):
    refresh_token: str | None = None


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(body: RefreshRequest, request: Request):
    """Exchange a valid refresh token for a new access token."""
    token = body.refresh_token or get_refresh_token_from_request(request)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh token required")

    payload = verify_token(token, token_type="refresh")
    new_access = create_access_token({"sub": payload["sub"]})
    return TokenResponse(access_token=new_access)


@router.get("/verify")
async def verify_access_token(request: Request):
    """Verify the Bearer access token in the Authorization header."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Bearer token required")
    token = auth[7:].strip()
    payload = verify_token(token, token_type="access")
    return {"valid": True, "sub": payload.get("sub")}


# ── /me/permissions — used by Studio frontend's usePermissions hook ───────────

_STUDIO_ALL_PERMISSIONS = [
    "tools.read", "tools.write",
    "mcp.manage",
    "memory.read", "memory.write",
    "skills.manage",
    "connectors.manage",
]

router_me = APIRouter(prefix="/api/v1/me", tags=["me"])


@router_me.get("/permissions")
async def get_my_permissions(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Return effective permissions for the current user.

    Superusers get the wildcard ['*'] so all Studio menu items appear.
    Regular users get permissions derived from their roles.
    """
    if current_user.is_superuser:
        return {"permissions": ["*"], "max_level": 3, "is_superuser": True}

    user_roles = db.query(UserRole).filter(UserRole.user_id == current_user.id).all()
    role_ids = [ur.role_id for ur in user_roles]
    permissions: set[str] = set()
    max_level = 0
    if role_ids:
        roles = db.query(Role).filter(Role.id.in_(role_ids)).all()
        for role in roles:
            if role.permissions:
                for p in role.permissions:
                    permissions.add(p)
            if hasattr(role, "level") and role.level:
                max_level = max(max_level, role.level)

    return {
        "permissions": sorted(permissions),
        "max_level": max_level,
        "is_superuser": False,
    }
