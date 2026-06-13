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
