"""
Plugin / Skills marketplace endpoints.
Browse, install, uninstall, upgrade, and audit skills.
"""
import uuid
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session
from app.db import get_db
from app import models, schemas, auth

router = APIRouter(tags=["plugins"])


@router.get("/api/v1/plugins/marketplace")
def discover_skills(
    query: str = "",
    category: str = "",
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Browse the skills marketplace."""
    from app.services.skill_marketplace import get_marketplace
    return get_marketplace().discover(query=query, category=category, page=page, size=size)


@router.get("/api/v1/plugins")
def list_installed_plugins(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """List installed skills."""
    from app.services.skill_marketplace import get_marketplace
    return {"items": get_marketplace().get_installed(db)}


@router.post("/api/v1/plugins/install", response_model=schemas.PluginInstallResponse)
def install_plugin(
    install_data: schemas.PluginInstall,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Install a skill from the marketplace."""
    if not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="Admin required")

    from app.services.skill_marketplace import get_marketplace
    result = get_marketplace().install(
        skill_id=install_data.plugin_id,
        version=install_data.version,
        config=install_data.config,
        db=db,
    )

    if result.get("status") == "error":
        raise HTTPException(status_code=400, detail=result.get("error"))
    if result.get("status") == "blocked":
        raise HTTPException(status_code=403, detail=f"Security audit failed: {result.get('reason')}")

    return {
        "installation_id": result.get("installation_id", str(uuid.uuid4())),
        "status": result.get("status", "installed"),
        "installed_at": datetime.utcnow(),
    }


@router.delete("/api/v1/plugins/{plugin_id}")
def uninstall_plugin(
    plugin_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Uninstall a skill."""
    if not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="Admin required")

    from app.services.skill_marketplace import get_marketplace
    result = get_marketplace().uninstall(plugin_id, db)
    if result.get("status") == "error":
        raise HTTPException(status_code=404, detail=result.get("error"))
    return result


@router.put("/api/v1/plugins/{plugin_id}/upgrade")
def upgrade_plugin(
    plugin_id: str,
    data: dict,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Upgrade a skill to a new version."""
    if not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="Admin required")

    target_version = data.get("version", "")
    if not target_version:
        raise HTTPException(status_code=400, detail="version is required")

    from app.services.skill_marketplace import get_marketplace
    result = get_marketplace().upgrade(plugin_id, target_version, db)
    if result.get("status") == "error":
        raise HTTPException(status_code=400, detail=result.get("error"))
    return result


@router.get("/api/v1/plugins/{plugin_id}/audit")
def audit_plugin(
    plugin_id: str,
    version: str = "",
    current_user: models.User = Depends(auth.get_current_user),
):
    """Get security audit report for a skill."""
    from app.services.skill_marketplace import get_marketplace
    result = get_marketplace().audit(plugin_id, version)
    if result.get("risk_level") == "unknown":
        raise HTTPException(status_code=404, detail=result.get("error"))
    return result


class InstallFromURLRequest(BaseModel):
    url: str


# ── Package distribution endpoints ────────────────────────────────────────────

@router.get("/api/v1/plugins/packages/{skill_id}")
def download_skill_package(
    skill_id: str,
    current_user: models.User = Depends(auth.get_current_user),
):
    """
    Download a packable skill as a zip archive.

    The archive can be sent to another AIOS instance and installed via
    POST /api/v1/plugins/install-from-url or POST /api/v1/plugins/upload-package.
    """
    from app.services.skill_packaging import pack_skill

    try:
        zip_bytes = pack_skill(skill_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    filename = f"{skill_id}.zip"
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/api/v1/plugins/install-from-url")
def install_plugin_from_url(
    request: InstallFromURLRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """
    Install a skill package by downloading it from a remote URL.

    Typically used to pull a tool bundle from another AIOS instance:
      { "url": "http://other-instance:8000/api/v1/plugins/packages/media-generation-tools" }

    NOTE: A backend restart is required for newly installed tools to be
    available to the agent runtime.
    """
    if not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="Admin required")

    url = (request.url or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="url is required")

    from app.services.skill_packaging import install_from_url
    result = install_from_url(url, db)

    if result.get("status") == "error":
        raise HTTPException(status_code=400, detail=result.get("error"))
    if result.get("status") == "blocked":
        raise HTTPException(
            status_code=403,
            detail=f"Security check failed: {result.get('error')} | violations: {result.get('violations')}",
        )

    return result


@router.post("/api/v1/plugins/upload-package")
async def upload_skill_package(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """
    Install a skill package from an uploaded zip file.

    The zip must contain a valid manifest.json and tool Python files.

    NOTE: A backend restart is required for newly installed tools to be
    available to the agent runtime.
    """
    if not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="Admin required")

    if not file.filename or not file.filename.endswith(".zip"):
        raise HTTPException(status_code=400, detail="Uploaded file must be a .zip archive")

    zip_bytes = await file.read()
    if not zip_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    from app.services.skill_packaging import install_from_package
    result = install_from_package(zip_bytes, db)

    if result.get("status") == "error":
        raise HTTPException(status_code=400, detail=result.get("error"))
    if result.get("status") == "blocked":
        raise HTTPException(
            status_code=403,
            detail=f"Security check failed: {result.get('error')} | violations: {result.get('violations')}",
        )

    return result


# ── IM webhook ────────────────────────────────────────────────────────────────

@router.post("/api/v1/webhooks/im")
def im_webhook(
    webhook_data: dict,
    current_user: models.User = Depends(auth.get_current_user),
):
    """Process incoming IM webhook messages."""
    from app.services import im as im_svc
    return im_svc.process_message(
        platform=webhook_data.get("platform", ""),
        channel=webhook_data.get("channel", ""),
        user=webhook_data.get("user", ""),
        text=webhook_data.get("text", ""),
    )
