"""Studio backend package bootstrap."""
from __future__ import annotations

import os
from pathlib import Path


def _load_env_file(path: Path) -> bool:
    """Load simple KEY=VALUE pairs without adding a runtime dependency."""
    if not path.exists():
        return False
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            os.environ.setdefault(key, value)
    return True


def _load_local_env() -> None:
    app_dir = Path(__file__).resolve().parent
    backend_dir = app_dir.parent
    studio_dir = backend_dir.parent

    # Match start.sh: prefer backend/.env, fall back to the Studio root .env.
    if _load_env_file(backend_dir / ".env"):
        return
    _load_env_file(studio_dir / ".env")


_load_local_env()
