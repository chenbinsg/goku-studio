"""
BaseTool — abstract base class for all agent tools.

Every tool must define:
  - name: unique snake_case identifier
  - description: human-readable description (shown to LLM)
  - parameters: JSON Schema for the tool's input
  - execute(): the actual implementation
"""
from __future__ import annotations
import logging
import time
import threading
from abc import ABC, abstractmethod
from collections import deque

from app.agent.context import AgentContext

logger = logging.getLogger(__name__)

# jsonschema is used for full parameter validation when available.
try:
    from jsonschema import Draft7Validator as _Draft7Validator
    _JSONSCHEMA_AVAILABLE = True
except ImportError:
    _JSONSCHEMA_AVAILABLE = False


class BaseTool(ABC):
    """Abstract base class for agent tools."""

    name: str = ""
    description: str = ""
    parameters: dict = {}
    permission_level: int = 0  # 0=public, 1=auth, 2=approval, 3=admin
    timeout: int = 60  # default timeout in seconds
    requires_approval: bool = False  # if True, agent pauses for human approval before execution
    specialized: bool = False  # if True, excluded from default tool pool; only available via explicit allowed_tools
    # Set to (calls, window_seconds) to enable rate limiting, e.g. (10, 60) = 10 calls/minute.
    rate_limit: tuple[int, int] | None = None

    # Per-instance call-timestamp ring buffer for rate limiting (keyed by task_id).
    _rl_lock: threading.Lock = threading.Lock()
    _rl_calls: dict[str, deque] = {}  # task_id → deque of call timestamps

    @abstractmethod
    def execute(self, params: dict, ctx: AgentContext) -> dict:
        """
        Execute the tool with given parameters.
        Returns a result dict.
        Raises Exception on failure.
        """

    def to_function_schema(self) -> dict:
        """Convert to OpenAI function calling schema."""
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
        }

    def check_rate_limit(self, task_id: str = "global") -> None:
        """Raise ValueError if this tool has exceeded its rate limit for the given task.

        Uses a sliding-window counter keyed by task_id so different tasks don't
        share quota. Tools that call external APIs should set rate_limit = (N, seconds).
        """
        if not self.rate_limit:
            return
        max_calls, window_seconds = self.rate_limit
        now = time.monotonic()
        with self._rl_lock:
            if task_id not in self._rl_calls:
                self._rl_calls[task_id] = deque()
            dq = self._rl_calls[task_id]
            # Evict timestamps outside the window.
            while dq and now - dq[0] > window_seconds:
                dq.popleft()
            if len(dq) >= max_calls:
                wait = round(window_seconds - (now - dq[0]), 1)
                raise ValueError(
                    f"Tool '{self.name}' rate limit reached ({max_calls} calls/{window_seconds}s). "
                    f"Retry in ~{wait}s or use a different approach."
                )
            dq.append(now)

    def should_require_approval(self, params: dict) -> bool:
        """
        Dynamic approval check. Override in subclass for per-invocation decisions.
        Default: return self.requires_approval.
        """
        return self.requires_approval

    def validate_params(self, params: dict) -> bool:
        """Validate params against the tool's JSON Schema.

        Uses jsonschema for full validation (types, enums, required fields, formats)
        when available. Falls back to required-field-only check otherwise.
        Raises ValueError with a human-readable message on failure.
        """
        if not self.parameters:
            return True

        if _JSONSCHEMA_AVAILABLE:
            validator = _Draft7Validator(self.parameters)
            errors = sorted(validator.iter_errors(params), key=lambda e: list(e.absolute_path))
            if errors:
                # Collect ALL validation errors at once so the LLM can fix everything
                # in a single retry rather than discovering one missing field per call.
                messages = []
                for exc in errors:
                    path = " → ".join(str(p) for p in exc.absolute_path) if exc.absolute_path else "root"
                    messages.append(f"  • [{path}] {exc.message}")
                raise ValueError(
                    f"Tool '{self.name}' has {len(errors)} parameter error(s):\n" + "\n".join(messages)
                )
        else:
            # Minimal fallback: check all required fields at once.
            required = self.parameters.get("required", [])
            missing = [f for f in required if f not in params]
            if missing:
                raise ValueError(
                    f"Tool '{self.name}': missing required parameters: {', '.join(missing)}"
                )

        return True
