from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

from starlette.requests import Request

from app.routers.studio.agents import OptimizePromptRequest, optimize_prompt


def test_optimize_prompt_is_forwarded_to_core():
    body = OptimizePromptRequest(text="你是一名专业的客户服务专员。")
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/v1/agents/optimize-prompt",
            "headers": [(b"authorization", b"Bearer test-token")],
        }
    )
    expected = {
        "optimized": "You are a professional customer service specialist.",
        "original_tokens": 10,
        "optimized_tokens": 11,
        "original_chars": 14,
        "optimized_chars": 51,
    }

    with patch(
        "app.services.core_runtime_proxy.post_to_core",
        new=AsyncMock(return_value=expected),
    ) as post_to_core:
        result = asyncio.run(optimize_prompt(body, request, user=object()))

    assert result == expected
    post_to_core.assert_awaited_once_with(
        request,
        "/api/v1/agents/optimize-prompt",
        {"text": body.text},
    )
