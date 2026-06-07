"""
Skills marketplace — discovery, install/uninstall, versioning, security audit.
Extends the existing Plugin model with marketplace capabilities.
"""
import logging
import uuid
from datetime import datetime

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

# Built-in skills registry (in production, could be fetched from a remote registry)
BUILTIN_SKILLS = [
    {
        "id": "data-export",
        "name": "Data Export",
        "description": "Export task results to CSV, Excel, or PDF format",
        "latest_version": "2.0.0",
        "versions": ["1.0.0", "2.0.0"],
        "author": "system",
        "category": "data",
        "permissions_required": ["file_write"],
        "tools_provided": ["export_csv", "export_excel", "export_pdf"],
    },
    {
        "id": "code-formatter",
        "name": "Code Formatter",
        "description": "Format code in multiple languages (Python, JS, SQL, etc.)",
        "latest_version": "1.2.0",
        "versions": ["1.0.0", "1.1.0", "1.2.0"],
        "author": "system",
        "category": "development",
        "permissions_required": ["code_execute"],
        "tools_provided": ["format_code"],
    },
    {
        "id": "text-summarizer",
        "name": "Text Summarizer",
        "description": "Summarize long documents, articles, or conversation histories",
        "latest_version": "1.0.0",
        "versions": ["1.0.0"],
        "author": "system",
        "category": "text",
        "permissions_required": [],
        "tools_provided": ["summarize_text"],
    },
    {
        "id": "image-generator",
        "name": "Image Generator",
        "description": "Generate images using gpt-image-2 or Stable Diffusion APIs",
        "latest_version": "1.1.0",
        "versions": ["1.0.0", "1.1.0"],
        "author": "system",
        "category": "media",
        "permissions_required": ["http_request"],
        "tools_provided": ["generate_image"],
    },
    {
        "id": "email-assistant",
        "name": "Email Assistant",
        "description": "Draft, send, and manage emails via SMTP/IMAP",
        "latest_version": "1.0.0",
        "versions": ["1.0.0"],
        "author": "system",
        "category": "communication",
        "permissions_required": ["send_notification"],
        "tools_provided": ["draft_email", "send_email"],
    },
    {
        "id": "database-analyzer",
        "name": "Database Analyzer",
        "description": "Analyze database schema, suggest optimizations, generate ERDs",
        "latest_version": "1.0.0",
        "versions": ["1.0.0"],
        "author": "system",
        "category": "data",
        "permissions_required": ["sql_query"],
        "tools_provided": ["analyze_schema", "suggest_indexes"],
    },
    {
        "id": "api-tester",
        "name": "API Tester",
        "description": "Test REST APIs with assertions, generate Postman collections",
        "latest_version": "1.0.0",
        "versions": ["1.0.0"],
        "author": "system",
        "category": "development",
        "permissions_required": ["http_request"],
        "tools_provided": ["test_api", "generate_collection"],
    },
    {
        "id": "calendar-sync",
        "name": "Calendar Sync",
        "description": "Sync tasks and deadlines with Google Calendar or Outlook",
        "latest_version": "1.0.0",
        "versions": ["1.0.0"],
        "author": "system",
        "category": "productivity",
        "permissions_required": ["http_request"],
        "tools_provided": ["create_event", "list_events"],
    },
    {
        "id": "code-review",
        "name": "Code Review",
        "description": "AI-powered code review: detect bugs, security issues, code smells, and suggest improvements",
        "latest_version": "1.0.0",
        "versions": ["1.0.0"],
        "author": "system",
        "category": "development",
        "permissions_required": ["file_read", "grep_search"],
        "tools_provided": ["review_code", "check_security"],
    },
    {
        "id": "unit-test-runner",
        "name": "Unit Test Runner",
        "description": "Run unit tests (pytest, jest, go test), parse results, and generate coverage reports",
        "latest_version": "1.0.0",
        "versions": ["1.0.0"],
        "author": "system",
        "category": "testing",
        "permissions_required": ["shell_execute", "file_read"],
        "tools_provided": ["run_tests", "test_coverage"],
    },
    {
        "id": "code-generator",
        "name": "Code Generator",
        "description": "Generate boilerplate code, CRUD APIs, data models, and project scaffolding",
        "latest_version": "1.0.0",
        "versions": ["1.0.0"],
        "author": "system",
        "category": "development",
        "permissions_required": ["file_write", "code_execute"],
        "tools_provided": ["generate_code", "scaffold_project"],
    },
    {
        "id": "git-workflow",
        "name": "Git Workflow",
        "description": "Automate git workflows: branch management, PR creation, conflict resolution, changelog generation",
        "latest_version": "1.0.0",
        "versions": ["1.0.0"],
        "author": "system",
        "category": "development",
        "permissions_required": ["git", "shell_execute"],
        "tools_provided": ["create_pr", "generate_changelog"],
    },
    {
        "id": "ci-cd-helper",
        "name": "CI/CD Helper",
        "description": "Generate and validate CI/CD configs (GitHub Actions, GitLab CI, Jenkins), analyze pipeline failures",
        "latest_version": "1.0.0",
        "versions": ["1.0.0"],
        "author": "system",
        "category": "development",
        "permissions_required": ["file_write", "http_request"],
        "tools_provided": ["generate_pipeline", "analyze_failure"],
    },
    {
        "id": "integration-tester",
        "name": "Integration Tester",
        "description": "Run integration and E2E tests, mock external services, validate API contracts",
        "latest_version": "1.0.0",
        "versions": ["1.0.0"],
        "author": "system",
        "category": "testing",
        "permissions_required": ["shell_execute", "http_request"],
        "tools_provided": ["run_e2e", "mock_service", "validate_contract"],
    },
    {
        "id": "dependency-scanner",
        "name": "Dependency Scanner",
        "description": "Scan project dependencies for vulnerabilities, outdated packages, and license compliance",
        "latest_version": "1.0.0",
        "versions": ["1.0.0"],
        "author": "system",
        "category": "testing",
        "permissions_required": ["shell_execute", "file_read"],
        "tools_provided": ["scan_deps", "check_licenses"],
    },
    {
        "id": "media-generation-tools",
        "name": "Media Generation Tools (Local)",
        "description": "本地生成音频和视频，无需外部API，使用加法合成和帧渲染技术",
        "latest_version": "1.0.0",
        "versions": ["1.0.0"],
        "author": "system",
        "category": "media",
        "license": "MIT",
        "tags": ["video", "music", "audio", "offline", "local"],
        "permissions_required": ["file_write", "subprocess_run"],
        "tools_provided": ["generate_video_local", "generate_music_local"],
        "packable": True,  # 可以被打成包下载
        "tool_files": ["generate_video_local.py", "generate_music_local.py"],
        "dependencies": ["numpy>=1.24", "Pillow>=10.0", "imageio[ffmpeg]>=2.31"],
        "system_dependencies": ["ffmpeg"],
    },
    # ── Industry Skill Pack: Japan IR ─────────────────────────────────────────
    {
        "id": "japan-ir-skill-pack",
        "name": "日本 IR 助理技能包 (Japan IR Assistant)",
        "description": (
            "面向日本上市企业 IR 部门的完整工具集：投资者管理、路演活动、"
            "批量邮件邀请、审批流程、IR 报告生成，以及 Microsoft Teams 通知。"
            "需配置 IRA_API_BASE_URL 指向 IRA 后台服务。"
        ),
        "latest_version": "1.0.0",
        "versions": ["1.0.0"],
        "author": "system",
        "category": "finance",
        "license": "MIT",
        "tags": ["IR", "investor-relations", "japan", "finance", "roadshow", "email"],
        "permissions_required": ["http_request", "email_send"],
        "tools_provided": [
            # Investor management
            "ira_search_investors", "ira_create_investor", "ira_update_investor",
            # Event management
            "ira_create_event", "ira_list_events",
            "ira_add_event_participants", "ira_update_participant_status",
            "ira_get_event_summary",
            # Email campaigns
            "ira_create_email_template", "ira_render_email_template",
            "ira_queue_bulk_emails", "ira_send_email_queue",
            # Communication logging & tasks
            "ira_log_communication", "ira_create_task", "ira_list_tasks",
            # Notifications & audit
            "ira_notify_teams", "ira_log_agent_action",
            # Segmentation
            "ira_create_group", "ira_list_groups", "ira_add_to_group",
            # Approval workflow
            "ira_create_approval", "ira_update_approval", "ira_list_approvals",
            # Materials
            "ira_upload_material", "ira_link_material",
            # IR report generation
            "send_ir_report",
        ],
        "packable": True,
        "tool_files": ["ira_tools.py", "send_ir_report.py"],
        "dependencies": ["requests>=2.31"],
        "system_dependencies": [],
        "config_schema": {
            "type": "object",
            "properties": {
                "IRA_API_BASE_URL": {
                    "type": "string",
                    "description": "Base URL of the IRA backend service",
                    "default": "http://localhost:8088/api/ira",
                },
                "IRA_API_TOKEN": {
                    "type": "string",
                    "description": "Bearer token for authenticating with the IRA API",
                },
            },
            "required": ["IRA_API_BASE_URL"],
        },
        "example_tasks": [
            "搜索所有外资机构投资者，按重要度排序",
            "为Q3业绩说明会创建活动并批量发送邮件邀请",
            "生成本周IR投资者互动报告",
        ],
    },
    # ── Industry Skill Pack: Market Intelligence ──────────────────────────────
    {
        "id": "market-intelligence-skill-pack",
        "name": "市场情报技能包 (Market Intelligence)",
        "description": (
            "日本市场监控与情报收集工具集：实时股价查询（含日股、ETF、加密货币）、"
            "每日市场动态报告生成、百悟机会情报（电信/银行/金融科技/采购）、"
            "股东监控，以及日本股票交易分析。"
        ),
        "latest_version": "1.0.0",
        "versions": ["1.0.0"],
        "author": "system",
        "category": "finance",
        "license": "MIT",
        "tags": [
            "market", "stock", "japan", "finance", "intelligence",
            "shareholder", "monitoring", "daily-report",
        ],
        "permissions_required": ["http_request"],
        "tools_provided": [
            "get_stock_price",
            "send_market_report",
            "baiwu_daily_report",
            "jp_stock_trading",
        ],
        "packable": True,
        "tool_files": [
            "get_stock_price.py",
            "send_market_report.py",
            "baiwu_daily_report.py",
            "jp_stock_trading.py",
        ],
        "dependencies": ["requests>=2.31", "yfinance>=0.2"],
        "system_dependencies": [],
        "config_schema": {
            "type": "object",
            "properties": {
                "MARKET_MONITOR_API_URL": {
                    "type": "string",
                    "description": "Market monitor backend API URL (optional)",
                },
                "BAIWU_API_URL": {
                    "type": "string",
                    "description": "Baiwu intelligence API URL (optional)",
                },
            },
        },
        "example_tasks": [
            "查询丰田汽车（7203.T）今日股价及52周高低点",
            "生成今日A股市场情报报告并发送给团队",
            "监控前十大股东持仓变化",
        ],
    },
]

# Dangerous patterns for security audit
_DANGEROUS_PATTERNS = [
    r"subprocess\.", r"os\.system", r"eval\(", r"exec\(",
    r"__import__", r"importlib", r"socket\.", r"ctypes\.",
    r"shutil\.rmtree", r"rm\s+-rf",
]


class SkillMarketplace:
    """Skills marketplace for discovering, installing, and managing agent skills."""

    def discover(self, query: str = "", category: str = "",
                 page: int = 1, size: int = 20) -> dict:
        """Search available skills in the registry."""
        results = list(BUILTIN_SKILLS)

        if query:
            q = query.lower()
            results = [
                s for s in results
                if q in s["name"].lower() or q in s["description"].lower()
                   or q in s.get("id", "").lower()
                   or any(q in t.lower() for t in s.get("tags", []))
            ]

        if category:
            results = [s for s in results if s.get("category") == category]

        total = len(results)
        start = (page - 1) * size
        items = results[start:start + size]

        return {
            "items": items,
            "total": total,
            "page": page,
            "size": size,
            "categories": sorted(set(s.get("category", "") for s in BUILTIN_SKILLS)),
        }

    def install(self, skill_id: str, version: str, config: dict, db: Session) -> dict:
        """Install a skill: validate, security audit, save to DB."""
        from app.models import Plugin

        # 1. Find skill in registry
        skill_info = next((s for s in BUILTIN_SKILLS if s["id"] == skill_id), None)
        if not skill_info:
            return {"status": "error", "error": f"Skill '{skill_id}' not found in registry"}

        # 2. Validate version
        effective_version = version or skill_info["latest_version"]
        if effective_version not in skill_info.get("versions", []):
            return {"status": "error", "error": f"Version '{effective_version}' not available"}

        # 3. Check if already installed
        existing = db.query(Plugin).filter(
            Plugin.name == skill_info["name"],
            Plugin.status == "installed",
        ).first()
        if existing:
            return {"status": "error", "error": f"Skill '{skill_info['name']}' already installed (id: {existing.id[:8]})"}

        # 4. Run security audit
        audit_result = self.audit(skill_id, effective_version)
        if audit_result.get("risk_level") == "blocked":
            return {"status": "blocked", "reason": "Security audit failed", "audit": audit_result}

        # 5. Create Plugin record
        plugin = Plugin(
            id=str(uuid.uuid4()),
            name=skill_info["name"],
            version=effective_version,
            description=skill_info["description"],
            config=config,
            status="installed",
            author=skill_info.get("author", "unknown"),
            category=skill_info.get("category", ""),
            permissions_required=skill_info.get("permissions_required", []),
            security_audit=audit_result,
            source_url=f"builtin://{skill_id}",
        )
        db.add(plugin)
        db.commit()

        logger.info("Installed skill: %s v%s (id: %s)", skill_info["name"], effective_version, plugin.id[:8])

        return {
            "status": "installed",
            "installation_id": plugin.id,
            "name": skill_info["name"],
            "version": effective_version,
            "tools_provided": skill_info.get("tools_provided", []),
            "installed_at": plugin.installed_at.isoformat() if plugin.installed_at else None,
        }

    def uninstall(self, plugin_id: str, db: Session) -> dict:
        """Uninstall a skill."""
        from app.models import Plugin

        plugin = db.query(Plugin).filter(Plugin.id == plugin_id).first()
        if not plugin:
            return {"status": "error", "error": "Plugin not found"}

        plugin.status = "uninstalled"
        plugin.uninstalled_at = datetime.utcnow()
        db.commit()

        logger.info("Uninstalled skill: %s (id: %s)", plugin.name, plugin.id[:8])
        return {"status": "uninstalled", "name": plugin.name}

    def upgrade(self, plugin_id: str, target_version: str, db: Session) -> dict:
        """Upgrade a skill to a new version."""
        from app.models import Plugin

        plugin = db.query(Plugin).filter(Plugin.id == plugin_id, Plugin.status == "installed").first()
        if not plugin:
            return {"status": "error", "error": "Plugin not found or not installed"}

        # Find in registry by name
        skill_info = next(
            (s for s in BUILTIN_SKILLS if s["name"] == plugin.name),
            None,
        )
        if not skill_info:
            return {"status": "error", "error": "Skill no longer in registry"}

        if target_version not in skill_info.get("versions", []):
            return {"status": "error", "error": f"Version '{target_version}' not available"}

        previous_version = plugin.version
        plugin.version = target_version
        plugin.security_audit = self.audit(skill_info["id"], target_version)
        db.commit()

        logger.info("Upgraded skill: %s %s → %s", plugin.name, previous_version, target_version)
        return {
            "status": "upgraded",
            "name": plugin.name,
            "previous_version": previous_version,
            "new_version": target_version,
        }

    def audit(self, skill_id: str, version: str) -> dict:
        """Security audit for a skill version."""
        skill_info = next((s for s in BUILTIN_SKILLS if s["id"] == skill_id), None)
        if not skill_info:
            return {"risk_level": "unknown", "error": "Skill not found"}

        # Check permissions required
        high_risk_perms = {"shell_execute", "file_write", "sql_query"}
        required = set(skill_info.get("permissions_required", []))
        risky = required & high_risk_perms

        # Built-in skills are trusted
        is_builtin = skill_info.get("author") == "system"

        risk_level = "low"
        warnings = []

        if risky and not is_builtin:
            risk_level = "medium"
            warnings.append(f"Requires high-risk permissions: {', '.join(risky)}")

        if not is_builtin:
            warnings.append("Third-party skill — review source before installing")
            # Scan for dangerous patterns (would scan actual code in production)
            risk_level = "medium"

        return {
            "skill_id": skill_id,
            "version": version,
            "risk_level": risk_level,
            "is_builtin": is_builtin,
            "permissions_required": list(required),
            "warnings": warnings,
            "audited_at": datetime.utcnow().isoformat(),
        }

    def get_installed(self, db: Session) -> list:
        """List installed skills from DB."""
        from app.models import Plugin
        plugins = db.query(Plugin).filter(Plugin.status == "installed").all()
        return [
            {
                "id": p.id,
                "name": p.name,
                "version": p.version,
                "description": p.description,
                "category": getattr(p, "category", ""),
                "author": getattr(p, "author", ""),
                "status": p.status,
                "installed_at": p.installed_at.isoformat() if p.installed_at else None,
            }
            for p in plugins
        ]


# Singleton
_marketplace = SkillMarketplace()


def get_marketplace() -> SkillMarketplace:
    return _marketplace
