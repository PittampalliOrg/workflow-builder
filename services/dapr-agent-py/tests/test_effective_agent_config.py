from __future__ import annotations

import json
import os
import sys

import pytest


root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

from src.effective_agent_config import (  # noqa: E402
    build_effective_agent_config,
    effective_audit_fields,
    resolve_llm_component,
    resolve_llm_metadata,
    runtime_context_audit_cache_fields,
)


def test_config_hash_is_stable_for_semantically_identical_config() -> None:
    config_a = {
        "modelSpec": "openai/o3",
        "builtinTools": ["write_file", "read_file"],
        "tools": ["write_file", "read_file"],
        "mcpServers": [
            {
                "serverName": "GitHub",
                "transport": "streamable-http",
                "allowedTools": ["get_issue", "list_repositories"],
            }
        ],
    }
    config_b = {
        "tools": ["read_file", "write_file"],
        "mcpServers": [
            {
                "allowedTools": ["list_repositories", "get_issue"],
                "transport": "streamable_http",
                "serverName": "GitHub",
            }
        ],
        "builtinTools": ["read_file", "write_file"],
        "modelSpec": "openai/o3",
    }

    first = build_effective_agent_config(
        agent_config=config_a,
        raw_message={"agentId": "agt_1", "cwd": "/work"},
        turn=1,
        config_revision=1,
        cwd="/work",
    )
    second = build_effective_agent_config(
        agent_config=config_b,
        raw_message={"cwd": "/work", "agentId": "agt_1"},
        turn=2,
        config_revision=1,
        cwd="/work",
    )

    assert first["configHash"] == second["configHash"]
    assert first["turn"] == 1
    assert second["turn"] == 2


def test_snapshot_excludes_prompts_auth_headers_env_and_schemas() -> None:
    snapshot = build_effective_agent_config(
        agent_config={
            "modelSpec": "anthropic/claude-opus-4-7",
            "systemPrompt": "secret system prompt",
            "instructions": ["do hidden thing"],
            "mcpServers": [
                {
                    "serverName": "private",
                    "transport": "stdio",
                    "command": "node",
                    "env": {"TOKEN": "vault-token"},
                    "headers": {"Authorization": "Bearer secret"},
                    "allowedTools": ["search"],
                    "toolSchemas": {"search": {"properties": {"q": {"type": "string"}}}},
                }
            ],
        },
        raw_message={"prompt": "raw user text", "cwd": "/sandbox"},
        turn=1,
        config_revision=1,
        cwd="/sandbox",
    )

    encoded = json.dumps(snapshot, sort_keys=True)
    assert "secret system prompt" not in encoded
    assert "raw user text" not in encoded
    assert "Bearer secret" not in encoded
    assert "vault-token" not in encoded
    assert "properties" not in encoded
    assert snapshot["tools"]["mcpServers"] == [
        {
            "serverName": "private",
            "transport": "stdio",
            "toolNames": ["search"],
        }
    ]


@pytest.mark.parametrize(
    ("model_spec", "llm_component", "provider", "provider_model"),
    [
        ("openai/gpt-5.5", "llm-openai-gpt5", "openai", "gpt-5.5"),
        ("openai/gpt-5.4", "llm-openai-gpt5", "openai", "gpt-5.5"),
        (
            "anthropic/claude-opus-4-8",
            "llm-anthropic-opus",
            "anthropic",
            "claude-opus-4-8",
        ),
        (
            "anthropic/claude-opus-4-7",
            "llm-anthropic-opus",
            "anthropic",
            "claude-opus-4-8",
        ),
        ("openai/o3", "llm-openai-o3", "openai", "o3"),
        (
            "nvidia/meta/llama-3.1-8b-instruct",
            "llm-nvidia-llama31-8b",
            "nvidia",
            "meta/llama-3.1-8b-instruct",
        ),
        (
            "nvidia/mistralai/mistral-medium-3.5-128b",
            "llm-nvidia-mistral-medium-35-128b",
            "nvidia",
            "mistralai/mistral-medium-3.5-128b",
        ),
        (
            "nvidia/qwen/qwen3-coder-480b-a35b-instruct",
            "llm-nvidia-qwen3-coder-480b",
            "nvidia",
            "qwen/qwen3-coder-480b-a35b-instruct",
        ),
        (
            "nvidia/mistralai/devstral-2-123b-instruct-2512",
            "llm-nvidia-devstral-2-123b",
            "nvidia",
            "mistralai/devstral-2-123b-instruct-2512",
        ),
        (
            "nvidia/z-ai/glm4.7",
            "llm-nvidia-glm47",
            "nvidia",
            "z-ai/glm4.7",
        ),
        (
            "foundry/DeepSeek-V4-Flash",
            "llm-foundry-deepseek-v4-flash",
            "foundry",
            "DeepSeek-V4-Flash",
        ),
        (
            "together/zai-org/GLM-5.1",
            "llm-together-glm-51",
            "together",
            "zai-org/GLM-5.1",
        ),
        (
            "together/Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
            "llm-together-qwen3-coder-480b",
            "together",
            "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
        ),
        (
            "together/deepseek-ai/DeepSeek-V4-Pro",
            "llm-together-deepseek-v4-pro",
            "together",
            "deepseek-ai/DeepSeek-V4-Pro",
        ),
        (
            "deepseek/deepseek-v4-pro",
            "llm-deepseek-v4-pro",
            "deepseek",
            "deepseek-v4-pro",
        ),
        (
            "alibaba/qwen3-coder-plus",
            "llm-alibaba-qwen3-coder-plus",
            "alibaba",
            "qwen3-coder-plus",
        ),
        (
            "deepseek-v4-flash",
            "llm-deepseek-v4-flash",
            "deepseek",
            "deepseek-v4-flash",
        ),
        ("kimi/kimi-k3", "llm-kimi-k3", "kimi", "kimi-k3"),
        (
            "googleai/gemini-3-pro-preview",
            "llm-google-gemini",
            "googleai",
            "gemini-3.1-pro-preview",
        ),
        (
            "googleai/gemini-3.1-pro-preview",
            "llm-google-gemini",
            "googleai",
            "gemini-3.1-pro-preview",
        ),
        ("deepseek/default", "llm-deepseek", "deepseek", "default"),
        (
            "huggingface/meta-llama/Meta-Llama-3-8B",
            "llm-huggingface-llama3",
            "huggingface",
            "meta-llama/Meta-Llama-3-8B",
        ),
        ("mistral/open-mistral-7b", "llm-mistral-open", "mistral", "open-mistral-7b"),
        ("echo/local", "llm-echo", "echo", "local"),
    ],
)
def test_model_mapping_records_spec_component_provider_and_provider_model(
    model_spec: str,
    llm_component: str,
    provider: str,
    provider_model: str,
) -> None:
    llm = resolve_llm_metadata(message={"agentConfig": {"modelSpec": model_spec}})

    expected = {
        "modelSpec": model_spec,
        "llmComponent": llm_component,
        "provider": provider,
        "providerModel": provider_model,
    }
    if llm_component == "llm-kimi-k3":
        expected.update(
            {
                "contextWindowTokens": 1_048_576,
                "reasoningEffort": "max",
            }
        )
    assert llm == expected


def test_mcp_auth_changes_do_not_change_hash() -> None:
    base = {
        "modelSpec": "openai/o3",
        "mcpServers": [
            {
                "serverName": "github",
                "transport": "streamable_http",
                "headers": {"Authorization": "Bearer one"},
            }
        ],
    }
    changed_secret = {
        **base,
        "mcpServers": [
            {
                "serverName": "github",
                "transport": "streamable_http",
                "headers": {"Authorization": "Bearer two"},
            }
        ],
    }

    first = build_effective_agent_config(
        agent_config=base,
        raw_message={},
        turn=1,
        config_revision=1,
        cwd="/sandbox",
    )
    second = build_effective_agent_config(
        agent_config=changed_secret,
        raw_message={},
        turn=1,
        config_revision=1,
        cwd="/sandbox",
    )

    assert first["configHash"] == second["configHash"]
    assert first["tools"]["mcpConfigHash"] == second["tools"]["mcpConfigHash"]


def test_effective_audit_fields_are_small_and_flat() -> None:
    instruction_bundle = {
        "schemaVersion": "workflow-builder.instruction-bundle.v1",
        "instructionHash": "i" * 64,
        "templateName": "workflow-builder canonical bundle",
        "templateHash": "t" * 64,
        "sources": [{"field": "persona.role", "sourceType": "agent-profile"}],
    }
    snapshot = build_effective_agent_config(
        agent_config={"modelSpec": "openai/o3"},
        raw_message={},
        turn=3,
        config_revision=2,
        cwd="/sandbox",
        instruction_bundle=instruction_bundle,
    )

    audit = effective_audit_fields(snapshot)

    assert audit["turn"] == 3
    assert audit["configRevision"] == 2
    assert audit["configHash"] == snapshot["configHash"]
    assert audit["instructionHash"] == "i" * 64
    assert audit["templateName"] == "workflow-builder canonical bundle"
    assert audit["templateHash"] == "t" * 64
    assert snapshot["instructionBundleSchemaVersion"] == "workflow-builder.instruction-bundle.v1"
    assert snapshot["instructionTextStored"] is True
    assert audit["modelSpec"] == "openai/o3"
    assert audit["llmComponent"] == "llm-openai-o3"
    assert audit["provider"] == "openai"


def test_runtime_context_cache_retains_snapshot_audit_fields() -> None:
    snapshot = build_effective_agent_config(
        agent_config={"modelSpec": "openai/gpt-5.5"},
        raw_message={},
        turn=2,
        config_revision=3,
        cwd="/workspace",
    )

    cached = runtime_context_audit_cache_fields(
        {
            "llmComponent": "llm-openai-gpt5",
            "templateName": "workflow-builder canonical bundle",
            "templateHash": "t" * 64,
            "effectiveAgentConfig": snapshot,
        }
    )

    assert cached["turn"] == 2
    assert cached["configRevision"] == 3
    assert cached["configHash"] == snapshot["configHash"]
    assert cached["templateName"] == "workflow-builder canonical bundle"
    assert cached["templateHash"] == "t" * 64
    assert cached["modelSpec"] == "openai/gpt-5.5"
    assert cached["llmComponent"] == "llm-openai-gpt5"
    assert cached["provider"] == "openai"
    assert cached["providerModel"] == "gpt-5.5"
    assert cached["effectiveAgentConfig"] == snapshot


def test_resolve_llm_metadata_without_reasoning_effort_does_not_crash():
    """LIVE-CAUGHT regression: _string() returns None for a missing key, and an
    unguarded .lower() crashed EVERY session whose agentConfig had no
    reasoningEffort (only effort-carrying dynamic-script calls survived)."""
    llm = resolve_llm_metadata(agent_config={"modelSpec": "zai/glm-5.2"})
    assert "reasoningEffort" not in llm
    assert llm["modelSpec"] == "zai/glm-5.2"
    # Empty config takes the K3 platform default, whose max effort is explicit.
    llm = resolve_llm_metadata(agent_config={})
    assert llm["reasoningEffort"] == "max"


def test_resolve_llm_metadata_carries_valid_reasoning_effort():
    llm = resolve_llm_metadata(
        agent_config={"modelSpec": "zai/glm-5.2", "reasoningEffort": "LOW"}
    )
    assert llm["reasoningEffort"] == "low"
    # Invalid values are dropped, not propagated.
    llm = resolve_llm_metadata(
        agent_config={"modelSpec": "zai/glm-5.2", "reasoningEffort": "bogus"}
    )
    assert "reasoningEffort" not in llm


def test_resolve_llm_metadata_carries_response_json_schema():
    schema = {"type": "object", "required": ["ok"], "properties": {"ok": {"type": "boolean"}}}
    llm = resolve_llm_metadata(agent_config={"modelSpec": "openai/gpt-5.5", "responseJsonSchema": schema})
    assert llm["responseJsonSchema"] == schema
    assert llm["modelSpec"] == "openai/gpt-5.5"


def test_resolve_llm_metadata_without_response_json_schema_is_safe():
    llm = resolve_llm_metadata(agent_config={"modelSpec": "zai/glm-5.2"})
    assert "responseJsonSchema" not in llm
    # a non-dict responseJsonSchema is dropped, not propagated
    llm = resolve_llm_metadata(agent_config={"modelSpec": "zai/glm-5.2", "responseJsonSchema": "nope"})
    assert "responseJsonSchema" not in llm


def test_resolve_llm_metadata_carries_structured_output_mode():
    schema = {"type": "object", "properties": {"x": {"type": "string"}}}
    llm = resolve_llm_metadata(
        agent_config={
            "modelSpec": "zai/glm-5.2",
            "responseJsonSchema": schema,
            "structuredOutputMode": "tool",
        }
    )
    assert llm["structuredOutputMode"] == "tool"
    assert llm["responseJsonSchema"] == schema


def test_resolve_llm_metadata_drops_unknown_structured_output_mode():
    llm = resolve_llm_metadata(
        agent_config={"modelSpec": "zai/glm-5.2", "structuredOutputMode": "bogus"}
    )
    assert "structuredOutputMode" not in llm
    llm = resolve_llm_metadata(agent_config={"modelSpec": "zai/glm-5.2"})
    assert "structuredOutputMode" not in llm


def test_deepseek_default_is_v4_pro():
    # Bare provider name + the API-side family alias land on the v4-pro default.
    assert resolve_llm_component("deepseek") == "llm-deepseek-v4-pro"
    assert resolve_llm_component("deepseek/deepseek-chat") == "llm-deepseek-v4-pro"
    # Explicit specs unchanged; legacy deepseek/default keeps its component.
    assert resolve_llm_component("deepseek/deepseek-v4-pro") == "llm-deepseek-v4-pro"
    assert resolve_llm_component("deepseek/deepseek-v4-flash") == "llm-deepseek-v4-flash"
    assert resolve_llm_component("deepseek/default") == "llm-deepseek"


def test_platform_default_is_kimi_k3():
    assert resolve_llm_component(None) == "llm-kimi-k3"
    llm = resolve_llm_metadata(agent_config={})
    assert llm["llmComponent"] == "llm-kimi-k3"
    assert llm["providerModel"] == "kimi-k3"
    assert llm["contextWindowTokens"] == 1_048_576
    assert llm["reasoningEffort"] == "max"


def test_kimi_k3_always_records_max_reasoning_effort():
    llm = resolve_llm_metadata(
        agent_config={"modelSpec": "kimi/kimi-k3", "reasoningEffort": "low"}
    )
    assert llm["contextWindowTokens"] == 1_048_576
    assert llm["reasoningEffort"] == "max"


def test_unknown_deepseek_spec_falls_back_to_v4_pro():
    # An unrecognized deepseek/* spec must NOT kill the session pre-turn —
    # it resolves to the v4-pro default (with a warning).
    assert resolve_llm_component("deepseek/deepseek-v9-ultra") == "llm-deepseek-v4-pro"


def test_unknown_non_deepseek_spec_still_raises():
    import pytest as _pytest

    with _pytest.raises(ValueError):
        resolve_llm_component("zai/glm-99")
