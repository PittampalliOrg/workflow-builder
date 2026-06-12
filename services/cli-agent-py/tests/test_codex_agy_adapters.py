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


def test_codex_build_argv_default_mode(codex_home):
    argv = get_adapter("codex").build_argv(SESSION["agentConfig"], {})
    assert argv[0] == "codex"
    assert "--sandbox" in argv and "danger-full-access" in argv
    assert "--ask-for-approval" in argv and "on-request" in argv
    assert "--model" in argv and "gpt-5.5" in argv


def test_codex_build_argv_bypass_mode(codex_home):
    cfg = {**SESSION["agentConfig"], "permissionMode": "bypass"}
    argv = get_adapter("codex").build_argv(cfg, {})
    assert "--dangerously-bypass-approvals-and-sandbox" in argv


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
    # `codex resume --last` precedes the TUI flags
    assert argv[0] == "codex" and argv[1] == "resume" and argv[2] == "--last"
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


def test_codex_model_normalization():
    assert normalize_codex_model("openai/o4") == "o4"
    assert normalize_codex_model("gpt-5.5") == "gpt-5.5"
    # `gpt-5-codex` was dropped from codex 0.139.0's catalog -> remap to default.
    assert normalize_codex_model("gpt-5-codex") == "gpt-5.5"
    assert normalize_codex_model("openai/gpt-5-codex") == "gpt-5.5"
    assert normalize_codex_model("anthropic/claude-opus-4-8") == "gpt-5.5"  # default


# --- antigravity -------------------------------------------------------------


@pytest.fixture
def agy_home(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_LOCAL_SANDBOX_ROOT", str(tmp_path / "sandbox"))
    monkeypatch.delenv("CLI_AGENT_AGY_HOME", raising=False)
    monkeypatch.delenv("AGY_AUTH_JSON", raising=False)
    return tmp_path / "sandbox"


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


def test_agy_seed_writes_gemini_md_and_settings(agy_home):
    get_adapter("antigravity").seed(AGY_SESSION)
    assert (agy_home / ".gemini/GEMINI.md").read_text().startswith("Be terse.")
    settings = json.loads((agy_home / ".gemini/antigravity-cli/settings.json").read_text())
    assert settings["model"] == "gemini-2.5-pro"
    assert settings["enableTelemetry"] is False
    assert str(agy_home).endswith("sandbox") or settings["trustedWorkspaces"]


def test_agy_build_argv():
    argv = get_adapter("antigravity").build_argv(AGY_SESSION["agentConfig"], {})
    assert argv[0] == "agy"
    assert "--model" in argv and "gemini-2.5-pro" in argv
    # default mode: no skip-permissions
    assert "--dangerously-skip-permissions" not in argv


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
    assert normalize_agy_model("gemini-2.0-flash") == "gemini-2.0-flash"
    assert normalize_agy_model("anthropic/claude-opus-4-8") is None  # default empty
