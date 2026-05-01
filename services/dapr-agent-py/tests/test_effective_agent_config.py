from __future__ import annotations

import json
import os
import sys


root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

from src.effective_agent_config import (  # noqa: E402
    build_effective_agent_config,
    effective_audit_fields,
    resolve_llm_metadata,
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


def test_model_mapping_records_spec_component_provider_and_provider_model() -> None:
    llm = resolve_llm_metadata(
        message={"agentConfig": {"modelSpec": "openai/gpt-5.4"}}
    )

    assert llm == {
        "modelSpec": "openai/gpt-5.4",
        "llmComponent": "llm-openai-gpt5",
        "provider": "openai",
        "providerModel": "gpt-5.4",
    }


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
    snapshot = build_effective_agent_config(
        agent_config={"modelSpec": "openai/o3"},
        raw_message={},
        turn=3,
        config_revision=2,
        cwd="/sandbox",
    )

    audit = effective_audit_fields(snapshot)

    assert audit["turn"] == 3
    assert audit["configRevision"] == 2
    assert audit["configHash"] == snapshot["configHash"]
    assert audit["modelSpec"] == "openai/o3"
    assert audit["llmComponent"] == "llm-openai-o3"
