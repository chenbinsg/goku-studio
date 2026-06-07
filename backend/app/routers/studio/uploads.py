"""
File upload API — handles image and document uploads for multimodal agent input.
"""
import os
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Request
from fastapi.responses import FileResponse

from app import models, auth
from app.limiter import limiter, _UPLOAD_RATE_LIMIT

router = APIRouter(prefix="/api/v1/uploads", tags=["uploads"])

# Support both env var names; AGENT_WORKSPACE is the canonical one used by agent tools
WORKSPACE = os.environ.get("AGENT_WORKSPACE") or os.environ.get("AGENT_WORKSPACE", "/tmp/agent_workspace")
UPLOAD_DIR = os.path.join(WORKSPACE, "uploads")
MAX_SIZE = 100 * 1024 * 1024  # 100 MB (raised for reconciliation files)

ALLOWED_TYPES = {
    # Images
    "image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml",
    # Documents
    "application/pdf",
    "application/msword",  # .doc
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",  # .docx
    "text/markdown",  # .md
    "text/plain",  # .txt (fallback for markdown)
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",  # .xlsx
    "application/vnd.ms-excel",  # .xls
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",  # .pptx
    "application/vnd.ms-powerpoint",  # .ppt
    "text/csv",  # .csv
    "text/tab-separated-values",  # .tsv
    "application/json",  # .json
    # Fallback for browsers that send generic types
    "application/octet-stream",
}


# Map file extensions to content types (for when browser sends generic type)
EXT_TO_CONTENT_TYPE = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".ppt": "application/vnd.ms-powerpoint",
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".json": "application/json",
}


def _detect_content_type(file: UploadFile) -> str:
    """Detect content type from file extension or content_type header."""
    content_type = file.content_type or ""

    # If browser sends a known valid type, use it
    if content_type in ALLOWED_TYPES and content_type != "application/octet-stream":
        return content_type

    # Try to detect from file extension
    filename = file.filename or ""
    ext = Path(filename).suffix.lower()
    if ext in EXT_TO_CONTENT_TYPE:
        return EXT_TO_CONTENT_TYPE[ext]

    # Return original content type (might fail validation later)
    return content_type


@router.post("")
@limiter.limit(_UPLOAD_RATE_LIMIT)
async def upload_file(
    request: Request,
    file: UploadFile = File(...),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Upload a file (image or PDF) for use as agent input."""
    content_type = _detect_content_type(file)
    if content_type not in ALLOWED_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type: {content_type}. "
                   f"Allowed: {', '.join(sorted(ALLOWED_TYPES))}",
        )

    data = await file.read()
    if len(data) > MAX_SIZE:
        raise HTTPException(status_code=413, detail=f"File too large (max {MAX_SIZE // 1024 // 1024}MB)")

    # Determine extension from content type
    ext_map = {
        "image/jpeg": "jpg", "image/png": "png",
        "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg",
        "application/pdf": "pdf",
        "application/msword": "doc",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
        "text/markdown": "md",
        "text/plain": "txt",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
        "application/vnd.ms-excel": "xls",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
        "application/vnd.ms-powerpoint": "ppt",
        "text/csv": "csv",
        "text/tab-separated-values": "tsv",
        "application/json": "json",
    }
    ext = ext_map.get(content_type, "bin")
    file_id = str(uuid.uuid4())
    filename = f"{file_id}.{ext}"

    os.makedirs(UPLOAD_DIR, exist_ok=True)
    file_path = os.path.join(UPLOAD_DIR, filename)
    with open(file_path, "wb") as f:
        f.write(data)

    return {
        "file_id": file_id,
        "filename": file.filename,
        "content_type": content_type,
        "size": len(data),
        "path": file_path,
        "url": f"/api/v1/uploads/{file_id}",
    }


@router.get("/{file_id}")
def get_upload(
    file_id: str,
    current_user: models.User = Depends(auth.get_current_user),
):
    """Retrieve an uploaded file by ID."""
    if any(c in file_id for c in ('/', '\\', '..', '*', '?', '[', ']')) or len(file_id) > 64:
        raise HTTPException(status_code=400, detail="Invalid file ID")
    upload_dir = Path(UPLOAD_DIR)
    if not upload_dir.exists():
        raise HTTPException(status_code=404, detail="Upload not found")

    matches = list(upload_dir.glob(f"{file_id}.*"))
    if not matches:
        raise HTTPException(status_code=404, detail="Upload not found")

    return FileResponse(matches[0])


@router.get("/{file_id}/public")
def get_upload_public(file_id: str):
    """
    Serve uploaded **images only** without Bearer auth, so browser <img> tags work.
    Non-image files (PDF, DOCX, etc.) are rejected with 403.
    File IDs are 128-bit UUIDs, making enumeration computationally infeasible.
    """
    # Reject path traversal and glob wildcard characters that could match unintended files
    if any(c in file_id for c in ('/', '\\', '..', '*', '?', '[', ']')) or len(file_id) > 64:
        raise HTTPException(status_code=400, detail="Invalid file ID")

    upload_dir = Path(UPLOAD_DIR)
    if not upload_dir.exists():
        raise HTTPException(status_code=404, detail="Upload not found")

    matches = list(upload_dir.glob(f"{file_id}.*"))
    if not matches:
        raise HTTPException(status_code=404, detail="Upload not found")

    file_path = matches[0]
    ext = file_path.suffix.lower()
    _IMAGE_TYPES = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
    }
    media_type = _IMAGE_TYPES.get(ext)
    if not media_type:
        # Documents (PDF, DOCX, etc.) require authenticated access via GET /{file_id}
        raise HTTPException(
            status_code=403,
            detail="Public access is restricted to image files. "
                   "Use the authenticated endpoint for documents.",
        )
    return FileResponse(file_path, media_type=media_type)


# ── Workspace-generated file serving ─────────────────────────────────────────
# These endpoints are intentionally public (no Bearer auth) because browser
# <img>, <video>, and <audio> tags cannot attach Authorization headers.
# Security controls:
#   1. Strict filename validation (no path separators or traversal sequences)
#   2. File-type whitelists per endpoint — only the declared media types are served
#   3. Files are stored under a controlled workspace root; subdirectories are fixed
#   4. Non-media files (scripts, executables, documents) cannot be served

_workspace_router = APIRouter(prefix="/api/v1/workspace", tags=["workspace"])

_IMAGE_MEDIA_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml",
}
_VIDEO_MEDIA_TYPES = {".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime"}
_AUDIO_MEDIA_TYPES = {".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4"}


def _validate_workspace_filename(filename: str, allowed_types: dict) -> str:
    """Validate filename and return the file extension. Raises HTTPException on violation."""
    if not filename or "/" in filename or "\\" in filename or ".." in filename or len(filename) > 255:
        raise HTTPException(status_code=400, detail="Invalid filename")
    ext = Path(filename).suffix.lower()
    if ext not in allowed_types:
        raise HTTPException(status_code=403, detail=f"File type '{ext}' is not permitted on this endpoint.")
    return ext


def _serve_workspace_file(subdir: str, filename: str, allowed_types: dict):
    """Serve a workspace file via the pluggable storage backend.

    Search order:
      1. workspace/{subdir}/{filename}          — root-level (legacy / shared)
      2. workspace/{user_dir}/{subdir}/{filename} — per-user subdirectory (file_ops default)
    """
    import os as _os
    from fastapi.responses import Response
    from app.services.workspace_storage import get_storage
    ext = _validate_workspace_filename(filename, allowed_types)
    storage = get_storage()
    rel_path = f"{subdir}/{filename}"
    # Fast path: local file — use FileResponse (zero-copy sendfile)
    local = storage.local_path(rel_path)
    if local is not None:
        if Path(local).is_file():
            return FileResponse(local, media_type=allowed_types[ext])
        # Fallback: search inside per-user subdirectories (workspace/<username>/<subdir>/<file>)
        workspace_base = Path(_os.environ.get("AGENT_WORKSPACE", "/tmp/agent_workspace"))
        for candidate in sorted(workspace_base.glob(f"*/{subdir}/{filename}")):
            if candidate.is_file():
                return FileResponse(str(candidate), media_type=allowed_types[ext])
        raise HTTPException(status_code=404, detail="File not found")
    # S3 / remote path — proxy the bytes through the backend
    try:
        data = storage.read(rel_path)
    except Exception:
        raise HTTPException(status_code=404, detail="File not found")
    return Response(content=data, media_type=allowed_types[ext])


@_workspace_router.get("/images/{filename}")
def get_workspace_image(filename: str):
    """Serve agent-generated images (PNG/JPG/WEBP/GIF/SVG) for browser <img> tags."""
    return _serve_workspace_file("images", filename, _IMAGE_MEDIA_TYPES)


@_workspace_router.get("/assets/{filename}")
def get_workspace_asset(filename: str):
    """Serve static image assets from workspace/assets/ (SVG/PNG/JPG/WEBP/GIF only)."""
    return _serve_workspace_file("assets", filename, _IMAGE_MEDIA_TYPES)


@_workspace_router.get("/videos/{filename}")
def get_workspace_video(filename: str):
    """Serve agent-generated videos (MP4/WEBM/MOV) for browser <video> tags."""
    return _serve_workspace_file("videos", filename, _VIDEO_MEDIA_TYPES)


@_workspace_router.get("/audio/{filename}")
def get_workspace_audio(filename: str):
    """Serve agent-generated audio (MP3/WAV/OGG/M4A) for browser <audio> tags."""
    return _serve_workspace_file("audio", filename, _AUDIO_MEDIA_TYPES)
