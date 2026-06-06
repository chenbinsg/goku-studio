"""
Enterprise connector webhook endpoints.
Receives messages from DingTalk, Feishu, etc. and creates agent tasks.
"""
import logging
import os
from fastapi import APIRouter, Request, HTTPException, Depends

from app import auth, models
from app.services.webhook_security import allow_missing_webhook_secret

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/connectors", tags=["connectors"])


def _require_superuser(current_user: models.User = Depends(auth.get_current_user)) -> models.User:
    if not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="Admin required")
    return current_user


@router.get("")
def list_connectors(current_user: models.User = Depends(auth.get_current_user)):
    """List configured connectors and their status."""
    from app.db import SessionLocal
    from app.routers.studio.connector_config import _load_all_configs, _get_value

    # Load DB connector configs for accurate status (falls back to env vars automatically)
    try:
        _db = SessionLocal()
        try:
            _cfgs = _load_all_configs(_db)
        finally:
            _db.close()
    except Exception:
        _cfgs = {}

    def _cfg(key: str) -> str:
        return _get_value(_cfgs, key)

    connectors = []

    # ── Outlook / Email ────────────────────────────────────────────────────────
    smtp_host      = _cfg("CONNECTOR_EMAIL_HOST") or os.environ.get("SMTP_HOST", "")
    smtp_user      = _cfg("CONNECTOR_EMAIL_USER") or os.environ.get("SMTP_USER", "")
    graph_ok = bool(
        os.environ.get("OUTLOOK_CLIENT_ID")
        and os.environ.get("OUTLOOK_CLIENT_SECRET")
        and os.environ.get("OUTLOOK_TENANT_ID")
        and os.environ.get("OUTLOOK_MAILBOX")
    )
    imap_ok = bool(
        os.environ.get("IMAP_HOST")
        and os.environ.get("IMAP_USER")
        and os.environ.get("IMAP_PASS")
    )
    smtp_ok = bool(smtp_host and smtp_user)

    email_capabilities = []
    if smtp_ok:
        email_capabilities.append(f"发送 (SMTP: {smtp_user})")
    if graph_ok:
        email_capabilities.append(f"收取 (Graph API: {os.environ.get('OUTLOOK_MAILBOX','')})")
    elif imap_ok:
        email_capabilities.append(f"收取 (IMAP: {os.environ.get('IMAP_USER','')})")

    connectors.append({
        "name": "outlook",
        "display_name": "Outlook / Email",
        "configured": smtp_ok or graph_ok or imap_ok,
        "webhook_path": "/api/v1/outlook/status",
        "detail": "、".join(email_capabilities) if email_capabilities else "未配置 SMTP / Graph API / IMAP",
        "capabilities": {
            "send": smtp_ok,
            "receive": graph_ok or imap_ok,
        },
    })

    # ── Microsoft Teams ────────────────────────────────────────────────────────
    teams_app_id   = _cfg("CONNECTOR_TEAMS_APP_ID") or os.environ.get("TEAMS_APP_ID", "")
    teams_webhook  = _cfg("CONNECTOR_TEAMS_WEBHOOK_URL") or os.environ.get("TEAMS_WEBHOOK_URL", "")

    teams_caps = []
    if teams_webhook:
        teams_caps.append("主动发送 (Webhook)")
    if teams_app_id:
        teams_caps.append("Bot 双向接入")

    connectors.append({
        "name": "teams",
        "display_name": "Microsoft Teams",
        "configured": bool(teams_app_id or teams_webhook),
        "webhook_path": "/api/v1/connectors/teams/webhook",
        "detail": "、".join(teams_caps) if teams_caps else "未配置 TEAMS_WEBHOOK_URL 或 TEAMS_APP_ID",
        "capabilities": {
            "send": bool(teams_webhook or teams_app_id),
            "receive": bool(teams_app_id),
        },
    })

    # ── Feishu ─────────────────────────────────────────────────────────────────
    fs_url = _cfg("CONNECTOR_FEISHU_WEBHOOK_URL") or os.environ.get("FEISHU_WEBHOOK_URL", "")
    fs_app_id = _cfg("CONNECTOR_FEISHU_APP_ID") or os.environ.get("FEISHU_APP_ID", "")
    fs_app_secret = _cfg("CONNECTOR_FEISHU_APP_SECRET") or os.environ.get("FEISHU_APP_SECRET", "")
    fs_caps = []
    if fs_url:
        fs_caps.append("Webhook 通知")
    if fs_app_id and fs_app_secret:
        fs_caps.append("应用机器人会话")
    connectors.append({
        "name": "feishu",
        "display_name": "飞书",
        "configured": bool(fs_url or (fs_app_id and fs_app_secret)),
        "webhook_path": "/api/v1/unicall/webhooks/feishu",
        "detail": "、".join(fs_caps) if fs_caps else "未配置 FEISHU_WEBHOOK_URL 或 FEISHU_APP_ID/SECRET",
        "capabilities": {"send": bool(fs_url or (fs_app_id and fs_app_secret)), "receive": bool(fs_app_id and fs_app_secret)},
    })

    # ── WeChat Work (企业微信) ──────────────────────────────────────────────────
    wechat_bot_key  = os.environ.get("WECHAT_BOT_WEBHOOK_KEY", "")
    wechat_corp_id  = os.environ.get("WECHAT_CORP_ID", "")
    wechat_agent_id = os.environ.get("WECHAT_AGENT_ID", "")

    wechat_caps = []
    if wechat_bot_key:
        wechat_caps.append("群机器人通知 (Bot Webhook)")
    if wechat_corp_id and wechat_agent_id:
        wechat_caps.append("双向 App 消息 (Corp API)")

    connectors.append({
        "name": "wechat",
        "display_name": "企业微信 (WeChat Work)",
        "configured": bool(wechat_bot_key or (wechat_corp_id and wechat_agent_id)),
        "webhook_path": "/api/v1/connectors/wechat/webhook",
        "detail": "、".join(wechat_caps) if wechat_caps else "未配置 WECHAT_BOT_WEBHOOK_KEY 或 WECHAT_CORP_ID",
        "capabilities": {
            "send": bool(wechat_bot_key or wechat_corp_id),
            "receive": bool(wechat_corp_id and os.environ.get("WECHAT_ENCODING_AES_KEY")),
        },
    })

    # ── LINE ───────────────────────────────────────────────────────────────────
    line_secret = os.environ.get("LINE_CHANNEL_SECRET", "")
    line_token  = os.environ.get("LINE_CHANNEL_ACCESS_TOKEN", "")
    connectors.append({
        "name": "line",
        "display_name": "LINE Messaging",
        "configured": bool(line_secret and line_token),
        "webhook_path": "/api/v1/line/webhook",
        "detail": "LINE Bot 已配置" if (line_secret and line_token) else "未配置 LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN",
        "capabilities": {"send": bool(line_token), "receive": bool(line_secret)},
    })

    # ── Telegram ───────────────────────────────────────────────────────────────
    tg_token   = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    tg_wh_tok  = os.environ.get("TELEGRAM_WEBHOOK_TOKEN", "")
    connectors.append({
        "name": "telegram",
        "display_name": "Telegram Bot",
        "configured": bool(tg_token),
        "webhook_path": f"/api/v1/telegram/webhook/{tg_wh_tok}" if tg_wh_tok else "/api/v1/telegram/webhook/<token>",
        "detail": (
            "Bot 已配置，Webhook token 已设置" if (tg_token and tg_wh_tok)
            else "Bot token 已配置，请设置 TELEGRAM_WEBHOOK_TOKEN" if tg_token
            else "未配置 TELEGRAM_BOT_TOKEN"
        ),
        "capabilities": {"send": bool(tg_token), "receive": bool(tg_token and tg_wh_tok)},
        "setup_url": "/api/v1/telegram/register",
    })

    # ── WhatsApp Business ──────────────────────────────────────────────────────
    wa_token   = os.environ.get("WHATSAPP_TOKEN", "")
    wa_phone   = os.environ.get("WHATSAPP_PHONE_NUMBER_ID", "")
    wa_verify  = os.environ.get("WHATSAPP_VERIFY_TOKEN", "")
    wa_ok      = bool(wa_token and wa_phone)
    connectors.append({
        "name": "whatsapp",
        "display_name": "WhatsApp Business",
        "configured": wa_ok,
        "webhook_path": "/api/v1/whatsapp/webhook",
        "detail": (
            f"WhatsApp Business 已配置 (Phone ID: {wa_phone[:8]}...)" if wa_ok
            else "未配置 WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID"
        ),
        "capabilities": {"send": wa_ok, "receive": bool(wa_ok and wa_verify)},
    })

    # ── Discord Bot ────────────────────────────────────────────────────────────
    dc_app_id  = os.environ.get("DISCORD_APPLICATION_ID", "")
    dc_pub_key = os.environ.get("DISCORD_PUBLIC_KEY", "")
    dc_token   = os.environ.get("DISCORD_BOT_TOKEN", "")
    dc_ok      = bool(dc_app_id and dc_token)
    connectors.append({
        "name": "discord",
        "display_name": "Discord Bot",
        "configured": dc_ok,
        "webhook_path": "/api/v1/discord/interactions",
        "detail": (
            "Discord Bot 已配置" if dc_ok
            else "未配置 DISCORD_APPLICATION_ID / DISCORD_BOT_TOKEN"
        ),
        "capabilities": {"send": bool(dc_token), "receive": bool(dc_app_id and dc_pub_key)},
    })

    return {"connectors": connectors}


@router.post("/dingtalk/webhook")
async def dingtalk_webhook(request: Request):
    """Receive messages from DingTalk bot."""
    from app.services.connectors.dingtalk import DingTalkConnector
    from app.services.im import process_message

    body = await request.body()
    payload = await request.json()

    connector = DingTalkConnector()

    # Verify signature
    timestamp = request.headers.get("timestamp", "")
    sign = request.headers.get("sign", "")
    if not connector.verify_webhook(timestamp, sign, body):
        raise HTTPException(status_code=403, detail="Invalid signature")

    # Parse event
    event = connector.parse_event(payload)

    if not event.get("text"):
        return {"msgtype": "empty", "empty": {}}

    # Process message — create task
    result = process_message(
        platform="dingtalk",
        channel=event.get("channel", ""),
        user=event.get("user", ""),
        text=event["text"],
    )

    # Reply to DingTalk
    if result.get("task_id"):
        reply_text = f"收到，任务已创建: {result['task_id'][:8]}..."
    else:
        reply_text = result.get("response", "处理失败")

    return {
        "msgtype": "text",
        "text": {"content": reply_text},
    }


@router.post("/feishu/webhook")
async def feishu_webhook(request: Request):
    """Receive messages from Feishu event subscription."""
    from app.services.connectors.feishu import FeishuConnector
    from app.services.im import process_message

    body = await request.body()
    payload = await request.json()

    connector = FeishuConnector()

    # Handle challenge verification
    if payload.get("type") == "url_verification":
        event = connector.parse_event(payload)
        return {"challenge": event.get("challenge", "")}

    # Verify signature
    timestamp = request.headers.get("X-Lark-Request-Timestamp", "")
    sign = request.headers.get("X-Lark-Signature", "")
    if not sign or not timestamp or not connector.verify_webhook(timestamp, sign, body):
        raise HTTPException(status_code=403, detail="Invalid signature")

    # Parse event
    event = connector.parse_event(payload)

    if event.get("type") != "message" or not event.get("text"):
        return {"code": 0, "msg": "ok"}

    # Process message — create task
    result = process_message(
        platform="feishu",
        channel=event.get("channel", ""),
        user=event.get("user", ""),
        text=event["text"],
    )

    return {"code": 0, "msg": "ok", "task_id": result.get("task_id")}


@router.post("/teams/webhook")
async def teams_webhook(request: Request):
    """Receive messages from Microsoft Teams via Bot Framework."""
    import json as _json
    from app.services.connectors.teams import TeamsConnector
    from app.services.im import process_message

    payload = await request.json()
    connector = TeamsConnector()

    # Verify auth token
    auth_header = request.headers.get("Authorization", "")
    if not connector.verify_webhook(sign=auth_header):
        raise HTTPException(status_code=403, detail="Invalid authorization")

    # Parse event
    event = connector.parse_event(payload)

    # Skip non-message activities
    if event.get("msg_type") != "message" or not event.get("text"):
        return {"status": "ok"}

    # Process message — create task
    result = process_message(
        platform="teams",
        channel=event.get("channel", ""),
        user=event.get("user", ""),
        text=event["text"],
    )

    # Reply to Teams conversation
    if result.get("task_id"):
        reply_text = f"Received! Task created: {result['task_id'][:8]}..."
    else:
        reply_text = result.get("response", "Processing failed")

    conv_ref = event.get("conversation_ref", {})
    if conv_ref.get("serviceUrl"):
        connector.send_message(
            target=_json.dumps(conv_ref),
            content=reply_text,
        )

    return {"status": "ok", "task_id": result.get("task_id")}


@router.get("/wechat/webhook")
async def wechat_webhook_verify(request: Request):
    """
    WeChat Work callback URL verification (GET).
    WeChat sends: ?msg_signature=xx&timestamp=xx&nonce=xx&echostr=xx
    We must decrypt echostr and return it plain.
    """
    from app.services.connectors.wechat import WeChatWorkConnector, _decrypt_msg

    params = request.query_params
    msg_signature = params.get("msg_signature", "")
    timestamp     = params.get("timestamp", "")
    nonce         = params.get("nonce", "")
    echostr       = params.get("echostr", "")

    connector = WeChatWorkConnector()
    if not connector.verify_callback_signature(timestamp, nonce, msg_signature, echostr):
        raise HTTPException(status_code=403, detail="Invalid signature")

    # Decrypt echostr and return it
    decrypted = _decrypt_msg(echostr) if echostr else None
    if decrypted is None:
        if not allow_missing_webhook_secret("wechat work"):
            raise HTTPException(status_code=403, detail="Encrypted callback verification required")
        from fastapi.responses import PlainTextResponse
        return PlainTextResponse(echostr)

    from fastapi.responses import PlainTextResponse
    return PlainTextResponse(decrypted.decode("utf-8") if isinstance(decrypted, bytes) else decrypted)


@router.post("/wechat/webhook")
async def wechat_webhook(request: Request):
    """
    Receive messages from WeChat Work Corporate App callback.
    WeChat sends encrypted XML via POST.
    """
    from app.services.connectors.wechat import WeChatWorkConnector
    from app.services.im import process_message

    params    = request.query_params
    timestamp = params.get("timestamp", "")
    nonce     = params.get("nonce", "")
    msg_sig   = params.get("msg_signature", "")

    body = await request.body()
    body_str = body.decode("utf-8")

    connector = WeChatWorkConnector()

    # Decrypt the XML body
    payload = connector.decrypt_callback(body_str)
    if payload is None:
        logger.warning("WeChat Work: failed to decrypt callback body")
        return {"success": False}

    # Verify signature using the Encrypt field from raw XML
    import xml.etree.ElementTree as ET
    try:
        raw_root = ET.fromstring(body_str)
        raw = {child.tag: (child.text or "") for child in raw_root}
        encrypt_field = raw.get("Encrypt", "")
    except Exception:
        encrypt_field = ""

    if not msg_sig or not timestamp or not nonce:
        raise HTTPException(status_code=403, detail="Missing callback signature")
    if not encrypt_field and not allow_missing_webhook_secret("wechat work"):
        raise HTTPException(status_code=403, detail="Encrypted callback payload required")
    if not connector.verify_callback_signature(timestamp, nonce, msg_sig, encrypt_field):
        raise HTTPException(status_code=403, detail="Invalid signature")

    # Parse the decrypted event
    event = connector.parse_event(payload)

    if not event.get("text"):
        # Return empty success for non-text events (e.g. subscriptions)
        return "<xml><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[]]></Content></xml>"

    from_user = event.get("user", "")

    # Process message — create task, run agent, reply back
    result = process_message(
        platform="wechat",
        channel=event.get("channel", ""),
        user=from_user,
        user_name=event.get("user_name", from_user),
        text=event["text"],
        receive_id=from_user,
        receive_id_type="userid",
    )

    # WeChat Work requires immediate HTTP 200 response (process async)
    return {"success": True, "task_id": result.get("task_id")}


@router.post("/{connector_name}/send")
async def send_connector_message(
    connector_name: str,
    data: dict,
    current_user: models.User = Depends(_require_superuser),
):
    """Send a message via a connector (feishu, dingtalk, teams)."""
    target = data.get("target", "")
    content = data.get("content", "")
    msg_type = data.get("msg_type", "text")

    if not content:
        raise HTTPException(status_code=400, detail="content is required")

    if connector_name == "feishu":
        from app.services.connectors.feishu import FeishuConnector
        connector = FeishuConnector()
    elif connector_name == "dingtalk":
        from app.services.connectors.dingtalk import DingTalkConnector
        connector = DingTalkConnector()
    elif connector_name == "teams":
        from app.services.connectors.teams import TeamsConnector
        connector = TeamsConnector()
    elif connector_name == "wechat":
        from app.services.connectors.wechat import WeChatWorkConnector
        connector = WeChatWorkConnector()
    else:
        raise HTTPException(status_code=400, detail=f"Unknown connector: {connector_name}")

    result = connector.send_message(target=target, content=content, msg_type=msg_type)
    return result


@router.post("/test")
async def test_connector(data: dict, current_user: models.User = Depends(_require_superuser)):
    """Test a connector configuration by sending a test message."""
    connector_name = data.get("connector", "")
    target = data.get("target", "")
    message = data.get("message", "AI Agent 连接测试 ✓")

    if connector_name == "dingtalk":
        from app.services.connectors.dingtalk import DingTalkConnector
        connector = DingTalkConnector()
    elif connector_name == "feishu":
        from app.services.connectors.feishu import FeishuConnector
        connector = FeishuConnector()
    elif connector_name == "teams":
        from app.services.connectors.teams import TeamsConnector
        connector = TeamsConnector()
    elif connector_name == "wechat":
        from app.services.connectors.wechat import WeChatWorkConnector
        connector = WeChatWorkConnector()
    else:
        raise HTTPException(status_code=400, detail=f"Unknown connector: {connector_name}")

    result = connector.send_message(target=target, content=message, msg_type="text")
    return result
