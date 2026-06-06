"""
registry — manages registration, discovery, and execution of agent tools.
Integrates DLP scanning on inputs/outputs and permission checking.
"""
import json
import logging
import threading
from typing import Optional

from app.agent.tools.base import BaseTool
from app.agent.context import AgentContext
from app.config import settings

from app.agent.tools.agent_icon_tools import (
    NameFormatterTool,
    SvgGeneratorTool,
    SvgValidatorTool,
    IconFileWriterTool,
    PreviewRendererTool,
    IconRegistryTool,
    DesignTokenManagerTool,
    CreateIconTool,
)


_global_registry = None

logger = logging.getLogger(__name__)

class registry:
    """Central registry for all agent tools."""

    def __init__(self):
        self._tools: dict[str, BaseTool] = {}
        self._lock = threading.Lock()
        # Schema cache: invalidated whenever the tool set changes.
        self._schema_cache: list[dict] | None = None
        self._schema_cache_by_level: dict[int, list[dict]] = {}

    def _invalidate_schema_cache(self):
        self._schema_cache = None
        self._schema_cache_by_level.clear()

    def register(self, tool: BaseTool):
        """Register a tool. Overwrites if name already exists."""
        with self._lock:
            self._tools[tool.name] = tool
            self._invalidate_schema_cache()
            logger.info("Registered tool: %s", tool.name)

    def unregister(self, name: str) -> bool:
        """Remove a tool by name. Returns True if it existed."""
        with self._lock:
            if name in self._tools:
                del self._tools[name]
                self._invalidate_schema_cache()
                logger.info("Unregistered tool: %s", name)
                return True
            return False

    def get(self, name: str) -> Optional[BaseTool]:
        """Get a tool by name."""
        return self._tools.get(name)

    def list_all(self) -> list[BaseTool]:
        """List all registered tools."""
        return list(self._tools.values())

    def get_schemas(self) -> list[dict]:
        """Return function-calling schemas for all tools (cached)."""
        if self._schema_cache is None:
            self._schema_cache = [t.to_function_schema() for t in self._tools.values()]
        return self._schema_cache

    def create_subset(self, tool_names: list[str]) -> "registry":
        """Create a new registry containing only the specified tools."""
        subset = registry()
        for name in tool_names:
            tool = self._tools.get(name)
            if tool:
                subset.register(tool)
        return subset

    def get_schemas_for_user(self, user_level: int = 0) -> list[dict]:
        """Return function-calling schemas for tools the user can access (cached per level)."""
        if user_level not in self._schema_cache_by_level:
            self._schema_cache_by_level[user_level] = [
                t.to_function_schema()
                for t in self._tools.values()
                if t.permission_level <= user_level
            ]
        return self._schema_cache_by_level[user_level]

    def execute(self, name: str, params: dict, ctx: AgentContext,
                timeout: int = None, db=None, dlp_bypass: bool = False) -> dict:
        """
        Execute a tool by name with permission + DLP checks.
        Returns the tool result dict.
        Raises KeyError if tool not found.
        """
        tool = self._tools.get(name)
        if tool is None:
            raise KeyError(f"Tool not found: {name}")

        # Permission check
        if ctx.user_id and db and tool.permission_level > 0:
            try:
                from app.services.permission import check_tool_permission
                if not check_tool_permission(ctx.user_id, tool.permission_level, db):
                    return {"error": f"Permission denied for tool '{name}' (requires level {tool.permission_level})",
                            "permission_denied": True}
            except Exception as e:
                logger.debug("Permission check failed (non-critical): %s", e)

        # DLP check on input parameters (skip when agent has dlp_bypass=True)
        if not dlp_bypass:
            try:
                from app.services import dlp
                dlp_result = dlp.check_outbound(params)
                if dlp_result.get("blocked"):
                    return {"error": f"DLP blocked input: {dlp_result.get('reason')}", "dlp_blocked": True}
            except Exception:
                pass  # DLP is best-effort

        # Rate limit check (per-task sliding window)
        try:
            tool.check_rate_limit(task_id=ctx.task_id or "global")
        except ValueError as e:
            return {"error": str(e), "rate_limited": True}

        # Validate parameters
        try:
            tool.validate_params(params)
        except ValueError as e:
            return {"error": str(e), "validation_failed": True}

        # Approval check for high-risk tools (dynamic per invocation)
        if tool.should_require_approval(params) and db and ctx.task_id:
            approval_result = self._wait_for_approval(tool, params, ctx, db)
            if approval_result is not None:
                return approval_result  # rejected or timed out

        # Pre-tool-use hooks
        try:
            from app.agent.hooks import run_hooks
            pre_results = run_hooks("pre_tool_use", name, params=params, ctx=ctx)
            for hr in pre_results:
                if not hr.success:
                    logger.info("Tool '%s' blocked by pre_tool_use hook: %s", name, hr.stderr[:200])
                    return {
                        "error": f"Blocked by hook: {hr.stderr[:300]}",
                        "hook_blocked": True,
                    }
        except Exception as e:
            logger.debug("Pre-hook check failed (non-critical): %s", e)

        # Execute with timeout — always respect the tool's own declared timeout
        # Use the larger of: caller-supplied timeout vs tool's own timeout
        effective_timeout = max(timeout or 0, tool.timeout or 0) or 60
        import time as _time
        _t0 = _time.perf_counter()
        result = self._execute_with_timeout(tool, params, ctx, effective_timeout)
        _duration = _time.perf_counter() - _t0

        # Prometheus metrics for tool execution
        try:
            from app.services.prometheus import counter_inc, histogram_observe
            status_label = "error" if result.get("error") else "ok"
            counter_inc("aios_tool_executions_total", labels={"tool": name, "status": status_label})
            histogram_observe("aios_tool_duration_seconds", _duration, labels={"tool": name})
        except Exception:
            pass

        # Post-tool-use hooks (best-effort, don't affect result)
        try:
            from app.agent.hooks import run_hooks as _run_hooks
            event_type = "on_error" if result.get("error") else "post_tool_use"
            _run_hooks(event_type, name, params=params, result=result, ctx=ctx)
        except Exception as e:
            logger.debug("Post-hook failed (non-critical): %s", e)

        # DLP check on output
        try:
            from app.services import dlp
            result = dlp.process_output(result)
        except Exception:
            pass  # DLP is best-effort

        # Audit log for tool execution
        try:
            from app.services import audit
            audit.log(
                action=f"tool_execute:{name}",
                user_id=ctx.user_id or "agent",
                details={
                    "tool": name,
                    "params_summary": json.dumps(params, ensure_ascii=False, default=str)[:200],
                    "success": "error" not in result,
                },
                db=db,
                resource_type="tool",
                resource_id=ctx.task_id,
            )
        except Exception:
            pass  # Audit is best-effort

        return result

    def _wait_for_approval(self, tool: BaseTool, params: dict, ctx: AgentContext, db) -> Optional[dict]:
        """
        Create an approval request and wait for it to be approved/rejected.
        Returns None if approved (proceed with execution),
        or an error dict if rejected/timed out.
        """
        import time
        import uuid as _uuid
        try:
            from app.models import Approval, ApprovalStatus

            approval = Approval(
                id=str(_uuid.uuid4()),
                task_id=ctx.task_id,
                operation=f"tool:{tool.name}",
                risk_level=tool.permission_level,
                description=f"Agent requests to execute '{tool.name}' with params: "
                            f"{json.dumps(params, ensure_ascii=False, default=str)[:500]}",
                status=ApprovalStatus.PENDING,
            )
            db.add(approval)
            db.commit()
            logger.info("Approval requested for tool '%s' (approval_id=%s)", tool.name, approval.id[:8])

            # Notify the frontend chat that approval is needed
            try:
                from app.services.event_bus import publish as _pub
                _pub(ctx.task_id, {
                    "type": "need_approval",
                    "approval_id": approval.id,
                    "tool_name": tool.name,
                    "risk_level": tool.permission_level,
                    "description": approval.description[:200],
                    "message": f"⚠️ Agent 需要您的授权才能继续：**{tool.name}**\n\n"
                               f"请前往 [审批中心](/approvals) 处理，或在此直接操作。",
                })
            except Exception:
                pass

            # Poll for approval. Intervals and timeout are configurable via settings.
            # Use a fresh session per poll to bypass MySQL REPEATABLE READ snapshot isolation,
            # which would otherwise cause db.refresh() to always see stale "pending" status.
            from app.db import SessionLocal as _SessionLocal
            approval_id_str = approval.id
            max_wait = settings.AGENT_APPROVAL_TIMEOUT
            poll_interval = settings.AGENT_APPROVAL_POLL_INTERVAL
            elapsed = 0
            while elapsed < max_wait:
                time.sleep(poll_interval)
                elapsed += poll_interval
                poll_db = _SessionLocal()
                try:
                    refreshed = poll_db.query(Approval).filter(
                        Approval.id == approval_id_str
                    ).first()
                    if refreshed is None:
                        poll_db.close()
                        break
                    current_status = refreshed.status
                    current_comment = refreshed.comment
                except Exception as poll_exc:
                    logger.warning("Approval poll error (will retry): %s", poll_exc)
                    poll_db.close()
                    continue
                finally:
                    poll_db.close()

                if current_status == ApprovalStatus.APPROVED:
                    logger.info("Approval %s granted for tool '%s'", approval_id_str[:8], tool.name)
                    return None  # proceed
                elif current_status == ApprovalStatus.REJECTED:
                    return {
                        "error": f"Tool '{tool.name}' execution rejected by approver: {current_comment or 'no reason'}",
                        "approval_rejected": True,
                        "approval_id": approval_id_str,
                    }

            # Timed out
            return {
                "error": f"Approval for tool '{tool.name}' timed out after {max_wait}s",
                "approval_timeout": True,
                "approval_id": approval_id_str,
            }
        except Exception as e:
            logger.error("Approval system failed for tool '%s': %s", tool.name, e)
            return {
                "error": f"Approval system unavailable — tool '{tool.name}' execution blocked for safety. Please retry later.",
                "approval_error": True,
            }  # fail-closed: if approval system breaks, block execution

    def _execute_with_timeout(self, tool: BaseTool, params: dict, ctx: AgentContext, timeout: int) -> dict:
        """Execute a tool with a timeout. Returns result or error dict."""
        result_holder = [None]
        error_holder = [None]

        def _run():
            try:
                result_holder[0] = tool.execute(params, ctx)
            except Exception as e:
                error_holder[0] = e

        thread = threading.Thread(target=_run, daemon=True)
        thread.start()
        thread.join(timeout=timeout)

        if thread.is_alive():
            logger.warning("Tool %s timed out after %ds", tool.name, timeout)
            return {"error": f"Tool execution timed out after {timeout}s", "timeout": True}

        if error_holder[0]:
            logger.warning("Tool %s failed: %s", tool.name, error_holder[0])
            return {"error": str(error_holder[0])[:500], "exception": True}

        return result_holder[0] or {"error": "Tool returned no result"}


# ── Singleton registry ────────────────────────────────────────────────────────

_global_registry: Optional[registry] = None


def get_tool_registry() -> registry:
    """Get or create the global tool registry with all built-in tools."""
    global _global_registry
    if _global_registry is not None:
        return _global_registry

    tool_registry = globals()["registry"]()

    # Register built-in tools
    from app.agent.tools.http_request import HttpRequestTool
    from app.agent.tools.web_fetch import WebFetchTool
    from app.agent.tools.sql_query import SqlQueryTool
    from app.agent.tools.code_execute import CodeExecuteTool
    from app.agent.tools.file_ops import (
    FileReadTool, FileWriteTool, FileEditTool, FileListTool,
    AgentCodebaseReadTool, AgentCodebaseListTool, AgentCodebaseSearchTool
)
    from app.agent.tools.web_search import WebSearchTool
    from app.agent.tools.memory_search import MemorySearchTool
    from app.agent.tools.send_notification import SendNotificationTool
    from app.agent.tools.send_user_message import SendUserMessageTool
    from app.agent.tools.teams_message import TeamsMessageTool
    from app.agent.tools.feishu_message import FeishuMessageTool
    from app.agent.tools.knowledge_search import KnowledgeSearchTool
    from app.agent.tools.code_search import GrepSearchTool, FileGlobTool
    from app.agent.tools.shell_execute import ShellExecuteTool
    from app.agent.tools.run_e2e_test import RunE2ETestTool
    from app.agent.tools.ask_user import AskUserTool
    from app.agent.tools.spawn_subagent import SpawnSubagentTool, ListAgentTypesTool

    from app.agent.tools.todo_write import TodoWriteTool
    from app.agent.tools.browser_action import BrowserActionTool
    from app.agent.tools.agent_comm import SendAgentMessageTool, ReceiveAgentMessagesTool, ListActiveAgentsTool
    from app.agent.tools.canvas_push import CanvasPushTool
    from app.agent.tools.push_chart import PushChartTool
    from app.agent.tools.system_doctor import SystemDoctorTool
    from app.agent.tools.code_generator import CodeGeneratorTool
    from app.agent.tools.create_article import CreateArticleTool
    from app.agent.tools.generate_image import GenerateImageTool
    from app.agent.tools.compose_poster_with_logo import ComposePosterWithLogoTool

    from app.agent.tools.create_program import CreateProgramTool
    # aibi_query 工具已全局停用(2026-06):统一改走 aibi-qa MCP server。
    # BusinessReportTool 仍内部直接实例化 AIBIQueryTool 取数,不受影响。
    # 如需恢复:取消本行与下方 register 行的注释即可。
    # from app.agent.tools.aibi_query import AIBIQueryTool
    from app.agent.tools.business_report import BusinessReportTool
    from app.agent.tools.email_read import EmailReadTool
    from app.agent.tools.email_send import EmailSendTool
    from app.agent.tools.fetch_pending_emails import FetchPendingEmailsTool
    from app.agent.tools.submit_email_draft import SubmitEmailDraftTool
    from app.agent.tools.microphone_capture import MicrophoneCaptureTool
    from app.agent.tools.calendar_event import CalendarEventTool
    from app.agent.tools.outlook_calendar import OutlookCalendarTool
    from app.agent.tools.system_settings import SystemSettingsTool

    from app.agent.tools.user_profile import UserProfileTool
    from app.agent.tools.wechat_message import WeChatMessageTool
    from app.agent.tools.get_weather import GetWeatherTool
    from app.agent.tools.get_stock_price import GetStockPriceTool

    from app.agent.tools.get_exchange_rate import GetExchangeRateTool
    from app.agent.tools.workflow_generator import WorkflowGeneratorTool
    from app.agent.tools.tool_probe import ToolProbeTool
    from app.agent.tools.agent_probe import AgentProbeTool
    from app.agent.tools.log_doctor import LogDoctorTool
    from app.agent.tools.analyze_image import AnalyzeImageTool

    tool_registry.register(HttpRequestTool())
    tool_registry.register(WebFetchTool())
    tool_registry.register(SqlQueryTool())
    tool_registry.register(CodeExecuteTool())
    tool_registry.register(FileReadTool())
    tool_registry.register(FileWriteTool())
    tool_registry.register(FileEditTool())
    tool_registry.register(FileListTool())
    tool_registry.register(AgentCodebaseReadTool())
    tool_registry.register(AgentCodebaseListTool())
    tool_registry.register(AgentCodebaseSearchTool())
    tool_registry.register(WebSearchTool())
    tool_registry.register(MemorySearchTool())
    tool_registry.register(SendNotificationTool())
    tool_registry.register(SendUserMessageTool())
    tool_registry.register(TeamsMessageTool())
    tool_registry.register(FeishuMessageTool())
    tool_registry.register(KnowledgeSearchTool())
    tool_registry.register(GrepSearchTool())
    tool_registry.register(FileGlobTool())
    tool_registry.register(ShellExecuteTool())
    tool_registry.register(RunE2ETestTool())
    tool_registry.register(AskUserTool())
    tool_registry.register(SpawnSubagentTool())
    tool_registry.register(ListAgentTypesTool())

    tool_registry.register(TodoWriteTool())
    tool_registry.register(BrowserActionTool())
    tool_registry.register(SendAgentMessageTool())
    tool_registry.register(ReceiveAgentMessagesTool())
    tool_registry.register(ListActiveAgentsTool())
    tool_registry.register(CanvasPushTool())
    tool_registry.register(PushChartTool())
    tool_registry.register(SystemDoctorTool())
    tool_registry.register(CodeGeneratorTool())
    tool_registry.register(CreateArticleTool())
    tool_registry.register(GenerateImageTool())

    # Alias: image_render → generate_image (keeps backward-compat with agent configs)
    class _ImageRenderAlias(GenerateImageTool):
        name = "image_render"
    tool_registry.register(_ImageRenderAlias())

    tool_registry.register(ComposePosterWithLogoTool())

    tool_registry.register(CreateProgramTool())
    # aibi_query 全局停用 — 改走 aibi-qa MCP server(见上方 import 处注释)。
    # tool_registry.register(AIBIQueryTool())
    tool_registry.register(BusinessReportTool())
    tool_registry.register(EmailReadTool())
    tool_registry.register(EmailSendTool())
    tool_registry.register(FetchPendingEmailsTool())
    tool_registry.register(SubmitEmailDraftTool())
    tool_registry.register(MicrophoneCaptureTool())
    tool_registry.register(CalendarEventTool())
    tool_registry.register(OutlookCalendarTool())
    tool_registry.register(SystemSettingsTool())

    tool_registry.register(UserProfileTool())
    tool_registry.register(WeChatMessageTool())
    tool_registry.register(GetWeatherTool())
    tool_registry.register(GetStockPriceTool())
    tool_registry.register(GetExchangeRateTool())
    tool_registry.register(WorkflowGeneratorTool())
    tool_registry.register(ToolProbeTool())
    tool_registry.register(AgentProbeTool())
    tool_registry.register(LogDoctorTool())
    tool_registry.register(AnalyzeImageTool())
    tool_registry.register(NameFormatterTool())
    tool_registry.register(SvgGeneratorTool())
    tool_registry.register(SvgValidatorTool())
    tool_registry.register(IconFileWriterTool())
    tool_registry.register(PreviewRendererTool())
    tool_registry.register(IconRegistryTool())
    tool_registry.register(DesignTokenManagerTool())
    tool_registry.register(CreateIconTool())

    # ── Agent Builder（对话式 Agent 创建器）────────────────────────────────────
    from app.agent.tools.agent_builder import AgentBuilderTool
    tool_registry.register(AgentBuilderTool())

    # ── IRA tools (Investor Relations Assistant) ──────────────────────────────
    from app.agent.tools.ira_tools import ALL_IRA_TOOLS
    for _ira_cls in ALL_IRA_TOOLS:
        tool_registry.register(_ira_cls())

    # ── 报告发送工具 ──────────────────────────────────────────────────────────
    try:
        from app.agent.tools.baiwu_daily_report import BaiwuDailyReportTool
        from app.agent.tools.send_market_report import SendMarketReportTool
        from app.agent.tools.send_ir_report import SendIRReportTool
        tool_registry.register(BaiwuDailyReportTool())
        tool_registry.register(SendMarketReportTool())
        tool_registry.register(SendIRReportTool())
    except Exception as _e:
        logger.warning("Report tools unavailable: %s", _e)

    # ── 日本株取引分析ツール ──────────────────────────────────────────────────
    try:
        from app.agent.tools.jp_stock_trading import JpStockTradingTool
        tool_registry.register(JpStockTradingTool())
    except Exception as _e:
        logger.warning("JpStockTradingTool unavailable: %s", _e)

    # ── TTS 语音合成工具 ──────────────────────────────────────────────────────
    try:
        from app.agent.tools.tts_speak import TtsSpeakTool
        tool_registry.register(TtsSpeakTool())
    except Exception as _e:
        logger.warning("TtsSpeakTool unavailable: %s", _e)

    # ── 客服专员工具 (CS-Agent) ───────────────────────────────────────────────
    try:
        from app.agent.tools.ticket_ops import TicketOpsTool
        tool_registry.register(TicketOpsTool())
    except Exception as _e:
        logger.warning("TicketOpsTool unavailable: %s", _e)

    try:
        from app.agent.tools.customer_verify import CustomerVerifyTool
        tool_registry.register(CustomerVerifyTool())
    except Exception as _e:
        logger.warning("CustomerVerifyTool unavailable: %s", _e)

    try:
        from app.agent.tools.feedback_collect import FeedbackCollectTool
        tool_registry.register(FeedbackCollectTool())
    except Exception as _e:
        logger.warning("FeedbackCollectTool unavailable: %s", _e)

    # ── CS P0 工具：客户数据、退款、账户、人工升级 ────────────────────────────
    try:
        from app.agent.tools.customer_lookup import CustomerLookupTool
        tool_registry.register(CustomerLookupTool())
    except Exception as _e:
        logger.warning("CustomerLookupTool unavailable: %s", _e)

    try:
        from app.agent.tools.order_lookup import OrderLookupTool
        tool_registry.register(OrderLookupTool())
    except Exception as _e:
        logger.warning("OrderLookupTool unavailable: %s", _e)

    try:
        from app.agent.tools.refund_request import RefundRequestTool
        tool_registry.register(RefundRequestTool())
    except Exception as _e:
        logger.warning("RefundRequestTool unavailable: %s", _e)

    try:
        from app.agent.tools.account_ops import AccountOpsTool
        tool_registry.register(AccountOpsTool())
    except Exception as _e:
        logger.warning("AccountOpsTool unavailable: %s", _e)

    try:
        from app.agent.tools.escalate_to_human import EscalateToHumanTool
        tool_registry.register(EscalateToHumanTool())
    except Exception as _e:
        logger.warning("EscalateToHumanTool unavailable: %s", _e)

    # ── CS P2 工具：客户历史、报告、路由、知识库 ──────────────────────────────
    try:
        from app.agent.tools.customer_history import CustomerHistoryTool
        tool_registry.register(CustomerHistoryTool())
    except Exception as _e:
        logger.warning("CustomerHistoryTool unavailable: %s", _e)

    try:
        from app.agent.tools.cs_report import CsReportTool
        tool_registry.register(CsReportTool())
    except Exception as _e:
        logger.warning("CsReportTool unavailable: %s", _e)

    try:
        from app.agent.tools.cs_router import CsRouterTool
        tool_registry.register(CsRouterTool())
    except Exception as _e:
        logger.warning("CsRouterTool unavailable: %s", _e)

    try:
        from app.agent.tools.kb_ops import KbOpsTool
        tool_registry.register(KbOpsTool())
    except Exception as _e:
        logger.warning("KbOpsTool unavailable: %s", _e)

    # ── CS P3 工具：模板、批量操作、自动回复 ──────────────────────────────────
    try:
        from app.agent.tools.cs_template import CsTemplateTool
        tool_registry.register(CsTemplateTool())
    except Exception as _e:
        logger.warning("CsTemplateTool unavailable: %s", _e)

    try:
        from app.agent.tools.cs_batch import CsBatchTool
        tool_registry.register(CsBatchTool())
    except Exception as _e:
        logger.warning("CsBatchTool unavailable: %s", _e)

    try:
        from app.agent.tools.cs_auto_reply import CsAutoReplyTool
        tool_registry.register(CsAutoReplyTool())
    except Exception as _e:
        logger.warning("CsAutoReplyTool unavailable: %s", _e)

    # ── 滑块验证码工具 ────────────────────────────────────────────────────────
    try:
        from app.agent.tools.slider_captcha_solver import SliderCaptchaSolverTool
        tool_registry.register(SliderCaptchaSolverTool())
    except Exception as e:
        logger.warning("SliderCaptchaSolverTool 注册失败 (non-critical): %s", e)

    # ── Self-Evolution tools (v1.9.9) — specialized/admin-only ───────────────
    try:
        from app.agent.tools.supervisor_tools import (
            QueryTaskTracesTool,
            SearchSupervisorInsightsTool,
            ListImprovementProposalsTool,
            GenerateAgentPerformanceReportTool,
        )
        from app.agent.tools.optimizer_tools import (
            ApplyPromptHintTool,
            InjectAgentMemoryTool,
            PatchAgentToolListTool,
            SubmitToolChangeForApprovalTool,
        )
        from app.agent.tools.call_claude_code import CallClaudeCodeTool
        for _t in (
            QueryTaskTracesTool(),
            SearchSupervisorInsightsTool(),
            ListImprovementProposalsTool(),
            GenerateAgentPerformanceReportTool(),
            ApplyPromptHintTool(),
            InjectAgentMemoryTool(),
            PatchAgentToolListTool(),
            SubmitToolChangeForApprovalTool(),
            CallClaudeCodeTool(),
        ):
            tool_registry.register(_t)
        logger.info("Self-evolution tools registered (9 tools)")
    except Exception as e:
        logger.warning("Self-evolution tool registration failed (non-critical): %s", e)

    # Register MCP tools from the DB-backed runtime config (best-effort)
    try:
        from app.agent.mcp.client import get_mcp_manager
        from app.agent.mcp.registry_integration import register_mcp_tools
        mcp_manager = get_mcp_manager()
        mcp_results = register_mcp_tools(tool_registry, mcp_manager)
        mcp_total = sum(len(tools) for tools in mcp_results.values())
        if mcp_total > 0:
            logger.info("Registered %d MCP tools from %d servers", mcp_total, len(mcp_results))
    except ImportError:
        logger.debug("MCP SDK not installed, skipping MCP tool registration")
    except Exception as e:
        logger.warning("MCP tool registration failed (non-critical): %s", e)

    _global_registry = tool_registry

    # Auto-sync built-in tools to database (best-effort)
    # This ensures users can see all available tools in the frontend
    try:
        _sync_tools_to_db(tool_registry.list_all())
    except Exception as e:
        logger.warning("Tool sync to DB failed (non-critical): %s", e)

    return tool_registry


def _sync_tools_to_db(tools: list):
    """Sync tool metadata to database for frontend visibility.

    Important behavior:
    - Uses the in-memory registry as the source of truth for built-in Python tools.
    - Inserts missing tools.
    - Updates existing tools' description/handler/schema/permission_level, instead of silently skipping them.
      This fixes the common issue where a tool appears in the UI but has stale schema/metadata.
    - Does not delete tools that are only in DB, because AIOS may also store UI-created tools or MCP tools there.
    """
    import json
    import uuid
    from sqlalchemy import text
    from sqlalchemy.orm import Session
    from app.db import engine

    # Map tool names to handlers used by the executor / frontend.
    handler_map = {
        "http_request": "builtin.http.request",
        "web_fetch":    "builtin.web.fetch",
        "sql_query": "builtin.sql.query",
        "code_execute": "builtin.code.execute",
        "file_read": "builtin.file.read",
        "file_write": "builtin.file.write",
        "file_edit": "builtin.file.edit",
        "file_list": "builtin.file.list",
        "analyze_image": "builtin.vision.analyze",
        "web_search": "builtin.web.search",
        "memory_search": "builtin.memory.search",
        "send_notification": "builtin.notification.send",
        "send_user_message": "builtin.user.send_message",
        "teams_message": "builtin.teams.message",
        "feishu_message": "builtin.feishu.message",
        "knowledge_search": "builtin.knowledge.search",
        "grep_search": "builtin.search.grep",
        "file_glob": "builtin.search.glob",
        "shell_execute": "builtin.shell.execute",
        "run_e2e_test": "builtin.test.e2e",
        "ask_user": "builtin.user.ask",
        "spawn_subagent": "builtin.subagent.spawn",
        "list_agent_types": "builtin.subagent.list_types",

        "todo_write": "builtin.todo.write",
        "browser_action": "builtin.browser.action",
        "send_agent_message": "builtin.agent.send_message",
        "receive_agent_messages": "builtin.agent.receive_messages",
        "list_active_agents": "builtin.agent.list",
        "canvas_push": "builtin.canvas.push",
        "system_doctor": "builtin.system.doctor",
        "code_generator": "builtin.code.generate",
        "agent_codebase_read": "builtin.agent.codebase_read",
        "agent_codebase_list": "builtin.agent.codebase_list",
        "agent_codebase_search": "builtin.agent.codebase_search",
        "create_article": "builtin.content.create_article",
        "generate_image": "builtin.content.generate_image",
        "image_render": "builtin.content.generate_image",
        "compose_poster_with_logo": "builtin.content.compose_poster_with_logo",

        "create_program": "builtin.content.create_program",
        "email_read": "builtin.email.read",
        "email_send": "builtin.email.send",
        "microphone_capture": "builtin.microphone.capture",
        "calendar_event": "builtin.calendar.event",
        "outlook_calendar": "builtin.calendar.outlook",
        "system_settings": "builtin.system.settings",

        "user_profile": "builtin.user.profile",
        "wechat_message": "builtin.wechat.message",
        "get_weather": "builtin.weather.get",
        "get_stock_price": "builtin.stock.price",

        "get_exchange_rate": "builtin.exchange_rate.get",
        "workflow_generator": "builtin.workflow.generate",
        "tool_probe": "builtin.tool.probe",
        "agent_probe": "builtin.agent.probe",
        "baiwu_daily_report": "builtin.baiwu.daily_report",

        # IRA tools
        "ira_search_investors":         "builtin.ira.search_investors",
        "ira_create_investor":          "builtin.ira.create_investor",
        "ira_update_investor":          "builtin.ira.update_investor",
        "ira_create_event":             "builtin.ira.create_event",
        "ira_list_events":              "builtin.ira.list_events",
        "ira_add_event_participants":   "builtin.ira.add_event_participants",
        "ira_update_participant_status":"builtin.ira.update_participant_status",
        "ira_get_event_summary":        "builtin.ira.get_event_summary",
        "ira_create_email_template":    "builtin.ira.create_email_template",
        "ira_render_email_template":    "builtin.ira.render_email_template",
        "ira_queue_bulk_emails":        "builtin.ira.queue_bulk_emails",
        "ira_send_email_queue":         "builtin.ira.send_email_queue",
        "ira_log_communication":        "builtin.ira.log_communication",
        "ira_create_task":              "builtin.ira.create_task",
        "ira_list_tasks":               "builtin.ira.list_tasks",
        "ira_notify_teams":             "builtin.ira.notify_teams",
        "ira_log_agent_action":         "builtin.ira.log_agent_action",

        # Agent Icon Designer tools
        "create_icon": "builtin.icon.create_icon",
        "name_formatter": "builtin.icon.name_formatter",
        "svg_generator": "builtin.icon.svg_generator",
        "svg_validator": "builtin.icon.svg_validator",
        "icon_file_writer": "builtin.icon.file_writer",
        "preview_renderer": "builtin.icon.preview_renderer",
        "icon_registry": "builtin.icon.registry",
        "design_token_manager": "builtin.icon.design_token_manager",
    }

    # Build batch payload — one row per tool.
    rows = []
    for tool in tools:
        rows.append({
            "id": str(uuid.uuid4()),
            "name": tool.name,
            "description": (tool.description or tool.name)[:500],
            "handler": handler_map.get(tool.name, f"builtin.{tool.name}"),
            "schema": json.dumps(tool.parameters or {}, ensure_ascii=False),
            "permission_level": int(getattr(tool, "permission_level", 0) or 0),
        })

    if not rows:
        return

    # Single bulk upsert: insert all rows; on name collision update mutable fields.
    # ROW_COUNT() after executemany: 1 per insert, 2 per update (MySQL convention).
    with Session(engine) as db:
        db.execute(
            text("""
                INSERT INTO tools (id, name, description, handler, `schema`, permission_level, created_at)
                VALUES (:id, :name, :description, :handler, :schema, :permission_level, NOW())
                ON DUPLICATE KEY UPDATE
                    description      = VALUES(description),
                    handler          = VALUES(handler),
                    `schema`         = VALUES(`schema`),
                    permission_level = VALUES(permission_level)
            """),
            rows,
        )
        db.commit()

    logger.info("Tool DB sync completed: total_in_memory=%d", len(rows))
