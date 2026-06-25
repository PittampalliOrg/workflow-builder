"""Unit tests for the Z.AI adapter vision (B1) + per-model endpoint routing (B3)."""

from __future__ import annotations

import importlib
import os

import pytest

zai = importlib.import_module("src.zai_adapter")


@pytest.fixture(autouse=True)
def _clear_env(monkeypatch):
    for k in (
        "ZAI_BASE_URL",
        "ZAI_CODING_BASE_URL",
        "ZAI_PAAS_BASE_URL",
        "ZAI_API_KEY",
        "ZAI_PAAS_API_KEY",
        "ZAI_PAAS_COMPONENTS",
    ):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("ZAI_API_KEY", "test-key")


# --- B3: per-model endpoint routing ---------------------------------------

def test_coding_model_uses_coding_endpoint():
    assert zai._zai_base_url("llm-glm-5.2").endswith("/coding/paas/v4")
    assert not zai._is_zai_paas_component("llm-glm-5.2")


def test_vlm_model_uses_paas_endpoint():
    assert zai._is_zai_paas_component("llm-glm-5v-turbo")
    assert zai._zai_base_url("llm-glm-5v-turbo").endswith("/paas/v4")
    assert "/coding/" not in zai._zai_base_url("llm-glm-5v-turbo")


def test_explicit_base_url_overrides_both(monkeypatch):
    monkeypatch.setenv("ZAI_BASE_URL", "https://example.test/v9")
    assert zai._zai_base_url("llm-glm-5.2") == "https://example.test/v9"
    assert zai._zai_base_url("llm-glm-5v-turbo") == "https://example.test/v9"


def test_vlm_model_id_mapped():
    assert zai._get_zai_model("llm-glm-5v-turbo") == "glm-5v-turbo"
    assert zai._is_zai_component("llm-glm-5v-turbo")


def test_paas_uses_separate_key_when_present(monkeypatch):
    monkeypatch.setenv("ZAI_PAAS_API_KEY", "paas-key")
    headers, mode = zai._auth_headers("llm-glm-5v-turbo")
    assert headers["Authorization"] == "Bearer paas-key"
    assert mode == "zai-paas-key"
    # coding model still uses the account key
    headers2, mode2 = zai._auth_headers("llm-glm-5.2")
    assert headers2["Authorization"] == "Bearer test-key"
    assert mode2 == "zai-api-key"


def test_paas_falls_back_to_account_key(monkeypatch):
    headers, mode = zai._auth_headers("llm-glm-5v-turbo")
    assert headers["Authorization"] == "Bearer test-key"
    assert mode == "zai-api-key"


# --- B1: vision content parts + deferred trailing image -------------------

ANTHROPIC_IMG = {
    "type": "image",
    "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"},
}
MCP_IMG = {"type": "image", "data": "BBBB", "mimeType": "image/jpeg"}


def test_to_parts_anthropic_and_mcp_shapes():
    parts, has = zai._to_zai_content_parts([{"type": "text", "text": "hi"}, ANTHROPIC_IMG])
    assert has
    assert parts[0] == {"type": "text", "text": "hi"}
    assert parts[1]["type"] == "image_url"
    assert parts[1]["image_url"]["url"] == "data:image/png;base64,AAAA"

    parts2, has2 = zai._to_zai_content_parts([MCP_IMG])
    assert has2
    assert parts2[0]["image_url"]["url"] == "data:image/jpeg;base64,BBBB"


def test_plain_text_no_image():
    parts, has = zai._to_zai_content_parts("just text")
    assert not has
    assert parts == [{"type": "text", "text": "just text"}]


def test_tool_image_deferred_to_trailing_user_message():
    msgs = zai._normalize_messages_for_zai(
        None,
        [
            {"role": "user", "content": "judge the page"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"id": "c1", "type": "function", "function": {"name": "shot", "arguments": "{}"}}
                ],
            },
            {"role": "tool", "tool_call_id": "c1", "content": [{"type": "text", "text": "ok"}, ANTHROPIC_IMG]},
        ],
    )
    # tool message stays text-only (linkage intact), image rides a trailing user msg
    tool_msg = next(m for m in msgs if m.get("role") == "tool")
    assert isinstance(tool_msg["content"], str)
    last = msgs[-1]
    assert last["role"] == "user"
    assert isinstance(last["content"], list)
    assert any(p.get("type") == "image_url" for p in last["content"])


def test_image_cap_keeps_last_n(monkeypatch):
    monkeypatch.setenv("DAPR_AGENT_PY_MAX_IMAGE_TOOL_RESULTS", "2")
    importlib.reload(zai)
    monkeypatch.setenv("ZAI_API_KEY", "test-key")
    src = [{"role": "user", "content": "x"}]
    for i in range(4):
        src.append({
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": f"c{i}", "type": "function", "function": {"name": "shot", "arguments": "{}"}}],
        })
        src.append({"role": "tool", "tool_call_id": f"c{i}", "content": [{"type": "image", "data": str(i), "mimeType": "image/png"}]})
    msgs = zai._normalize_messages_for_zai(None, src)
    imgs = [p for m in msgs if isinstance(m.get("content"), list) for p in m["content"] if p.get("type") == "image_url"]
    assert len(imgs) == 2
    # most-recent kept
    assert imgs[-1]["image_url"]["url"].endswith("base64,3")
    importlib.reload(zai)
