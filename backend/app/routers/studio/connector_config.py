"""
Connector Configuration API — manage email, Feishu, and Teams channel settings.
Configs are stored in the SystemConfig table (key/value), falling back to env vars.
Sensitive fields are masked as "***" in GET responses.
"""
import os
import smtplib
import ssl
import uuid
from email.mime.text import MIMEText
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import get_db
from app import auth

router = APIRouter(prefix="/api/v1/connectors", tags=["connectors"])

MASK = "***"

# ---------------------------------------------------------------------------
# Admin guard
# ---------------------------------------------------------------------------

def _require_admin(current_user) -> None:
    if not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="Admin required")


# ---------------------------------------------------------------------------
# Config key definitions
# ---------------------------------------------------------------------------

_EMAIL_KEYS = [
    "CONNECTOR_EMAIL_ENABLED",
    "CONNECTOR_EMAIL_HOST",
    "CONNECTOR_EMAIL_PORT",
    "CONNECTOR_EMAIL_USER",
    "CONNECTOR_EMAIL_PASS",
    "CONNECTOR_EMAIL_FROM",
    "CONNECTOR_EMAIL_SSL",
]

_FEISHU_KEYS = [
    "CONNECTOR_FEISHU_ENABLED",
    "CONNECTOR_FEISHU_MODE",
    "CONNECTOR_FEISHU_APP_ID",
    "CONNECTOR_FEISHU_APP_SECRET",
    "CONNECTOR_FEISHU_WEBHOOK_URL",
    "CONNECTOR_FEISHU_WEBHOOK_SECRET",
]

_TEAMS_KEYS = [
    "CONNECTOR_TEAMS_ENABLED",
    "CONNECTOR_TEAMS_MODE",
    "CONNECTOR_TEAMS_APP_ID",
    "CONNECTOR_TEAMS_APP_PASSWORD",
    "CONNECTOR_TEAMS_TENANT_ID",
    "CONNECTOR_TEAMS_WEBHOOK_URL",
]

_SENSITIVE_KEYS = {
    "CONNECTOR_EMAIL_PASS",
    "CONNECTOR_FEISHU_APP_SECRET",
    "CONNECTOR_FEISHU_WEBHOOK_SECRET",
    "CONNECTOR_TEAMS_APP_PASSWORD",
}

# Env-var fallback mapping: connector key → env var name
_ENV_FALLBACK = {
    "CONNECTOR_EMAIL_HOST": "SMTP_HOST",
    "CONNECTOR_EMAIL_PORT": "SMTP_PORT",
    "CONNECTOR_EMAIL_USER": "SMTP_USER",
    "CONNECTOR_EMAIL_PASS": "SMTP_PASS",
    "CONNECTOR_EMAIL_FROM": "SMTP_FROM",
    "CONNECTOR_EMAIL_SSL": "SMTP_SSL",
    "CONNECTOR_FEISHU_WEBHOOK_URL": "FEISHU_WEBHOOK_URL",
    "CONNECTOR_FEISHU_WEBHOOK_SECRET": "FEISHU_WEBHOOK_SECRET",
    "CONNECTOR_FEISHU_APP_ID": "FEISHU_APP_ID",
    "CONNECTOR_FEISHU_APP_SECRET": "FEISHU_APP_SECRET",
    "CONNECTOR_TEAMS_WEBHOOK_URL": "TEAMS_WEBHOOK_URL",
    "CONNECTOR_TEAMS_APP_ID": "TEAMS_APP_ID",
    "CONNECTOR_TEAMS_APP_PASSWORD": "TEAMS_APP_PASSWORD",
    "CONNECTOR_TEAMS_TENANT_ID": "TEAMS_TENANT_ID",
}


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def _load_all_configs(db: Session) -> dict[str, str]:
    """Load all CONNECTOR_* configs from DB into a dict."""
    from app.models import SystemConfig
    rows = db.query(SystemConfig).filter(
        SystemConfig.key.like("CONNECTOR_%")
    ).all()
    result: dict[str, str] = {}
    for row in rows:
        val = row.value
        # SystemConfig.value is JSON — stored as string or bool/int
        if isinstance(val, str):
            result[row.key] = val
        else:
            result[row.key] = str(val) if val is not None else ""
    return result


def _get_value(configs: dict[str, str], key: str) -> str:
    """Return the value for a key: DB first, then env fallback."""
    if key in configs:
        return configs[key]
    env_key = _ENV_FALLBACK.get(key)
    if env_key:
        return os.environ.get(env_key, "")
    return ""


def _upsert_config(db: Session, key: str, value: str) -> None:
    from app.models import SystemConfig
    row = db.query(SystemConfig).filter(SystemConfig.key == key).first()
    if row:
        row.value = value
    else:
        db.add(SystemConfig(id=str(uuid.uuid4()), key=key, value=value))


# ---------------------------------------------------------------------------
# Shape builders
# ---------------------------------------------------------------------------

def _build_email_shape(configs: dict[str, str], mask_secrets: bool) -> dict:
    def _s(k: str) -> str:
        v = _get_value(configs, k)
        if mask_secrets and k in _SENSITIVE_KEYS and v:
            return MASK
        return v

    enabled_raw = _get_value(configs, "CONNECTOR_EMAIL_ENABLED")
    ssl_raw = _get_value(configs, "CONNECTOR_EMAIL_SSL")
    port_raw = _get_value(configs, "CONNECTOR_EMAIL_PORT")

    return {
        "enabled": enabled_raw.lower() in ("1", "true", "yes") if enabled_raw else False,
        "host": _s("CONNECTOR_EMAIL_HOST"),
        "port": int(port_raw) if port_raw.isdigit() else 587,
        "user": _s("CONNECTOR_EMAIL_USER"),
        "pass": _s("CONNECTOR_EMAIL_PASS"),
        "from": _s("CONNECTOR_EMAIL_FROM"),
        "ssl": ssl_raw.lower() in ("1", "true", "yes") if ssl_raw else False,
    }


def _build_feishu_shape(configs: dict[str, str], mask_secrets: bool) -> dict:
    def _s(k: str) -> str:
        v = _get_value(configs, k)
        if mask_secrets and k in _SENSITIVE_KEYS and v:
            return MASK
        return v

    enabled_raw = _get_value(configs, "CONNECTOR_FEISHU_ENABLED")
    return {
        "enabled": enabled_raw.lower() in ("1", "true", "yes") if enabled_raw else False,
        "mode": _get_value(configs, "CONNECTOR_FEISHU_MODE") or "webhook",
        "app_id": _s("CONNECTOR_FEISHU_APP_ID"),
        "app_secret": _s("CONNECTOR_FEISHU_APP_SECRET"),
        "webhook_url": _get_value(configs, "CONNECTOR_FEISHU_WEBHOOK_URL"),
        "webhook_secret": _s("CONNECTOR_FEISHU_WEBHOOK_SECRET"),
    }


def _build_teams_shape(configs: dict[str, str], mask_secrets: bool) -> dict:
    def _s(k: str) -> str:
        v = _get_value(configs, k)
        if mask_secrets and k in _SENSITIVE_KEYS and v:
            return MASK
        return v

    enabled_raw = _get_value(configs, "CONNECTOR_TEAMS_ENABLED")
    return {
        "enabled": enabled_raw.lower() in ("1", "true", "yes") if enabled_raw else False,
        "mode": _get_value(configs, "CONNECTOR_TEAMS_MODE") or "webhook",
        "app_id": _s("CONNECTOR_TEAMS_APP_ID"),
        "app_password": _s("CONNECTOR_TEAMS_APP_PASSWORD"),
        "tenant_id": _s("CONNECTOR_TEAMS_TENANT_ID"),
        "webhook_url": _get_value(configs, "CONNECTOR_TEAMS_WEBHOOK_URL"),
    }


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------

class EmailConfig(BaseModel):
    enabled: Optional[bool] = None
    host: Optional[str] = None
    port: Optional[int] = None
    user: Optional[str] = None
    # field name is "pass" — use alias
    password: Optional[str] = None
    from_addr: Optional[str] = None
    ssl: Optional[bool] = None

    class Config:
        populate_by_name = True


class FeishuConfig(BaseModel):
    enabled: Optional[bool] = None
    mode: Optional[str] = None
    app_id: Optional[str] = None
    app_secret: Optional[str] = None
    webhook_url: Optional[str] = None
    webhook_secret: Optional[str] = None


class TeamsConfig(BaseModel):
    enabled: Optional[bool] = None
    mode: Optional[str] = None
    app_id: Optional[str] = None
    app_password: Optional[str] = None
    tenant_id: Optional[str] = None
    webhook_url: Optional[str] = None


class ConnectorConfigUpdate(BaseModel):
    email: Optional[dict] = None
    feishu: Optional[FeishuConfig] = None
    teams: Optional[TeamsConfig] = None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/config")
def get_connector_config(
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    """Return all connector configs. Secrets are masked."""
    configs = _load_all_configs(db)
    return {
        "email": _build_email_shape(configs, mask_secrets=True),
        "feishu": _build_feishu_shape(configs, mask_secrets=True),
        "teams": _build_teams_shape(configs, mask_secrets=True),
    }


@router.put("/config")
def update_connector_config(
    payload: dict,
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    """Update connector configs. Admin only. Fields equal to '***' are skipped."""
    _require_admin(current_user)

    email = payload.get("email") or {}
    feishu = payload.get("feishu") or {}
    teams = payload.get("teams") or {}

    def _save(key: str, value: Any) -> None:
        if value is None:
            return
        str_val = str(value)
        if str_val == MASK:
            return  # skip — caller sent back the masked placeholder
        _upsert_config(db, key, str_val)
        # 同步更新 os.environ，让 connectors.py 和各 tool 立即感知到新配置
        env_key = _ENV_FALLBACK.get(key)
        if env_key and str_val:
            os.environ[env_key] = str_val

    # Email
    if email:
        _save("CONNECTOR_EMAIL_ENABLED", email.get("enabled"))
        _save("CONNECTOR_EMAIL_HOST", email.get("host"))
        _save("CONNECTOR_EMAIL_PORT", email.get("port"))
        _save("CONNECTOR_EMAIL_USER", email.get("user"))
        _save("CONNECTOR_EMAIL_PASS", email.get("pass") or email.get("password"))
        _save("CONNECTOR_EMAIL_FROM", email.get("from") or email.get("from_addr"))
        _save("CONNECTOR_EMAIL_SSL", email.get("ssl"))

    # Feishu
    if feishu:
        _save("CONNECTOR_FEISHU_ENABLED", feishu.get("enabled"))
        _save("CONNECTOR_FEISHU_MODE", feishu.get("mode"))
        _save("CONNECTOR_FEISHU_APP_ID", feishu.get("app_id"))
        _save("CONNECTOR_FEISHU_APP_SECRET", feishu.get("app_secret"))
        _save("CONNECTOR_FEISHU_WEBHOOK_URL", feishu.get("webhook_url"))
        _save("CONNECTOR_FEISHU_WEBHOOK_SECRET", feishu.get("webhook_secret"))

    # Teams
    if teams:
        _save("CONNECTOR_TEAMS_ENABLED", teams.get("enabled"))
        _save("CONNECTOR_TEAMS_MODE", teams.get("mode"))
        _save("CONNECTOR_TEAMS_APP_ID", teams.get("app_id"))
        _save("CONNECTOR_TEAMS_APP_PASSWORD", teams.get("app_password"))
        _save("CONNECTOR_TEAMS_TENANT_ID", teams.get("tenant_id"))
        _save("CONNECTOR_TEAMS_WEBHOOK_URL", teams.get("webhook_url"))

    db.commit()
    auth.log_audit_action(
        db, current_user.id, "update_connector_config", "system_config", None,
        {"sections": [k for k, v in {"email": email, "feishu": feishu, "teams": teams}.items() if v]},
    )

    # Return the fresh masked view
    configs = _load_all_configs(db)
    return {
        "email": _build_email_shape(configs, mask_secrets=True),
        "feishu": _build_feishu_shape(configs, mask_secrets=True),
        "teams": _build_teams_shape(configs, mask_secrets=True),
    }


# ---------------------------------------------------------------------------
# Test endpoints
# ---------------------------------------------------------------------------

@router.post("/test/email")
def test_email_connection(
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    """Test the email connector by connecting to SMTP and sending a test message."""
    if not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="Admin required")
    configs = _load_all_configs(db)
    host = _get_value(configs, "CONNECTOR_EMAIL_HOST")
    port_raw = _get_value(configs, "CONNECTOR_EMAIL_PORT")
    user = _get_value(configs, "CONNECTOR_EMAIL_USER")
    password = _get_value(configs, "CONNECTOR_EMAIL_PASS")
    from_addr = _get_value(configs, "CONNECTOR_EMAIL_FROM")
    ssl_raw = _get_value(configs, "CONNECTOR_EMAIL_SSL")
    use_ssl = ssl_raw.lower() in ("1", "true", "yes") if ssl_raw else False

    if not host:
        return {"ok": False, "error": "Email host is not configured"}

    port = int(port_raw) if port_raw and port_raw.isdigit() else 587
    recipient = from_addr or user
    if not recipient:
        return {"ok": False, "error": "No recipient address configured (set from or user)"}

    try:
        msg = MIMEText("This is a test message from AIOS connector configuration.", "plain", "utf-8")
        msg["Subject"] = "[AIOS] Email connector test"
        msg["From"] = from_addr or user
        msg["To"] = recipient

        if use_ssl:
            ctx = ssl.create_default_context()
            with smtplib.SMTP_SSL(host, port, context=ctx, timeout=10) as server:
                if user and password:
                    server.login(user, password)
                server.sendmail(msg["From"], [recipient], msg.as_string())
        else:
            with smtplib.SMTP(host, port, timeout=10) as server:
                server.ehlo()
                server.starttls()
                if user and password:
                    server.login(user, password)
                server.sendmail(msg["From"], [recipient], msg.as_string())

        return {"ok": True, "message": f"Test email sent successfully to {recipient}"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@router.post("/test/feishu")
def test_feishu_connection(
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    """Test the Feishu connector by posting a test message to the webhook URL."""
    if not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="Admin required")
    configs = _load_all_configs(db)
    webhook_url = _get_value(configs, "CONNECTOR_FEISHU_WEBHOOK_URL")

    if not webhook_url:
        return {"ok": False, "error": "Feishu webhook URL is not configured"}

    payload = {
        "msg_type": "text",
        "content": {"text": "[AIOS] Feishu connector test — connection successful"},
    }

    # Optional HMAC signature
    webhook_secret = _get_value(configs, "CONNECTOR_FEISHU_WEBHOOK_SECRET")
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if webhook_secret:
        import hashlib
        import hmac
        import time as _time
        timestamp = str(int(_time.time()))
        sign_str = f"{timestamp}\n{webhook_secret}"
        sign = hmac.new(
            sign_str.encode("utf-8"),
            digestmod=hashlib.sha256,
        ).digest()
        import base64
        payload["timestamp"] = timestamp
        payload["sign"] = base64.b64encode(sign).decode("utf-8")

    try:
        resp = httpx.post(webhook_url, json=payload, headers=headers, timeout=10)
        data = resp.json()
        if resp.status_code == 200 and data.get("code", 0) == 0:
            return {"ok": True, "message": "Feishu webhook test succeeded"}
        return {"ok": False, "error": f"Feishu API error: {data}"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@router.post("/test/teams")
def test_teams_connection(
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    """Test the Teams connector by posting a test adaptive card to the webhook URL."""
    if not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="Admin required")
    configs = _load_all_configs(db)
    webhook_url = _get_value(configs, "CONNECTOR_TEAMS_WEBHOOK_URL")

    if not webhook_url:
        return {"ok": False, "error": "Teams webhook URL is not configured"}

    payload = {
        "type": "message",
        "attachments": [
            {
                "contentType": "application/vnd.microsoft.card.adaptive",
                "content": {
                    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                    "type": "AdaptiveCard",
                    "version": "1.2",
                    "body": [
                        {
                            "type": "TextBlock",
                            "text": "[AIOS] Teams connector test — connection successful",
                            "wrap": True,
                        }
                    ],
                },
            }
        ],
    }

    try:
        resp = httpx.post(
            webhook_url,
            json=payload,
            headers={"Content-Type": "application/json"},
            timeout=10,
        )
        if resp.status_code in (200, 202):
            return {"ok": True, "message": "Teams webhook test succeeded"}
        return {"ok": False, "error": f"Teams webhook returned HTTP {resp.status_code}: {resp.text[:300]}"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
