"""ClaudeCodeAdapter seed / argv / env tests."""

from __future__ import annotations

import base64
import json

import pytest

from src.cli_adapters import get_adapter
from src.cli_adapters.claude_code import (
    SKILL_MAX_FILE_BYTES,
    normalize_claude_model,
    normalize_permission_mode,
)


@pytest.fixture
def seeded_dirs(tmp_path, monkeypatch):
    wfb_dir = tmp_path / "wfb"
    config_dir = tmp_path / "claude-config"
    monkeypatch.setenv("CLI_AGENT_WFB_DIR", str(wfb_dir))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(config_dir))
    return wfb_dir, config_dir


def test_seed_writes_mcp_system_prompt_and_skills(seeded_dirs):
    wfb_dir, config_dir = seeded_dirs
    adapter = get_adapter("claude-code")
    result = adapter.seed(
        {
            "agentConfig": {
                "mcpServers": [
                    {"name": "github", "transport": "streamable_http", "url": "https://mcp.example/mcp"},
                ],
                "skills": [
                    {
                        "name": "my-skill",
                        "prompt": "# My Skill\nDo the thing.",
                        "packageManifest": {
                            "files": [
                                {"path": "references/notes.md", "content": "notes"},
                                {"path": "../escape.md", "content": "evil"},
                            ]
                        },
                    },
                    {"name": "slug-only-skill"},
                ],
            },
            "instructionBundle": {"rendered": {"system": "Be terse."}},
        }
    )
    mcp = json.loads((wfb_dir / "mcp.json").read_text())
    assert mcp == {
        "mcpServers": {"github": {"type": "http", "url": "https://mcp.example/mcp"}}
    }
    assert result.paths["mcpConfigPath"] == str(wfb_dir / "mcp.json")
    assert (wfb_dir / "system-prompt.md").read_text().strip() == "Be terse."
    skill_dir = config_dir / "skills" / "my-skill"
    assert (skill_dir / "references" / "notes.md").read_text() == "notes"
    # prompt becomes SKILL.md when the manifest lacks one
    assert (skill_dir / "SKILL.md").read_text().startswith("# My Skill")
    # traversal-unsafe path skipped with a warning; slug-only skill skipped silently
    assert not (config_dir / "skills" / "escape.md").exists()
    assert not (tmp_path_parent_has_escape(config_dir))
    assert any("unsafe path" in warning for warning in result.warnings)
    assert not (config_dir / "skills" / "slug-only-skill").exists()


def tmp_path_parent_has_escape(config_dir) -> bool:
    return (config_dir / "skills" / ".." / "escape.md").resolve().exists()


def test_seed_without_servers_or_prompt_writes_nothing(seeded_dirs):
    wfb_dir, _config_dir = seeded_dirs
    adapter = get_adapter("claude-code")
    result = adapter.seed({"agentConfig": {}})
    assert "mcpConfigPath" not in result.paths
    assert "systemPromptPath" not in result.paths
    assert not (wfb_dir / "mcp.json").exists()


def test_seed_writes_onboarding_state(seeded_dirs, monkeypatch):
    """Fresh pods must boot the TUI straight into the REPL — no theme picker,
    no login screen (the subscription login launches a browser OAuth flow that
    kills the pane in a pod; observed live on ryzen 2026-06-10)."""
    import json

    _wfb_dir, config_dir = seeded_dirs
    monkeypatch.setenv("AGENT_LOCAL_SANDBOX_ROOT", "/sandbox")
    adapter = get_adapter("claude-code")
    result = adapter.seed({"agentConfig": {}})
    state_path = config_dir / ".claude.json"
    assert result.paths["claudeStatePath"] == str(state_path)
    state = json.loads(state_path.read_text())
    assert state["hasCompletedOnboarding"] is True
    assert state["projects"]["/sandbox"]["hasTrustDialogAccepted"] is True
    # bare-name twin for forward compatibility
    assert json.loads((config_dir / "claude.json").read_text()) == state


def test_seed_never_clobbers_existing_claude_state(seeded_dirs):
    import json

    _wfb_dir, config_dir = seeded_dirs
    config_dir.mkdir(parents=True, exist_ok=True)
    existing = {"hasCompletedOnboarding": True, "oauthAccount": {"id": "user-x"}}
    (config_dir / ".claude.json").write_text(json.dumps(existing))
    adapter = get_adapter("claude-code")
    result = adapter.seed({"agentConfig": {}})
    assert "claudeStatePath" not in result.paths
    assert json.loads((config_dir / ".claude.json").read_text()) == existing


def test_oversized_skill_file_skipped(seeded_dirs):
    _wfb_dir, config_dir = seeded_dirs
    adapter = get_adapter("claude-code")
    big = "x" * (SKILL_MAX_FILE_BYTES + 1)
    result = adapter.seed(
        {
            "agentConfig": {
                "skills": [
                    {
                        "name": "big",
                        "packageManifest": {
                            "files": [
                                {"path": "big.txt", "content": big},
                                {"path": "ok.txt", "content": "fine"},
                            ]
                        },
                    }
                ]
            }
        }
    )
    assert not (config_dir / "skills" / "big" / "big.txt").exists()
    assert (config_dir / "skills" / "big" / "ok.txt").read_text() == "fine"
    assert any("oversized" in warning for warning in result.warnings)


def test_base64_encoded_skill_file_decoded(seeded_dirs):
    _wfb_dir, config_dir = seeded_dirs
    adapter = get_adapter("claude-code")
    encoded = base64.b64encode(b"#!/bin/sh\necho hi\n").decode()
    adapter.seed(
        {
            "agentConfig": {
                "skills": [
                    {
                        "name": "b64",
                        "packageManifest": {
                            "files": [
                                {"path": "run.sh", "content": encoded, "encoding": "base64"}
                            ]
                        },
                    }
                ]
            }
        }
    )
    assert (config_dir / "skills" / "b64" / "run.sh").read_bytes() == b"#!/bin/sh\necho hi\n"


def test_build_argv(seeded_dirs):
    adapter = get_adapter("claude-code")
    argv = adapter.build_argv(
        {"modelSpec": "anthropic/claude-opus-4-8", "permissionMode": "acceptEdits"},
        {"mcpConfigPath": "/sandbox/.wfb/mcp.json", "systemPromptPath": "/sandbox/.wfb/system-prompt.md"},
    )
    assert argv[0] == "claude"
    assert argv[argv.index("--model") + 1] == "claude-opus-4-8"
    assert argv[argv.index("--permission-mode") + 1] == "acceptEdits"
    assert argv[argv.index("--mcp-config") + 1] == "/sandbox/.wfb/mcp.json"
    assert argv[argv.index("--append-system-prompt-file") + 1] == "/sandbox/.wfb/system-prompt.md"


def test_build_argv_omits_optional_flags():
    adapter = get_adapter("claude-code")
    argv = adapter.build_argv({}, {})
    assert "--mcp-config" not in argv
    assert "--append-system-prompt-file" not in argv
    assert "--continue" not in argv


def test_build_argv_continue_on_resume():
    """continueSession (set by the BFF when re-mounting a prior transcript)
    launches `claude --continue` to pick up the conversation."""
    adapter = get_adapter("claude-code")
    argv = adapter.build_argv({"continueSession": True}, {})
    assert "--continue" in argv
    # not added otherwise
    assert "--continue" not in adapter.build_argv({"continueSession": False}, {})


def test_pane_env_passthrough_and_api_key_exclusion():
    adapter = get_adapter("claude-code")
    env = adapter.pane_env(
        {
            "CLAUDE_CODE_OAUTH_TOKEN": "tok",
            "CLAUDE_CONFIG_DIR": "/sandbox/.claude",
            "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
            "OTEL_EXPORTER_OTLP_ENDPOINT": "http://otel:4318",
            "OTEL_RESOURCE_ATTRIBUTES": "service.name=cli-agent-py",
            "ANTHROPIC_API_KEY": "sk-bad",
            "CLAUDE_API_KEY": "sk-worse",
            "RANDOM_SECRET": "nope",
        },
        session_id="sess-9",
    )
    assert env["CLAUDE_CODE_OAUTH_TOKEN"] == "tok"
    assert env["CLAUDE_CONFIG_DIR"] == "/sandbox/.claude"
    assert env["OTEL_EXPORTER_OTLP_ENDPOINT"] == "http://otel:4318"
    assert env["OTEL_RESOURCE_ATTRIBUTES"] == "service.name=cli-agent-py,wfb.session.id=sess-9"
    assert "ANTHROPIC_API_KEY" not in env
    assert "CLAUDE_API_KEY" not in env
    assert "RANDOM_SECRET" not in env


def test_normalizers():
    assert normalize_claude_model("anthropic/claude-opus-4-8") == "claude-opus-4-8"
    assert normalize_claude_model("claude-sonnet-4-6") == "claude-sonnet-4-6"
    assert normalize_permission_mode("plan") == "plan"
    assert normalize_permission_mode("bypass") == "bypassPermissions"
    assert normalize_permission_mode("dontAsk") == "bypassPermissions"
    assert normalize_permission_mode("bogus") == "default"
    assert normalize_permission_mode(None) == "default"
