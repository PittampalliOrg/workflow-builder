from pathlib import Path

import app
from app import (
    DaprAgentRunRequest,
    ExecuteRequest,
    PROFILE_TOOL_GROUPS,
    _build_result_payload,
    _build_task_prompt,
    _resolve_effective_tool_group,
    execute_step,
    runtime_introspect,
)


def test_profiles_default_to_expected_tool_groups() -> None:
    assert PROFILE_TOOL_GROUPS["review"] == "read_only"
    assert PROFILE_TOOL_GROUPS["implement"] == "all"


def test_build_task_prompt_includes_profile_specific_sections() -> None:
    prompt = _build_task_prompt(
        DaprAgentRunRequest(
            prompt="Fix the failing auth tests",
            profile="repair",
            cwd="/tmp/repo",
            expectedOutput="Green test suite",
            verifyCommands="pnpm test auth",
        )
    )

    assert "Profile: repair" in prompt
    assert "Repository root:\n/tmp/repo" in prompt
    assert "Verify commands:\npnpm test auth" in prompt


def test_resolve_effective_tool_group_prefers_request_policy() -> None:
    request = DaprAgentRunRequest(
        prompt="Review the repository",
        profile="review",
        toolPolicy="all",
    )

    assert _resolve_effective_tool_group(request) == "all"


def test_build_result_payload_returns_change_summary(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(app, "WORKSPACE_ROOT", tmp_path)
    repo_root = tmp_path / "repo"
    repo_root.mkdir(parents=True)

    payload = _build_result_payload(
        instance_id="wf-123",
        request=DaprAgentRunRequest(
            prompt="Explain the project",
            profile="review",
            cwd=str(repo_root),
        ),
        workflow_output='{"content":"Repository summary"}',
    )

    assert payload["text"] == "Repository summary"
    assert payload["agentWorkflowId"] == "wf-123"
    assert payload["runSummary"]["toolGroup"] == "read_only"


def test_runtime_introspect_reports_profiles() -> None:
    response = runtime_introspect()

    assert "implement" in response["profiles"]
    assert response["profileToolGroups"]["repair"] == "all"


def test_execute_step_wraps_api_run(monkeypatch) -> None:
    def fake_api_run(_request: DaprAgentRunRequest) -> dict[str, object]:
        return {"success": True, "text": "Applied fix", "agentWorkflowId": "wf-456"}

    monkeypatch.setattr(app, "api_run", fake_api_run)

    response = execute_step(
        ExecuteRequest(
            step="run",
            execution_id="exec-1",
            workflow_id="workflow-1",
            node_id="node-1",
            input={"prompt": "Apply the fix", "profile": "implement"},
        )
    )

    assert response["success"] is True
    assert response["data"]["text"] == "Applied fix"
