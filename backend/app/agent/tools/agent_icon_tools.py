from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime
from pathlib import Path
import xml.etree.ElementTree as ET

from app.agent.context import AgentContext
from app.agent.tools.base import BaseTool


_CODEBASE_DIR = os.environ.get("AGENT_CODEBASE_DIR", "/app")
ICON_OUTPUT_DIR = os.environ.get(
    "ICON_OUTPUT_DIR",
    os.path.join(_CODEBASE_DIR, "frontend", "public", "icons"),
)
ICON_REGISTRY_FILE = os.environ.get(
    "ICON_REGISTRY_FILE",
    os.path.join(_CODEBASE_DIR, "frontend", "public", "icons", "icon_registry.jsonl"),
)

_DANGEROUS_SVG_RE = re.compile(
    r"<\s*(script|foreignObject|iframe|object|embed)\b|on\w+\s*=|javascript:",
    re.I,
)


def _slugify(value: str, fallback: str = "agent_icon") -> str:
    value = (value or "").strip()
    known = {
        "代理头像设计师": "agent_icon_designer",
        "代理图标设计师": "agent_icon_designer",
        "股东会组织助理": "shareholder_meeting_organizer_assistant",
        "支付交易对账": "payment_transaction_reconciliation",
        "支付交易对账助理": "payment_transaction_reconciliation_assistant",
        "售前技术支持工程师": "presales_tech_support",
        "售前技术支持": "presales_tech_support",
        "售前技术支持agent": "presales_tech_support",
        "售前技术支持Agent": "presales_tech_support",
    }
    if value in known:
        return known[value]

    # ASCII names: normal snake_case.
    ascii_value = value.encode("ascii", "ignore").decode("ascii")
    ascii_value = re.sub(r"[^A-Za-z0-9]+", "_", ascii_value).strip("_").lower()
    ascii_value = re.sub(r"_+", "_", ascii_value)
    if ascii_value:
        return ascii_value

    # Non-ASCII fallback: stable hash, filesystem-safe.
    digest = hashlib.sha1(value.encode("utf-8")).hexdigest()[:8]
    return f"{fallback}_{digest}"


def _clean_file_name(name: str) -> str:
    name = _slugify(name)
    name = re.sub(r"[^a-z0-9_\-]", "_", name.lower()).strip("_")
    return name or "agent_icon"


def _safe_svg(svg_code: str) -> bool:
    if not svg_code or "<svg" not in svg_code or "</svg>" not in svg_code:
        return False
    if _DANGEROUS_SVG_RE.search(svg_code):
        return False
    try:
        ET.fromstring(svg_code)
        return True
    except ET.ParseError:
        return False


def _payment_reconciliation_svg(title: str = "Payment reconciliation icon") -> str:
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" role="img" aria-label="{title}">
  <rect x="6" y="6" width="52" height="52" rx="16" fill="#F8FAFC"/>
  <rect x="13" y="17" width="28" height="18" rx="5" fill="#E0F2FE" stroke="#2563EB" stroke-width="3"/>
  <path d="M17 24h20" stroke="#2563EB" stroke-width="3" stroke-linecap="round"/>
  <path d="M18 30h8" stroke="#2563EB" stroke-width="3" stroke-linecap="round"/>
  <rect x="23" y="29" width="28" height="18" rx="5" fill="#DCFCE7" stroke="#16A34A" stroke-width="3"/>
  <path d="M30 38l5 5 10-11" stroke="#16A34A" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M44 18l5 5-5 5" stroke="#7C3AED" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M49 23H38" stroke="#7C3AED" stroke-width="3" stroke-linecap="round"/>
  <path d="M20 47l-5-5 5-5" stroke="#7C3AED" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M15 42h11" stroke="#7C3AED" stroke-width="3" stroke-linecap="round"/>
</svg>'''


def _generic_agent_svg(title: str = "Agent icon") -> str:
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" role="img" aria-label="{title}">
  <rect x="6" y="6" width="52" height="52" rx="16" fill="#F5F3FF"/>
  <circle cx="32" cy="30" r="15" fill="#DDD6FE" stroke="#7C3AED" stroke-width="3"/>
  <rect x="22" y="24" width="20" height="14" rx="7" fill="#111827"/>
  <circle cx="28" cy="31" r="2.5" fill="#FFFFFF"/>
  <circle cx="36" cy="31" r="2.5" fill="#FFFFFF"/>
  <path d="M28 39c2.5 2 5.5 2 8 0" stroke="#7C3AED" stroke-width="3" stroke-linecap="round"/>
  <path d="M32 15v-5" stroke="#7C3AED" stroke-width="3" stroke-linecap="round"/>
  <circle cx="32" cy="9" r="3" fill="#7C3AED"/>
  <path d="M18 46h28" stroke="#7C3AED" stroke-width="3" stroke-linecap="round"/>
</svg>'''


def _generate_svg(agent_name: str, description: str = "", style: str = "modern") -> str:
    text = f"{agent_name} {description}".lower()
    if any(k in text for k in ["支付", "交易", "对账", "payment", "transaction", "reconciliation"]):
        return _payment_reconciliation_svg(agent_name)
    return _generic_agent_svg(agent_name)


class NameFormatterTool(BaseTool):
    name = "name_formatter"
    specialized = True
    description = "Convert an agent name into a safe snake_case filename."
    parameters = {
        "type": "object",
        "properties": {
            "raw_name": {"type": "string", "description": "Original agent name."}
        },
        "required": ["raw_name"],
    }
    permission_level = 0

    def execute(self, params: dict, ctx: AgentContext) -> dict:
        raw_name = params.get("raw_name") or params.get("agent_name") or "agent_icon"
        file_name = _clean_file_name(str(raw_name))
        return {"file_name": file_name}


class SvgGeneratorTool(BaseTool):
    name = "svg_generator"
    specialized = True
    description = "Generate clean SVG icon code from an agent name and optional description."
    parameters = {
        "type": "object",
        "properties": {
            "agent_name": {"type": "string"},
            "description": {"type": "string"},
            "style": {"type": "string", "default": "modern"},
        },
        "required": ["agent_name"],
    }
    permission_level = 0

    def execute(self, params: dict, ctx: AgentContext) -> dict:
        agent_name = str(params.get("agent_name") or params.get("icon_name") or "Agent Icon")
        description = str(params.get("description") or "")
        style = str(params.get("style") or "modern")
        svg_code = _generate_svg(agent_name, description, style)
        return {"svg_code": svg_code}


class SvgValidatorTool(BaseTool):
    name = "svg_validator"
    specialized = True
    description = "Validate that SVG code is safe and parseable."
    parameters = {
        "type": "object",
        "properties": {"svg_code": {"type": "string"}},
        "required": ["svg_code"],
    }
    permission_level = 0

    def execute(self, params: dict, ctx: AgentContext) -> dict:
        svg_code = str(params.get("svg_code") or "")
        valid = _safe_svg(svg_code)
        return {"valid": valid, "error": None if valid else "Invalid or unsafe SVG"}


class IconFileWriterTool(BaseTool):
    name = "icon_file_writer"
    specialized = True
    description = "Save SVG code to the frontend public icons directory."
    parameters = {
        "type": "object",
        "properties": {
            "file_name": {"type": "string", "description": "Filename without extension."},
            "svg_code": {"type": "string"},
        },
        "required": ["file_name", "svg_code"],
    }
    permission_level = 0

    def execute(self, params: dict, ctx: AgentContext) -> dict:
        file_name = _clean_file_name(str(params.get("file_name") or "agent_icon"))
        svg_code = str(params.get("svg_code") or "")
        if not _safe_svg(svg_code):
            return {"error": "Invalid or unsafe SVG; file was not written", "validation_failed": True}

        base_path = Path(ICON_OUTPUT_DIR).expanduser().resolve()
        base_path.mkdir(parents=True, exist_ok=True)
        full_path = base_path / f"{file_name}.svg"
        full_path.write_text(svg_code, encoding="utf-8")
        return {"path": str(full_path), "public_url": f"/icons/{file_name}.svg"}


class PreviewRendererTool(BaseTool):
    name = "preview_renderer"
    specialized = True
    description = "Return the public SVG URL as a lightweight preview reference."
    parameters = {
        "type": "object",
        "properties": {"file_name": {"type": "string"}},
        "required": ["file_name"],
    }
    permission_level = 0

    def execute(self, params: dict, ctx: AgentContext) -> dict:
        file_name = _clean_file_name(str(params.get("file_name") or "agent_icon"))
        return {"preview_url": f"/icons/{file_name}.svg"}


class IconRegistryTool(BaseTool):
    name = "icon_registry"
    specialized = True
    description = "Register icon metadata in a JSONL registry file."
    parameters = {
        "type": "object",
        "properties": {
            "agent_name": {"type": "string"},
            "file_path": {"type": "string"},
            "public_url": {"type": "string"},
            "style": {"type": "string"},
        },
        "required": ["agent_name", "file_path"],
    }
    permission_level = 0

    def execute(self, params: dict, ctx: AgentContext) -> dict:
        registry_path = Path(ICON_REGISTRY_FILE).expanduser().resolve()
        registry_path.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "agent_name": params.get("agent_name"),
            "file_path": params.get("file_path"),
            "public_url": params.get("public_url"),
            "style": params.get("style") or "modern",
            "created_at": datetime.now().isoformat(),
        }
        with registry_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
        return {"registered": True, "registry_file": str(registry_path)}


class DesignTokenManagerTool(BaseTool):
    name = "design_token_manager"
    specialized = True
    description = "Return default design tokens for the icon system."
    parameters = {"type": "object", "properties": {}}
    permission_level = 0

    def execute(self, params: dict, ctx: AgentContext) -> dict:
        return {
            "primary": "#7C3AED",
            "secondary": "#2563EB",
            "success": "#16A34A",
            "background": "#F8FAFC",
            "stroke_width": 3,
            "corner_radius": 16,
        }


class CreateIconTool(BaseTool):
    name = "create_icon"
    specialized = True
    description = "One-shot workflow: generate, validate, save, and register an SVG icon for an agent."
    parameters = {
        "type": "object",
        "properties": {
            "agent_name": {"type": "string", "description": "Name of the agent."},
            "description": {"type": "string", "description": "Agent purpose or visual requirements."},
            "file_name": {"type": "string", "description": "Optional filename without extension."},
            "style": {"type": "string", "default": "modern"},
        },
        "required": ["agent_name"],
    }
    permission_level = 0

    def execute(self, params: dict, ctx: AgentContext) -> dict:
        agent_name = str(params.get("agent_name") or "Agent Icon")
        description = str(params.get("description") or "")
        style = str(params.get("style") or "modern")
        file_name = _clean_file_name(str(params.get("file_name") or agent_name))

        svg_code = _generate_svg(agent_name, description, style)
        if not _safe_svg(svg_code):
            return {"error": "Generated SVG failed validation", "validation_failed": True}

        base_path = Path(ICON_OUTPUT_DIR).expanduser().resolve()
        base_path.mkdir(parents=True, exist_ok=True)
        full_path = base_path / f"{file_name}.svg"
        full_path.write_text(svg_code, encoding="utf-8")
        public_url = f"/icons/{file_name}.svg"

        try:
            registry_path = Path(ICON_REGISTRY_FILE).expanduser().resolve()
            registry_path.parent.mkdir(parents=True, exist_ok=True)
            record = {
                "agent_name": agent_name,
                "description": description,
                "file_name": file_name,
                "file_path": str(full_path),
                "public_url": public_url,
                "style": style,
                "created_at": datetime.now().isoformat(),
            }
            with registry_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
        except Exception as e:
            return {
                "path": str(full_path),
                "public_url": public_url,
                "warning": f"Icon saved, but registry update failed: {e}",
            }

        return {
            "path": str(full_path),
            "public_url": public_url,
            "file_name": file_name,
            "svg_code": svg_code,
        }
