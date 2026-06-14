"""CodexAdapter + AntigravityAdapter seed / argv / env tests.

These lock the two security-critical invariants for the new OAuth CLIs:
  - codex: the delivered CODEX_AUTH_JSON blob is written to auth.json (chmod
    600) and is NEVER re-exported into the pane env (where codex would prefer
    the env credential over the user's ChatGPT subscription file);
  - agy: device-login means no credential is required, and every Google/Gemini
    API-key env is stripped so the OAuth path is taken.
"""

from __future__ import annotations

import json
import stat
import tomllib

import pytest

from src.cli_adapters import get_adapter
from src.cli_adapters.antigravity import normalize_agy_model
from src.cli_adapters.codex import normalize_codex_model

AUTH_BLOB = json.dumps(
    {
        "OPENAI_API_KEY": None,
        "tokens": {"access_token": "a", "refresh_token": "r", "id_token": "i"},
        "last_refresh": "2026-06-01T00:00:00Z",
    }
)

SESSION = {
    "agentConfig": {
        "modelSpec": "openai/gpt-5.5",
        "permissionMode": "default",
        "mcpServers": [
            {
                "name": "goal",
                "transport": "streamable_http",
                "url": "http://workflow-mcp-server:3200/mcp",
                "headers": {"X-Wfb-Session-Id": "sess-1"},
            },
            {"name": "fs", "transport": "stdio", "command": "npx", "args": ["-y", "x"]},
        ],
    },
    "instructionBundle": {"rendered": {"system": "You are helpful."}},
}


# --- codex -------------------------------------------------------------------


@pytest.fixture
def codex_home(tmp_path, monkeypatch):
    home = tmp_path / "codex"
    monkeypatch.setenv("CODEX_HOME", str(home))
    monkeypatch.setenv("AGENT_LOCAL_SANDBOX_ROOT", str(tmp_path / "sandbox"))
    return home


def test_codex_seed_materializes_auth_file_0600(codex_home, monkeypatch):
    monkeypatch.setenv("CODEX_AUTH_JSON", AUTH_BLOB)
    adapter = get_adapter("codex")
    result = adapter.seed(SESSION)
    auth = codex_home / "auth.json"
    assert auth.exists()
    assert json.loads(auth.read_text())["tokens"]["refresh_token"] == "r"
    assert stat.S_IMODE(auth.stat().st_mode) == 0o600
    assert not result.warnings


def test_codex_seed_warns_without_blob(codex_home, monkeypatch):
    monkeypatch.delenv("CODEX_AUTH_JSON", raising=False)
    result = get_adapter("codex").seed(SESSION)
    assert not (codex_home / "auth.json").exists()
    assert any("no CODEX_AUTH_JSON" in w for w in result.warnings)


def test_codex_seed_never_clobbers_refreshed_auth(codex_home, monkeypatch):
    codex_home.mkdir(parents=True)
    (codex_home / "auth.json").write_text('{"tokens":{"refresh_token":"FRESH"}}')
    monkeypatch.setenv("CODEX_AUTH_JSON", AUTH_BLOB)
    get_adapter("codex").seed(SESSION)
    assert "FRESH" in (codex_home / "auth.json").read_text()


def test_codex_config_toml_is_valid_and_has_mcp(codex_home, monkeypatch):
    monkeypatch.setenv("CODEX_AUTH_JSON", AUTH_BLOB)
    get_adapter("codex").seed(SESSION)
    cfg = tomllib.loads((codex_home / "config.toml").read_text())
    assert cfg["forced_login_method"] == "chatgpt"
    assert cfg["mcp_servers"]["goal"]["url"].endswith("/mcp")
    assert cfg["mcp_servers"]["goal"]["http_headers"]["X-Wfb-Session-Id"] == "sess-1"
    assert cfg["mcp_servers"]["fs"]["command"] == "npx"


def test_codex_config_toml_otel_is_struct_variant(codex_home, monkeypatch):
    """codex 0.139.0 rejects the old flat `exporter = "otlp-http"` + top-level
    `endpoint`. The [otel] table must use the externally-tagged struct variant
    with a REQUIRED `protocol`, and must not carry an `endpoint` at its own level
    (the table is deny_unknown_fields)."""
    monkeypatch.setenv("CODEX_AUTH_JSON", AUTH_BLOB)
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://otel-collector:4318")
    get_adapter("codex").seed(SESSION)
    cfg = tomllib.loads((codex_home / "config.toml").read_text())
    otel = cfg["otel"]
    assert "endpoint" not in otel  # endpoint must live inside the exporter variant
    http = otel["exporter"]["otlp-http"]
    assert http["endpoint"] == "http://otel-collector:4318/v1/logs"
    assert http["protocol"] == "binary"  # required field
    assert otel["metrics_exporter"] == "none"  # no default Statsig export


def test_codex_config_pretrusts_sandbox_cwd(codex_home, monkeypatch, tmp_path):
    """codex 0.139.0 blocks on a "Do you trust this directory?" onboarding prompt
    for an untrusted cwd, start-stalling the session. The generated config must
    pre-trust the sandbox cwd (the --cd target) so codex boots to its prompt."""
    sandbox = str(tmp_path / "sandbox")
    monkeypatch.setenv("AGENT_LOCAL_SANDBOX_ROOT", sandbox)
    monkeypatch.setenv("CODEX_AUTH_JSON", AUTH_BLOB)
    get_adapter("codex").seed(SESSION)
    cfg = tomllib.loads((codex_home / "config.toml").read_text())
    assert cfg["projects"][sandbox]["trust_level"] == "trusted"


def test_codex_seed_writes_hooks_json_for_completion_signal(codex_home, monkeypatch):
    monkeypatch.setenv("CODEX_AUTH_JSON", AUTH_BLOB)
    result = get_adapter("codex").seed(SESSION)
    hooks = json.loads((codex_home / "hooks.json").read_text())
    assert "Stop" in hooks["hooks"]
    stop_hook = hooks["hooks"]["Stop"][0]["hooks"][0]
    assert stop_hook["type"] == "command"
    assert "--adapter codex --event Stop" in stop_hook["command"]
    assert result.paths["hooksPath"].endswith("hooks.json")
    assert result.paths["hookRelayPath"].endswith("wfb_hook_relay.py")


def test_codex_build_argv_default_mode(codex_home):
    argv = get_adapter("codex").build_argv(SESSION["agentConfig"], {})
    assert argv[0] == "codex"
    assert "--dangerously-bypass-hook-trust" in argv
    assert "--yolo" in argv
    assert "--sandbox" not in argv
    assert "--ask-for-approval" not in argv
    assert "--model" in argv and "gpt-5.5" in argv


def test_codex_build_argv_bypass_mode(codex_home):
    cfg = {**SESSION["agentConfig"], "permissionMode": "bypass"}
    argv = get_adapter("codex").build_argv(cfg, {})
    assert "--yolo" in argv


def test_codex_seed_links_sessions_into_transcript_store(codex_home, monkeypatch, tmp_path):
    """$CODEX_HOME/sessions is redirected into the per-session JuiceFS subtree so
    rollouts persist + `codex resume --last` works across pods."""
    mount = tmp_path / "tx"
    mount.mkdir()
    monkeypatch.setenv("CLI_TRANSCRIPT_MOUNT", str(mount))
    monkeypatch.setenv("CODEX_AUTH_JSON", AUTH_BLOB)
    result = get_adapter("codex").seed(SESSION)
    sessions = codex_home / "sessions"
    assert sessions.is_symlink()
    assert result.paths["transcriptStore"] == str(mount / "codex")
    (sessions / "2026" / "r.jsonl").parent.mkdir(parents=True)
    (sessions / "2026" / "r.jsonl").write_text("{}\n")
    assert (mount / "codex" / "2026" / "r.jsonl").read_text() == "{}\n"


def test_codex_build_argv_resume_on_continue(codex_home):
    cfg = {**SESSION["agentConfig"], "continueSession": True}
    argv = get_adapter("codex").build_argv(cfg, {})
    # `codex resume --last` precedes the TUI flags, after global flags.
    resume_idx = argv.index("resume")
    assert argv[0] == "codex"
    assert argv[resume_idx : resume_idx + 3] == ["resume", "--last", "--cd"]
    assert "--cd" in argv
    # not present without the flag
    assert "resume" not in get_adapter("codex").build_argv(SESSION["agentConfig"], {})


def test_codex_pane_env_strips_apikey_and_blob():
    env = get_adapter("codex").pane_env(
        {
            "OPENAI_API_KEY": "sk-x",
            "CODEX_API_KEY": "sk-y",
            "CODEX_AUTH_JSON": AUTH_BLOB,
            "CODEX_HOME": "/sandbox/.codex",
            "PATH": "/usr/bin",
            "HOME": "/home/cli-agent",
        },
        session_id="sess-1",
    )
    assert "OPENAI_API_KEY" not in env
    assert "CODEX_API_KEY" not in env
    assert "CODEX_AUTH_JSON" not in env
    assert env["CODEX_HOME"] == "/sandbox/.codex"
    assert "wfb.session.id=sess-1" in env["OTEL_RESOURCE_ATTRIBUTES"]


def test_injection_marker_gating_per_adapter():
    """The zero-width INJECTION_MARKER is Claude-hook-only. codex's ratatui
    composer eats it + the first word, and neither codex nor agy has a
    UserPromptSubmit hook — so they must NOT prefix it. claude-code keeps it
    (its hook dedups self-injections)."""
    assert get_adapter("claude-code").uses_injection_marker is True
    assert get_adapter("codex").uses_injection_marker is False
    assert get_adapter("antigravity").uses_injection_marker is False
    assert get_adapter("claude-code").hook_reports_prompt_submit is False
    assert get_adapter("codex").hook_reports_prompt_submit is True
    assert get_adapter("antigravity").hook_reports_prompt_submit is False
    assert get_adapter("claude-code").idle_after_submit_is_success is False
    assert get_adapter("codex").idle_after_submit_is_success is False
    assert get_adapter("antigravity").idle_after_submit_is_success is True


def test_prompt_ready_marker_per_adapter():
    """Every interactive-cli adapter content-gates the kickoff on its rendered
    idle composer (herdr can report `idle` during the pre-composer boot screen,
    stranding an agent_status-gated seed above the banner). Each marker must be a
    substring present in the idle composer but ABSENT on the boot screen."""
    # claude/agy idle composers render a `? for shortcuts` hint footer.
    assert get_adapter("claude-code").prompt_ready_marker == "? for shortcuts"
    assert get_adapter("antigravity").prompt_ready_marker == "? for shortcuts"
    # codex has no hint bar; its composer status footer is `<model> <profile> ·
    # <cwd>` and the `· <cwd>` segment is composer-only (the boot banner writes
    # `directory: /sandbox`, no middle dot) + mode/model-independent.
    assert get_adapter("codex").prompt_ready_marker == "· /sandbox"


def test_codex_model_normalization():
    assert normalize_codex_model("openai/o4") == "o4"
    assert normalize_codex_model("gpt-5.5") == "gpt-5.5"
    # `gpt-5-codex` was dropped from codex 0.139.0's catalog -> remap to default.
    assert normalize_codex_model("gpt-5-codex") == "gpt-5.5"
    assert normalize_codex_model("openai/gpt-5-codex") == "gpt-5.5"
    assert normalize_codex_model("anthropic/claude-opus-4-8") == "gpt-5.5"  # default


def test_codex_transcript_maps_agent_message_and_usage():
    adapter = get_adapter("codex")
    message = {
        "timestamp": "2026-06-14T09:09:11.111Z",
        "type": "event_msg",
        "payload": {
            "type": "agent_message",
            "message": "final answer",
            "phase": "final_answer",
        },
    }
    usage = {
        "timestamp": "2026-06-14T09:09:11.135Z",
        "type": "event_msg",
        "payload": {
            "type": "token_count",
            "info": {
                "last_token_usage": {
                    "input_tokens": 120,
                    "cached_input_tokens": 100,
                    "output_tokens": 7,
                    "reasoning_output_tokens": 3,
                    "total_tokens": 127,
                },
                "model_context_window": 258400,
            },
            "rate_limits": {"plan_type": "pro"},
        },
    }

    msg_events = adapter.map_transcript_entry(message)
    usage_events = adapter.map_transcript_entry(usage)

    assert msg_events == [
        {
            "type": "agent.message",
            "data": {
                "content": [{"type": "text", "text": "final answer"}],
                "phase": "final_answer",
            },
            "sourceEventId": "codex-transcript:agent_message:2026-06-14T09:09:11.111Z:message",
        }
    ]
    assert usage_events is not None
    usage_data = usage_events[0]["data"]
    assert usage_events[0]["type"] == "agent.llm_usage"
    assert usage_data["input_tokens"] == 20
    assert usage_data["cache_read_input_tokens"] == 100
    assert usage_data["output_tokens"] == 7
    assert usage_data["reasoning_output_tokens"] == 3
    assert usage_data["model_context_window"] == 258400
    assert usage_data["plan_type"] == "pro"


def test_codex_transcript_maps_mcp_tool_result():
    adapter = get_adapter("codex")
    entry = {
        "timestamp": "2026-06-14T18:16:28.193Z",
        "type": "event_msg",
        "payload": {
            "type": "mcp_tool_call_end",
            "call_id": "call_123",
            "invocation": {
                "server": "piece_microsoft-outlook",
                "tool": "findEmail",
                "arguments": {"searchQuery": "mcp-smoke-no-results", "top": 1},
            },
            "duration": {"secs": 1, "nanos": 627706550},
            "result": {
                "Ok": {
                    "content": [
                        {
                            "type": "text",
                            "text": 'Action "findEmail" failed: example',
                        }
                    ],
                    "isError": True,
                }
            },
        },
    }

    events = adapter.map_transcript_entry(entry)

    assert events == [
        {
            "type": "agent.tool_result",
            "data": {
                "tool_name": "mcp__piece_microsoft_outlook__findEmail",
                "name": "mcp__piece_microsoft_outlook__findEmail",
                "ok": False,
                "success": False,
                "output": 'Action "findEmail" failed: example',
                "output_preview": 'Action "findEmail" failed: example',
                "call_id": "call_123",
                "tool_input": {"searchQuery": "mcp-smoke-no-results", "top": 1},
                "input": {"searchQuery": "mcp-smoke-no-results", "top": 1},
                "server": "piece_microsoft-outlook",
                "mcp_tool": "findEmail",
                "duration": {"secs": 1, "nanos": 627706550},
                "is_error": True,
                "error": 'Action "findEmail" failed: example',
            },
            "sourceEventId": "codex-transcript:call_123:tool_result",
        }
    ]


def test_codex_hook_suppresses_mcp_post_tool_result():
    adapter = get_adapter("codex")

    assert (
        adapter.map_hook_event(
            {
                "hook_event_name": "PostToolUse",
                "tool_name": "mcp__piece_microsoft_outlook__findEmail",
                "tool_response": {"content": [{"type": "text", "text": "ok"}]},
            }
        )
        == []
    )
    assert (
        adapter.map_hook_event(
            {
                "hook_event_name": "PostToolUseFailure",
                "tool_name": "mcp__piece_microsoft_outlook__findEmail",
                "tool_response": "boom",
            }
        )
        == []
    )


def test_codex_hook_uses_generic_mapping_for_non_mcp_tools():
    adapter = get_adapter("codex")

    assert (
        adapter.map_hook_event(
            {
                "hook_event_name": "PostToolUse",
                "tool_name": "Read",
                "tool_response": {"content": "file text"},
            }
        )
        is None
    )


def test_codex_task_complete_raises_turn_completed(codex_home):
    adapter = get_adapter("codex")
    entry = {
        "timestamp": "2026-06-14T09:09:11.747Z",
        "type": "event_msg",
        "payload": {
            "type": "task_complete",
            "turn_id": "turn-1",
            "last_agent_message": "done",
        },
    }

    event = adapter.transcript_turn_completion(entry)

    assert event == {
        "type": "turn.completed",
        "completionSource": "codex_task_complete",
        "turnId": "turn-1",
        "lastAssistantText": "done",
    }
    sessions = codex_home / "sessions" / "2026"
    sessions.mkdir(parents=True)
    (sessions / "rollout.jsonl").write_text(json.dumps(entry) + "\n")
    assert adapter.extract_completion_text({}) == "done"


def test_codex_stop_hook_does_not_complete_turn():
    adapter = get_adapter("codex")
    assert adapter.stop_hook_completes_turn() is False
    assert adapter.is_turn_completion_hook("Stop") is False


# --- antigravity -------------------------------------------------------------


@pytest.fixture
def agy_home(tmp_path, monkeypatch):
    home = tmp_path / "sandbox"
    monkeypatch.setenv("AGENT_LOCAL_SANDBOX_ROOT", str(home))
    monkeypatch.setenv("CLI_AGENT_AGY_HOME_OVERRIDE", str(home))
    monkeypatch.delenv("AGY_AUTH_JSON", raising=False)
    return home


def test_agy_requires_interactive_login_is_dynamic(monkeypatch):
    # No captured bundle → device-code login first, so the kickoff is DEFERRED
    # (herdr reports the auth-code prompt as `idle`; an armed seed would land in
    # the login field).
    monkeypatch.delenv("AGY_AUTH_JSON", raising=False)
    assert get_adapter("antigravity").requires_interactive_login is True
    # Bundle delivered → seed() restores ~/.gemini and agy boots signed in, so the
    # kickoff can fire immediately.
    monkeypatch.setenv("AGY_AUTH_JSON", "x")
    assert get_adapter("antigravity").requires_interactive_login is False


def test_agy_seed_prompt_preserves_operator_goal_command():
    adapter = get_adapter("antigravity")
    assert adapter.format_seed_user_message("write the files") == "write the files"
    assert (
        adapter.format_seed_user_message("/goal write the files")
        == "/goal write the files"
    )


def test_agy_seed_restores_login_bundle(agy_home, monkeypatch):
    import base64
    import io
    import tarfile

    # build a base64 tar.gz with a token + init markers
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, data in (
            ("antigravity-cli/antigravity-oauth-token", b'{"token":{}}'),
            ("config/.migrated", b""),
        ):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    monkeypatch.setenv("AGY_AUTH_JSON", base64.b64encode(buf.getvalue()).decode())
    get_adapter("antigravity").seed(AGY_SESSION)
    gem = agy_home / ".gemini"
    assert (gem / "antigravity-cli" / "antigravity-oauth-token").read_bytes() == b'{"token":{}}'
    assert (gem / "config" / ".migrated").exists()


AGY_SESSION = {
    "agentConfig": {
        "modelSpec": "gemini/gemini-2.5-pro",
        "permissionMode": "default",
        "mcpServers": [
            {
                "name": "goal",
                "transport": "streamable_http",
                "url": "http://workflow-mcp-server:3200/mcp",
                "headers": {"X-Wfb-Session-Id": "s2"},
            },
        ],
    },
    "instructionBundle": {"rendered": {"system": "Be terse."}},
}


def test_agy_seed_writes_mcp_with_serverUrl_key(agy_home):
    result = get_adapter("antigravity").seed(AGY_SESSION)
    mcp = json.loads((agy_home / ".gemini/config/mcp_config.json").read_text())
    # agy's remote key is serverUrl (NOT url) — wrong key fails silently.
    assert mcp["mcpServers"]["goal"]["serverUrl"].endswith("/mcp")
    assert "url" not in mcp["mcpServers"]["goal"]
    assert result.paths["mcpConfigPath"].endswith("mcp_config.json")


def test_agy_seed_writes_hooks_json_for_completion_signal(agy_home):
    result = get_adapter("antigravity").seed(AGY_SESSION)
    hooks = json.loads((agy_home / ".gemini/config/hooks.json").read_text())
    stop_hook = hooks["workflow-builder"]["Stop"][0]
    assert stop_hook["type"] == "command"
    assert "--adapter antigravity --event Stop" in stop_hook["command"]
    end_hook = hooks["workflow-builder"]["SessionEnd"][0]["hooks"][0]
    assert "--adapter antigravity --event SessionEnd" in end_hook["command"]
    assert result.paths["hooksPath"].endswith("hooks.json")


def test_agy_seed_writes_stop_guard_for_output_sync(agy_home):
    session = {
        **AGY_SESSION,
        "outputSync": {
            "paths": [{"source": str(agy_home / "app"), "target": "/sandbox/app"}]
        },
        "stopCondition": "Stop only after index.html, styles.css, and README.md exist.",
        "requireFileChanges": True,
    }
    result = get_adapter("antigravity").seed(session)
    guard = json.loads((agy_home / ".wfb/agy_stop_guard.json").read_text())
    assert result.paths["agyStopGuardPath"].endswith("agy_stop_guard.json")
    assert guard["requiredSources"] == [{"source": str((agy_home / "app").resolve())}]
    assert guard["requiredFileNames"] == ["index.html", "styles.css", "README.md"]
    assert guard["requireFileChanges"] is True


def test_agy_seed_writes_stop_guard_from_durable_run_body(agy_home):
    session = {
        **AGY_SESSION,
        "outputSync": {
            "paths": [{"source": str(agy_home / "app"), "target": "/sandbox/app"}]
        },
        "body": {
            "stopCondition": "Stop only after index.html, styles.css, script.js, and README.md exist.",
            "requireFileChanges": True,
        },
    }
    result = get_adapter("antigravity").seed(session)
    guard = json.loads((agy_home / ".wfb/agy_stop_guard.json").read_text())
    assert result.paths["agyStopGuardPath"].endswith("agy_stop_guard.json")
    assert guard["requiredFileNames"] == [
        "index.html",
        "styles.css",
        "script.js",
        "README.md",
    ]
    assert guard["requireFileChanges"] is True
    assert guard["stopCondition"].startswith("Stop only after index.html")


def test_agy_seed_infers_stop_guard_from_initial_user_message(agy_home):
    session = {
        **AGY_SESSION,
        "outputSync": {
            "paths": [
                {
                    "source": str(agy_home / "3b1b-style-animation-example"),
                    "target": "/sandbox/3b1b-style-animation-example",
                }
            ]
        },
        "initialEvents": [
            {
                "type": "user.message",
                "content": [
                    {
                        "type": "text",
                        "text": (
                            "Build a browser animation in /sandbox/3b1b-style-animation-example "
                            "with index.html, styles.css, script.js, and README.md. "
                            "If a scene is useful, include scene.py as optional source only. "
                            "Do NOT create a package.json."
                        ),
                    }
                ],
            }
        ],
    }
    get_adapter("antigravity").seed(session)
    guard = json.loads((agy_home / ".wfb/agy_stop_guard.json").read_text())
    assert guard["requiredFileNames"] == [
        "index.html",
        "styles.css",
        "script.js",
        "README.md",
    ]
    assert guard["requireFileChanges"] is True
    assert "scene.py" not in guard["requiredFileNames"]
    assert "package.json" not in guard["requiredFileNames"]


def test_agy_seed_writes_gemini_md_and_settings(agy_home):
    get_adapter("antigravity").seed(AGY_SESSION)
    assert (agy_home / ".gemini/GEMINI.md").read_text().startswith("Be terse.")
    settings = json.loads((agy_home / ".gemini/antigravity-cli/settings.json").read_text())
    assert settings["model"] == "gemini-2.5-pro"
    assert settings["enableTelemetry"] is False
    assert settings["toolPermission"] == "always-proceed"
    assert settings["artifactReviewPolicy"] == "always-proceed"
    assert settings["allowNonWorkspaceAccess"] is True
    assert settings["terminal.integrated.shellIntegration.enabled"] is False
    assert settings["terminal.integrated.defaultProfile.linux"] == "bash"
    assert settings["terminal.integrated.profiles.linux"]["bash"]["path"] == "/bin/bash"
    assert settings["enableTerminalSandbox"] is False
    assert settings["permissions"]["allow"] == [
        "command(*)",
        f"read_file({agy_home})",
        f"write_file({agy_home})",
        "read_url(*)",
        "execute_url(*)",
        "mcp(*)",
    ]
    assert settings["permissions"]["deny"] == []
    assert settings["permissions"]["ask"] == []
    assert str(agy_home).endswith("sandbox") or settings["trustedWorkspaces"]


def test_agy_seed_overrides_restored_prompting_settings(agy_home):
    settings_path = agy_home / ".gemini/antigravity-cli/settings.json"
    settings_path.parent.mkdir(parents=True)
    settings_path.write_text(
        json.dumps(
            {
                "toolPermission": "request-review",
                "enableTerminalSandbox": True,
                "trustedWorkspaces": ["/old"],
                "permissions": {
                    "allow": [],
                    "deny": ["command(*)"],
                    "ask": ["command(*)", "mcp(*)"],
                },
            }
        )
    )

    get_adapter("antigravity").seed(AGY_SESSION)
    settings = json.loads(settings_path.read_text())

    assert settings["toolPermission"] == "always-proceed"
    assert settings["enableTerminalSandbox"] is False
    assert settings["permissions"]["deny"] == []
    assert settings["permissions"]["ask"] == []
    assert "/old" in settings["trustedWorkspaces"]
    assert str(agy_home) in settings["trustedWorkspaces"]


def test_agy_build_argv():
    argv = get_adapter("antigravity").build_argv(AGY_SESSION["agentConfig"], {})
    assert argv[0] == "agy"
    assert "--model" in argv and "gemini-2.5-pro" in argv
    assert "--dangerously-skip-permissions" in argv
    assert "--sandbox=false" in argv
    assert argv[argv.index("--add-dir") + 1].endswith("sandbox")


def test_agy_pane_env_strips_all_google_keys_and_pins_home(agy_home):
    env = get_adapter("antigravity").pane_env(
        {
            "ANTIGRAVITY_API_KEY": "a",
            "GEMINI_API_KEY": "b",
            "GOOGLE_API_KEY": "c",
            "GOOGLE_APPLICATION_CREDENTIALS": "/x",
            "PATH": "/usr/bin",
            "TERM": "xterm",
        },
        session_id="s2",
    )
    for k in (
        "ANTIGRAVITY_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
    ):
        assert k not in env
    assert env["HOME"] == str(agy_home)


def test_agy_model_normalization():
    assert normalize_agy_model("gemini/gemini-2.5-pro") == "gemini-2.5-pro"
    assert (
        normalize_agy_model("googleai/gemini-3.1-pro-preview")
        == "gemini-3.1-pro-preview"
    )
    assert (
        normalize_agy_model("google/gemini-3.1-pro-preview")
        == "gemini-3.1-pro-preview"
    )
    assert normalize_agy_model("gemini-2.0-flash") == "gemini-2.0-flash"
    assert normalize_agy_model("anthropic/claude-opus-4-8") is None  # default empty


def test_agy_hook_mapping_extracts_nested_tool_payloads():
    adapter = get_adapter("antigravity")
    events = adapter.map_hook_event(
        {
            "hook_event_name": "PreToolUse",
            "toolCall": {
                "name": "write_file",
                "input": {"path": "index.html", "content": "<canvas></canvas>"},
            },
        }
    )
    assert events == [
        {
            "type": "agent.tool_use",
            "data": {
                "tool_name": "write_file",
                "name": "write_file",
                "tool_input": {"path": "index.html", "content": "<canvas></canvas>"},
                "input": {"path": "index.html", "content": "<canvas></canvas>"},
            },
        }
    ]

    result = adapter.map_hook_event(
        {
            "hook_event_name": "PostToolUse",
            "toolCall": {"name": "write_file"},
            "toolResult": {"content": [{"type": "text", "text": "created"}]},
        }
    )
    assert result is not None
    assert result[0]["type"] == "agent.tool_result"
    assert result[0]["data"]["tool_name"] == "write_file"
    assert result[0]["data"]["output"] == "created"


def test_agy_hook_mapping_canonicalizes_mcp_call_tool_names():
    adapter = get_adapter("antigravity")
    events = adapter.map_hook_event(
        {
            "hook_event_name": "PreToolUse",
            "toolName": "call_mcp_tool",
            "toolInput": {
                "ServerName": "wfb_goal",
                "ToolName": "get_goal",
                "Arguments": {},
            },
        }
    )
    assert events == [
        {
            "type": "agent.tool_use",
            "data": {
                "tool_name": "mcp__wfb_goal__get_goal",
                "name": "mcp__wfb_goal__get_goal",
                "tool_input": {
                    "ServerName": "wfb_goal",
                    "ToolName": "get_goal",
                    "Arguments": {},
                },
                "input": {
                    "ServerName": "wfb_goal",
                    "ToolName": "get_goal",
                    "Arguments": {},
                },
                "server": "wfb_goal",
                "mcp_tool": "get_goal",
                "raw_tool_name": "call_mcp_tool",
            },
        }
    ]

    result = adapter.map_hook_event(
        {
            "hook_event_name": "PostToolUse",
            "toolName": "call_mcp_tool",
            "toolInput": {
                "ServerName": "wfb_goal",
                "ToolName": "update_goal",
                "Arguments": {"status": "complete"},
            },
            "toolResponse": {"content": [{"type": "text", "text": "ok"}]},
        }
    )
    assert result is not None
    assert result[0]["data"]["tool_name"] == "mcp__wfb_goal__update_goal"
    assert result[0]["data"]["name"] == "mcp__wfb_goal__update_goal"
    assert result[0]["data"]["raw_tool_name"] == "call_mcp_tool"
    assert result[0]["data"]["server"] == "wfb_goal"
    assert result[0]["data"]["mcp_tool"] == "update_goal"
    assert result[0]["data"]["input"]["ToolName"] == "update_goal"
    assert result[0]["data"]["output"] == "ok"


def test_agy_hook_mapping_skips_empty_anonymous_tool_hooks():
    event = get_adapter("antigravity").map_hook_event({"hook_event_name": "PreToolUse"})
    assert event == []
    result = get_adapter("antigravity").map_hook_event({"hook_event_name": "PostToolUse"})
    assert result == []


def test_agy_hook_mapping_uses_non_null_fallback_tool_name_for_payloads():
    event = get_adapter("antigravity").map_hook_event(
        {"hook_event_name": "PreToolUse", "input": {"path": "/sandbox/repo"}}
    )
    assert event is not None
    assert event[0]["data"]["tool_name"] == "agy_tool"
    assert event[0]["data"]["name"] == "agy_tool"


def test_agy_run_command_hook_shim_executes_and_denies_native_tool(
    tmp_path, monkeypatch
):
    sandbox = tmp_path / "sandbox"
    sandbox.mkdir()
    monkeypatch.setenv("AGENT_LOCAL_SANDBOX_ROOT", str(sandbox))
    monkeypatch.setenv("CLI_AGENT_AGY_RUN_COMMAND_SHIM", "true")
    adapter = get_adapter("antigravity")

    response = adapter.hook_response(
        "PreToolUse",
        {
            "hook_event_name": "PreToolUse",
            "toolName": "run_command",
            "toolInput": {
                "CommandLine": 'printf "agy-shim-ok\\n"',
                "Cwd": str(sandbox),
            },
        },
        {},
    )

    assert response is not None
    assert response["decision"] == "deny"
    assert "agy-shim-ok" in response["reason"]
    events = response["_workflowBuilderEvents"]
    result = next(event for event in events if event["type"] == "agent.tool_result")
    assert result["data"]["tool_name"] == "run_command"
    assert result["data"]["ok"] is True
    assert result["data"]["exit_code"] == 0
    assert result["data"]["output"] == "agy-shim-ok\n"
    assert result["data"]["shim"] == "agy-run-command-hook"


def test_agy_run_command_hook_shim_suppresses_native_post_tool_result(monkeypatch):
    monkeypatch.setenv("CLI_AGENT_AGY_RUN_COMMAND_SHIM", "true")

    events = get_adapter("antigravity").map_hook_event(
        {
            "hook_event_name": "PostToolUse",
            "toolName": "run_command",
            "toolInput": {"CommandLine": 'printf "ok\\n"', "Cwd": "/sandbox"},
            "toolResponse": {},
        }
    )

    assert events == []


def test_agy_run_command_hook_shim_times_out(tmp_path, monkeypatch):
    sandbox = tmp_path / "sandbox"
    sandbox.mkdir()
    monkeypatch.setenv("AGENT_LOCAL_SANDBOX_ROOT", str(sandbox))
    monkeypatch.setenv("CLI_AGENT_AGY_RUN_COMMAND_SHIM", "true")
    monkeypatch.setenv("CLI_AGENT_AGY_RUN_COMMAND_TIMEOUT_SECONDS", "1")

    response = get_adapter("antigravity").hook_response(
        "PreToolUse",
        {
            "hook_event_name": "PreToolUse",
            "toolName": "run_command",
            "toolInput": {"CommandLine": "sleep 10", "Cwd": str(sandbox)},
        },
        {},
    )

    assert response is not None
    result = next(
        event
        for event in response["_workflowBuilderEvents"]
        if event["type"] == "agent.tool_result"
    )
    assert response["decision"] == "deny"
    assert result["data"]["ok"] is False
    assert result["data"]["timed_out"] is True
    assert result["data"]["exit_code"] == 124
    assert "Command timed out after 1 seconds." in result["data"]["stderr"]


def test_agy_run_command_hook_shim_rejects_cwd_outside_sandbox(tmp_path, monkeypatch):
    sandbox = tmp_path / "sandbox"
    sandbox.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    monkeypatch.setenv("AGENT_LOCAL_SANDBOX_ROOT", str(sandbox))
    monkeypatch.setenv("CLI_AGENT_AGY_RUN_COMMAND_SHIM", "true")

    response = get_adapter("antigravity").hook_response(
        "PreToolUse",
        {
            "hook_event_name": "PreToolUse",
            "toolName": "run_command",
            "toolInput": {"CommandLine": "pwd", "Cwd": str(outside)},
        },
        {},
    )

    assert response is not None
    result = next(
        event
        for event in response["_workflowBuilderEvents"]
        if event["type"] == "agent.tool_result"
    )
    assert response["decision"] == "deny"
    assert result["data"]["ok"] is False
    assert result["data"]["exit_code"] == 2
    assert "outside the managed sandbox" in result["data"]["stderr"]


def test_agy_transcript_final_response_maps_message_usage_and_completion():
    adapter = get_adapter("antigravity")
    entry = {
        "source": "MODEL",
        "type": "PLANNER_RESPONSE",
        "status": "DONE",
        "step_index": 21,
        "model": "gemini-2.5-pro",
        "content": "Created index.html, styles.css, script.js, and README.md.",
        "usageMetadata": {"promptTokenCount": 12, "candidatesTokenCount": 7},
    }

    events = adapter.map_transcript_entry(entry)
    assert events == [
        {
            "type": "agent.message",
            "data": {
                "content": [
                    {
                        "type": "text",
                        "text": "Created index.html, styles.css, script.js, and README.md.",
                    }
                ],
                "model": "gemini-2.5-pro",
            },
            "sourceEventId": "agy-transcript:21:message",
        },
        {
            "type": "agent.llm_usage",
            "data": {
                "input_tokens": 12,
                "output_tokens": 7,
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0,
                "model": "gemini-2.5-pro",
            },
            "sourceEventId": "agy-transcript:21:usage",
        },
    ]
    assert adapter.transcript_turn_completion(entry) == {
        "type": "turn.completed",
        "lastAssistantText": "Created index.html, styles.css, script.js, and README.md.",
    }


def test_agy_transcript_maps_native_tokens_cache_usage():
    adapter = get_adapter("antigravity")
    entry = {
        "id": "agy-turn-1",
        "type": "gemini",
        "model": "gemini-3.1-pro-preview",
        "content": "Done.",
        "tokens": {
            "input": 17313,
            "output": 31,
            "cached": 15871,
            "thoughts": 56,
            "total": 17400,
        },
    }

    events = adapter.map_transcript_entry(entry)

    assert events == [
        {
            "type": "agent.llm_usage",
            "data": {
                "input_tokens": 1442,
                "output_tokens": 31,
                "cache_read_input_tokens": 15871,
                "cache_creation_input_tokens": 0,
                "reasoning_output_tokens": 56,
                "total_tokens": 17400,
                "model": "gemini-3.1-pro-preview",
            },
            "sourceEventId": "agy-transcript:agy-turn-1:usage",
        }
    ]


def test_agy_transcript_maps_gemini_usage_metadata_cache_usage():
    adapter = get_adapter("antigravity")
    entry = {
        "source": "MODEL",
        "type": "PLANNER_RESPONSE",
        "status": "DONE",
        "step_index": 22,
        "modelName": "gemini-3.1-pro",
        "usageMetadata": {
            "promptTokenCount": 2000,
            "candidatesTokenCount": 40,
            "cachedContentTokenCount": 1500,
            "thoughtsTokenCount": 30,
            "totalTokenCount": 2070,
        },
    }

    events = adapter.map_transcript_entry(entry)

    assert events == [
        {
            "type": "agent.llm_usage",
            "data": {
                "input_tokens": 500,
                "output_tokens": 40,
                "cache_read_input_tokens": 1500,
                "cache_creation_input_tokens": 0,
                "reasoning_output_tokens": 30,
                "total_tokens": 2070,
                "model": "gemini-3.1-pro",
            },
            "sourceEventId": "agy-transcript:22:usage",
        }
    ]


def test_agy_transcript_estimates_usage_when_native_usage_absent():
    adapter = get_adapter("antigravity")
    adapter.map_transcript_entry(
        {
            "step_index": 0,
            "source": "USER_EXPLICIT",
            "type": "USER_INPUT",
            "status": "DONE",
            "content": "Reply exactly: agy-token-cache-smoke-ok. Do not use Bash.",
        }
    )
    entry = {
        "step_index": 2,
        "source": "MODEL",
        "type": "PLANNER_RESPONSE",
        "status": "DONE",
        "content": "agy-token-cache-smoke-ok",
    }

    events = adapter.map_transcript_entry(entry)

    assert events is not None
    assert [event["type"] for event in events] == ["agent.message", "agent.llm_usage"]
    usage = events[1]["data"]
    assert usage["input_tokens"] > 0
    assert usage["output_tokens"] > 0
    assert usage["cache_read_input_tokens"] == 0
    assert usage["cache_creation_input_tokens"] == 0
    assert usage["context_source"] == "transcript_estimate"
    assert usage["context_count_method"] == "estimated"
    assert usage["context_count_scope"] == "last_agy_turn"
    assert usage["usage_estimated"] is True
    assert usage["usage_source"] == "agy_transcript_estimate"
    assert events[1]["sourceEventId"] == "agy-transcript:2:usage"


def test_agy_transcript_ignores_managed_run_command_denial_artifact():
    adapter = get_adapter("antigravity")
    entry = {
        "source": "MODEL",
        "type": "PLANNER_RESPONSE",
        "status": "DONE",
        "step_index": 22,
        "content": (
            "Created At: 2026-06-14T16:39:25Z\n"
            "Completed At: 2026-06-14T16:39:25Z\n"
            "Error invalid tool call: model output error: invalid tool call error "
            "(invalid_args) Tool call denied with reason: Workflow-builder "
            "executed this run_command in the managed sandbox and blocked AGY's "
            "native terminal executor for this call. Treat the captured result "
            "below as the Bash tool result; do not retry the same command unless "
            "the user asks.\n"
            "Exit code: 0\n"
            "stdout:\n"
            "wfb-agy-final-ok\n"
            "\nstderr:"
        ),
    }

    assert adapter.map_transcript_entry(entry) == []
    assert adapter.transcript_turn_completion(entry) is None


def test_agy_transcript_ignores_native_tool_display_artifacts():
    adapter = get_adapter("antigravity")
    entry = {
        "source": "MODEL",
        "type": "PLANNER_RESPONSE",
        "status": "DONE",
        "step_index": 23,
        "content": (
            "Created At: 2026-06-14T18:20:27Z\n"
            "Completed At: 2026-06-14T18:20:27Z\n"
            "File Path: `file:///home/cli-agent/.gemini/antigravity-cli/brain/output.txt`\n"
            "Total Lines: 8835\n"
            "Total Bytes: 529002\n"
            "Showing lines 1 to 800\n"
            "1: [{\"name\":\"private-file.txt\"}]"
        ),
    }

    assert adapter.map_transcript_entry(entry) == []
    assert adapter.transcript_turn_completion(entry) is None


def test_agy_transcript_ignores_grep_search_display_artifacts():
    adapter = get_adapter("antigravity")
    entry = {
        "source": "MODEL",
        "type": "PLANNER_RESPONSE",
        "status": "DONE",
        "step_index": 24,
        "content": (
            "Created At: 2026-06-14T20:20:46Z\n"
            "Completed At: 2026-06-14T20:20:46Z\n"
            '{"File":"/sandbox/repo/astropy/utils/misc.py",'
            '"LineNumber":497,"LineContent":"class InheritDocstrings(type):"}'
        ),
    }

    assert adapter.map_transcript_entry(entry) == []
    assert adapter.transcript_turn_completion(entry) is None


def test_agy_transcript_completion_waits_for_stop_guard_outputs(agy_home):
    adapter = get_adapter("antigravity")
    session = {
        **AGY_SESSION,
        "outputSync": {
            "paths": [{"source": str(agy_home / "app"), "target": "/sandbox/app"}]
        },
        "body": {
            "stopCondition": "Stop only after index.html and styles.css exist.",
        },
    }
    adapter.seed(session)
    entry = {
        "source": "MODEL",
        "type": "PLANNER_RESPONSE",
        "status": "DONE",
        "step_index": 7,
        "content": "I am done.",
    }
    assert adapter.transcript_turn_completion(entry) is None

    app = agy_home / "app"
    app.mkdir()
    (app / "index.html").write_text("<canvas></canvas>")
    (app / "styles.css").write_text("body{}")
    assert adapter.transcript_turn_completion(entry) is None


def test_agy_transcript_tool_request_is_not_completion():
    adapter = get_adapter("antigravity")
    entry = {
        "source": "MODEL",
        "type": "PLANNER_RESPONSE",
        "status": "DONE",
        "content": "I will write the files.",
        "tool_calls": [{"name": "write_file"}],
    }
    assert adapter.map_transcript_entry(entry) == []
    assert adapter.transcript_turn_completion(entry) is None
