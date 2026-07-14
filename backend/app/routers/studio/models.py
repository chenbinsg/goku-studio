"""Model catalog proxy — exposes Goku-Router's /v1/models to the Studio UI.

The workflow designer's per-node model dropdown must stay in sync with what
Goku-Router can actually serve, instead of a hardcoded list that drifts out of
date. This proxies the router's public /v1/models endpoint so the UI always
reflects the live model_catalog.
"""
import os

import httpx
from fastapi import APIRouter, Depends

from app import auth, models

router = APIRouter(prefix="/api/v1/models", tags=["models"])

# Goku-Router base URL; its OpenAI-compatible catalog lives under /v1/models.
ROUTER_URL = os.getenv("ROUTER_URL", "http://localhost:8159")


@router.get("")
def list_models(current_user: models.User = Depends(auth.get_current_user)):
    """Return routable model ids from Goku-Router's catalog.

    Excludes the pseudo-model "router/auto" (a routing directive, not a concrete
    model). Degrades gracefully to an empty list if the router is unreachable so
    the designer renders rather than errors.
    """
    try:
        resp = httpx.get(f"{ROUTER_URL}/v1/models", timeout=5.0)
        resp.raise_for_status()
        model_ids = [m for m in resp.json().get("models", []) if m != "router/auto"]
        return {"models": model_ids, "source": "router"}
    except Exception:
        return {"models": [], "source": "unavailable"}
