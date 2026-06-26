"""
JSON logging for goku-studio.

Forces every log record — application loggers plus uvicorn's own
``uvicorn``/``uvicorn.error``/``uvicorn.access`` loggers — through a single
JSON formatter writing to stdout.  Call :func:`setup_logging` once, as early
as possible (see app/main.py), so import-time logs are captured too.

No third-party dependency: the formatter is built on the stdlib ``logging``
and ``json`` modules.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone

# Standard LogRecord attributes — anything NOT in here is treated as a custom
# "extra" field and merged into the JSON output.
_RESERVED = frozenset(
    logging.makeLogRecord({}).__dict__.keys()
) | {"message", "asctime", "taskName", "color_message"}


class JsonFormatter(logging.Formatter):
    """Render a LogRecord as a single-line JSON object."""

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "timestamp": datetime.fromtimestamp(
                record.created, tz=timezone.utc
            ).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }

        # Any extra=... fields passed to the logger.
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = value

        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        if record.stack_info:
            payload["stack_info"] = self.formatStack(record.stack_info)

        return json.dumps(payload, ensure_ascii=False, default=str)


def setup_logging(level: str | None = None) -> None:
    """Install the JSON formatter on the root logger and uvicorn's loggers.

    Idempotent: replaces existing handlers so re-running (e.g. uvicorn
    ``--reload`` worker restarts) doesn't duplicate output.
    """
    log_level = (level or os.environ.get("LOG_LEVEL", "INFO")).upper()

    handler = logging.StreamHandler()  # stdout/stderr per stdlib default
    handler.setFormatter(JsonFormatter())

    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(log_level)

    # uvicorn installs its own handlers/formatters; strip them and let records
    # propagate up to the root JSON handler instead.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access", "gunicorn.error"):
        lg = logging.getLogger(name)
        lg.handlers = []
        lg.propagate = True
        lg.setLevel(log_level)
