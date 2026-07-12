from __future__ import annotations

import json
from pathlib import Path

from core.sw_expressions import evaluate_expression


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_PATH = (
    REPOSITORY_ROOT
    / "scripts"
    / "fixtures"
    / "generator-critic"
    / "microservice-dev-session.json"
)
SERVICES = (
    "workflow-builder",
    "workflow-orchestrator",
    "function-router",
    "mcp-gateway",
    "workflow-mcp-server",
)


def test_clone_command_evaluates_and_preserves_inner_jq_interpolation() -> None:
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    expression = next(
        entry["clone_repo"]["with"]["command"]
        for entry in fixture["do"]
        if "clone_repo" in entry
    )
    context = {
        "trigger": {
            "repoUrl": "PittampalliOrg/workflow-builder",
            "sourceRevision": "a" * 40,
            "mode": "preview-native",
            "service": SERVICES[0],
        },
        "provision_preview": {
            "services": [
                {
                    "service": service,
                    "ok": True,
                    "info": {
                        "ready": True,
                        "repoSubdir": ".",
                        "syncPaths": ["src"],
                        "syncUrl": f"https://{service}.example.test/sync",
                        "syncCapability": f"capability-{service}",
                        "extraSync": [],
                        "captureOnly": [],
                    },
                }
                for service in SERVICES
            ]
        },
    }

    command = evaluate_expression(expression, context)

    assert isinstance(command, str)
    assert "jq -r '.service as $service | (.info // .) as $info | \"" in command
    assert r"SERVICE=\($service | @sh)\n" in command
    assert r'SUBDIR=\(($info.repoSubdir // ".") | @sh)\n' in command
    assert r"PATHS=\((($info.syncPaths" in command
