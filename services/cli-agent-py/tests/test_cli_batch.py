from __future__ import annotations

import subprocess
from pathlib import Path

from src.cli_adapters import get_adapter
import src.cli_batch as batch


def test_codex_batch_uses_output_schema_and_returns_structured_output(
    tmp_path, monkeypatch
):
    sandbox = tmp_path / "sandbox"
    sandbox.mkdir()
    monkeypatch.setenv("AGENT_LOCAL_SANDBOX_ROOT", str(sandbox))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex-home"))
    monkeypatch.setattr(get_adapter("codex"), "on_session_started", lambda _sid: None)
    published: list[tuple[str, str, dict]] = []
    monkeypatch.setattr(
        batch,
        "publish_session_event",
        lambda sid, etype, data, **_kw: published.append((sid, etype, data)),
    )
    seen_argv: list[str] = []

    def fake_run(argv, *, cwd, env):
        seen_argv.extend(argv)
        assert cwd == str(sandbox)
        output_path = Path(argv[argv.index("--output-last-message") + 1])
        output_path.write_text('{"answer": "yes"}\n', encoding="utf-8")
        return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

    monkeypatch.setattr(batch, "_run_subprocess", fake_run)

    result = batch.run_cli_once_activity(
        {
            "sessionId": "sess-batch",
            "instanceId": "inst-batch",
            "autoTerminateAfterEndTurn": True,
            "seedUserMessage": "return the object",
            "agentConfig": {
                "runtime": "codex-cli",
                "cliAdapter": "codex",
                "responseJsonSchema": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["answer"],
                    "properties": {"answer": {"type": "string"}},
                },
            },
            "seed": {"paths": {}},
        }
    )

    assert seen_argv[:2] == ["codex", "exec"]
    assert "--output-schema" in seen_argv
    assert result["status"] == "completed"
    assert result["structuredOutput"] == {"answer": "yes"}
    assert ("sess-batch", "structured_output.validation", {"ok": True, "source": "native_schema"}) in published
    assert any(event[1] == "agent.message" for event in published)
