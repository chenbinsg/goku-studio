"""
Audit origin: how a recorded change came to happen.

An audit row says WHO changed something. It cannot say whether that person
clicked it in the UI or asked an agent to do it for them — and those two read
very differently when someone is reconstructing an incident. Threading a
"trigger" argument through the 80-odd call sites of `auth.log_audit_action`
is not workable, so the origin travels in a ContextVar, the way the trace id
already does (see `middleware/trace.py`), and `log_audit_action` reads it at
write time. A task run sets it once; every audit write underneath inherits it.

The actor stays the responsible person in every case. An agent that edits a
config because someone told it to has made that person's change, and the row
names the person — `actor_agent_id` records which agent carried it out, it does
not replace the actor. The one exception is work nobody approved: the
optimizer's daily batch applies LOW/MED proposals on its own authority, so
there is no responsible person to name and those rows carry `user_id = NULL`,
which the UI reads as 「系统」.

A ContextVar set inside a worker thread is private to that thread, which is
exactly the scope wanted here: `task_executor.execute` runs per task in its own
thread, and one task's origin must never leak into another's.
"""
from contextvars import ContextVar, Token
from dataclasses import dataclass
from typing import Optional

# Trigger vocabulary. These are stored in `audit_logs.trigger_type` and are the
# API's contract with the UI, so they stay stable even if the labels change.
TRIGGER_UI = "ui"                      # 界面操作 — a person acting in the UI
TRIGGER_CONVERSATION = "conversation"  # 对话指令 — a person instructing an agent
TRIGGER_SCHEDULE = "schedule"          # 定时任务 — heartbeat or cron
TRIGGER_RULE = "rule"                  # 规则触发 — inbound event, or an automatic batch
TRIGGER_DEPLOY = "deploy"              # 部署与启动 — seeds, migrations, and the
                                      # service's own startup work

# `task.context["_trigger"]`, written by whoever created the task
# (tasks/heartbeat.py, tasks/email_watcher.py, tasks/scheduler.py,
# routers/studio/workflows.py). A task with no `_trigger` was created by a
# person talking to an agent, which is the common case.
_TASK_TRIGGER_MAP = {
    "heartbeat": TRIGGER_SCHEDULE,
    "cron": TRIGGER_SCHEDULE,
    "webhook": TRIGGER_RULE,
    "email_queue": TRIGGER_RULE,
}


@dataclass(frozen=True)
class AuditOrigin:
    """Why the change underway is happening, and what carried it out."""
    trigger_type: str
    actor_agent_id: Optional[str] = None
    task_id: Optional[str] = None


_origin_var: ContextVar[Optional[AuditOrigin]] = ContextVar("audit_origin", default=None)


def get_origin() -> Optional[AuditOrigin]:
    """The origin in force, or None when nothing set one (a plain UI request)."""
    return _origin_var.get()


def set_origin(origin: Optional[AuditOrigin]) -> Token:
    """Install an origin. Hand the token back to `reset_origin` when done."""
    return _origin_var.set(origin)


def reset_origin(token: Token) -> None:
    try:
        _origin_var.reset(token)
    except ValueError:
        # The token belongs to another context (the caller moved threads).
        # Clearing outright is the safe reading: better no origin than a stale one.
        _origin_var.set(None)


def origin_for_task(task, context: Optional[dict] = None) -> AuditOrigin:
    """Derive the origin of an agent task run.

    `context` is what the caller passed to `task_executor.execute`; it can be
    None on a retry, in which case the task's stored context is the same data.
    """
    ctx = context if isinstance(context, dict) else None
    if ctx is None:
        ctx = getattr(task, "context", None) or {}

    # `_custom_agent_id` is the effective agent after per-message routing;
    # `_agent_id` is what the conversation started with (see
    # routers/studio/workflows.py). The task column is the fallback.
    agent_id = (
        ctx.get("_custom_agent_id")
        or ctx.get("_agent_id")
        or getattr(task, "agent_id", None)
    )
    return AuditOrigin(
        trigger_type=_TASK_TRIGGER_MAP.get(ctx.get("_trigger"), TRIGGER_CONVERSATION),
        actor_agent_id=agent_id,
        task_id=getattr(task, "id", None),
    )


def system_origin(trigger_type: str = TRIGGER_RULE) -> AuditOrigin:
    """Origin for automatic work that no person requested or approved."""
    return AuditOrigin(trigger_type=trigger_type)
