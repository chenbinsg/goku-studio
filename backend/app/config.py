"""
Studio-specific application configuration.

Extends SharedSettings with fields that are only relevant to goku-studio.
Import ``settings`` anywhere: ``from app.config import settings``
"""
from typing import Optional
from goku_shared.config import SharedSettings


class Settings(SharedSettings):
    # ── Workspace (Studio uses uploads/ for agent icon storage) ───────────
    AGENT_WORKSPACE: str = "/tmp/agent_workspace"
    PUBLIC_BASE_URL: str = ""
    AGENT_CODEBASE_DIR: str = "/app"

    # ── Enterprise connectors (used by Studio connector config) ────────────
    DINGTALK_WEBHOOK_TOKEN: Optional[str] = None
    DINGTALK_WEBHOOK_SECRET: Optional[str] = None
    FEISHU_APP_ID: Optional[str] = None
    FEISHU_APP_SECRET: Optional[str] = None
    FEISHU_WEBHOOK_URL: Optional[str] = None
    TEAMS_APP_ID: Optional[str] = None
    TEAMS_APP_PASSWORD: Optional[str] = None
    TEAMS_TENANT_ID: Optional[str] = None

    # ── DLP bypass (agent-level flag, managed here) ────────────────────────
    DLP_ENABLED: bool = True

    # ── Self-evolution proposals (Studio stores them) ──────────────────────
    SUPERVISOR_ENABLED: bool = True

    # ── Multi-DB (Studio connectors may read external DBs) ────────────────
    SQL_DATABASES: Optional[str] = None  # JSON: {"erp": "mysql://...", ...}

    # ── Storage (agent icons / uploaded assets) ───────────────────────────
    WORKSPACE_STORAGE: str = "local"
    S3_BUCKET: str = ""
    S3_ENDPOINT_URL: str = ""
    S3_REGION: str = "us-east-1"
    S3_ACCESS_KEY: str = ""
    S3_SECRET_KEY: str = ""
    S3_PREFIX: str = "workspace/"
    S3_PUBLIC_BASE: str = ""
    S3_PRESIGN_TTL: int = 3600

    model_config = {"env_file": ".env", "extra": "ignore"}


settings = Settings()
