from pathlib import Path

import app
from app import (
    AgentRunContext,
    DaprAgentRunRequest,
    ExecuteRequest,
    PROFILE_TOOL_GROUPS,
    WorkspaceCleanupRequest,
    WorkspaceProfileRequest,
    WorkspaceSession,
    _build_result_payload,
    _build_task_prompt,
    _load_workspace_session,
    _normalize_run_request,
    _persist_run_context,
    _persist_workspace_session,
    _resolve_runner_workflow_client,
    _resolve_effective_tool_group,
    _trace_id_from_otel,
    execute_step,
    runtime_introspect,
    workspace_change_artifact,
    workspace_cleanup,
    workspace_execution_changes,
    workspace_execution_file_snapshot,
    workspace_execution_patch,
    workspace_profile,
)
from tools import list_files, read_file
from tools import ToolRuntimeContext, pop_tool_context, push_tool_context


class FakeStateStore:
    def __init__(self) -> None:
        self.storage: dict[str, dict[str, object]] = {}

    def load(self, *, key: str, default: dict[str, object] | None = None, **_kwargs) -> dict[str, object]:
        return dict(self.storage.get(key, default or {}))

    def save(self, *, key: str, value: dict[str, object], **_kwargs) -> None:
        self.storage[key] = dict(value)

    def delete(self, *, key: str, **_kwargs) -> None:
        self.storage.pop(key, None)


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
    assert "repository-relative paths such as '.' or 'src/app.ts'" in prompt


def test_normalize_run_request_accepts_task_aliases() -> None:
    request = _normalize_run_request({"task": "Review the repo", "mode": "review"})

    assert request.prompt == "Review the repo"


def test_trace_id_from_otel_prefers_explicit_trace_id() -> None:
    assert (
        _trace_id_from_otel(
            {
                "traceId": "0123456789abcdef0123456789abcdef",
            }
        )
        == "0123456789abcdef0123456789abcdef"
    )


def test_resolve_runner_workflow_client_supports_callable_attr(monkeypatch) -> None:
    class FakeClient:
        pass

    class FakeRunner:
        def workflow_client(self) -> FakeClient:
            return FakeClient()

    monkeypatch.setattr(app, "runner", FakeRunner())

    client = _resolve_runner_workflow_client()

    assert isinstance(client, FakeClient)


def test_resolve_effective_tool_group_prefers_request_policy() -> None:
    request = DaprAgentRunRequest(
        prompt="Review the repository",
        profile="review",
        toolPolicy="all",
    )

    assert _resolve_effective_tool_group(request) == "all"


def test_resolve_effective_tool_group_maps_legacy_tools_bundle() -> None:
    request = DaprAgentRunRequest(
        prompt="Review the repository",
        profile="review",
        tools='["read","list","bash"]',
    )

    assert _resolve_effective_tool_group(request) == "all"


def test_build_result_payload_returns_change_summary(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(app, "WORKSPACE_ROOT", tmp_path)
    monkeypatch.setattr(app, "run_state_store", FakeStateStore())
    monkeypatch.setattr(app, "run_context_cache", {})
    repo_root = tmp_path / "repo"
    repo_root.mkdir(parents=True)
    _persist_run_context(
        AgentRunContext(
            instance_id="wf-123",
            profile="review",
            cwd=str(repo_root),
            tool_group="read_only",
            max_turns=30,
            trace_id="0123456789abcdef0123456789abcdef",
        )
    )

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
    assert payload["agentProgress"]["framework"] == "dapr-agent"
    assert payload["agentProgress"]["status"] == "completed"
    assert payload["traceId"] == "0123456789abcdef0123456789abcdef"


def test_workspace_execution_artifact_endpoints_use_persisted_run_artifacts(
    tmp_path: Path,
    monkeypatch,
) -> None:
    fake_store = FakeStateStore()
    monkeypatch.setattr(app, "run_state_store", fake_store)
    monkeypatch.setattr(app, "run_context_cache", {})
    monkeypatch.setattr(
        app,
        "summarize_command_changes",
        lambda _root: {
            "changeSummary": {
                "files": [{"path": "README.md", "additions": 2, "deletions": 0}],
                "stats": {"files": 1, "additions": 2, "deletions": 0},
                "changed": True,
            }
        },
    )
    monkeypatch.setattr(app, "git_diff", lambda _path=".": {"diff": "diff --git a/README.md b/README.md"})

    repo_root = tmp_path / "repo"
    repo_root.mkdir(parents=True)
    (repo_root / "README.md").write_text("hello", encoding="utf-8")

    _persist_run_context(
        AgentRunContext(
            instance_id="wf-artifacts",
            profile="implement",
            cwd=str(repo_root),
            tool_group="all",
            max_turns=12,
            execution_id="exec-artifacts",
            trace_id="trace-123",
        )
    )

    _build_result_payload(
        instance_id="wf-artifacts",
        request=DaprAgentRunRequest(
            prompt="Update the repo",
            profile="implement",
            cwd=str(repo_root),
            executionId="exec-artifacts",
        ),
        workflow_output='{"content":"Applied changes"}',
    )

    changes = workspace_execution_changes("exec-artifacts")
    patch = workspace_execution_patch("exec-artifacts")
    artifact = workspace_change_artifact("wf-artifacts-patch")
    snapshot = workspace_execution_file_snapshot("exec-artifacts", path="README.md")

    assert changes["count"] == 1
    assert patch["changeSets"][0]["changeSetId"] == "wf-artifacts-patch"
    assert "diff --git" in patch["patch"]
    assert artifact["metadata"]["executionId"] == "exec-artifacts"
    assert "diff --git" in artifact["patch"]
    assert snapshot["snapshot"]["content"] == "hello"


def test_runtime_introspect_reports_profiles() -> None:
    response = runtime_introspect()

    assert "implement" in response["profiles"]
    assert response["profileToolGroups"]["repair"] == "all"
    assert response["registry"]["enabled"] is True
    assert any(entry["name"] == "dapr-coding-agent" for entry in response["registry"]["registeredAgents"])
    assert any(profile["id"] == "review" for profile in response["publishedProfiles"])


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


def test_workspace_session_persists_through_state_store(tmp_path: Path, monkeypatch) -> None:
    fake_store = FakeStateStore()
    monkeypatch.setattr(app, "workspace_state_store", fake_store)
    monkeypatch.setattr(app, "workspace_sessions", {})
    monkeypatch.setattr(app, "sessions_by_execution", {})

    session = WorkspaceSession(
        workspace_ref="workspace-123",
        execution_id="exec-123",
        root_path=tmp_path,
        working_directory=tmp_path / "repo",
        enabled_tools=["read", "bash"],
    )
    _persist_workspace_session(session)
    app.workspace_sessions.clear()

    restored = _load_workspace_session("workspace-123")

    assert restored is not None
    assert restored.execution_id == "exec-123"
    assert restored.enabled_tools == ["read", "bash"]
    assert restored.working_directory == (tmp_path / "repo").resolve()


def test_workspace_cleanup_uses_persisted_execution_refs(tmp_path: Path, monkeypatch) -> None:
    fake_store = FakeStateStore()
    monkeypatch.setattr(app, "workspace_state_store", fake_store)
    monkeypatch.setattr(app, "workspace_sessions", {})
    monkeypatch.setattr(app, "sessions_by_execution", {})
    monkeypatch.setattr(app, "WORKSPACE_ROOT", tmp_path)

    profile = workspace_profile(
        WorkspaceProfileRequest(
            executionId="exec-cleanup",
            rootPath="exec-cleanup",
            enabledTools=["read"],
        )
    )
    workspace_root = Path(profile["rootPath"])
    assert workspace_root.exists()

    app.workspace_sessions.clear()
    app.sessions_by_execution.clear()

    response = workspace_cleanup(WorkspaceCleanupRequest(executionId="exec-cleanup"))

    assert response["cleanedWorkspaceRefs"] == [profile["workspaceRef"]]
    assert workspace_root.exists() is False


def test_workspace_tools_honor_explicit_workspace_root(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    sibling_root = tmp_path / "other"
    sibling_root.mkdir()

    (repo_root / "README.md").write_text("repo readme", encoding="utf-8")
    (sibling_root / "README.md").write_text("other readme", encoding="utf-8")

    context = ToolRuntimeContext.from_workspace_root(repo_root)
    token = push_tool_context(context)
    try:
        files = list_files(".")
        assert files == ["README.md"]
        assert read_file("README.md") == "repo readme"
    finally:
        pop_tool_context(token)
