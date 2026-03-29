from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

if "httpx" not in sys.modules:
    httpx_module = types.ModuleType("httpx")
    httpx_module.Client = object
    sys.modules["httpx"] = httpx_module

MODULE_PATH = ROOT / "activities" / "call_agent_service.py"
SPEC = importlib.util.spec_from_file_location("call_agent_service", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module from {MODULE_PATH}")
CALL_AGENT_SERVICE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CALL_AGENT_SERVICE)

_build_openshell_session_start_command = (
    CALL_AGENT_SERVICE._build_openshell_session_start_command
)


def test_build_openshell_session_start_command_uses_persistent_session():
    command = _build_openshell_session_start_command(
        {
            "prompt": "Inspect the repository and leave it ready for user handoff.",
            "provider": "claude",
            "model": "anthropic/claude-sonnet-4-6",
            "sandboxRepoPath": "/sandbox/repo",
            "sessionName": "handoff-session",
        },
        session_id="123e4567-e89b-12d3-a456-426614174000",
    )

    assert "cd /sandbox/repo &&" in command
    assert "--session-id 123e4567-e89b-12d3-a456-426614174000" in command
    assert "handoff-session" not in command
    assert "--permission-mode bypassPermissions" in command
    assert "--no-session-persistence" not in command


def test_build_openshell_session_start_command_forwards_claude_model():
    command = _build_openshell_session_start_command(
        {
            "prompt": "Initialize the session.",
            "provider": "claude",
            "model": "anthropic/claude-sonnet-4-6",
        },
        session_id="123e4567-e89b-12d3-a456-426614174000",
    )

    assert "--model claude-sonnet-4-6" in command
