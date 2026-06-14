from __future__ import annotations

import src.output_sync as output_sync


def test_output_sync_accepts_timeout_ms(monkeypatch, tmp_path):
    sandbox = tmp_path / "sandbox"
    app_dir = sandbox / "app"
    app_dir.mkdir(parents=True)
    (app_dir / "index.html").write_text("<html></html>", encoding="utf-8")

    timeouts: list[int] = []

    def fake_post_workspace_command(*, workspace_ref, command, timeout_seconds):
        assert workspace_ref == "workspace-1"
        assert command
        timeouts.append(timeout_seconds)
        return {"ok": True, "exitCode": 0}

    monkeypatch.setenv("AGENT_LOCAL_SANDBOX_ROOT", str(sandbox))
    monkeypatch.setattr(
        output_sync, "_post_workspace_command", fake_post_workspace_command
    )

    result = output_sync.sync_output_activity(
        {
            "outputSync": {
                "workspaceRef": "workspace-1",
                "timeoutMs": 1500,
                "paths": [{"source": "app", "target": "/sandbox/app"}],
            }
        }
    )

    assert result["ok"] is True
    assert result["copied"][0]["fileCount"] == 1
    assert timeouts == [2, 2]


def test_output_sync_chunks_large_file_payloads(monkeypatch, tmp_path):
    sandbox = tmp_path / "sandbox"
    app_dir = sandbox / "app"
    app_dir.mkdir(parents=True)
    large_content = "console.log('x');\n" * 2000
    (app_dir / "script.js").write_text(large_content, encoding="utf-8")

    commands: list[str] = []

    def fake_post_workspace_command(*, workspace_ref, command, timeout_seconds):
        assert workspace_ref == "workspace-1"
        assert timeout_seconds == 30
        commands.append(command)
        return {"ok": True, "exitCode": 0}

    monkeypatch.setenv("AGENT_LOCAL_SANDBOX_ROOT", str(sandbox))
    monkeypatch.setattr(
        output_sync, "_post_workspace_command", fake_post_workspace_command
    )

    result = output_sync.sync_output_activity(
        {
            "outputSync": {
                "workspaceRef": "workspace-1",
                "timeoutSeconds": 30,
                "paths": [{"source": "app", "target": "/sandbox/app"}],
            }
        }
    )

    assert result["ok"] is True
    assert result["copied"][0]["fileCount"] == 1
    assert len(commands) > 3
    assert any("${target}.b64.wfbtmp" in command for command in commands)
    assert max(len(command) for command in commands) < 13_000
