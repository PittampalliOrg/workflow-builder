from pathlib import Path

import app
import pytest
from app import (
    AgentRunContext,
    ApproveRequest,
    DaprAgentRunRequest,
    ExecuteRequest,
    PROFILE_TOOL_GROUPS,
    TerminateRequest,
    WorkspaceCleanupRequest,
    WorkspaceProfileRequest,
    WorkspaceSession,
    _build_run_context,
    _build_result_payload,
    _build_task_prompt,
    _load_workspace_session,
    _load_run_context,
    _normalize_run_request,
    _persist_run_context,
    _persist_workspace_session,
    _resolve_runner_workflow_client,
    _resolve_effective_tool_group,
    _resolve_run_engine,
    _trace_id_from_otel,
    execute_step,
    api_run_approve,
    runtime_introspect,
    workspace_change_artifact,
    workspace_cleanup,
    workspace_execution_changes,
    workspace_execution_file_snapshot,
    workspace_execution_patch,
    workspace_profile,
)
from tools import build_workspace_patch, list_files, read_file, summarize_command_changes
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


def test_resolve_effective_tool_group_forces_read_only_during_planning() -> None:
    request = DaprAgentRunRequest(
        prompt="Plan the feature",
        profile="feature-delivery",
        mode="feature_delivery_plan",
        toolPolicy="all",
    )

    assert _resolve_effective_tool_group(request) == "planning"


def test_build_result_payload_returns_change_summary(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(app, "WORKSPACE_ROOT", tmp_path)
    monkeypatch.setattr(app, "run_state_store", FakeStateStore())
    monkeypatch.setattr(app, "run_context_cache", {})
    repo_root = tmp_path / "repo"
    repo_root.mkdir(parents=True)
    _persist_run_context(
        AgentRunContext(
            instance_id="wf-123",
            mode="execute_direct",
            profile="review",
            model="gpt-5.4",
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


def test_build_result_payload_returns_plan_artifact_for_planning_mode(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(app, "WORKSPACE_ROOT", tmp_path)
    monkeypatch.setattr(app, "run_state_store", FakeStateStore())
    monkeypatch.setattr(app, "run_context_cache", {})
    repo_root = tmp_path / "repo"
    repo_root.mkdir(parents=True)
    _persist_run_context(
        AgentRunContext(
            instance_id="wf-plan",
            mode="feature_delivery_plan",
            profile="feature-delivery",
            model="gpt-5.4",
            cwd=str(repo_root),
            tool_group="read_only",
            max_turns=30,
            trace_id="trace-plan",
        )
    )

    payload = _build_result_payload(
        instance_id="wf-plan",
        request=DaprAgentRunRequest(
            prompt="Add feature flags to the API",
            profile="feature-delivery",
            mode="feature_delivery_plan",
            cwd=str(repo_root),
            verifyCommands="pnpm type-check\npnpm test",
        ),
        workflow_output={
            "plan": {
                "summary": "Introduce feature flag checks in the API layer.",
                "tasks": [
                    {"title": "Audit current flag usage"},
                    {"title": "Implement API middleware"},
                ],
                "acceptanceCriteria": ["Feature flags gate the new endpoint"],
                "verificationCommands": ["pnpm type-check", "pnpm test"],
                "files": ["src/api/feature-flags.ts"],
            },
            "planMarkdown": "# Plan\n\n- Audit current flag usage",
        },
    )

    assert payload["mode"] == "feature_delivery_plan"
    assert payload["artifactRef"] == "plan_wf-plan"
    assert payload["plan"]["goal"] == "Add feature flags to the API"
    assert payload["plan"]["files"] == ["src/api/feature-flags.ts"]
    assert payload["verification"]["status"] == "planned"
    assert payload["snapshotRefs"] == []
    assert payload["agentProgress"]["phase"] == "planned"


def test_build_run_context_uses_request_model_over_runtime_default() -> None:
    context = _build_run_context(
        "wf-model",
        DaprAgentRunRequest(
            prompt="Review the project",
            profile="review",
            model="gpt-5.4",
        ),
        trace_id="trace-123",
    )

    assert context.model == "gpt-5.4"
    assert context.trace_id == "trace-123"


def test_resolve_run_engine_prefers_langgraph_for_coding_profiles(monkeypatch) -> None:
    monkeypatch.setattr(app, "is_langgraph_available", lambda: True)

    engine = _resolve_run_engine(
        DaprAgentRunRequest(
            prompt="Implement the task",
            profile="implement",
        )
    )

    assert engine == app.LANGGRAPH_ENGINE_NAME


def test_build_result_payload_marks_pending_plan_as_awaiting_approval(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(app, "WORKSPACE_ROOT", tmp_path)
    monkeypatch.setattr(app, "run_state_store", FakeStateStore())
    monkeypatch.setattr(app, "run_context_cache", {})
    repo_root = tmp_path / "repo"
    repo_root.mkdir(parents=True)
    _persist_run_context(
        AgentRunContext(
            instance_id="wf-awaiting",
            mode="feature_delivery_plan",
            profile="feature-delivery",
            model="gpt-5.4",
            engine=app.LANGGRAPH_ENGINE_NAME,
            cwd=str(repo_root),
            tool_group="planning",
            max_turns=30,
            execute_after_approval=True,
            approval_event_name="approval-wf-awaiting",
            trace_id="trace-awaiting",
        )
    )

    payload = _build_result_payload(
        instance_id="wf-awaiting",
        request=DaprAgentRunRequest(
            prompt="Add feature flags",
            profile="feature-delivery",
            mode="feature_delivery_plan",
            cwd=str(repo_root),
        ),
        workflow_output={
            "plan": {
                "summary": "Implement feature flags safely.",
                "tasks": [{"title": "Update middleware"}],
                "verificationCommands": ["pnpm type-check"],
            },
            "planMarkdown": "# Plan",
        },
        pending_approval=True,
    )

    assert payload["status"] == "awaiting_approval"
    assert payload["approvalEventName"] == "approval-wf-awaiting"
    assert payload["agentProgress"]["phase"] == "awaiting_approval"
    assert payload["runSummary"]["engine"] == app.LANGGRAPH_ENGINE_NAME


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
            mode="execute_direct",
            profile="implement",
            model="gpt-5.4",
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


def test_build_result_payload_falls_back_to_persisted_workspace_mutation(
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
                "files": [],
                "stats": {"files": 0, "additions": 0, "deletions": 0},
                "changed": False,
            }
        },
    )
    monkeypatch.setattr(app, "git_diff", lambda _path=".": {"diff": ""})

    repo_root = tmp_path / "repo"
    repo_root.mkdir(parents=True)
    (repo_root / "scripts").mkdir()
    created = repo_root / "scripts" / "demo.py"
    created.write_text("print('hello')\n", encoding="utf-8")

    app._persist_run_context(
        app.AgentRunContext(
            instance_id="wf-fallback",
            mode="execute_direct",
            profile="implement",
            model="gpt-5.4",
            cwd=str(repo_root),
            tool_group="all",
            max_turns=12,
            execution_id="exec-fallback",
            trace_id="trace-fallback",
        )
    )
    app._persist_workspace_mutation(
        "wf-fallback",
        {
            "changeSummary": {
                "files": [
                    {
                        "path": "scripts/demo.py",
                        "additions": 1,
                        "deletions": 0,
                        "status": "untracked",
                    }
                ],
                "stats": {"files": 1, "additions": 1, "deletions": 0},
                "changed": True,
            },
            "patch": "diff --git a/scripts/demo.py b/scripts/demo.py\n",
        },
    )

    payload = app._build_result_payload(
        instance_id="wf-fallback",
        request=app.DaprAgentRunRequest(
            prompt="Update the repo",
            profile="implement",
            cwd=str(repo_root),
            executionId="exec-fallback",
        ),
        workflow_output='{"content":"Applied changes"}',
    )

    assert payload["patch"].startswith("diff --git a/scripts/demo.py")
    assert payload["changeSummary"]["changed"] is True
    assert payload["fileChanges"][0]["path"] == "scripts/demo.py"
    assert payload["snapshotRefs"] == ["scripts/demo.py"]


def test_change_summary_and_patch_include_untracked_files(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir(parents=True)
    subprocess_run = __import__("subprocess").run
    subprocess_run(
        ["git", "init"],
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
    )
    (repo_root / "scripts").mkdir()
    (repo_root / "scripts" / "__pycache__").mkdir()
    created = repo_root / "scripts" / "demo.py"
    created.write_text("print('hello')\n", encoding="utf-8")
    generated = repo_root / "scripts" / "__pycache__" / "demo.cpython-312.pyc"
    generated.write_bytes(b"pyc")

    summary = summarize_command_changes(repo_root)
    patch = build_workspace_patch(repo_root)

    assert summary["changeSummary"]["changed"] is True
    assert summary["changeSummary"]["files"][0]["path"] == "scripts/demo.py"
    assert summary["changeSummary"]["files"][0]["status"] == "untracked"
    assert "diff --git a/scripts/demo.py b/scripts/demo.py" in patch
    assert "__pycache__" not in patch


def test_runtime_introspect_reports_profiles() -> None:
    response = runtime_introspect()

    assert "implement" in response["profiles"]
    assert response["profileToolGroups"]["repair"] == "all"
    assert response["registry"]["enabled"] is True
    assert any(entry["name"] == "dapr-coding-agent" for entry in response["registry"]["registeredAgents"])
    assert any(profile["id"] == "review" for profile in response["publishedProfiles"])


def test_api_run_terminate_cleans_workspace_and_keeps_run_context(
    tmp_path: Path,
    monkeypatch,
) -> None:
    fake_store = FakeStateStore()
    monkeypatch.setattr(app, "run_state_store", fake_store)
    monkeypatch.setattr(app, "workspace_state_store", fake_store)
    monkeypatch.setattr(app, "run_context_cache", {})
    monkeypatch.setattr(app, "workspace_sessions", {})
    monkeypatch.setattr(app, "sessions_by_execution", {})

    class FakeWorkflowClient:
        def __init__(self) -> None:
            self.terminated: list[tuple[str, object]] = []

        def terminate_workflow(self, instance_id: str, *, output: object = None) -> None:
            self.terminated.append((instance_id, output))

    fake_client = FakeWorkflowClient()
    monkeypatch.setattr(app, "_workflow_client_for_runs", lambda: fake_client)

    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir(parents=True)
    repo_root = workspace_root / "repo"
    repo_root.mkdir()

    session = WorkspaceSession(
        workspace_ref="workspace-123",
        execution_id="exec-123",
        root_path=workspace_root,
        working_directory=repo_root,
        enabled_tools=["read", "bash"],
    )
    _persist_workspace_session(session)
    _persist_run_context(
        AgentRunContext(
            instance_id="wf-terminate",
            mode="execute_direct",
            profile="implement",
            model="gpt-5.4",
            cwd=str(repo_root),
            tool_group="all",
            max_turns=12,
            execution_id="exec-123",
            workspace_ref="workspace-123",
            trace_id="trace-terminate",
        )
    )

    response = app.api_run_terminate(
        "wf-terminate",
        TerminateRequest(
            reason="timeout",
            workspaceRef="workspace-123",
            cleanupWorkspace=True,
        ),
    )

    assert response["success"] is True
    assert fake_client.terminated == [("wf-terminate", "timeout")]
    assert _load_workspace_session("workspace-123") is None
    assert _load_run_context("wf-terminate") is not None


def test_api_run_approve_raises_workflow_event(monkeypatch) -> None:
    fake_store = FakeStateStore()
    monkeypatch.setattr(app, "run_state_store", fake_store)
    monkeypatch.setattr(app, "run_context_cache", {})

    class FakeWorkflowClient:
        def __init__(self) -> None:
            self.raised: list[tuple[str, str, dict[str, object]]] = []

        def raise_workflow_event(self, *, instance_id: str, event_name: str, data: dict[str, object]) -> None:
            self.raised.append((instance_id, event_name, data))

    fake_client = FakeWorkflowClient()
    monkeypatch.setattr(app, "_workflow_client_for_runs", lambda: fake_client)

    _persist_run_context(
        AgentRunContext(
            instance_id="wf-approve",
            mode="feature_delivery_plan",
            profile="feature-delivery",
            model="gpt-5.4",
            cwd="/tmp",
            tool_group="planning",
            max_turns=30,
            engine=app.LANGGRAPH_ENGINE_NAME,
            execute_after_approval=True,
            approval_event_name="approval-wf-approve",
            trace_id="trace-approve",
        )
    )

    response = api_run_approve(
        "wf-approve",
        ApproveRequest(approved=True, reason="Looks good", approvedBy="reviewer@example.com"),
    )

    assert response["success"] is True
    assert response["approvalEventName"] == "approval-wf-approve"
    assert fake_client.raised == [
        (
            "wf-approve",
            "approval-wf-approve",
            {
                "approved": True,
                "reason": "Looks good",
                "approvedBy": "reviewer@example.com",
                "respondedBy": "reviewer@example.com",
            },
        )
    ]


def test_rejected_tool_attempt_still_advances_iteration(monkeypatch) -> None:
    fake_store = FakeStateStore()
    monkeypatch.setattr(app, "run_state_store", fake_store)
    monkeypatch.setattr(app, "run_context_cache", {})

    _persist_run_context(
        AgentRunContext(
            instance_id="wf-rejected-tool",
            mode="execute_direct",
            profile="review",
            model="gpt-5.4",
            cwd="/tmp",
            tool_group="read_only",
            max_turns=24,
            trace_id="trace-rejected-tool",
        )
    )

    fake_agent = object.__new__(app.CodingDurableAgent)

    with pytest.raises(app.AgentError, match="not allowed for tool group"):
        app.CodingDurableAgent.run_tool(
            fake_agent,
            None,
            {
                "instance_id": "wf-rejected-tool",
                "tool_call": {
                    "id": "tool-1",
                    "function": {
                        "name": "ExecuteCommand",
                        "arguments": "{}",
                    },
                },
            },
        )

    progress = app._load_agent_progress("wf-rejected-tool")

    assert progress is not None
    assert progress["currentIteration"] == 1
    assert progress["activeToolName"] is None
    assert progress["recentTurns"] == [
        {
            "label": "ExecuteCommand",
            "summary": "Rejected ExecuteCommand: not allowed for read_only",
            "status": "failed",
        }
    ]


def test_call_llm_advances_iteration(monkeypatch) -> None:
    fake_store = FakeStateStore()
    monkeypatch.setattr(app, "run_state_store", fake_store)
    monkeypatch.setattr(app, "run_context_cache", {})

    _persist_run_context(
        AgentRunContext(
            instance_id="wf-call-llm",
            mode="execute_direct",
            profile="review",
            model="gpt-5.4",
            cwd="/tmp",
            tool_group="read_only",
            max_turns=24,
            trace_id="trace-call-llm",
        )
    )

    monkeypatch.setattr(
        app.DurableAgent,
        "call_llm",
        lambda self, ctx, payload: {
            "role": "assistant",
            "content": "ok",
        },
        raising=False,
    )

    fake_agent = object.__new__(app.CodingDurableAgent)

    result = app.CodingDurableAgent.call_llm(
        fake_agent,
        None,
        {
            "instance_id": "wf-call-llm",
        },
    )

    progress = app._load_agent_progress("wf-call-llm")

    assert result["content"] == "ok"
    assert progress is not None
    assert progress["currentIteration"] == 1
    assert progress["summary"] == "Reasoning iteration 1"


def test_dapr_agent_workflow_does_not_reset_progress_during_replay(monkeypatch) -> None:
    calls: list[tuple[str, str]] = []

    class FakeAgent:
        def agent_workflow(self, _ctx, _message):
            if False:
                yield None
            return {"content": "done"}

    class FakeCtx:
        instance_id = "wf-replay"
        is_replaying = True

    monkeypatch.setattr(app, "_persist_run_context", lambda *_args, **_kwargs: calls.append(("persist", "context")))
    monkeypatch.setattr(
        app,
        "_persist_agent_progress",
        lambda *_args, **_kwargs: calls.append(("persist", "progress")),
    )
    monkeypatch.setattr(
        app,
        "_update_agent_progress",
        lambda *_args, **_kwargs: calls.append(("update", "progress")),
    )
    monkeypatch.setattr(app, "_build_run_agent", lambda _run_context: FakeAgent())
    monkeypatch.setattr(app, "_build_result_payload", lambda **_kwargs: {"ok": True})

    workflow = app.dapr_agent_workflow(
        FakeCtx(),
        {
            "prompt": "Review the project",
            "profile": "review",
        },
    )

    with pytest.raises(StopIteration) as stop:
        next(workflow)

    assert stop.value.value == {"ok": True}
    assert calls == []


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


def test_api_run_status_falls_back_to_persisted_state_when_workflow_client_is_unavailable(
    tmp_path: Path,
    monkeypatch,
) -> None:
    fake_store = FakeStateStore()
    monkeypatch.setattr(app, "run_state_store", fake_store)
    monkeypatch.setattr(app, "run_context_cache", {})
    monkeypatch.setattr(app, "runner", None)

    repo_root = tmp_path / "repo"
    repo_root.mkdir(parents=True)
    _persist_run_context(
        AgentRunContext(
            instance_id="wf-persisted",
            mode="feature_delivery_execute",
            profile="feature-delivery",
            model="gpt-5.4",
            cwd=str(repo_root),
            tool_group="all",
            max_turns=40,
            execution_id="exec-persisted",
            artifact_ref="plan_persisted",
            trace_id="trace-persisted",
        )
    )
    app._persist_agent_progress(
        "wf-persisted",
        {
            "framework": "dapr-agent",
            "status": "completed",
            "phase": "completed",
            "summary": "Applied approved plan",
            "currentIteration": 7,
            "maxIterations": 40,
            "traceId": "trace-persisted",
        },
    )
    app._persist_run_artifact(
        "wf-persisted",
        {
            "patch": "diff --git a/demo.py b/demo.py",
            "artifactRef": "plan_persisted",
            "changeSummary": {
                "files": [{"path": "demo.py", "additions": 3, "deletions": 0}],
                "stats": {"files": 1, "additions": 3, "deletions": 0},
                "changed": True,
            },
            "fileChanges": [{"path": "demo.py", "additions": 3, "deletions": 0}],
            "snapshotRefs": ["demo.py"],
        },
    )

    status = app.api_run_status("wf-persisted")

    assert status["status"] == "completed"
    assert status["runtimeStatus"] == "PERSISTED_STATE"
    assert status["traceId"] == "trace-persisted"
    assert status["agentProgress"]["currentIteration"] == 7
    assert "diff --git" in status["serializedOutput"]


def test_api_run_status_reconstructs_running_progress_from_context_when_state_lookup_fails(
    tmp_path: Path,
    monkeypatch,
) -> None:
    fake_store = FakeStateStore()
    monkeypatch.setattr(app, "run_state_store", fake_store)
    monkeypatch.setattr(app, "run_context_cache", {})

    repo_root = tmp_path / "repo"
    repo_root.mkdir(parents=True)
    _persist_run_context(
        AgentRunContext(
            instance_id="wf-running",
            mode="feature_delivery_plan",
            profile="feature-delivery",
            model="gpt-5.4",
            cwd=str(repo_root),
            tool_group="planning",
            max_turns=25,
            execution_id="exec-running",
            trace_id="trace-running",
        )
    )

    class RaisingClient:
        def get_workflow_state(self, *_args, **_kwargs):
            raise RuntimeError("workflow state temporarily unavailable")

    class FakeRunner:
        workflow_client = RaisingClient()

    monkeypatch.setattr(app, "runner", FakeRunner())

    status = app.api_run_status("wf-running")

    assert status["status"] == "running"
    assert status["runtimeStatus"] == "PERSISTED_STATE"
    assert status["phase"] == "planning"
    assert status["agentProgress"]["currentIteration"] == 0
    assert status["traceId"] == "trace-running"
