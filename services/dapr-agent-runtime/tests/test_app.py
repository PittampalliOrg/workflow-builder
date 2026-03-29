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
    BrowserCaptureFlowRequest,
    BrowserCaptureStepRequest,
    BrowserMaterializeChangeArtifactRequest,
    BrowserValidateRequest,
    DaprAgentRunRequest,
    ExecuteRequest,
    PROFILE_TOOL_GROUPS,
    TerminateRequest,
    WorkspaceCapabilityValidationRequest,
    WorkspaceCleanupRequest,
    WorkspaceCommandRequest,
    WorkspaceProfileRequest,
    WorkspaceSession,
    _detect_repository_signals,
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
    _validate_workspace_capabilities,
    _resolve_runner_workflow_client,
    _resolve_effective_tool_group,
    _resolve_run_engine,
    _schedule_workflow_run,
    _trace_id_from_otel,
    execute_step,
    api_run_approve,
    runtime_introspect,
    workspace_capabilities_validate,
    workspace_change_artifact,
    workspace_cleanup,
    workspace_execution_changes,
    workspace_execution_file_snapshot,
    workspace_execution_patch,
    workspace_profile,
    _capture_browser_step_with_retry,
    BROWSER_CAPTURE_STEP_ATTEMPT_TIMEOUT_MS,
    PlaywrightTimeoutError,
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

    assert (
        command
        == "set -eu; unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy; "
        "export HOME=/tmp; cd /sandbox/repo; git status --short"
    )


def test_openshell_tool_context_rewrites_legacy_workspace_cd_commands() -> None:
    context = langgraph_engine.OpenShellToolContext(
        sandbox_name="openshell-test",
        repo_path="/sandbox/repo",
    )

    command = context._compose_command("cd /workspace; git status --short", ".")

    assert (
        command
        == "set -eu; unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy; "
        "export HOME=/tmp; cd /sandbox/repo; cd /sandbox/repo; git status --short"
    )


def test_openshell_tool_context_can_preserve_proxy_environment() -> None:
    context = langgraph_engine.OpenShellToolContext(
        sandbox_name="openshell-test",
        repo_path="/sandbox/repo",
        preserve_proxy_env=True,
    )

    command = context._compose_command("pnpm install --frozen-lockfile", "basics/learn-starter")

    assert "unset HTTP_PROXY" not in command
    assert command.startswith("set -eu; export HOME=/tmp;")
    assert "cd /sandbox/repo/basics/learn-starter;" in command


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
    assert command.endswith("pnpm vitest run app/api/mcp-chat/route.test.ts")


def test_openshell_compose_argv_uses_non_login_bash() -> None:
    context = langgraph_engine.OpenShellToolContext(
        sandbox_name="openshell-test",
        repo_path="/sandbox/repo",
    )

    argv = context._compose_argv("pnpm build", "basics/learn-starter")

    assert argv[:4] == ["bash", "--noprofile", "--norc", "-lc"]
    assert "cd /sandbox/repo/basics/learn-starter;" in argv[4]


def test_openshell_run_command_returns_structured_nonzero_results(monkeypatch) -> None:
    context = langgraph_engine.OpenShellToolContext(
        sandbox_name="openshell-test",
        repo_path="/sandbox/repo",
    )
    requests: list[dict[str, object]] = []

    def fake_request(**kwargs):
        requests.append(kwargs)
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

    assert requests[0]["payload"]["command"][:4] == [
        "bash",
        "--noprofile",
        "--norc",
        "-lc",
    ]
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


def test_wait_for_sandbox_ready_supports_status_sandbox_name(monkeypatch) -> None:
    responses = iter(
        [
            {"status": {"sandbox": {"Name": "browser-claim"}}},
            {
                "status": {
                    "podName": "aio-browser-pool-123",
                    "podIp": "10.0.0.8",
                }
            },
        ]
    )

    monkeypatch.setattr(app, "_k8s_request", lambda *_args, **_kwargs: next(responses))

    ready = app._wait_for_sandbox_ready("browser-claim", timeout_ms=1000)

    assert ready == {
        "sandboxName": "browser-claim",
        "podName": "aio-browser-pool-123",
        "podIp": "10.0.0.8",
    }


def test_wait_for_sandbox_ready_supports_service_fqdn_and_pod_annotation(monkeypatch) -> None:
    responses = iter(
        [
            {"status": {"sandbox": {"Name": "browser-claim"}}},
            {
                "metadata": {
                    "annotations": {
                        "agents.x-k8s.io/pod-name": "aio-browser-pool-456",
                    }
                },
                "status": {
                    "serviceFQDN": "browser-claim.agent-sandbox.svc.cluster.local",
                },
            },
        ]
    )

    monkeypatch.setattr(app, "_k8s_request", lambda *_args, **_kwargs: next(responses))

    ready = app._wait_for_sandbox_ready("browser-claim", timeout_ms=1000)

    assert ready == {
        "sandboxName": "browser-claim",
        "podName": "aio-browser-pool-456",
        "podIp": "browser-claim.agent-sandbox.svc.cluster.local",
    }


def test_workspace_clone_k8s_uses_authenticated_clone_url(tmp_path: Path, monkeypatch) -> None:
    session = WorkspaceSession(
        workspace_ref="workspace-browser-clone",
        execution_id="exec-browser-clone",
        root_path=tmp_path / "workspace",
        working_directory=tmp_path / "workspace",
        enabled_tools=[],
        backend="k8s",
        sandbox_details={
            "podIp": "browser-claim.agent-sandbox.svc.cluster.local",
            "port": 8080,
            "executePath": "v1/shell/exec",
        },
    )
    session.root_path.mkdir(parents=True)

    monkeypatch.setattr(app, "_workspace_from_ref", lambda _workspace_ref: session)

    recorded_commands: list[str] = []

    def fake_run_k8s_workspace_command(*_args, **kwargs):
        recorded_commands.append(kwargs["command"])
        command = kwargs["command"]
        if "git rev-parse HEAD" in command:
            return {"success": True, "stdout": "deadbeef\n", "stderr": "", "exitCode": 0}
        if "find . -type f | wc -l" in command:
            return {"success": True, "stdout": "42\n", "stderr": "", "exitCode": 0}
        return {"success": True, "stdout": "", "stderr": "", "exitCode": 0}

    monkeypatch.setattr(app, "_run_k8s_workspace_command", fake_run_k8s_workspace_command)

    result = app.workspace_clone(
        app.WorkspaceCloneRequest(
            executionId="exec-browser-clone",
            workspaceRef="workspace-browser-clone",
            repositoryUrl="http://gitea-http.gitea.svc.cluster.local:3000/giteaadmin/ai-chatbot.git",
            repositoryOwner="giteaadmin",
            repositoryRepo="ai-chatbot",
            repositoryBranch="main",
            repositoryUsername="gitea-user",
            repositoryToken="token:with/slash",
            targetDir="ai-chatbot",
        )
    )

    assert "gitea-user:token%3Awith%2Fslash@gitea-http.gitea.svc.cluster.local:3000" in recorded_commands[0]
    assert recorded_commands[0].startswith("export GIT_TERMINAL_PROMPT=0 && rm -rf ")
    assert result["commitHash"] == "deadbeef"
    assert result["fileCount"] == 42


def test_create_browser_sandbox_session_bootstraps_workspace_root(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(app, "_k8s_request", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(
        app,
        "_wait_for_sandbox_ready",
        lambda *_args, **_kwargs: {
            "sandboxName": "browser-claim",
            "podName": "aio-browser-pool-789",
            "podIp": "browser-claim.agent-sandbox.svc.cluster.local",
        },
    )
    monkeypatch.setattr(app, "_wait_for_browser_http_ready", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(app, "_wait_for_shell_ready", lambda *_args, **_kwargs: None)

    recorded_commands: list[tuple[str, str]] = []

    def fake_run_k8s_workspace_command(session, *, command, cwd=None, timeout_ms=None):
        recorded_commands.append((command, str(cwd)))
        return {"success": True, "stdout": "", "stderr": "", "exitCode": 0}

    monkeypatch.setattr(app, "_run_k8s_workspace_command", fake_run_k8s_workspace_command)

    session = app._create_browser_sandbox_session(
        execution_id="exec-browser-bootstrap",
        name="Debug Browser Bootstrap",
        root_path=tmp_path / "workspace-root",
        enabled_tools=["bash", "git"],
        command_timeout_ms=120_000,
        sandbox_template="aio-browser",
    )

    assert session.working_directory == tmp_path / "workspace-root"
    assert session.sandbox_details["workingDirectory"] == "/home/gem"
    assert recorded_commands == [
        (f"mkdir -p '{tmp_path / 'workspace-root'}'", "/home/gem")
    ]


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


def test_record_langgraph_progress_event_normalizes_tool_payloads(monkeypatch) -> None:
    fake_store = FakeStateStore()
    monkeypatch.setattr(app, "run_state_store", fake_store)
    monkeypatch.setattr(app, "run_context_cache", {})
    emitted_events: list[dict[str, object]] = []
    streamed_events: list[dict[str, object]] = []
    monkeypatch.setattr(
        app,
        "_emit_agent_event",
        lambda _run_context, **payload: emitted_events.append(payload),
    )
    monkeypatch.setattr(
        app,
        "_push_stream_event",
        lambda _instance_id, event: streamed_events.append(event),
    )

    run_context = AgentRunContext(
        instance_id="wf-langgraph-tool",
        mode="execute_direct",
        profile="review",
        model="gpt-5.4",
        engine="langgraph-deepagents",
        cwd="/tmp",
        tool_group="all",
        max_turns=24,
        trace_id="trace-langgraph-tool",
    )
    _persist_run_context(run_context)
    app._persist_agent_progress(
        "wf-langgraph-tool",
        app._default_agent_progress(run_context, status="running"),
    )

    app._record_langgraph_progress_event(
        "wf-langgraph-tool",
        run_context,
        phase="execute",
        event={
            "event": "tool_complete",
            "name": "ExecuteCommand",
            "input": {"command": "find . -maxdepth 1 -type f"},
            "output": {
                "stdout": "README.md\npackage.json\n",
                "stderr": "",
                "exitCode": 0,
            },
            "status": "completed",
        },
    )

    assert streamed_events[0]["type"] == "tool_complete"
    assert emitted_events[0]["event_type"] == "tool_complete"
    assert emitted_events[0]["toolName"] == "ExecuteCommand"
    assert emitted_events[0]["toolArgs"] == {
        "command": "find . -maxdepth 1 -type f",
    }
    assert emitted_events[0]["toolResult"] == {
        "stdout": "README.md\npackage.json\n",
        "exitCode": 0,
    }


def test_record_langgraph_progress_event_normalizes_sandbox_output(monkeypatch) -> None:
    emitted_events: list[dict[str, object]] = []
    monkeypatch.setattr(
        app,
        "_emit_agent_event",
        lambda _run_context, **payload: emitted_events.append(payload),
    )
    monkeypatch.setattr(app, "_push_stream_event", lambda *_args, **_kwargs: None)

    run_context = AgentRunContext(
        instance_id="wf-langgraph-sandbox",
        mode="execute_direct",
        profile="review",
        model="gpt-5.4",
        engine="langgraph-deepagents",
        cwd="/tmp",
        tool_group="all",
        max_turns=24,
        trace_id="trace-langgraph-sandbox",
    )

    app._record_langgraph_progress_event(
        "wf-langgraph-sandbox",
        run_context,
        phase="execute",
        event={
            "event": "sandbox_output",
            "cmd": "pwd",
            "result": {"stdout": "/sandbox/repo\n", "stderr": "", "returncode": "0"},
        },
    )

    assert emitted_events[0]["event_type"] == "sandbox_output"
    assert emitted_events[0]["command"] == "pwd"
    assert emitted_events[0]["output"] == "/sandbox/repo"
    assert emitted_events[0]["exitCode"] == 0


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


def test_workspace_profile_returns_capability_metadata(tmp_path: Path, monkeypatch) -> None:
    fake_store = FakeStateStore()
    monkeypatch.setattr(app, "workspace_state_store", fake_store)
    monkeypatch.setattr(app, "workspace_sessions", {})
    monkeypatch.setattr(app, "sessions_by_execution", {})
    monkeypatch.setattr(
        app,
        "_detect_available_capabilities",
        lambda _tool_backend=None: ["bash", "git", "node", "pnpm"],
    )

    profile = workspace_profile(
        WorkspaceProfileRequest(
            executionId="exec-capabilities",
            rootPath=str(tmp_path / "exec-capabilities"),
            enabledTools=["read", "bash"],
        )
    )

    assert profile["availableCapabilities"] == ["bash", "git", "node", "pnpm"]
    assert profile["executionProfile"] == "base"
    assert profile["repositorySignals"]["runtimeFamily"] == "generic"


def test_browser_workspace_profile_uses_k8s_session(monkeypatch) -> None:
    fake_store = FakeStateStore()
    monkeypatch.setattr(app, "workspace_state_store", fake_store)
    monkeypatch.setattr(app, "workspace_sessions", {})
    monkeypatch.setattr(app, "sessions_by_execution", {})

    def fake_create_browser_sandbox_session(**kwargs) -> WorkspaceSession:
        return WorkspaceSession(
            workspace_ref="workspace-browser",
            execution_id=str(kwargs["execution_id"]),
            root_path=Path(str(kwargs["root_path"])),
            working_directory=Path(str(kwargs["root_path"])),
            enabled_tools=list(kwargs["enabled_tools"]),
            backend="k8s",
            command_timeout_ms=int(kwargs["command_timeout_ms"] or 360000),
            sandbox_template="aio-browser",
            sandbox_details={
                "claimName": "browser-claim",
                "podIp": "10.0.0.12",
                "port": 8080,
                "healthPath": "v1/docs",
                "executePath": "v1/shell/exec",
            },
            available_capabilities=["bash", "git", "browser", "screenshot"],
        )

    monkeypatch.setattr(app, "_create_browser_sandbox_session", fake_create_browser_sandbox_session)

    profile = workspace_profile(
        WorkspaceProfileRequest(
            executionId="exec-browser",
            enabledTools=["bash"],
            sandboxTemplate="aio-browser",
        )
    )

    assert profile["backend"] == "k8s"
    assert profile["rootPath"] == "/home/gem/workspaces/exec-browser"
    restored = _load_workspace_session("workspace-browser")
    assert restored is not None
    assert restored.backend == "k8s"
    assert restored.sandbox_template == "aio-browser"


def test_workspace_command_routes_k8s_session_through_remote_exec(monkeypatch) -> None:
    fake_store = FakeStateStore()
    monkeypatch.setattr(app, "workspace_state_store", fake_store)
    monkeypatch.setattr(app, "workspace_sessions", {})
    monkeypatch.setattr(app, "sessions_by_execution", {})

    session = WorkspaceSession(
        workspace_ref="workspace-browser-cmd",
        execution_id="exec-browser",
        root_path=Path("/home/gem/workspaces/exec-browser"),
        working_directory=Path("/home/gem/workspaces/exec-browser/repo"),
        enabled_tools=["bash"],
        backend="k8s",
        sandbox_template="aio-browser",
        sandbox_details={
            "podIp": "10.0.0.13",
            "port": 8080,
            "executePath": "v1/shell/exec",
        },
    )
    _persist_workspace_session(session)

    captured: dict[str, object] = {}

    def fake_run_k8s_workspace_command(session_arg, *, command, cwd=None, timeout_ms=None):
        captured["workspaceRef"] = session_arg.workspace_ref
        captured["command"] = command
        captured["cwd"] = str(cwd)
        captured["timeoutMs"] = timeout_ms
        return {
            "stdout": "ok\n",
            "stderr": "",
            "exitCode": 0,
            "success": True,
            "executionTimeMs": 25,
            "timedOut": False,
        }

    monkeypatch.setattr(app, "_run_k8s_workspace_command", fake_run_k8s_workspace_command)

    response = app.workspace_command(
        WorkspaceCommandRequest(
            executionId="exec-browser",
            workspaceRef="workspace-browser-cmd",
            command="npm install",
            timeoutMs=60000,
        )
    )

    assert response["success"] is True
    assert captured["workspaceRef"] == "workspace-browser-cmd"
    assert captured["command"] == "npm install"
    assert captured["cwd"] == "/home/gem/workspaces/exec-browser/repo"


def test_run_k8s_workspace_command_preserves_zero_exit_code(monkeypatch) -> None:
    session = WorkspaceSession(
        workspace_ref="workspace-browser-zero-exit",
        execution_id="exec-browser",
        root_path=Path("/home/gem/workspaces/exec-browser"),
        working_directory=Path("/home/gem/workspaces/exec-browser/repo"),
        enabled_tools=["bash"],
        backend="k8s",
        sandbox_template="aio-browser",
        sandbox_details={
            "podIp": "10.0.0.13",
            "port": 8080,
            "executePath": "v1/shell/exec",
        },
    )

    monkeypatch.setattr(
        app,
        "_http_json",
        lambda *_args, **_kwargs: {
            "data": {
                "exit_code": 0,
                "output": "install-complete\n",
                "stderr": "",
            }
        },
    )

    result = app._run_k8s_workspace_command(
        session,
        command="python3 -c 'print(\"ok\")'",
        cwd=session.working_directory,
        timeout_ms=60_000,
    )

    assert result["exitCode"] == 0
    assert result["success"] is True
    assert result["stdout"] == "install-complete\n"


def test_run_k8s_workspace_command_waits_for_async_shell_completion(monkeypatch) -> None:
    session = WorkspaceSession(
        workspace_ref="workspace-browser-async-exit",
        execution_id="exec-browser",
        root_path=Path("/home/gem/workspaces/exec-browser"),
        working_directory=Path("/home/gem/workspaces/exec-browser/repo"),
        enabled_tools=["bash"],
        backend="k8s",
        sandbox_template="aio-browser",
        sandbox_details={
            "podIp": "10.0.0.13",
            "port": 8080,
            "executePath": "v1/shell/exec",
        },
    )

    responses = iter(
        [
            {
                "success": True,
                "message": "Command still running (timeout 20s reached)",
                "data": {
                    "session_id": "shell-session-1",
                    "command": "npm ci",
                    "status": "running",
                    "output": None,
                    "exit_code": None,
                },
            },
            {
                "success": True,
                "data": {
                    "status": "completed",
                },
            },
            {
                "success": True,
                "data": {
                    "session_id": "shell-session-1",
                    "command": "npm ci",
                    "status": "completed",
                    "output": "added 42 packages\n",
                    "exit_code": 0,
                },
            },
        ]
    )

    monkeypatch.setattr(app, "_http_json", lambda *_args, **_kwargs: next(responses))

    result = app._run_k8s_workspace_command(
        session,
        command="npm ci",
        cwd=session.working_directory,
        timeout_ms=60_000,
    )

    assert result["exitCode"] == 0
    assert result["success"] is True
    assert result["stdout"] == "added 42 packages\n"
    assert result["timedOut"] is False


def test_run_k8s_workspace_command_marks_async_timeout(monkeypatch) -> None:
    session = WorkspaceSession(
        workspace_ref="workspace-browser-async-timeout",
        execution_id="exec-browser",
        root_path=Path("/home/gem/workspaces/exec-browser"),
        working_directory=Path("/home/gem/workspaces/exec-browser/repo"),
        enabled_tools=["bash"],
        backend="k8s",
        sandbox_template="aio-browser",
        sandbox_details={
            "podIp": "10.0.0.13",
            "port": 8080,
            "executePath": "v1/shell/exec",
        },
    )

    responses = iter(
        [
            {
                "success": True,
                "message": "Command still running (timeout 20s reached)",
                "data": {
                    "session_id": "shell-session-timeout",
                    "command": "npm run dev",
                    "status": "running",
                },
            },
            {
                "success": True,
                "data": {
                    "status": "running",
                },
            },
            {
                "success": True,
                "data": {
                    "session_id": "shell-session-timeout",
                    "command": "npm run dev",
                    "status": "running",
                    "output": "still booting\n",
                    "exit_code": None,
                },
            },
        ]
    )

    monotonic_values = iter([0.0, 0.0, 2.0, 2.0])
    monkeypatch.setattr(app, "_http_json", lambda *_args, **_kwargs: next(responses))
    monkeypatch.setattr(app.time, "monotonic", lambda: next(monotonic_values))

    result = app._run_k8s_workspace_command(
        session,
        command="npm run dev",
        cwd=session.working_directory,
        timeout_ms=1_000,
    )

    assert result["exitCode"] == 124
    assert result["success"] is False
    assert result["stdout"] == "still booting\n"
    assert result["timedOut"] is True
    assert "timed out" in result["stderr"].lower()


def test_browser_connection_info_rewrites_loopback_cdp_host(monkeypatch) -> None:
    session = WorkspaceSession(
        workspace_ref="workspace-browser-cdp",
        execution_id="exec-browser",
        root_path=Path("/home/gem/workspaces/exec-browser"),
        working_directory=Path("/home/gem/workspaces/exec-browser/repo"),
        enabled_tools=["browser"],
        backend="k8s",
        sandbox_template="aio-browser",
        sandbox_details={"podIp": "10.0.0.99", "port": 8080},
    )

    monkeypatch.setattr(
        app,
        "_http_json",
        lambda *_args, **_kwargs: {
            "success": True,
            "data": {
                "cdp_url": "ws://127.0.0.1:8080/cdp/devtools/browser/browser-id",
            },
        },
    )

    assert (
        app._browser_connection_info(session)
        == "ws://10.0.0.99:8080/cdp/devtools/browser/browser-id"
    )


def test_browser_materialize_change_artifact_restores_snapshots(monkeypatch) -> None:
    fake_workspace_store = FakeStateStore()
    fake_run_store = FakeStateStore()
    monkeypatch.setattr(app, "workspace_state_store", fake_workspace_store)
    monkeypatch.setattr(app, "run_state_store", fake_run_store)
    monkeypatch.setattr(app, "workspace_sessions", {})
    monkeypatch.setattr(app, "sessions_by_execution", {})

    session = WorkspaceSession(
        workspace_ref="workspace-browser-materialize",
        execution_id="exec-browser",
        root_path=Path("/home/gem/workspaces/exec-browser"),
        working_directory=Path("/home/gem/workspaces/exec-browser/repo"),
        enabled_tools=["bash"],
        backend="k8s",
        sandbox_template="aio-browser",
        sandbox_details={"podIp": "10.0.0.14", "port": 8080, "executePath": "v1/shell/exec"},
    )
    _persist_workspace_session(session)
    fake_run_store.save(
        key=app._run_artifact_key("run-browser"),
        value={
            "changeSetId": "run-browser-patch",
            "executionId": "exec-browser",
            "fileSnapshots": [
                {"path": "app/page.tsx", "status": "M", "newContent": "updated"},
                {"path": "old.txt", "status": "D"},
            ],
        },
    )
    fake_run_store.save(
        key=app._execution_runs_key("exec-browser"),
        value={"executionId": "exec-browser", "runIds": ["run-browser"]},
    )

    written: list[tuple[str, str]] = []
    deleted: list[str] = []
    monkeypatch.setattr(
        app,
        "_write_remote_file",
        lambda _session, target_path, content: written.append((str(target_path), content)),
    )
    monkeypatch.setattr(
        app,
        "_delete_remote_path",
        lambda _session, target_path: deleted.append(str(target_path)),
    )

    response = app.browser_materialize_change_artifact(
        BrowserMaterializeChangeArtifactRequest(
            executionId="exec-browser",
            workspaceRef="workspace-browser-materialize",
        )
    )

    assert response["changeSetId"] == "run-browser-patch"
    assert written[0] == ("/home/gem/workspaces/exec-browser/repo/app/page.tsx", "updated")
    assert written[1][0] == "/home/gem/workspaces/exec-browser/repo/.wf-preview/materialized-change-set.json"
    assert '"changeSetId": "run-browser-patch"' in written[1][1]
    assert deleted == ["/home/gem/workspaces/exec-browser/repo/old.txt"]


def test_browser_capture_flow_persists_artifact(monkeypatch) -> None:
    fake_store = FakeStateStore()
    monkeypatch.setattr(app, "workspace_state_store", fake_store)
    monkeypatch.setattr(app, "workspace_sessions", {})
    monkeypatch.setattr(app, "sessions_by_execution", {})

    session = WorkspaceSession(
        workspace_ref="workspace-browser-capture",
        execution_id="exec-browser",
        root_path=Path("/home/gem/workspaces/exec-browser"),
        working_directory=Path("/home/gem/workspaces/exec-browser/repo"),
        enabled_tools=["bash"],
        backend="k8s",
        sandbox_template="aio-browser",
        sandbox_details={"podIp": "10.0.0.15", "port": 8080},
    )
    _persist_workspace_session(session)
    monkeypatch.setattr(app, "_browser_connection_info", lambda _session: "ws://browser.test/devtools")

    captured_save: dict[str, object] = {}

    def fake_save_workflow_browser_artifact(**kwargs):
        captured_save.update(kwargs)
        return {
            "id": "artifact-browser-1",
            "workflowExecutionId": kwargs["workflow_execution_id"],
            "workflowId": kwargs["workflow_id"],
            "nodeId": kwargs["node_id"],
            "workspaceRef": kwargs["workspace_ref"],
            "artifactType": "capture_flow_v1",
            "artifactVersion": 1,
            "status": kwargs["status"],
            "manifestJson": {"steps": []},
        }

    monkeypatch.setattr(app, "_save_workflow_browser_artifact", fake_save_workflow_browser_artifact)

    class FakePage:
        def __init__(self) -> None:
            self.url = "http://127.0.0.1:3009/"

        def goto(self, url, wait_until=None, timeout=None):
            self.url = url

        def wait_for_selector(self, selector, timeout=None):
            return None

        def wait_for_function(self, expression, *, arg=None, timeout=None):
            return None

        def wait_for_timeout(self, timeout):
            return None

        def screenshot(self, full_page=True, type="png"):
            return b"png-bytes"

        def title(self):
            return "Browser Smoke"

    class FakeContext:
        def __init__(self) -> None:
            self.pages = [FakePage()]

        def new_page(self):
            page = FakePage()
            self.pages.append(page)
            return page

    class FakeBrowser:
        def __init__(self) -> None:
            self.contexts = [FakeContext()]

        def new_context(self):
            context = FakeContext()
            self.contexts.append(context)
            return context

        def close(self):
            return None

    class FakeChromium:
        def connect_over_cdp(self, cdp_url, timeout=None):
            assert cdp_url == "ws://browser.test/devtools"
            return FakeBrowser()

    class FakePlaywrightManager:
        def __enter__(self):
            return type("FakePlaywright", (), {"chromium": FakeChromium()})()

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(app, "sync_playwright", lambda: FakePlaywrightManager())

    response = app.browser_capture_flow(
        BrowserCaptureFlowRequest(
            executionId="exec-browser",
            dbExecutionId="db-exec-browser",
            workspaceRef="workspace-browser-capture",
            workflowId="wf-browser",
            nodeId="node-browser",
            baseUrl="http://127.0.0.1:3009",
            steps=[
                BrowserCaptureStepRequest(
                    label="Home",
                    path="/",
                    waitForText="Welcome",
                )
            ],
        )
    )

    assert response["artifactId"] == "artifact-browser-1"
    assert response["stepCount"] == 1
    assert captured_save["workflow_execution_id"] == "db-exec-browser"
    assert len(captured_save["screenshots"]) == 1
    assert captured_save["status"] == "completed"


def test_browser_capture_flow_retries_until_page_is_ready(monkeypatch) -> None:
    fake_store = FakeStateStore()
    monkeypatch.setattr(app, "workspace_state_store", fake_store)
    monkeypatch.setattr(app, "workspace_sessions", {})
    monkeypatch.setattr(app, "sessions_by_execution", {})

    session = WorkspaceSession(
        workspace_ref="workspace-browser-capture-retry",
        execution_id="exec-browser",
        root_path=Path("/home/gem/workspaces/exec-browser"),
        working_directory=Path("/home/gem/workspaces/exec-browser/repo"),
        enabled_tools=["bash"],
        backend="k8s",
        sandbox_template="aio-browser",
        sandbox_details={"podIp": "10.0.0.15", "port": 8080},
    )
    _persist_workspace_session(session)
    monkeypatch.setattr(app, "_browser_connection_info", lambda _session: "ws://browser.test/devtools")

    captured_save: dict[str, object] = {}

    def fake_save_workflow_browser_artifact(**kwargs):
        captured_save.update(kwargs)
        return {
            "id": "artifact-browser-retry",
            "workflowExecutionId": kwargs["workflow_execution_id"],
            "workflowId": kwargs["workflow_id"],
            "nodeId": kwargs["node_id"],
            "workspaceRef": kwargs["workspace_ref"],
            "artifactType": "capture_flow_v1",
            "artifactVersion": 1,
            "status": kwargs["status"],
            "manifestJson": {"steps": []},
        }

    monkeypatch.setattr(app, "_save_workflow_browser_artifact", fake_save_workflow_browser_artifact)

    class FakePage:
        def __init__(self) -> None:
            self.url = "about:blank"
            self.goto_attempts = 0

        def goto(self, url, wait_until=None, timeout=None):
            self.goto_attempts += 1
            if self.goto_attempts == 1:
                raise RuntimeError("connection refused")
            self.url = url

        def wait_for_selector(self, selector, timeout=None):
            return None

        def wait_for_function(self, expression, *, arg=None, timeout=None):
            return None

        def wait_for_timeout(self, timeout):
            return None

        def screenshot(self, full_page=True, type="png"):
            return b"png-bytes"

        def title(self):
            return "Browser Smoke"

    class FakeContext:
        def __init__(self) -> None:
            self.pages = [FakePage()]

        def new_page(self):
            page = FakePage()
            self.pages.append(page)
            return page

    class FakeBrowser:
        def __init__(self) -> None:
            self.contexts = [FakeContext()]

        def new_context(self):
            context = FakeContext()
            self.contexts.append(context)
            return context

        def close(self):
            return None

    class FakeChromium:
        def connect_over_cdp(self, cdp_url, timeout=None):
            assert cdp_url == "ws://browser.test/devtools"
            return FakeBrowser()

    class FakePlaywrightManager:
        def __enter__(self):
            return type("FakePlaywright", (), {"chromium": FakeChromium()})()

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(app, "sync_playwright", lambda: FakePlaywrightManager())

    response = app.browser_capture_flow(
        BrowserCaptureFlowRequest(
            executionId="exec-browser",
            dbExecutionId="db-exec-browser",
            workspaceRef="workspace-browser-capture-retry",
            workflowId="wf-browser",
            nodeId="node-browser",
            baseUrl="http://127.0.0.1:3009",
            steps=[
                BrowserCaptureStepRequest(
                    label="Home",
                    path="/",
                    waitForText="Welcome",
                )
            ],
            timeoutMs=5_000,
        )
    )

    assert response["artifactId"] == "artifact-browser-retry"
    assert response["stepCount"] == 1
    assert captured_save["status"] == "completed"


def test_browser_capture_flow_uses_larger_per_attempt_timeout(monkeypatch) -> None:
    fake_store = FakeStateStore()
    monkeypatch.setattr(app, "workspace_state_store", fake_store)
    monkeypatch.setattr(app, "workspace_sessions", {})
    monkeypatch.setattr(app, "sessions_by_execution", {})

    session = WorkspaceSession(
        workspace_ref="workspace-browser-capture-timeout",
        execution_id="exec-browser",
        root_path=Path("/home/gem/workspaces/exec-browser"),
        working_directory=Path("/home/gem/workspaces/exec-browser/repo"),
        enabled_tools=["bash"],
        backend="k8s",
        sandbox_template="aio-browser",
        sandbox_details={"podIp": "10.0.0.15", "port": 8080},
    )
    _persist_workspace_session(session)
    monkeypatch.setattr(app, "_browser_connection_info", lambda _session: "ws://browser.test/devtools")
    monkeypatch.setattr(
        app,
        "_save_workflow_browser_artifact",
        lambda **kwargs: {
            "id": "artifact-browser-timeout",
            "workflowExecutionId": kwargs["workflow_execution_id"],
            "workflowId": kwargs["workflow_id"],
            "nodeId": kwargs["node_id"],
            "workspaceRef": kwargs["workspace_ref"],
            "artifactType": "capture_flow_v1",
            "artifactVersion": 1,
            "status": kwargs["status"],
            "manifestJson": {"steps": []},
        },
    )

    seen_timeouts: list[int | None] = []

    class FakePage:
        def __init__(self) -> None:
            self.url = "about:blank"

        def goto(self, url, wait_until=None, timeout=None):
            seen_timeouts.append(timeout)
            self.url = url

        def wait_for_selector(self, selector, timeout=None):
            return None

        def wait_for_function(self, expression, *, arg=None, timeout=None):
            return None

        def wait_for_timeout(self, timeout):
            return None

        def screenshot(self, full_page=True, type="png"):
            return b"png-bytes"

        def title(self):
            return "Browser Smoke"

    class FakeContext:
        def __init__(self) -> None:
            self.pages = [FakePage()]

        def new_page(self):
            page = FakePage()
            self.pages.append(page)
            return page

    class FakeBrowser:
        def __init__(self) -> None:
            self.contexts = [FakeContext()]

        def new_context(self):
            context = FakeContext()
            self.contexts.append(context)
            return context

        def close(self):
            return None

    class FakeChromium:
        def connect_over_cdp(self, cdp_url, timeout=None):
            assert cdp_url == "ws://browser.test/devtools"
            return FakeBrowser()

    class FakePlaywrightManager:
        def __enter__(self):
            return type("FakePlaywright", (), {"chromium": FakeChromium()})()

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(app, "sync_playwright", lambda: FakePlaywrightManager())

    response = app.browser_capture_flow(
        BrowserCaptureFlowRequest(
            executionId="exec-browser",
            dbExecutionId="db-exec-browser",
            workspaceRef="workspace-browser-capture-timeout",
            workflowId="wf-browser",
            nodeId="node-browser",
            baseUrl="http://127.0.0.1:3009",
            steps=[BrowserCaptureStepRequest(label="Home", path="/")],
            timeoutMs=180_000,
        )
    )

    assert response["artifactId"] == "artifact-browser-timeout"
    assert seen_timeouts == [8_000]


def test_browser_capture_retry_respects_min_viable_floor() -> None:
    """Every attempt gets at least min_viable timeout; loop exits cleanly."""
    recorded_timeouts: list[int] = []
    attempts_before_success = 4

    class TimingPage:
        def __init__(self):
            self.url = "about:blank"
            self._attempt = 0

        def goto(self, url, wait_until=None, timeout=None):
            self._attempt += 1
            recorded_timeouts.append(timeout)
            if self._attempt < attempts_before_success:
                raise PlaywrightTimeoutError(f"Timeout {timeout}ms exceeded")
            self.url = url

        def wait_for_selector(self, selector, timeout=None):
            pass

        def wait_for_function(self, expression, *, arg=None, timeout=None):
            pass

        def wait_for_timeout(self, timeout):
            pass

        def screenshot(self, full_page=True, type="png"):
            return b"png-bytes"

    page = TimingPage()
    budget_ms = 60_000
    result = _capture_browser_step_with_retry(
        page,
        target_url="http://127.0.0.1:3009/",
        wait_for_selector=None,
        wait_for_text=None,
        delay_ms=None,
        full_page=True,
        timeout_ms=budget_ms,
    )

    assert result == b"png-bytes"
    assert len(recorded_timeouts) == attempts_before_success
    attempt_cap = min(budget_ms, BROWSER_CAPTURE_STEP_ATTEMPT_TIMEOUT_MS)
    min_viable = max(2_000, attempt_cap // 2)
    for t in recorded_timeouts:
        assert t >= min_viable, f"Attempt got {t}ms, expected >= {min_viable}ms"
    for t in recorded_timeouts:
        assert t <= BROWSER_CAPTURE_STEP_ATTEMPT_TIMEOUT_MS


def test_browser_capture_retry_exits_before_tiny_attempt() -> None:
    """Loop stops instead of issuing a pathologically small final attempt."""
    recorded_timeouts: list[int] = []

    class AlwaysFailPage:
        url = "about:blank"

        def goto(self, url, wait_until=None, timeout=None):
            recorded_timeouts.append(timeout)
            raise PlaywrightTimeoutError(f"Timeout {timeout}ms exceeded")

        def wait_for_timeout(self, timeout):
            pass

    page = AlwaysFailPage()
    budget_ms = 20_000
    with pytest.raises(RuntimeError, match="Browser capture timed out"):
        _capture_browser_step_with_retry(
            page,
            target_url="http://127.0.0.1:3009/",
            wait_for_selector=None,
            wait_for_text=None,
            delay_ms=None,
            full_page=True,
            timeout_ms=budget_ms,
        )

    attempt_cap = min(budget_ms, BROWSER_CAPTURE_STEP_ATTEMPT_TIMEOUT_MS)
    min_viable = max(2_000, attempt_cap // 2)
    for t in recorded_timeouts:
        assert t >= min_viable, f"Issued attempt with only {t}ms (< {min_viable}ms floor)"


def test_detect_repository_signals_prefers_pnpm_repo(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    (repo_root / "package.json").write_text(
        json.dumps({"name": "demo", "packageManager": "pnpm@9.0.0"}),
        encoding="utf-8",
    )
    (repo_root / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'", encoding="utf-8")

    signals = _detect_repository_signals(repo_root)

    assert signals["runtimeFamily"] == "node"
    assert signals["packageManager"] == "pnpm"
    assert signals["hasPackageJson"] is True
    assert signals["hasPnpmLock"] is True


def test_workspace_capability_validation_requires_pnpm_for_pnpm_repo(
    tmp_path: Path,
    monkeypatch,
) -> None:
    fake_store = FakeStateStore()
    monkeypatch.setattr(app, "workspace_state_store", fake_store)
    monkeypatch.setattr(app, "workspace_sessions", {})
    monkeypatch.setattr(app, "sessions_by_execution", {})
    monkeypatch.setattr(
        app,
        "_detect_available_capabilities",
        lambda _tool_backend=None: ["bash", "git", "node"],
    )

    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    (repo_root / "package.json").write_text(
        json.dumps({"name": "demo", "packageManager": "pnpm@9.0.0"}),
        encoding="utf-8",
    )
    (repo_root / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'", encoding="utf-8")

    session = WorkspaceSession(
        workspace_ref="workspace-validate",
        execution_id="exec-validate",
        root_path=tmp_path,
        working_directory=repo_root,
        enabled_tools=["read", "bash"],
        preferred_execution_profile="node-pnpm",
    )
    _persist_workspace_session(session)

    result = workspace_capabilities_validate(
        WorkspaceCapabilityValidationRequest(
            workspaceRef="workspace-validate",
            verifyCommands=["pnpm type-check"],
        )
    )

    assert result["success"] is False
    assert result["executionProfile"] == "node-pnpm"
    assert result["missingCapabilities"] == ["pnpm"]
    assert result["requiredCapabilities"] == ["bash", "git", "node", "pnpm"]


def test_workspace_capability_validation_succeeds_for_openshell_pnpm_repo(
    tmp_path: Path,
    monkeypatch,
) -> None:
    fake_store = FakeStateStore()
    monkeypatch.setattr(app, "workspace_state_store", fake_store)
    monkeypatch.setattr(app, "workspace_sessions", {})
    monkeypatch.setattr(app, "sessions_by_execution", {})
    monkeypatch.setattr(
        app,
        "_detect_available_capabilities",
        lambda tool_backend=None: (
            app._finalize_available_capabilities(
                {"bash", "git", "node", "npm", "corepack", "python"}
            )
            if tool_backend == "openshell"
            else ["bash", "git", "python"]
        ),
    )

    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    (repo_root / "package.json").write_text(
        json.dumps({"name": "demo", "packageManager": "pnpm@9.0.0"}),
        encoding="utf-8",
    )
    (repo_root / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'", encoding="utf-8")

    session = WorkspaceSession(
        workspace_ref="workspace-validate-openshell",
        execution_id="exec-validate-openshell",
        root_path=tmp_path,
        working_directory=repo_root,
        enabled_tools=["read", "bash"],
        preferred_execution_profile="node-pnpm",
    )
    _persist_workspace_session(session)

    result = workspace_capabilities_validate(
        WorkspaceCapabilityValidationRequest(
            workspaceRef="workspace-validate-openshell",
            verifyCommands=["pnpm type-check"],
            toolBackend="openshell",
        )
    )

    assert result["success"] is True
    assert result["missingCapabilities"] == []
    assert result["workspaceProfile"]["backend"] == "openshell"
    assert result["workspaceProfile"]["executionProfile"] == "node-pnpm"
    assert "pnpm" in result["availableCapabilities"]


def test_workspace_capability_validation_succeeds_when_required_tools_exist(
    tmp_path: Path,
    monkeypatch,
) -> None:
    fake_store = FakeStateStore()
    monkeypatch.setattr(app, "workspace_state_store", fake_store)
    monkeypatch.setattr(app, "workspace_sessions", {})
    monkeypatch.setattr(app, "sessions_by_execution", {})
    monkeypatch.setattr(
        app,
        "_detect_available_capabilities",
        lambda _tool_backend=None: ["bash", "git", "node", "pnpm"],
    )

    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    (repo_root / "package.json").write_text(
        json.dumps({"name": "demo", "packageManager": "pnpm@9.0.0"}),
        encoding="utf-8",
    )
    (repo_root / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'", encoding="utf-8")

    session = WorkspaceSession(
        workspace_ref="workspace-validate-ok",
        execution_id="exec-validate-ok",
        root_path=tmp_path,
        working_directory=repo_root,
        enabled_tools=["read", "bash"],
        preferred_execution_profile="node-pnpm",
    )

    result = _validate_workspace_capabilities(
        session,
        verify_commands=["pnpm type-check"],
    )

    assert result["success"] is True
    assert result["missingCapabilities"] == []
    assert result["workspaceProfile"]["executionProfile"] == "node-pnpm"


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


def test_browser_validate_request_model_defaults() -> None:
    """BrowserValidateRequest should require deterministic workspace inputs and apply defaults."""
    req = BrowserValidateRequest(
        executionId="exec-1",
        workspaceRef="workspace-1",
        installCommand="npm ci",
        devServerCommand="npm run dev",
        workflowId="wf-1",
        nodeId="node-1",
    )
    assert req.repoPath == "/sandbox/repo"
    assert req.baseUrl == "http://127.0.0.1:3009"
    assert req.timeoutMs is None
    assert req.workflowId == "wf-1"
    assert req.workspaceRef == "workspace-1"
    assert req.sandboxName is None


def test_browser_validate_uses_materialized_local_workspace(monkeypatch, tmp_path: Path) -> None:
    session = WorkspaceSession(
        workspace_ref="workspace-local",
        execution_id="exec-1",
        root_path=tmp_path,
        working_directory=tmp_path / "repo",
        enabled_tools=["bash"],
        backend="local",
    )
    session.working_directory.mkdir(parents=True)
    called: dict[str, object] = {}

    monkeypatch.setattr(app, "_workspace_from_ref", lambda workspace_ref: session)
    marker_path = app._browser_materialization_marker_path(session.working_directory)
    marker_path.parent.mkdir(parents=True, exist_ok=True)
    marker_path.write_text(
        json.dumps(
            {
                "changeSetId": "cs-1",
                "sourceExecutionId": "exec-1",
                "selectedRunId": "run-1",
                "materializedAt": "2026-03-29T00:00:00Z",
            }
        ),
        encoding="utf-8",
    )

    def fake_local_browser_validate(request, local_session, *, execution_id, timeout_seconds):
        called["workspace_ref"] = local_session.workspace_ref
        called["execution_id"] = execution_id
        called["timeout_seconds"] = timeout_seconds
        return {"success": True, "status": "completed", "artifactId": "bwf_test"}

    monkeypatch.setattr(app, "_browser_validate_local_workspace", fake_local_browser_validate)

    class ShouldNotInstantiate:
        def __init__(self, **_kwargs):
            raise AssertionError("OpenShellToolContext should not be used for deterministic browser validation")

    result = app.browser_validate(
        BrowserValidateRequest(
            executionId="exec-1",
            workspaceRef="workspace-local",
            installCommand="cd basics/learn-starter && pnpm install --frozen-lockfile --prefer-offline",
            devServerCommand="cd basics/learn-starter && pnpm dev --hostname 0.0.0.0 --port 3009",
            workflowId="wf-1",
            nodeId="node-1",
        )
    )

    assert result["success"] is True
    assert called == {
        "workspace_ref": "workspace-local",
        "execution_id": "exec-1",
        "timeout_seconds": 2700,
    }


def test_browser_validate_requires_local_workspace_backend(monkeypatch, tmp_path: Path) -> None:
    session = WorkspaceSession(
        workspace_ref="workspace-k8s",
        execution_id="exec-1",
        root_path=tmp_path,
        working_directory=tmp_path / "repo",
        enabled_tools=["bash"],
        backend="k8s",
    )
    monkeypatch.setattr(app, "_workspace_from_ref", lambda _workspace_ref: session)

    result = app.browser_validate(
        BrowserValidateRequest(
            executionId="exec-1",
            workspaceRef="workspace-k8s",
            installCommand="npm ci",
            devServerCommand="npm run dev",
            workflowId="wf-1",
            nodeId="node-1",
        )
    )

    assert result["success"] is False
    assert result["phase"] == "workspace"
    assert "local materialized browser workspace" in result["error"]


def test_browser_validate_requires_materialized_workspace(monkeypatch, tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir(parents=True)
    session = WorkspaceSession(
        workspace_ref="workspace-local",
        execution_id="exec-1",
        root_path=tmp_path,
        working_directory=repo_root,
        enabled_tools=["bash"],
        backend="local",
    )
    monkeypatch.setattr(app, "_workspace_from_ref", lambda _workspace_ref: session)

    result = app.browser_validate(
        BrowserValidateRequest(
            executionId="exec-1",
            workspaceRef="workspace-local",
            installCommand="npm ci",
            devServerCommand="npm run dev",
            workflowId="wf-1",
            nodeId="node-1",
        )
    )

    assert result["success"] is False
    assert result["phase"] == "materialize"
    assert "has not been materialized" in result["error"]


def test_browser_validate_propagates_capture_error(monkeypatch, tmp_path: Path) -> None:
    session = WorkspaceSession(
        workspace_ref="workspace-local",
        execution_id="exec-1",
        root_path=tmp_path,
        working_directory=tmp_path / "repo",
        enabled_tools=["bash"],
        backend="local",
    )
    session.working_directory.mkdir(parents=True)
    marker_path = app._browser_materialization_marker_path(session.working_directory)
    marker_path.parent.mkdir(parents=True, exist_ok=True)
    marker_path.write_text(
        json.dumps(
            {
                "changeSetId": "cs-1",
                "sourceExecutionId": "exec-1",
                "selectedRunId": "run-1",
                "materializedAt": "2026-03-29T00:00:00Z",
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(app, "_workspace_from_ref", lambda _workspace_ref: session)
    monkeypatch.setattr(
        app,
        "_browser_validate_local_workspace",
        lambda *_args, **_kwargs: {
            "success": False,
            "phase": "capture",
            "error": "TargetClosedError: BrowserType.launch: missing libnspr4.so",
        },
    )

    result = app.browser_validate(
        BrowserValidateRequest(
            executionId="exec-1",
            workspaceRef="workspace-local",
            installCommand="npm ci",
            devServerCommand="npm run dev",
            workflowId="wf-1",
            nodeId="node-1",
        )
    )

    assert result["success"] is False
    assert result["phase"] == "capture"
    assert result["error"] == "TargetClosedError: BrowserType.launch: missing libnspr4.so"


def test_capture_browser_step_skips_redundant_body_wait() -> None:
    calls: list[tuple[str, str | int]] = []

    class FakePage:
        url = "http://127.0.0.1:3009/"

        def goto(self, target_url: str, *, wait_until: str, timeout: int) -> None:
            calls.append(("goto", target_url))

        def wait_for_selector(self, selector: str, timeout: int) -> None:
            calls.append(("wait_for_selector", selector))
            raise AssertionError("body wait should be skipped")

        def wait_for_function(self, *args, **kwargs) -> None:
            calls.append(("wait_for_function", "called"))

        def wait_for_timeout(self, delay_ms: int) -> None:
            calls.append(("wait_for_timeout", delay_ms))

        def screenshot(self, *, full_page: bool, type: str) -> bytes:
            calls.append(("screenshot", type))
            return b"png"

    png = app._capture_browser_step_with_retry(
        FakePage(),
        target_url="http://127.0.0.1:3009/",
        wait_for_selector="body",
        wait_for_text=None,
        delay_ms=None,
        full_page=True,
        timeout_ms=5_000,
    )

    assert png == b"png"
    assert ("goto", "http://127.0.0.1:3009/") in calls
    assert ("screenshot", "png") in calls
    assert not any(name == "wait_for_selector" for name, _value in calls)


def test_browser_materialize_change_artifact_supports_local_workspace(monkeypatch, tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir(parents=True)
    session = WorkspaceSession(
        workspace_ref="workspace-local",
        execution_id="exec-1",
        root_path=tmp_path,
        working_directory=repo_root,
        enabled_tools=["bash"],
        backend="local",
    )
    monkeypatch.setattr(app, "_workspace_from_ref", lambda _workspace_ref: session)
    monkeypatch.setattr(app, "_load_run_artifact", lambda _run_id: {
        "changeSetId": "changeset-1",
        "fileSnapshots": [
            {
                "path": "basics/learn-starter/pages/index.js",
                "status": "M",
                "newContent": "export default function Page(){return 'The workflow worked!'}\n",
            }
        ],
    })

    result = app.browser_materialize_change_artifact(
        BrowserMaterializeChangeArtifactRequest(
            executionId="exec-1",
            workspaceRef="workspace-local",
            sourceExecutionId="exec-1",
            durableInstanceId="run-1",
        )
    )

    target_file = repo_root / "basics/learn-starter/pages/index.js"
    marker_path = app._browser_materialization_marker_path(repo_root)
    marker_payload = json.loads(marker_path.read_text(encoding="utf-8"))

    assert result["changeSetId"] == "changeset-1"
    assert result["selectedRunId"] == "run-1"
    assert target_file.read_text(encoding="utf-8") == "export default function Page(){return 'The workflow worked!'}\n"
    assert marker_payload["changeSetId"] == "changeset-1"
    assert marker_payload["sourceExecutionId"] == "exec-1"
    assert marker_payload["selectedRunId"] == "run-1"


def test_browser_materialize_change_artifact_applies_patch_when_snapshots_are_absent(
    monkeypatch,
    tmp_path: Path,
) -> None:
    repo_root = tmp_path / "repo"
    target_file = repo_root / "basics/learn-starter/pages/index.js"
    target_file.parent.mkdir(parents=True)
    target_file.write_text("export default function Page(){return 'Welcome to Next.JS'}\n", encoding="utf-8")
    session = WorkspaceSession(
        workspace_ref="workspace-local-patch",
        execution_id="exec-2",
        root_path=tmp_path,
        working_directory=repo_root,
        enabled_tools=["bash"],
        backend="local",
    )
    monkeypatch.setattr(app, "_workspace_from_ref", lambda _workspace_ref: session)
    monkeypatch.setattr(
        app,
        "_load_run_artifact",
        lambda _run_id: {
            "changeSetId": "changeset-2",
            "patch": "\n".join(
                [
                    "diff --git a/basics/learn-starter/pages/index.js b/basics/learn-starter/pages/index.js",
                    "--- a/basics/learn-starter/pages/index.js",
                    "+++ b/basics/learn-starter/pages/index.js",
                    "@@ -1 +1 @@",
                    "-export default function Page(){return 'Welcome to Next.JS'}",
                    "+export default function Page(){return 'The workflow worked!'}",
                ]
            ),
        },
    )

    def fake_apply_workspace_patch(repo_root: Path, patch: str) -> None:
        assert repo_root == session.working_directory
        assert "The workflow worked!" in patch
        target_file.write_text(
            "export default function Page(){return 'The workflow worked!'}\n",
            encoding="utf-8",
        )

    monkeypatch.setattr(app, "_apply_workspace_patch", fake_apply_workspace_patch)

    result = app.browser_materialize_change_artifact(
        BrowserMaterializeChangeArtifactRequest(
            executionId="exec-2",
            workspaceRef="workspace-local-patch",
            sourceExecutionId="exec-2",
            durableInstanceId="run-2",
        )
    )

    marker_payload = json.loads(
        app._browser_materialization_marker_path(repo_root).read_text(encoding="utf-8")
    )

    assert result["changeSetId"] == "changeset-2"
    assert result["selectedRunId"] == "run-2"
    assert target_file.read_text(encoding="utf-8") == "export default function Page(){return 'The workflow worked!'}\n"
    assert str(target_file) in result["restoredPaths"]
    assert marker_payload["changeSetId"] == "changeset-2"
    assert marker_payload["sourceExecutionId"] == "exec-2"
    assert marker_payload["selectedRunId"] == "run-2"


def test_browser_materialize_change_artifact_uses_execution_log_artifact_when_run_store_is_empty(
    monkeypatch,
    tmp_path: Path,
) -> None:
    repo_root = tmp_path / "repo"
    target_file = repo_root / "app/layout.tsx"
    target_file.parent.mkdir(parents=True)
    target_file.write_text("export default function Layout(){return 'before'}\n", encoding="utf-8")
    session = WorkspaceSession(
        workspace_ref="workspace-local-log",
        execution_id="exec-log",
        root_path=tmp_path,
        working_directory=repo_root,
        enabled_tools=["bash"],
        backend="local",
    )
    monkeypatch.setattr(app, "_workspace_from_ref", lambda _workspace_ref: session)
    monkeypatch.setattr(app, "_load_run_artifact", lambda _run_id: None)
    monkeypatch.setattr(
        app,
        "_load_execution_log_change_artifact",
        lambda execution_id, durable_instance_id=None: {
            "changeSetId": "changeset-log",
            "daprInstanceId": durable_instance_id or "run-log",
            "patch": "\n".join(
                [
                    "diff --git a/app/layout.tsx b/app/layout.tsx",
                    "--- a/app/layout.tsx",
                    "+++ b/app/layout.tsx",
                    "@@ -1 +1 @@",
                    "-export default function Layout(){return 'before'}",
                    "+export default function Layout(){return 'after'}",
                ]
            ),
        }
        if execution_id == "exec-log"
        else None,
    )

    def fake_apply_workspace_patch(repo_root: Path, patch: str) -> None:
        assert repo_root == session.working_directory
        assert "export default function Layout(){return 'after'}" in patch
        target_file.write_text(
            "export default function Layout(){return 'after'}\n",
            encoding="utf-8",
        )

    monkeypatch.setattr(app, "_apply_workspace_patch", fake_apply_workspace_patch)

    result = app.browser_materialize_change_artifact(
        BrowserMaterializeChangeArtifactRequest(
            executionId="exec-log",
            workspaceRef="workspace-local-log",
            sourceExecutionId="exec-log",
            durableInstanceId="run-log",
        )
    )

    marker_payload = json.loads(
        app._browser_materialization_marker_path(repo_root).read_text(encoding="utf-8")
    )

    assert result["changeSetId"] == "changeset-log"
    assert result["selectedRunId"] == "run-log"
    assert target_file.read_text(encoding="utf-8") == "export default function Layout(){return 'after'}\n"
    assert str(target_file) in result["restoredPaths"]
    assert marker_payload["changeSetId"] == "changeset-log"
    assert marker_payload["sourceExecutionId"] == "exec-log"
    assert marker_payload["selectedRunId"] == "run-log"


def test_apply_workspace_patch_falls_back_for_truncated_unified_diff(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    target_file = repo_root / "app/layout.tsx"
    target_file.parent.mkdir(parents=True)
    target_file.write_text(
        "\n".join(
            [
                "line-1",
                "line-2",
                "line-3",
                "line-4",
                "line-5",
                "line-6",
                "line-7",
                "line-8",
                "line-9",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    patch = "\n".join(
        [
            "diff --git a/app/layout.tsx b/app/layout.tsx",
            "--- a/app/layout.tsx",
            "+++ b/app/layout.tsx",
            "@@ -4,4 +4,4 @@",
            " line-4",
            " line-5",
            "-line-6",
            "-line-7",
            "+line-six",
            "+line-seven",
            " line-8",
            " line-9",
        ]
    )

    app._apply_workspace_patch(repo_root, patch)

    assert target_file.read_text(encoding="utf-8").splitlines() == [
        "line-1",
        "line-2",
        "line-3",
        "line-4",
        "line-5",
        "line-six",
        "line-seven",
        "line-8",
        "line-9",
    ]
