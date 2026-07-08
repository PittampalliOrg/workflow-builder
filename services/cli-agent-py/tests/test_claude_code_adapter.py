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


@pytest.fixture(autouse=True)
def _clear_glm_gateway_env(monkeypatch):
    """build_argv now reads ANTHROPIC_BASE_URL from os.environ to detect Z.AI
    gateway mode (claude-code-cli-glm); clear it by default so the model-flag
    tests are deterministic regardless of the ambient shell. The GLM tests re-set
    it explicitly via monkeypatch."""
    monkeypatch.delenv("ANTHROPIC_BASE_URL", raising=False)


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


def test_seed_adds_structured_output_mcp_for_tool_mode(seeded_dirs):
    wfb_dir, config_dir = seeded_dirs
    adapter = get_adapter("claude-code")
    schema = {
        "type": "object",
        "properties": {"answer": {"type": "string"}},
        "required": ["answer"],
        "additionalProperties": False,
    }

    result = adapter.seed(
        {
            "agentConfig": {
                "structuredOutputMode": "tool",
                "responseJsonSchema": schema,
            }
        }
    )

    mcp = json.loads((wfb_dir / "mcp.json").read_text())
    structured = mcp["mcpServers"]["structured"]
    assert structured == _expected_structured_stdio_server(schema)

    state = json.loads((config_dir / ".claude.json").read_text())
    structured = state["mcpServers"]["structured"]
    assert structured == _expected_structured_stdio_server(schema)
    assert result.paths["mcpConfigPath"] == str(wfb_dir / "mcp.json")
    assert result.paths["claudeStructuredMcpConfigPath"] == str(
        config_dir / ".claude.json"
    )
    assert json.loads((config_dir / "claude.json").read_text()) == state


def test_seed_splits_project_mcp_from_structured_output_mcp(seeded_dirs):
    wfb_dir, config_dir = seeded_dirs
    adapter = get_adapter("claude-code")
    schema = {
        "type": "object",
        "properties": {"answer": {"type": "string"}},
        "required": ["answer"],
        "additionalProperties": False,
    }

    result = adapter.seed(
        {
            "agentConfig": {
                "mcpServers": [
                    {
                        "name": "github",
                        "transport": "streamable_http",
                        "url": "https://mcp.example/mcp",
                    },
                ],
                "structuredOutputMode": "tool",
                "responseJsonSchema": schema,
            }
        }
    )

    mcp = json.loads((wfb_dir / "mcp.json").read_text())
    assert mcp["mcpServers"]["github"] == {
        "type": "http",
        "url": "https://mcp.example/mcp",
    }
    assert "structured" in mcp["mcpServers"]
    state = json.loads((config_dir / ".claude.json").read_text())
    assert set(state["mcpServers"].keys()) == {"structured"}
    assert state["mcpServers"]["structured"] == _expected_structured_stdio_server(schema)
    assert result.paths["mcpConfigPath"] == str(wfb_dir / "mcp.json")
    assert result.paths["claudeStructuredMcpConfigPath"] == str(
        config_dir / ".claude.json"
    )


def tmp_path_parent_has_escape(config_dir) -> bool:
    return (config_dir / "skills" / ".." / "escape.md").resolve().exists()


def _expected_structured_stdio_server(schema: dict) -> dict:
    return {
        "type": "stdio",
        "command": "/app/.venv/bin/python",
        "args": ["-m", "src.structured_output_mcp"],
        "env": {
            "PYTHONPATH": "/app",
            "CLI_STRUCTURED_OUTPUT_SCHEMA": json.dumps(
                schema,
                sort_keys=True,
                ensure_ascii=False,
            ),
        },
    }


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


def test_seed_structured_output_preserves_existing_claude_state(seeded_dirs):
    import json

    _wfb_dir, config_dir = seeded_dirs
    config_dir.mkdir(parents=True, exist_ok=True)
    existing = {
        "hasCompletedOnboarding": True,
        "oauthAccount": {"id": "user-x"},
        "mcpServers": {"user_server": {"type": "stdio", "command": "existing"}},
    }
    (config_dir / ".claude.json").write_text(json.dumps(existing))
    schema = {
        "type": "object",
        "properties": {"answer": {"type": "string"}},
        "required": ["answer"],
        "additionalProperties": False,
    }
    adapter = get_adapter("claude-code")
    adapter.seed(
        {
            "agentConfig": {
                "structuredOutputMode": "tool",
                "responseJsonSchema": schema,
            }
        }
    )
    state = json.loads((config_dir / ".claude.json").read_text())
    assert state["oauthAccount"] == existing["oauthAccount"]
    assert state["mcpServers"]["user_server"] == existing["mcpServers"]["user_server"]
    assert state["mcpServers"]["structured"] == _expected_structured_stdio_server(schema)


def test_detect_goal_completion_on_goal_achieved_attachment():
    adapter = get_adapter("claude-code")
    # met:true is the native "goal achieved" signal → emit once.
    achieved = {
        "type": "user",
        "attachment": {"type": "goal_status", "met": True, "condition": "do X",
                       "reason": "The assistant did X."},
    }
    assert adapter.detect_goal_completion(achieved) == {
        "completionSource": "claude_transcript_goal",
        "summary": "The assistant did X.",
    }
    # met:false (intermediate evaluator check) → no completion.
    assert adapter.detect_goal_completion(
        {"attachment": {"type": "goal_status", "met": False, "condition": "do X"}}
    ) is None
    # non-goal rows → no completion.
    assert adapter.detect_goal_completion({"type": "assistant", "message": {}}) is None


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
    assert "--dangerously-skip-permissions" in argv
    assert "--permission-mode" not in argv
    assert argv[argv.index("--mcp-config") + 1] == "/sandbox/.wfb/mcp.json"
    assert argv[argv.index("--append-system-prompt-file") + 1] == "/sandbox/.wfb/system-prompt.md"


def test_build_argv_one_shot_disallows_ask_user_question():
    """Headless one-shot runs must disable AskUserQuestion — no human in the
    pane to answer it, so the tool call would block until the pod deadline."""
    adapter = get_adapter("claude-code")
    argv = adapter.build_argv({}, {}, one_shot=True)
    assert argv[argv.index("--disallowedTools") + 1] == "AskUserQuestion"


def test_build_argv_interactive_keeps_ask_user_question():
    """Interactive (default) sessions have a human, so AskUserQuestion stays."""
    adapter = get_adapter("claude-code")
    assert "--disallowedTools" not in adapter.build_argv({}, {})
    assert "--disallowedTools" not in adapter.build_argv({}, {}, one_shot=False)


def test_build_argv_omits_optional_flags():
    adapter = get_adapter("claude-code")
    argv = adapter.build_argv({}, {})
    assert "--mcp-config" not in argv
    assert "--append-system-prompt-file" not in argv
    assert "--continue" not in argv
    # no effort by default → neither --effort nor --settings
    assert "--effort" not in argv
    assert "--settings" not in argv
    assert "--fallback-model" not in argv


@pytest.mark.parametrize("level", ["low", "medium", "high", "xhigh"])
def test_build_argv_effort_levels_use_effort_flag(level):
    adapter = get_adapter("claude-code")
    argv = adapter.build_argv({"effort": level}, {})
    assert argv[argv.index("--effort") + 1] == level
    # effort levels are NOT the ultracode setting
    assert "--settings" not in argv


def test_build_argv_ultracode_uses_settings_not_effort():
    """ultracode is a Claude Code setting, enabled via --settings — NOT --effort."""
    adapter = get_adapter("claude-code")
    argv = adapter.build_argv({"effort": "ultracode"}, {})
    assert "--effort" not in argv
    assert argv[argv.index("--settings") + 1] == '{"ultracode": true}'


def test_build_argv_effort_max_is_env_only_not_argv():
    """max is session-only via CLAUDE_CODE_EFFORT_LEVEL (pane_env), not a flag."""
    adapter = get_adapter("claude-code")
    argv = adapter.build_argv({"effort": "max"}, {})
    assert "--effort" not in argv
    assert "--settings" not in argv


def test_build_argv_unknown_effort_omitted():
    adapter = get_adapter("claude-code")
    argv = adapter.build_argv({"effort": "bogus"}, {})
    assert "--effort" not in argv
    assert "--settings" not in argv


def test_build_argv_fallback_model_normalized_when_set():
    adapter = get_adapter("claude-code")
    argv = adapter.build_argv(
        {"modelSpec": "anthropic/claude-opus-4-8", "fallbackModelSpec": "anthropic/claude-sonnet-4-6"},
        {},
    )
    assert argv[argv.index("--model") + 1] == "claude-opus-4-8"
    assert argv[argv.index("--fallback-model") + 1] == "claude-sonnet-4-6"


def test_pane_env_effort_max_sets_level_env():
    adapter = get_adapter("claude-code")
    env = adapter.pane_env({"HOME": "/sandbox"}, session_id="s1", agent_config={"effort": "max"})
    assert env["CLAUDE_CODE_EFFORT_LEVEL"] == "max"
    # any other effort (or none) must NOT set the env var
    assert "CLAUDE_CODE_EFFORT_LEVEL" not in adapter.pane_env(
        {"HOME": "/sandbox"}, session_id="s1", agent_config={"effort": "high"}
    )
    assert "CLAUDE_CODE_EFFORT_LEVEL" not in adapter.pane_env({"HOME": "/sandbox"})


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


def test_build_argv_glm_gateway_omits_model(monkeypatch):
    """Z.AI gateway mode (claude-code-cli-glm): with ANTHROPIC_BASE_URL injected,
    the Opus/Sonnet/Haiku tiers come from ANTHROPIC_DEFAULT_*_MODEL, so build_argv
    must NOT emit --model/--fallback-model — a normalized claude-* id (or the
    DEFAULT_MODEL fallback applied to a zai/glm spec) would break the GLM gateway.
    Non-model flags still apply."""
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://api.z.ai/api/anthropic")
    adapter = get_adapter("claude-code")
    argv = adapter.build_argv(
        {"modelSpec": "zai/glm-5.2", "fallbackModelSpec": "zai/glm-5.1"}, {}
    )
    assert "--model" not in argv
    assert "--fallback-model" not in argv
    assert "--dangerously-skip-permissions" in argv


def test_build_argv_keeps_model_without_gateway():
    """Without ANTHROPIC_BASE_URL (stock anthropic claude-code-cli) the modelSpec
    still drives --model exactly as before."""
    adapter = get_adapter("claude-code")
    argv = adapter.build_argv({"modelSpec": "anthropic/claude-opus-4-8"}, {})
    assert argv[argv.index("--model") + 1] == "claude-opus-4-8"


def test_pane_env_forwards_glm_gateway_env_but_strips_api_key():
    """The GLM variant forwards ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL /
    ANTHROPIC_DEFAULT_*_MODEL / CLAUDE_CODE_AUTO_COMPACT_WINDOW to the pane, while
    STILL stripping the billing-flipping ANTHROPIC_API_KEY / CLAUDE_API_KEY."""
    adapter = get_adapter("claude-code")
    env = adapter.pane_env(
        {
            "HOME": "/sandbox",
            "ANTHROPIC_AUTH_TOKEN": "glm-key",
            "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic",
            "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.2[1m]",
            "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.2[1m]",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-4.7",
            "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "1000000",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "API_TIMEOUT_MS": "3000000",
            "ANTHROPIC_API_KEY": "sk-bad",
            "CLAUDE_API_KEY": "sk-worse",
        },
        session_id="sess-glm",
    )
    assert env["ANTHROPIC_AUTH_TOKEN"] == "glm-key"
    assert env["ANTHROPIC_BASE_URL"] == "https://api.z.ai/api/anthropic"
    assert env["ANTHROPIC_DEFAULT_OPUS_MODEL"] == "glm-5.2[1m]"
    assert env["ANTHROPIC_DEFAULT_SONNET_MODEL"] == "glm-5.2[1m]"
    assert env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] == "glm-4.7"
    assert env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] == "1000000"
    assert env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] == "1"
    assert env["API_TIMEOUT_MS"] == "3000000"
    assert "ANTHROPIC_API_KEY" not in env
    assert "CLAUDE_API_KEY" not in env


def test_seed_no_transcript_store_leaves_projects_local(seeded_dirs, monkeypatch):
    """Without CLI_TRANSCRIPT_MOUNT the transcript stays a normal local dir."""
    _wfb_dir, config_dir = seeded_dirs
    monkeypatch.delenv("CLI_TRANSCRIPT_MOUNT", raising=False)
    adapter = get_adapter("claude-code")
    result = adapter.seed({"agentConfig": {}})
    assert "transcriptStore" not in result.paths
    projects = config_dir / "projects"
    assert not projects.is_symlink()


def test_seed_links_transcript_into_durable_store(seeded_dirs, monkeypatch, tmp_path):
    """With CLI_TRANSCRIPT_MOUNT set, projects/ becomes a symlink into the
    per-session store, so a transcript written by claude lands in the mount."""
    _wfb_dir, config_dir = seeded_dirs
    mount = tmp_path / "transcripts-mount"
    mount.mkdir()
    monkeypatch.setenv("CLI_TRANSCRIPT_MOUNT", str(mount))
    adapter = get_adapter("claude-code")
    result = adapter.seed({"agentConfig": {}})
    target = mount / "claude"
    assert result.paths["transcriptStore"] == str(target)
    projects = config_dir / "projects"
    assert projects.is_symlink()
    assert projects.resolve() == target.resolve()
    # A transcript written through the symlink lands in the durable store.
    (projects / "-sandbox").mkdir(parents=True)
    (projects / "-sandbox" / "abc.jsonl").write_text("{}\n")
    assert (target / "-sandbox" / "abc.jsonl").read_text() == "{}\n"


def test_seed_migrates_existing_transcript_into_store(seeded_dirs, monkeypatch, tmp_path):
    """A pre-existing real projects/ dir is migrated into the store, not lost."""
    _wfb_dir, config_dir = seeded_dirs
    projects = config_dir / "projects" / "-sandbox"
    projects.mkdir(parents=True)
    (projects / "old.jsonl").write_text("prior\n")
    mount = tmp_path / "m"
    mount.mkdir()
    monkeypatch.setenv("CLI_TRANSCRIPT_MOUNT", str(mount))
    adapter = get_adapter("claude-code")
    adapter.seed({"agentConfig": {}})
    link = config_dir / "projects"
    assert link.is_symlink()
    assert (mount / "claude" / "-sandbox" / "old.jsonl").read_text() == "prior\n"


def test_normalizers():
    assert normalize_claude_model("anthropic/claude-opus-4-8") == "claude-opus-4-8"
    assert normalize_claude_model("claude-sonnet-4-6") == "claude-sonnet-4-6"
    assert normalize_permission_mode("plan") == "plan"
    assert normalize_permission_mode("bypass") == "bypassPermissions"
    assert normalize_permission_mode("dontAsk") == "bypassPermissions"
    assert normalize_permission_mode("bogus") == "default"
    assert normalize_permission_mode(None) == "default"


# --- hook wiring: deterministic Stop baked in managed-settings; only the
#     blocking permission hooks are per-session (interactive-only) ---

def _managed_settings() -> dict:
    from pathlib import Path

    import src.cli_adapters.claude_code as cc

    path = Path(cc.__file__).resolve().parents[2] / "docker" / "managed-settings.json"
    return json.loads(path.read_text(encoding="utf-8"))


def test_managed_settings_bakes_exactly_the_mirroring_hooks():
    """managed-settings.json must bake all mirroring/lifecycle hooks (incl Stop)
    plus the StopFailure turn-failure edge (belt-and-suspenders vs the per-session
    seed — the bake survives a failed _seed_runtime_hooks; double registration is
    harmless via the shared (instance_id, turn) completion key), and must NOT bake
    the blocking permission hooks (those strand one-shot runs)."""
    from src.cli_adapters.claude_code import (
        _BLOCKING_HOOK_EVENTS,
        _FAILURE_HOOK_EVENTS,
        _MIRROR_HOOK_EVENTS,
        HOOK_RELAY_URL,
    )

    settings = _managed_settings()
    baked = set(settings.get("hooks", {}).keys())
    assert baked == set(_MIRROR_HOOK_EVENTS) | set(_FAILURE_HOOK_EVENTS), (
        "managed-settings drifted from _MIRROR_HOOK_EVENTS + _FAILURE_HOOK_EVENTS"
    )
    assert "Stop" in baked, "deterministic Stop turn-end hook must be baked"
    assert "StopFailure" in baked, "the turn-failure edge must be baked"
    for ev in _BLOCKING_HOOK_EVENTS:
        assert ev not in baked, f"{ev} must NOT be baked (strands one-shot runs)"
    # every baked hook relays to the cli-agent-py hooks receiver, matcher-less
    for ev, cfgs in settings["hooks"].items():
        assert cfgs == [{"hooks": [{"type": "http", "url": HOOK_RELAY_URL}]}]


def test_seed_one_shot_registers_only_the_failure_edge(seeded_dirs):
    """A one-shot autoTerminate run registers ONLY the StopFailure edge per-session
    (mirroring/Stop stay baked); the blocking permission hooks would strand it."""
    from src.cli_adapters.claude_code import _BLOCKING_HOOK_EVENTS, _FAILURE_HOOK_EVENTS

    _, config_dir = seeded_dirs
    adapter = get_adapter("claude-code")
    adapter.seed({"agentConfig": {}, "autoTerminateAfterEndTurn": True})
    settings = json.loads((config_dir / "settings.json").read_text(encoding="utf-8"))
    assert set(settings["hooks"].keys()) == set(_FAILURE_HOOK_EVENTS)  # StopFailure only
    for ev in _BLOCKING_HOOK_EVENTS:
        assert ev not in settings["hooks"]  # no human → would strand
    assert "Stop" not in settings["hooks"]  # baked, not duplicated per-session


def test_seed_interactive_adds_blocking_hooks_and_failure_edge(seeded_dirs):
    """An interactive session adds the blocking permission hooks AND the StopFailure
    failure edge per-session (mirroring/Stop stay baked)."""
    from src.cli_adapters.claude_code import _BLOCKING_HOOK_EVENTS, _FAILURE_HOOK_EVENTS

    _, config_dir = seeded_dirs
    adapter = get_adapter("claude-code")
    adapter.seed({"agentConfig": {}})  # no autoTerminate → interactive
    settings = json.loads((config_dir / "settings.json").read_text(encoding="utf-8"))
    assert set(settings["hooks"].keys()) == set(_BLOCKING_HOOK_EVENTS) | set(
        _FAILURE_HOOK_EVENTS
    )
    assert "Stop" not in settings["hooks"]  # baked, not duplicated per-session


def test_seed_one_shot_writes_no_hooks_when_failure_edge_disabled(seeded_dirs, monkeypatch):
    """With CLI_TURN_FAILED_EDGE_ENABLED off, a one-shot run falls back to the old
    behavior: no per-session hooks (only the baked managed Stop/mirroring)."""
    import src.cli_adapters.claude_code as cc

    monkeypatch.setattr(cc, "CLI_TURN_FAILED_EDGE_ENABLED", False)
    _, config_dir = seeded_dirs
    adapter = get_adapter("claude-code")
    adapter.seed({"agentConfig": {}, "autoTerminateAfterEndTurn": True})
    settings = json.loads((config_dir / "settings.json").read_text(encoding="utf-8"))
    assert "hooks" not in settings  # nothing per-session; managed Stop is the edge
