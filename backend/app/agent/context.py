"""
AgentContext — runtime context for a single agent execution.
Carries task info, user permissions, memories, and step history.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class AgentContext:
    """Mutable context passed through the execution loop."""

    task_id: str = ""
    user_id: str = ""
    username: str = ""          # human-readable name (used for workspace dir)
    tenant_id: Optional[str] = None
    prompt: str = ""
    context: dict = field(default_factory=dict)

    # Populated during execution
    memories: list[dict] = field(default_factory=list)
    steps: list[dict] = field(default_factory=list)
    total_input_tokens: int = 0
    total_output_tokens: int = 0

    # Limits
    max_steps: int = 20
    step_timeout: int = 60  # seconds per tool call

    # Metadata for tools (e.g., todo_write stores todos here)
    metadata: dict = field(default_factory=dict)

    # IDs of AutoSkill records injected at the start of this task.
    # Populated by the executor during _build_initial_messages(); used by
    # _trigger_skill_extraction() to record feedback after completion.
    suggested_skill_ids: list[str] = field(default_factory=list)

    # Number of adaptive replans triggered so far in this task execution.
    replan_count: int = 0

    # Sub-agent mode: skip DB operations, event publishing, etc.
    is_subagent: bool = False

    # When True, the executor will NOT publish the "completed" SSE event itself.
    # The caller is responsible for publishing it after any post-execution DB work
    # (e.g. saving the assistant message) to avoid a race condition where the
    # frontend fetches messages before they have been committed.
    suppress_completed_event: bool = False

    def add_step(self, step: dict):
        self.steps.append(step)

    def add_tokens(self, input_tokens: int = 0, output_tokens: int = 0):
        self.total_input_tokens += input_tokens
        self.total_output_tokens += output_tokens
