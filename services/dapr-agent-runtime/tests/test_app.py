import inspect
import json
import subprocess
from pathlib import Path

import app
import langgraph_engine
import msgpack
import pytest
import tools
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
    _event_payload_id,
    _load_workspace_session,
    _load_run_context,
    _normalize_run_request,
    _publish_agent_events,
    _persist_run_context,
    _persist_workspace_session,
    _resolve_runner_workflow_client,
    _resolve_effective_tool_group,
    _resolve_run_engine,
    _schedule_workflow_run,
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
from tools import (
    build_workspace_patch,
    execute_command,
    list_files,
    read_file,
    summarize_command_changes,
)
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


def test_langgraph_model_builder_normalizes_openai_prefix(monkeypatch) -> None:
    recorded: dict[str, str | None] = {"model": None}

    def fake_init_chat_model(model: str, api_key: str | None = None):
        recorded["model"] = model
        return {"model": model, "api_key": api_key}

    monkeypatch.setattr(langgraph_engine, "init_chat_model", fake_init_chat_model)

    result = langgraph_engine._build_model("openai/gpt-5.4", "test-key")

    assert result == {"model": "openai:gpt-5.4", "api_key": "test-key"}
    assert recorded["model"] == "openai:gpt-5.4"


def test_langgraph_tool_invoker_unwraps_nested_args() -> None:
    def fake_git_status(path: str = ".") -> dict[str, str]:
        return {"path": path}

    result = langgraph_engine._invoke_tool(fake_git_status, args={"path": "repo"})

    assert result == {"path": "repo"}


def test_langgraph_bound_tools_preserve_function_signatures() -> None:
    bound_tools = langgraph_engine._bind_workspace_tools("planning", "/tmp/workspace")
    read_tool = next(tool for tool in bound_tools if tool.__name__ == "read_file")

    signature = inspect.signature(read_tool)

    assert "path" in signature.parameters


def test_langgraph_bound_tools_return_recoverable_missing_file_errors(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    context = ToolRuntimeContext.from_workspace_root(repo_root)
    token = push_tool_context(context)
    try:
        bound_tools = langgraph_engine._bind_workspace_tools("all", str(repo_root))
        read_tool = next(tool for tool in bound_tools if tool.__name__ == "read_file")

        result = read_tool("scripts/langgraph_smoke_report.py")
    finally:
        pop_tool_context(token)

    assert result["tool"] == "read_file"
    assert result["recoverable"] is True
    assert result["error"] == "File not found: scripts/langgraph_smoke_report.py"
    assert "write_file" in result["hint"]


def test_execute_command_returns_structured_timeout(monkeypatch, tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    context = ToolRuntimeContext.from_workspace_root(repo_root)
    token = push_tool_context(context)

    def fake_run(*_args, **_kwargs):
        raise subprocess.TimeoutExpired(
            cmd="pnpm type-check",
            timeout=tools.COMMAND_TIMEOUT_SECONDS,
            output="partial stdout",
            stderr="partial stderr",
        )

    monkeypatch.setattr("tools.subprocess.run", fake_run)

    try:
        result = execute_command("pnpm type-check")
    finally:
        pop_tool_context(token)

    assert result["exitCode"] == 124
    assert result["timedOut"] is True
    assert "timed out after" in result["stderr"]
    assert result["stdout"] == "partial stdout"


def test_langgraph_plan_phase_uses_read_only_tools_and_no_subagents() -> None:
    assert langgraph_engine._effective_tool_group("plan", "planning") == "read_only"
    assert langgraph_engine._effective_subagents("plan", "/tmp/workspace") == []


def test_langgraph_plan_phase_interrupts_and_resumes_with_checkpoint(monkeypatch) -> None:
    from langgraph.checkpoint.memory import InMemorySaver

    calls: list[list[dict[str, str]]] = []
    saver = InMemorySaver()

    class FakeModel:
        def invoke(self, messages):
            calls.append(messages)
            return {
                "text": json.dumps(
                    {
                        "artifactType": "claude_task_graph_v1",
                        "summary": "Plan response",
                        "tasks": [{"title": "Inspect repo"}],
                        "files": ["services/app.py"],
                        "verificationCommands": ["pnpm type-check"],
                    }
                )
            }

    monkeypatch.setattr(langgraph_engine, "is_langgraph_available", lambda: True)
    monkeypatch.setattr(langgraph_engine, "_build_model", lambda model, api_key: FakeModel())
    monkeypatch.setattr(langgraph_engine, "_build_checkpointer", lambda: saver)

    result = langgraph_engine.run_langgraph_task(
        prompt="Plan the work",
        workspace_root="/tmp/workspace",
        tool_group="planning",
        model="gpt-5.4",
        profile="feature-delivery",
        phase="plan",
        thread_id="plan-thread-123",
        require_review=True,
    )

    assert result.metadata["planner"] == "checkpointed-graph"
    assert result.metadata["threadId"] == "plan-thread-123"
    assert result.metadata["plannerStatus"] == "awaiting_review"
    assert result.metadata["sessionPersistence"] == "dapr-checkpointer"
    assert isinstance(result.metadata["approvalPayload"], dict)
    assert result.structured_output["summary"] == "Plan response"
    assert len(calls) == 1

    resumed = langgraph_engine.run_langgraph_task(
        prompt="Plan the work",
        workspace_root="/tmp/workspace",
        tool_group="planning",
        model="gpt-5.4",
        profile="feature-delivery",
        phase="plan",
        thread_id="plan-thread-123",
        require_review=True,
        planner_resume={"action": "approve", "approved": True},
    )

    assert resumed.metadata["plannerStatus"] == "approved"
    assert resumed.metadata["plannerCheckpointId"]
    assert resumed.structured_output["summary"] == "Plan response"
    assert len(calls) == 1


def test_langgraph_plan_phase_edit_feedback_reinterrupts(monkeypatch) -> None:
    from langgraph.checkpoint.memory import InMemorySaver

    calls: list[list[dict[str, str]]] = []
    saver = InMemorySaver()

    class FakeModel:
        def invoke(self, messages):
            calls.append(messages)
            return {
                "text": json.dumps(
                    {
                        "artifactType": "claude_task_graph_v1",
                        "summary": f"Plan revision {len(calls)}",
                        "tasks": [{"title": "Inspect repo"}],
                        "files": ["services/app.py"],
                        "verificationCommands": ["pnpm type-check"],
                    }
                )
            }

    monkeypatch.setattr(langgraph_engine, "is_langgraph_available", lambda: True)
    monkeypatch.setattr(langgraph_engine, "_build_model", lambda model, api_key: FakeModel())
    monkeypatch.setattr(langgraph_engine, "_build_checkpointer", lambda: saver)

    first = langgraph_engine.run_langgraph_task(
        prompt="Plan the work",
        workspace_root="/tmp/workspace",
        tool_group="planning",
        model="gpt-5.4",
        profile="feature-delivery",
        phase="plan",
        thread_id="plan-thread-edit",
        require_review=True,
    )

    edited = langgraph_engine.run_langgraph_task(
        prompt="Plan the work",
        workspace_root="/tmp/workspace",
        tool_group="planning",
        model="gpt-5.4",
        profile="feature-delivery",
        phase="plan",
        thread_id="plan-thread-edit",
        require_review=True,
        planner_resume={"action": "edit", "feedback": "Add more detail on testing"},
    )

    assert first.metadata["plannerStatus"] == "awaiting_review"
    assert edited.metadata["plannerStatus"] == "awaiting_review"
    assert edited.structured_output["summary"] == "Plan revision 2"
    assert len(calls) == 2


def test_langgraph_execute_phase_uses_dapr_checkpointer_and_thread_id(
    monkeypatch,
    tmp_path: Path,
) -> None:
    captured: dict[str, object] = {}

    class FakeCheckpointer:
        def __init__(self, *, store_name: str, key_prefix: str) -> None:
            captured["store_name"] = store_name
            captured["key_prefix"] = key_prefix

    class FakeGraph:
        def invoke(self, payload, config=None):
            captured["payload"] = payload
            captured["config"] = config
            return {"text": "Executed"}

    def fake_create_deep_agent(**kwargs):
        captured["create_kwargs"] = kwargs
        return FakeGraph()

    monkeypatch.setattr(langgraph_engine, "is_langgraph_available", lambda: True)
    monkeypatch.setattr(langgraph_engine, "_build_model", lambda model, api_key: object())
    monkeypatch.setattr(langgraph_engine, "DaprCheckpointer", FakeCheckpointer)
    monkeypatch.setattr(langgraph_engine, "SafeDaprCheckpointer", FakeCheckpointer)
    monkeypatch.setattr(langgraph_engine, "create_deep_agent", fake_create_deep_agent)

    result = langgraph_engine.run_langgraph_task(
        prompt="Implement the task",
        workspace_root=str(tmp_path),
        tool_group="all",
        model="gpt-5.4",
        profile="implement",
        phase="execute",
        thread_id="thread-123",
    )

    assert captured["store_name"] == langgraph_engine.LANGGRAPH_CHECKPOINT_STORE_NAME
    assert captured["key_prefix"] == langgraph_engine.LANGGRAPH_CHECKPOINT_KEY_PREFIX
    assert captured["config"] == {"configurable": {"thread_id": "thread-123"}}
    assert result.metadata["threadId"] == "thread-123"
    assert result.metadata["sessionPersistence"] == "dapr-checkpointer"
    assert (
        result.metadata["checkpointStoreName"]
        == langgraph_engine.LANGGRAPH_CHECKPOINT_STORE_NAME
    )


def test_openshell_tool_context_maps_legacy_workspace_cwd() -> None:
    context = langgraph_engine.OpenShellToolContext(
        sandbox_name="openshell-test",
        repo_path="/sandbox/repo",
    )

    command = context._compose_command("git status --short", "/workspace")

    assert command == "set -eu; cd /sandbox/repo; git status --short"


def test_openshell_tool_context_rewrites_legacy_workspace_cd_commands() -> None:
    context = langgraph_engine.OpenShellToolContext(
        sandbox_name="openshell-test",
        repo_path="/sandbox/repo",
    )

    command = context._compose_command("cd /workspace; git status --short", ".")

    assert command == "set -eu; cd /sandbox/repo; cd /sandbox/repo; git status --short"


def test_safe_dapr_checkpointer_disables_corrupting_put_writes(monkeypatch) -> None:
    calls: dict[str, object] = {}

    class FakeCheckpointer:
        def __init__(self, *, store_name: str, key_prefix: str) -> None:
            calls["store_name"] = store_name
            calls["key_prefix"] = key_prefix

        def put_writes(self, config, writes, task_id, task_path="") -> None:
            calls["base_put_writes_called"] = True

    monkeypatch.setattr(langgraph_engine, "DaprCheckpointer", FakeCheckpointer)

    class FakeSafeCheckpointer(FakeCheckpointer):
        def put_writes(self, config, writes, task_id, task_path="") -> None:
            calls["safe_put_writes_called"] = True
            return None

    monkeypatch.setattr(langgraph_engine, "SafeDaprCheckpointer", FakeSafeCheckpointer)

    checkpointer = langgraph_engine._build_checkpointer()

    assert isinstance(checkpointer, FakeSafeCheckpointer)
    checkpointer.put_writes({}, [("messages", {"ok": True})], "task-1")
    assert calls["store_name"] == langgraph_engine.LANGGRAPH_CHECKPOINT_STORE_NAME
    assert calls["key_prefix"] == langgraph_engine.LANGGRAPH_CHECKPOINT_KEY_PREFIX
    assert "base_put_writes_called" not in calls
    assert calls["safe_put_writes_called"] is True


def test_safe_dapr_checkpointer_decodes_checkpoint_without_messages(monkeypatch) -> None:
    if langgraph_engine.SafeDaprCheckpointer is None or langgraph_engine.DaprCheckpointer is None:
        pytest.skip("Dapr LangGraph checkpointer unavailable")

    class FakeState:
        def __init__(self, data) -> None:
            self.data = data

    checkpoint_payload = msgpack.packb(
        {
            b"checkpoint": {
                b"id": b"checkpoint-1",
                b"ts": b"2026-03-21T00:00:00Z",
                b"v": 1,
                b"channel_values": {
                    b"planJson": {
                        b"summary": b"Durable plan",
                    }
                },
                b"channel_versions": {},
                b"versions_seen": {},
                b"pending_sends": [],
            },
            b"metadata": msgpack.packb({"source": "loop", "step": 1}),
        }
    )

    class FakeClient:
        def get_state(self, *, store_name: str, key: str):
            if key == "checkpoint_latest:thread-1:__empty__":
                return FakeState("checkpoint:thread-1::checkpoint-1")
            if key == "checkpoint:thread-1::checkpoint-1":
                return FakeState(checkpoint_payload)
            return FakeState(None)

    def raise_missing_messages(self, config):
        raise KeyError(b"messages")

    monkeypatch.setattr(langgraph_engine.DaprCheckpointer, "get_tuple", raise_missing_messages)

    checkpointer = object.__new__(langgraph_engine.SafeDaprCheckpointer)
    checkpointer.store_name = "workflowstatestore"
    checkpointer.client = FakeClient()

    result = langgraph_engine.SafeDaprCheckpointer.get_tuple(
        checkpointer,
        {"configurable": {"thread_id": "thread-1"}},
    )

    assert result is not None
    assert result.checkpoint["channel_values"]["planJson"]["summary"] == "Durable plan"
    assert result.metadata["source"] == "loop"


def test_schedule_workflow_run_passes_registered_workflow_object(monkeypatch) -> None:
    captured: dict[str, object] = {}

    class FakeClient:
        def schedule_new_workflow(self, workflow, *, input=None, instance_id=None):
            captured["workflow"] = workflow
            captured["input"] = input
            captured["instance_id"] = instance_id

    monkeypatch.setattr(app, "_workflow_client_for_runs", lambda: FakeClient())

    request = DaprAgentRunRequest(prompt="Plan the work")

    _schedule_workflow_run(request, instance_id="run-123", trace_id="trace-123")

    assert captured["workflow"] is app.dapr_agent_workflow
    assert captured["instance_id"] == "run-123"
    assert isinstance(captured["input"], dict)
    assert captured["input"]["prompt"] == "Plan the work"
    assert captured["input"]["traceId"] == "trace-123"


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


def test_build_task_prompt_uses_sandbox_repo_path_for_openshell_backend() -> None:
    prompt = _build_task_prompt(
        DaprAgentRunRequest(
            prompt="Implement slash commands",
            profile="implement",
            cwd="/tmp/local-clone",
            toolBackend="openshell",
            sandboxRepoPath="/sandbox/repo",
        )
    )

    assert "Repository root inside sandbox:\n/sandbox/repo" in prompt
    assert "/tmp/local-clone" not in prompt


def test_openshell_cleanup_preserves_sandbox_when_keep_enabled(monkeypatch) -> None:
    context = langgraph_engine.OpenShellToolContext(
        sandbox_name="openshell-test",
        repo_path="/sandbox/repo",
        keep=True,
    )
    calls: list[tuple[str, str]] = []

    def fake_request(*, method: str, path: str, **_kwargs):
        calls.append((method, path))
        return {}

    monkeypatch.setattr(context, "_request", fake_request)

    context.cleanup()

    assert calls == []


def test_openshell_cleanup_deletes_sandbox_when_keep_disabled(monkeypatch) -> None:
    context = langgraph_engine.OpenShellToolContext(
        sandbox_name="openshell-test",
        repo_path="/sandbox/repo",
        keep=False,
    )
    calls: list[tuple[str, str]] = []

    def fake_request(*, method: str, path: str, **_kwargs):
        calls.append((method, path))
        return {}

    monkeypatch.setattr(context, "_request", fake_request)

    context.cleanup()

    assert calls == [("DELETE", "/api/v1/sandboxes/openshell-test")]


def test_openshell_compose_command_bootstraps_pnpm_when_missing() -> None:
    context = langgraph_engine.OpenShellToolContext(
        sandbox_name="openshell-test",
        repo_path="/sandbox/repo",
    )

    command = context._compose_command("pnpm vitest run app/api/mcp-chat/route.test.ts")

    assert "cd /sandbox/repo;" in command
    assert "if ! command -v pnpm >/dev/null 2>&1; then" in command
    assert 'corepack pnpm "$@"' in command
    assert "npx -y pnpm" in command
    assert "if [ -f package.json ] && [ ! -d node_modules ]; then" in command
    assert "pnpm install --frozen-lockfile || pnpm install;" in command
    assert command.endswith("pnpm vitest run app/api/mcp-chat/route.test.ts")


def test_openshell_run_command_returns_structured_nonzero_results(monkeypatch) -> None:
    context = langgraph_engine.OpenShellToolContext(
        sandbox_name="openshell-test",
        repo_path="/sandbox/repo",
    )

    def fake_request(**_kwargs):
        raise RuntimeError(
            json.dumps(
                {
                    "status": "failed",
                    "sandboxName": "openshell-test",
                    "result": {
                        "returncode": 1,
                        "stdout": "",
                        "stderr": "",
                        "sandboxName": "openshell-test",
                    },
                }
            )
        )

    monkeypatch.setattr(context, "_request", fake_request)

    result = context.run_command("find . -type f | grep plan")

    assert result["exitCode"] == 1
    assert result["stderr"] == ""
    assert result["sandboxName"] == "openshell-test"


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


def test_run_context_from_record_parses_string_false_for_execute_after_approval() -> None:
    context = app.AgentRunContext.from_record(
        {
            "instanceId": "wf-123",
            "mode": "plan_mode",
            "profile": "feature-delivery",
            "model": "gpt-5.4",
            "engine": "langgraph-deepagents",
            "cwd": "/tmp/repo",
            "toolGroup": "planning",
            "maxTurns": 30,
            "executeAfterApproval": "false",
        }
    )

    assert context.execute_after_approval is False


def test_build_run_context_parses_string_false_for_execute_after_approval() -> None:
    context = _build_run_context(
        "wf-123",
        DaprAgentRunRequest(
            prompt="Plan the task",
            mode="plan_mode",
            executeAfterApproval="false",
        ),
    )

    assert context.execute_after_approval is False


def test_build_run_context_generates_langgraph_thread_id() -> None:
    context = _build_run_context(
        "wf-123",
        DaprAgentRunRequest(
            prompt="Implement the task",
            engine="langgraph",
            executionId="exec-123",
        ),
    )

    assert context.planning_thread_id == "lg:plan:exec-123"
    assert context.execution_thread_id == "lg:exec:exec-123"
    assert context.thread_id == "lg:exec:exec-123"


def test_build_run_context_derives_gitea_repository_url_for_openshell(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(app, "workspace_sessions", {})
    monkeypatch.setattr(app, "workspace_state_store", FakeStateStore())
    monkeypatch.setattr(app, "sessions_by_execution", {})
    monkeypatch.setattr(
        app,
        "GITEA_INTERNAL_CLONE_BASE_URL",
        "http://gitea-http.gitea.svc.cluster.local:3000",
    )

    session = WorkspaceSession(
        workspace_ref="workspace-123",
        execution_id="exec-123",
        root_path=tmp_path,
        working_directory=tmp_path,
        enabled_tools=[],
        repository_owner="giteaadmin",
        repository_repo="workflow-builder",
        repository_branch="main",
    )
    _persist_workspace_session(session)

    context = _build_run_context(
        "wf-openshell",
        DaprAgentRunRequest(
            prompt="Implement the task",
            engine="langgraph",
            toolBackend="openshell",
            workspaceRef="workspace-123",
            sandboxRepoPath="/sandbox/repo",
        ),
    )

    assert (
        context.repository_url
        == "http://gitea-http.gitea.svc.cluster.local:3000/giteaadmin/workflow-builder.git"
    )
def test_build_result_payload_publishes_run_complete_event(
    tmp_path: Path,
    monkeypatch,
) -> None:
    published: list[dict[str, object]] = []
    monkeypatch.setattr(app, "WORKSPACE_ROOT", tmp_path)
    monkeypatch.setattr(app, "run_state_store", FakeStateStore())
    monkeypatch.setattr(app, "run_context_cache", {})
    monkeypatch.setattr(
        app,
        "_publish_agent_events",
        lambda run_context, events: published.extend(events),
    )
    repo_root = tmp_path / "repo"
    repo_root.mkdir(parents=True)
    _persist_run_context(
        AgentRunContext(
            instance_id="wf-complete",
            mode="execute_direct",
            profile="implement",
            model="gpt-5.4",
            cwd=str(repo_root),
            tool_group="all",
            max_turns=30,
            execution_id="exec-complete",
            trace_id="trace-complete",
        )
    )

    payload = _build_result_payload(
        instance_id="wf-complete",
        request=DaprAgentRunRequest(
            prompt="Ship the feature",
            profile="implement",
            cwd=str(repo_root),
            executionId="exec-complete",
        ),
        workflow_output='{"content":"Completed the requested implementation"}',
    )

    assert payload["text"] == "Completed the requested implementation"
    assert published[-1]["type"] == "run_complete"
    assert published[-1]["id"] == _event_payload_id("wf-complete", "run_complete")


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


def test_build_result_payload_includes_langgraph_session_metadata(
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
            instance_id="wf-session",
            mode="execute_direct",
            profile="implement",
            model="gpt-5.4",
            engine="langgraph-deepagents",
            cwd=str(repo_root),
            tool_group="all",
            max_turns=30,
            execution_id="exec-session",
            thread_id="thread-123",
            planning_thread_id="plan-thread-123",
            execution_thread_id="thread-123",
        )
    )

    payload = _build_result_payload(
        instance_id="wf-session",
        request=DaprAgentRunRequest(
            prompt="Implement the task",
            profile="implement",
            cwd=str(repo_root),
            engine="langgraph",
            threadId="thread-123",
        ),
        workflow_output={
            "content": "Implemented successfully",
            "threadId": "thread-123",
            "planningThreadId": "plan-thread-123",
            "executionThreadId": "thread-123",
            "plannerStatus": "approved",
            "plannerCheckpointId": "checkpoint-1",
            "sessionPersistence": "dapr-checkpointer",
            "engineMetadata": {
                "threadId": "thread-123",
                "planningThreadId": "plan-thread-123",
                "executionThreadId": "thread-123",
                "checkpointStoreName": "workflowstatestore",
                "checkpointKeyPrefix": "langgraph:checkpoint:",
            },
        },
    )

    assert payload["threadId"] == "thread-123"
    assert payload["planningThreadId"] == "plan-thread-123"
    assert payload["executionThreadId"] == "thread-123"
    assert payload["plannerStatus"] == "approved"
    assert payload["plannerCheckpointId"] == "checkpoint-1"
    assert payload["sessionPersistence"] == "dapr-checkpointer"
    assert payload["engineMetadata"]["checkpointStoreName"] == "workflowstatestore"
def test_publish_agent_events_posts_to_workflow_builder(monkeypatch) -> None:
    captured: dict[str, object] = {}

    class FakeResponse:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args: object) -> None:
            return None

    def fake_urlopen(request, timeout: int = 0):
        captured["url"] = request.full_url
        captured["timeout"] = timeout
        captured["headers"] = dict(request.header_items())
        captured["body"] = request.data.decode("utf-8")
        return FakeResponse()

    monkeypatch.setattr(app, "WORKFLOW_BUILDER_BASE_URL", "http://workflow-builder.test")
    monkeypatch.setattr(app, "WORKFLOW_BUILDER_INTERNAL_API_TOKEN", "secret-token")
    monkeypatch.setattr(app.urllib.request, "urlopen", fake_urlopen)

    _publish_agent_events(
        AgentRunContext(
            instance_id="run-123",
            mode="execute_direct",
            profile="implement",
            model="gpt-5.4",
            cwd="/tmp/repo",
            tool_group="all",
            max_turns=12,
            execution_id="exec-123",
        ),
        [
            {
                "id": "run-123:run_started",
                "ts": "2026-03-22T20:00:00Z",
                "type": "run_started",
                "phase": "executing",
            }
        ],
    )

    assert captured["url"] == (
        "http://workflow-builder.test/api/internal/agent/workflows/executions/exec-123/events"
    )
    assert "secret-token" in str(captured["headers"])
    assert '"daprInstanceId": "run-123"' in str(captured["body"])
    assert '"type": "run_started"' in str(captured["body"])


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


def test_resolve_run_engine_honors_explicit_dapr_agent_override(monkeypatch) -> None:
    monkeypatch.setattr(app, "is_langgraph_available", lambda: True)

    engine = _resolve_run_engine(
        DaprAgentRunRequest(
            prompt="Implement the task",
            profile="implement",
            engine="dapr-agent",
        )
    )

    assert engine == "dapr-agent"


def test_execute_step_passes_explicit_engine(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def fake_api_run(request: DaprAgentRunRequest) -> dict[str, object]:
        captured["engine"] = request.engine
        captured["profile"] = request.profile
        return {"text": "ok", "engine": request.engine}

    monkeypatch.setattr(app, "api_run", fake_api_run)

    payload = execute_step(
        ExecuteRequest(
            step="run",
            execution_id="exec-1",
            workflow_id="wf-1",
            node_id="node-1",
            input={
                "prompt": "Implement the task",
                "engine": "langgraph",
                "profile": "implement",
            },
        )
    )

    assert captured == {"engine": "langgraph", "profile": "implement"}
    assert payload["success"] is True
    assert payload["data"]["engine"] == "langgraph"


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
                    "action": "approve",
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


def test_workspace_tools_allow_absolute_paths_within_workspace_root(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    readme_path = repo_root / "README.md"
    readme_path.write_text("repo readme", encoding="utf-8")

    context = ToolRuntimeContext.from_workspace_root(repo_root)
    token = push_tool_context(context)
    try:
        assert read_file(str(readme_path)) == "repo readme"
        assert list_files(str(repo_root)) == ["README.md"]
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
