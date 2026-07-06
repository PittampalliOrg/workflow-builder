"""Generator-driven unit tests for the lifecycle session_workflow (no Dapr
sidecar): a fake context supplies tasks and the test pumps the generator,
monkeypatching ``wf_when_any`` to hand back the chosen winner task."""

from __future__ import annotations

import json
import subprocess

import pytest

import src.session_workflow as sw


class FakeTask:
    def __init__(self, kind: str, detail=None):
        self.kind = kind
        self.detail = detail
        self.result = None

    def get_result(self):
        return self.result


class FakeCtx:
    def __init__(self):
        self.instance_id = "inst-test-1"
        self.is_replaying = False
        self.activity_calls: list[tuple[str, dict]] = []
        self.continued_with = None

    def call_activity(self, activity, *, input=None, retry_policy=None):
        name = getattr(activity, "__name__", str(activity))
        self.activity_calls.append((name, dict(input or {})))
        return FakeTask(f"activity:{name}", input)

    def wait_for_external_event(self, name):
        return FakeTask(f"event:{name}")

    def create_timer(self, duration):
        return FakeTask("timer", duration)

    def continue_as_new(self, new_input):
        self.continued_with = new_input


class WorkflowDriver:
    """Pumps the workflow generator with scripted responses."""

    def __init__(self, ctx, input_data, monkeypatch):
        self.ctx = ctx
        self.gen = sw.session_workflow(ctx, input_data)
        self.pending_winner: FakeTask | None = None
        monkeypatch.setattr(sw, "wf_when_any", self._fake_when_any)
        self._when_any_tasks: list[FakeTask] = []

    def _fake_when_any(self, tasks):
        self._when_any_tasks = list(tasks)
        return FakeTask("when_any", tasks)

    def event_task(self) -> FakeTask:
        return next(t for t in self._when_any_tasks if t.kind.startswith("event:"))

    def timer_task(self) -> FakeTask:
        return next(t for t in self._when_any_tasks if t.kind == "timer")


BASE_INPUT = {
    "sessionId": "sess-wf-1",
    "agentConfig": {"modelSpec": "anthropic/claude-opus-4-8"},
}


def _start_to_first_when_any(
    driver, *, seed_result=None, prepare_result=None, start_result=None
):
    """Pump seed + start activities; returns the first when_any yield."""
    yielded = driver.gen.send(None)
    assert yielded.kind == "activity:seed_session_activity"
    yielded = driver.gen.send(seed_result or {"paths": {}, "warnings": []})
    if yielded.kind == "activity:prepare_swebench_workspace_activity":
        yielded = driver.gen.send(
            prepare_result or {"ok": True, "prepared": True, "workspaceRoot": "/sandbox/repo"}
        )
    assert yielded.kind == "activity:start_cli_activity"
    return driver.gen.send(start_result or {"paneRef": "p1", "agentDetected": True})


def _bounded_winner(driver, yielded, kind):
    """The post-loop activities (stop / extract_model_patch / sync_output) all run
    via ``_yield_bounded``, which yields ``when_any([activity, timer])`` and only
    returns the activity result when the activity TASK itself is the winner. Return
    that task so the test can inspect ``.detail`` / set ``.result`` before sending
    it back as the winner."""
    assert yielded.kind == "when_any"
    return next(t for t in driver._when_any_tasks if t.kind == kind)


def _complete_bounded_stop(driver, yielded, *, stop_result=None):
    """Drive the cooperative close (the common terminal case) — send the stop
    activity task back as the winner. Returns the generator's next yield, or
    re-raises StopIteration when the workflow ends."""
    stop_act = _bounded_winner(driver, yielded, "activity:stop_cli_activity")
    stop_act.result = {"ok": True} if stop_result is None else stop_result
    return driver.gen.send(stop_act)


# A completed/terminated run ends with three timer-bounded BEST-EFFORT syncs
# (browser video, workspace diff, source bundle), each a ``_yield_bounded``
# when_any yielded after stop/output-sync/patch. They don't touch the result
# contract; the tests just have to drive them to reach the return. (A failed run
# skips all three, so its tests still end right after stop.)
_BEST_EFFORT_SYNC_ACTIVITIES = (
    "activity:sync_browser_video_activity",
    "activity:sync_workspace_diff_activity",
    "activity:sync_source_bundle_activity",
)


def _drain_best_effort_syncs(driver, yielded):
    """Drive the three best-effort post-loop syncs in order by handing each
    activity task back as the winner. The final send returns the workflow result
    (raising StopIteration) — call inside ``pytest.raises(StopIteration)``."""
    for kind in _BEST_EFFORT_SYNC_ACTIVITIES:
        act = _bounded_winner(driver, yielded, kind)
        act.result = {"ok": True}
        yielded = driver.gen.send(act)
    return yielded


def _drive_terminal_to_result(driver, yielded):
    """Drive a completed/terminated run with no declared outputSync / swebench
    patch: cooperative stop → the three best-effort syncs. Raises StopIteration
    carrying the workflow result (call inside ``pytest.raises(StopIteration)``)."""
    yielded = _complete_bounded_stop(driver, yielded)
    _drain_best_effort_syncs(driver, yielded)


def test_auto_terminate_stops_after_first_turn_completed(monkeypatch):
    ctx = FakeCtx()
    driver = WorkflowDriver(
        ctx, {**BASE_INPUT, "autoTerminateAfterEndTurn": True}, monkeypatch
    )
    _start_to_first_when_any(driver)
    event_task = driver.event_task()
    event_task.result = {
        "events": [{"type": "turn.completed", "lastAssistantText": "workflow answer"}]
    }
    yielded = driver.gen.send(event_task)
    with pytest.raises(StopIteration) as stop:
        _drive_terminal_to_result(driver, yielded)
    result = stop.value.value
    assert result["success"] is True
    assert result["status"] == "completed"
    assert result["output"] == "workflow answer"
    assert result["turnCount"] == 1


def test_happy_path_turn_then_clean_exit(monkeypatch):
    published: list[tuple[str, str, dict, dict]] = []
    monkeypatch.setattr(
        sw,
        "publish_session_event",
        lambda sid, etype, data, **kw: published.append((sid, etype, data, kw)),
    )
    ctx = FakeCtx()
    driver = WorkflowDriver(ctx, dict(BASE_INPUT), monkeypatch)

    when_any = _start_to_first_when_any(driver)
    assert when_any.kind == "when_any"

    # Event wins: a completed turn.
    event_task = driver.event_task()
    event_task.result = {
        "events": [{"type": "turn.completed", "lastAssistantText": "the answer"}]
    }
    when_any = driver.gen.send(event_task)
    assert when_any.kind == "when_any"

    # Event wins again: clean cli exit.
    event_task = driver.event_task()
    event_task.result = {"events": [{"type": "cli.exited", "exitCode": 0}]}
    yielded = driver.gen.send(event_task)
    with pytest.raises(StopIteration) as stop:
        _drive_terminal_to_result(driver, yielded)
    result = stop.value.value
    assert result["success"] is True
    assert result["status"] == "completed"
    assert result["output"] == "the answer"
    assert result["content"] == "the answer"
    assert result["turnCount"] == 1
    assert result["sessionId"] == "sess-wf-1"
    assert result["agentRuntime"] == "claude-code-cli"
    assert result["childWorkflowName"] == "session_workflow"
    assert result["daprInstanceId"] == "inst-test-1"
    # status_starting at the top, status_terminated at the bottom.
    assert ("sess-wf-1", "session.status_starting", {}, {}) == published[0]
    turn_completed = next(
        event for event in published if event[1] == "session.turn_completed"
    )
    assert turn_completed[2]["turn"] == 1
    assert turn_completed[2]["agentRuntime"] == "claude-code-cli"
    assert turn_completed[2]["output_preview"] == "the answer"
    assert turn_completed[3]["blocking"] is True
    status_idle = next(
        event for event in published if event[1] == "session.status_idle"
    )
    assert status_idle[2]["turn"] == 1
    assert status_idle[2]["agentRuntime"] == "claude-code-cli"
    assert status_idle[2]["stop_reason"] == {"type": "end_turn"}
    assert status_idle[3]["blocking"] is True
    assert published.index(turn_completed) < published.index(status_idle)
    assert published[-1][1] == "session.status_terminated"
    assert published[-1][2]["status"] == "completed"
    assert published[-1][2]["stop_reason"] == {"type": "end_turn"}
    assert published[-1][2]["turnCount"] == 1


def test_result_contract_reports_selected_cli_runtime(monkeypatch):
    ctx = FakeCtx()
    driver = WorkflowDriver(
        ctx,
        {
            **BASE_INPUT,
            "agentConfig": {"runtime": "codex-cli", "cliAdapter": "codex"},
            "autoTerminateAfterEndTurn": True,
        },
        monkeypatch,
    )
    _start_to_first_when_any(driver)
    event_task = driver.event_task()
    event_task.result = {"events": [{"type": "turn.completed", "content": "done"}]}
    yielded = driver.gen.send(event_task)
    with pytest.raises(StopIteration) as stop:
        _drive_terminal_to_result(driver, yielded)
    assert stop.value.value["agentRuntime"] == "codex-cli"


def test_completed_run_syncs_declared_outputs(monkeypatch):
    ctx = FakeCtx()
    driver = WorkflowDriver(
        ctx,
        {
            **BASE_INPUT,
            "autoTerminateAfterEndTurn": True,
            "sandboxName": "workspace-1",
            "workspaceRef": "workspace-1",
            "outputSync": {
                "workspaceRef": "workspace-1",
                "paths": [{"source": "/sandbox/app", "target": "/sandbox/app"}],
            },
        },
        monkeypatch,
    )
    _start_to_first_when_any(driver)
    event_task = driver.event_task()
    event_task.result = {"events": [{"type": "turn.completed", "content": "done"}]}
    yielded = driver.gen.send(event_task)
    yielded = _complete_bounded_stop(driver, yielded)
    sync_act = _bounded_winner(driver, yielded, "activity:sync_output_activity")
    assert sync_act.detail["sandboxName"] == "workspace-1"
    assert sync_act.detail["outputSync"]["paths"][0]["source"] == "/sandbox/app"
    sync_act.result = {"ok": True, "copied": []}
    with pytest.raises(StopIteration) as stop:
        yielded = driver.gen.send(sync_act)
        _drain_best_effort_syncs(driver, yielded)
    result = stop.value.value
    assert result["success"] is True
    assert result["outputSync"]["ok"] is True


def test_completed_swebench_run_extracts_model_patch(monkeypatch):
    ctx = FakeCtx()
    driver = WorkflowDriver(
        ctx,
        {
            **BASE_INPUT,
            "autoTerminateAfterEndTurn": True,
            "cwd": "/sandbox/repo",
            "environmentConfig": {
                "swebenchInferenceEnvironment": {
                    "repo": "astropy/astropy",
                    "baseCommit": "abc123",
                    "workspaceRoot": "/sandbox/repo",
                }
            },
        },
        monkeypatch,
    )
    _start_to_first_when_any(driver)
    event_task = driver.event_task()
    event_task.result = {"events": [{"type": "turn.completed", "content": "done"}]}
    yielded = driver.gen.send(event_task)
    yielded = _complete_bounded_stop(driver, yielded)
    patch_act = _bounded_winner(driver, yielded, "activity:extract_model_patch_activity")
    assert patch_act.detail["baseCommit"] == "abc123"
    assert patch_act.detail["workspaceRoot"] == "/sandbox/repo"
    patch_act.result = {
        "ok": True,
        "modelPatch": "diff --git a/pkg.py b/pkg.py\n",
        "patchBytes": 28,
        "patchFilesTouched": ["pkg.py"],
    }
    with pytest.raises(StopIteration) as stop:
        yielded = driver.gen.send(patch_act)
        _drain_best_effort_syncs(driver, yielded)
    result = stop.value.value
    assert result["modelPatch"] == "diff --git a/pkg.py b/pkg.py\n"
    assert result["patchBytes"] == 28
    assert result["patchFilesTouched"] == ["pkg.py"]
    assert result["patchExtraction"]["ok"] is True
    assert "modelPatch" not in result["patchExtraction"]


def test_swebench_workspace_is_prepared_before_cli_start(monkeypatch):
    ctx = FakeCtx()
    driver = WorkflowDriver(
        ctx,
        {
            **BASE_INPUT,
            "autoTerminateAfterEndTurn": True,
            "cwd": "/sandbox/repo",
            "environmentConfig": {
                "swebenchInferenceEnvironment": {
                    "repo": "astropy/astropy",
                    "baseCommit": "abc123",
                    "workspaceRoot": "/sandbox/repo",
                }
            },
        },
        monkeypatch,
    )

    _start_to_first_when_any(driver)

    assert [name for name, _ in ctx.activity_calls[:3]] == [
        "seed_session_activity",
        "prepare_swebench_workspace_activity",
        "start_cli_activity",
    ]
    prepare_call = ctx.activity_calls[1][1]
    assert prepare_call == {
        "repo": "astropy/astropy",
        "baseCommit": "abc123",
        "workspaceRoot": "/sandbox/repo",
    }


def test_extract_model_patch_activity_uses_base_commit_and_excludes_tests(
    tmp_path, monkeypatch
):
    repo = tmp_path / "sandbox" / "repo"
    repo.mkdir(parents=True)
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "pkg.py").write_text("old\n", encoding="utf-8")
    (repo / "tests").mkdir()
    (repo / "tests" / "test_pkg.py").write_text("old\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "base"], cwd=repo, check=True)
    base = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    (repo / "pkg.py").write_text("new\n", encoding="utf-8")
    (repo / "tests" / "test_pkg.py").write_text("new\n", encoding="utf-8")
    monkeypatch.setenv("AGENT_LOCAL_SANDBOX_ROOT", str(tmp_path / "sandbox"))

    result = sw.extract_model_patch_activity(
        {"baseCommit": base, "workspaceRoot": str(repo)}
    )

    assert result["ok"] is True
    assert "diff --git a/pkg.py b/pkg.py" in result["modelPatch"]
    assert "tests/test_pkg.py" not in result["modelPatch"]
    assert result["patchFilesTouched"] == ["pkg.py"]


def test_prepare_swebench_workspace_activity_clones_base_commit(tmp_path, monkeypatch):
    source = tmp_path / "source"
    source.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=source, check=True)
    (source / "pkg.py").write_text("old\n", encoding="utf-8")
    subprocess.run(["git", "add", "pkg.py"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "base"], cwd=source, check=True)
    base = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=source, text=True
    ).strip()
    (source / "pkg.py").write_text("new\n", encoding="utf-8")
    subprocess.run(["git", "commit", "-am", "new", "-q"], cwd=source, check=True)
    remote_root = tmp_path / "remotes" / "local"
    remote_root.mkdir(parents=True)
    subprocess.run(
        ["git", "clone", "--bare", str(source), str(remote_root / "repo.git")],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    sandbox = tmp_path / "sandbox"
    monkeypatch.setenv("AGENT_LOCAL_SANDBOX_ROOT", str(sandbox))
    monkeypatch.setenv(
        "CLI_SWEBENCH_REPO_URL_TEMPLATE", f"file://{tmp_path}/remotes/{{repo}}.git"
    )

    result = sw.prepare_swebench_workspace_activity(
        {
            "repo": "local/repo",
            "baseCommit": base,
            "workspaceRoot": str(sandbox / "repo"),
        }
    )

    assert result["ok"] is True
    assert result["prepared"] is True
    assert (sandbox / "repo" / "pkg.py").read_text(encoding="utf-8") == "old\n"
    head = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=sandbox / "repo", text=True
    ).strip()
    assert head == base


def test_prepare_swebench_workspace_rejects_paths_outside_sandbox(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_LOCAL_SANDBOX_ROOT", str(tmp_path / "sandbox"))

    result = sw.prepare_swebench_workspace_activity(
        {
            "repo": "astropy/astropy",
            "baseCommit": "abc123",
            "workspaceRoot": str(tmp_path / "other" / "repo"),
        }
    )

    assert result["ok"] is False
    assert "workspaceRoot must be under" in result["error"]


def test_propagated_history_is_reduced_to_bounded_provenance(monkeypatch):
    class FakeScope:
        name = "OWN_HISTORY"

    class FakeHistoryEvent:
        def __init__(self, field_name: str):
            self.field_name = field_name

        def HasField(self, name: str):
            return name == self.field_name

    class FakeHistory:
        scope = FakeScope()
        events = [
            {"eventType": "ExecutionStarted", "payload": "DO_NOT_STORE"},
            FakeHistoryEvent("taskScheduled"),
            FakeHistoryEvent("childWorkflowInstanceCompleted"),
        ]

    ctx = FakeCtx()
    ctx.get_propagated_history = lambda: FakeHistory()
    driver = WorkflowDriver(
        ctx,
        {
            **BASE_INPUT,
            "autoTerminateAfterEndTurn": True,
            "workflowHistoryPropagation": {"requestedScope": "ownHistory"},
            "workflowId": "wf_123",
            "workflowExecutionId": "exec_123",
            "nodeId": "agent_step",
        },
        monkeypatch,
    )
    _start_to_first_when_any(driver)
    event_task = driver.event_task()
    event_task.result = {"events": [{"type": "turn.completed", "content": "done"}]}
    yielded = driver.gen.send(event_task)
    with pytest.raises(StopIteration) as stop:
        _drive_terminal_to_result(driver, yielded)

    result = stop.value.value
    propagation = result["provenance"]["workflowHistoryPropagation"]
    assert propagation["scope"] == "ownHistory"
    assert propagation["available"] is True
    assert propagation["eventCount"] == 3
    assert propagation["eventTypeCounts"] == {
        "ExecutionStarted": 1,
        "childWorkflowInstanceCompleted": 1,
        "taskScheduled": 1,
    }
    assert result["provenance"]["workflowContext"] == {
        "workflowId": "wf_123",
        "workflowExecutionId": "exec_123",
        "nodeId": "agent_step",
        "agentRuntime": "claude-code-cli",
    }
    serialized = json.dumps(result)
    assert "DO_NOT_STORE" not in serialized
    assert "payload" not in serialized


def test_missing_or_empty_propagated_history_is_not_an_error():
    missing = sw._workflow_history_provenance(
        FakeCtx(),
        {
            "workflowHistoryPropagation": {"requestedScope": "lineage"},
            "_message_metadata": {
                "workflowId": "wf_from_metadata",
                "workflowExecutionId": "exec_from_metadata",
                "nodeId": "node_from_metadata",
            },
        },
        "codex-cli",
    )
    assert missing["workflowHistoryPropagation"] == {
        "scope": "lineage",
        "available": False,
        "eventCount": 0,
        "eventTypeCounts": {},
    }
    assert missing["workflowContext"] == {
        "workflowId": "wf_from_metadata",
        "workflowExecutionId": "exec_from_metadata",
        "nodeId": "node_from_metadata",
        "agentRuntime": "codex-cli",
    }

    ctx = FakeCtx()
    ctx.get_propagated_history = lambda: type(
        "EmptyHistory",
        (),
        {"scope": None, "events": []},
    )()
    empty = sw._workflow_history_provenance(ctx, {}, "agy-cli")
    assert empty["workflowHistoryPropagation"]["scope"] == "none"
    assert empty["workflowHistoryPropagation"]["available"] is False


def test_seed_rejects_codex_runtime_without_cli_adapter():
    with pytest.raises(
        ValueError,
        match='agentConfig.runtime "codex-cli" requires agentConfig.cliAdapter "codex"',
    ):
        sw.seed_session_activity({"agentConfig": {"runtime": "codex-cli"}})


def test_seed_rejects_mismatched_cli_adapter():
    with pytest.raises(
        ValueError,
        match='agentConfig.runtime "agy-cli" requires agentConfig.cliAdapter "antigravity"',
    ):
        sw.seed_session_activity(
            {"agentConfig": {"runtime": "agy-cli", "cliAdapter": "claude-code"}}
        )


def test_nonzero_exit_code_fails_run(monkeypatch):
    ctx = FakeCtx()
    driver = WorkflowDriver(ctx, dict(BASE_INPUT), monkeypatch)
    _start_to_first_when_any(driver)
    event_task = driver.event_task()
    event_task.result = {"events": [{"type": "cli.exited", "exitCode": 3}]}
    yielded = driver.gen.send(event_task)
    with pytest.raises(StopIteration) as stop:
        _complete_bounded_stop(driver, yielded)
    assert stop.value.value["success"] is False
    assert stop.value.value["status"] == "failed"


def test_terminate_event_breaks_terminated(monkeypatch):
    ctx = FakeCtx()
    driver = WorkflowDriver(ctx, dict(BASE_INPUT), monkeypatch)
    _start_to_first_when_any(driver)
    event_task = driver.event_task()
    event_task.result = {"events": [{"type": "session.terminate"}]}
    yielded = driver.gen.send(event_task)
    with pytest.raises(StopIteration) as stop:
        _drive_terminal_to_result(driver, yielded)
    assert stop.value.value["status"] == "terminated"
    assert stop.value.value["success"] is True


def test_timer_path_probes_then_continues_then_terminal(monkeypatch):
    ctx = FakeCtx()
    driver = WorkflowDriver(ctx, dict(BASE_INPUT), monkeypatch)
    _start_to_first_when_any(driver)

    # Timer wins -> cancellation check -> probe -> not terminal -> loop again.
    timer = driver.timer_task()
    yielded = driver.gen.send(timer)
    assert yielded.kind == "activity:check_cancellation_activity"
    yielded = driver.gen.send({"cancelled": False})
    assert yielded.kind == "activity:probe_cli_activity"
    assert yielded.detail["paneRef"] == "p1"
    when_any = driver.gen.send({"terminal": False, "status": "idle"})
    assert when_any.kind == "when_any"

    # Timer wins again -> probe says terminal failed.
    timer = driver.timer_task()
    yielded = driver.gen.send(timer)
    assert yielded.kind == "activity:check_cancellation_activity"
    yielded = driver.gen.send({"cancelled": False})
    assert yielded.kind == "activity:probe_cli_activity"
    yielded = driver.gen.send(
        {"terminal": True, "status": "failed", "reason": "pane_gone"}
    )
    with pytest.raises(StopIteration) as stop:
        _complete_bounded_stop(driver, yielded)
    assert stop.value.value["status"] == "failed"


def test_persisted_cancel_flag_terminates_on_probe_path(monkeypatch):
    ctx = FakeCtx()
    driver = WorkflowDriver(ctx, dict(BASE_INPUT), monkeypatch)
    _start_to_first_when_any(driver)
    timer = driver.timer_task()
    yielded = driver.gen.send(timer)
    assert yielded.kind == "activity:check_cancellation_activity"
    yielded = driver.gen.send(
        {"cancelled": True, "request": {"type": "session.terminate"}}
    )
    with pytest.raises(StopIteration) as stop:
        _drive_terminal_to_result(driver, yielded)
    assert stop.value.value["status"] == "terminated"


def test_continue_as_new_carries_state(monkeypatch):
    monkeypatch.setattr(sw, "CLI_LIFECYCLE_MAX_ITERATIONS", 2)
    ctx = FakeCtx()
    driver = WorkflowDriver(ctx, dict(BASE_INPUT), monkeypatch)
    _start_to_first_when_any(driver)
    for text in ("one", "two"):
        event_task = driver.event_task()
        event_task.result = {
            "events": [{"type": "turn.completed", "lastAssistantText": text}]
        }
        try:
            driver.gen.send(event_task)
        except StopIteration:
            break
    assert ctx.continued_with is not None, "continue_as_new not reached"
    carried = ctx.continued_with["_carried"]
    assert carried["seeded"] is True
    assert carried["turnCount"] == 2
    assert carried["lastAssistantText"] == "two"
    assert carried["paneRef"] == "p1"
    assert carried["provenance"]["workflowHistoryPropagation"]["available"] is False


def test_carried_input_skips_seed_and_start(monkeypatch):
    ctx = FakeCtx()
    input_data = {
        **BASE_INPUT,
        "_carried": {
            "seeded": True,
            "turnCount": 5,
            "lastAssistantText": "carried answer",
            "paneRef": "p7",
        },
    }
    driver = WorkflowDriver(ctx, input_data, monkeypatch)
    when_any = driver.gen.send(None)
    assert when_any.kind == "when_any"  # straight to the event loop
    assert ctx.activity_calls == []
    event_task = driver.event_task()
    event_task.result = {"events": [{"type": "cli.exited", "exitCode": 0}]}
    yielded = driver.gen.send(event_task)
    stop_act = _bounded_winner(driver, yielded, "activity:stop_cli_activity")
    assert stop_act.detail["paneRef"] == "p7"
    with pytest.raises(StopIteration) as stop:
        _drive_terminal_to_result(driver, yielded)
    assert stop.value.value["turnCount"] == 5
    assert stop.value.value["output"] == "carried answer"


def test_turn_failed_fails_one_shot_run(monkeypatch):
    """A turn.failed edge fails a one-shot run exactly like a non-zero cli.exited:
    status_errored is published, then the standard failed teardown/contract."""
    published: list[tuple[str, str, dict, dict]] = []
    monkeypatch.setattr(
        sw,
        "publish_session_event",
        lambda sid, etype, data, **kw: published.append((sid, etype, data, kw)),
    )
    ctx = FakeCtx()
    driver = WorkflowDriver(
        ctx, {**BASE_INPUT, "autoTerminateAfterEndTurn": True}, monkeypatch
    )
    _start_to_first_when_any(driver)
    event_task = driver.event_task()
    event_task.result = {
        "events": [{"type": "turn.failed", "error": "model overloaded"}]
    }
    yielded = driver.gen.send(event_task)
    with pytest.raises(StopIteration) as stop:
        _complete_bounded_stop(driver, yielded)
    result = stop.value.value
    assert result["success"] is False
    assert result["status"] == "failed"
    assert result["turnCount"] == 1
    errored = next(e for e in published if e[1] == "session.status_errored")
    assert errored[2]["stop_reason"] == {"type": "error", "message": "model overloaded"}
    assert errored[2]["turn"] == 1
    assert errored[2]["agentRuntime"] == "claude-code-cli"
    assert errored[3]["blocking"] is True
    assert errored[3]["source_event_id"] == "inst-test-1:turn:1:errored"
    # No un-stick idle for a one-shot run (it terminates instead).
    assert not any(e[1] == "session.status_idle" for e in published)
    assert published[-1][1] == "session.status_terminated"
    assert published[-1][2]["status"] == "failed"
    assert published[-1][2]["success"] is False


def test_turn_failed_keeps_interactive_session_alive(monkeypatch):
    """An interactive session survives a failed turn: status_errored + an
    error-flavored status_idle un-stick the UI, and the loop keeps running."""
    published: list[tuple[str, str, dict, dict]] = []
    monkeypatch.setattr(
        sw,
        "publish_session_event",
        lambda sid, etype, data, **kw: published.append((sid, etype, data, kw)),
    )
    ctx = FakeCtx()
    driver = WorkflowDriver(ctx, dict(BASE_INPUT), monkeypatch)  # interactive
    _start_to_first_when_any(driver)
    event_task = driver.event_task()
    event_task.result = {"events": [{"type": "turn.failed", "error": "boom"}]}
    when_any = driver.gen.send(event_task)
    # The loop continues (another when_any yields), not a terminal teardown.
    assert when_any.kind == "when_any"
    errored = next(e for e in published if e[1] == "session.status_errored")
    assert errored[2]["stop_reason"] == {"type": "error", "message": "boom"}
    idle = next(e for e in published if e[1] == "session.status_idle")
    assert idle[2]["stop_reason"] == {"type": "error", "message": "boom"}
    assert idle[2]["turn"] == 1
    assert idle[3]["source_event_id"] == "inst-test-1:turn:1:errored-idle"
    assert idle[3]["blocking"] is True
    # errored is published before the un-stick idle.
    assert published.index(errored) < published.index(idle)
    # No terminal was published — the session is still live.
    assert not any(e[1] == "session.status_terminated" for e in published)


def test_turn_failed_does_not_publish_on_replay(monkeypatch):
    """Replay-safety: the status_errored/idle publishes are guarded by
    not ctx.is_replaying, but the workflow still resolves to a failed contract."""
    published: list[str] = []
    monkeypatch.setattr(
        sw,
        "publish_session_event",
        lambda sid, etype, data, **kw: published.append(etype),
    )
    ctx = FakeCtx()
    ctx.is_replaying = True
    driver = WorkflowDriver(
        ctx, {**BASE_INPUT, "autoTerminateAfterEndTurn": True}, monkeypatch
    )
    _start_to_first_when_any(driver)
    event_task = driver.event_task()
    event_task.result = {"events": [{"type": "turn.failed", "error": "boom"}]}
    yielded = driver.gen.send(event_task)
    with pytest.raises(StopIteration) as stop:
        _complete_bounded_stop(driver, yielded)
    assert stop.value.value["status"] == "failed"
    assert "session.status_errored" not in published
    assert "session.status_terminated" not in published


def test_seed_user_message_extracted_from_initial_events():
    """The kickoff prompt rides childInput.initialEvents (block-array content)
    and must be passed to start_cli_activity as seedUserMessage."""
    seed = sw._extract_seed_user_message(
        {
            "initialEvents": [
                {"type": "session.status_starting", "content": "ignore"},
                {
                    "type": "user.message",
                    "content": [{"type": "text", "text": "do the thing"}],
                },
            ]
        }
    )
    assert seed == "do the thing"


def test_seed_user_message_falls_back_to_workflow_builder_input():
    seed = sw._extract_seed_user_message(
        {"with": {"x-workflow-builder": {"input": "canvas prompt"}}}
    )
    assert seed == "canvas prompt"


def test_start_cli_activity_receives_seed_user_message(monkeypatch):
    ctx = FakeCtx()
    driver = WorkflowDriver(
        ctx,
        {
            **BASE_INPUT,
            "initialEvents": [
                {"type": "user.message", "content": [{"type": "text", "text": "kick"}]}
            ],
        },
        monkeypatch,
    )
    _start_to_first_when_any(driver)
    start_call = next(
        c for name, c in ctx.activity_calls if name == "start_cli_activity"
    )
    assert start_call["seedUserMessage"] == "kick"


# ---------------------------------------------------------------------------
# background_task_count instrumentation (data only; no drain / behavior change)
# ---------------------------------------------------------------------------


def _publish_capture(monkeypatch):
    published: list[tuple[str, str, dict, dict]] = []
    monkeypatch.setattr(
        sw,
        "publish_session_event",
        lambda sid, etype, data, **kw: published.append((sid, etype, data, kw)),
    )
    return published


def test_status_idle_includes_background_task_count(monkeypatch):
    """An interactive (non-auto-terminate) turn.completed carrying
    backgroundTaskCount rides it onto session.status_idle AND the terminal
    status as background_task_count."""
    published = _publish_capture(monkeypatch)
    ctx = FakeCtx()
    driver = WorkflowDriver(ctx, dict(BASE_INPUT), monkeypatch)  # interactive
    _start_to_first_when_any(driver)
    event_task = driver.event_task()
    event_task.result = {
        "events": [
            {
                "type": "turn.completed",
                "lastAssistantText": "the answer",
                "backgroundTaskCount": 2,
            }
        ]
    }
    when_any = driver.gen.send(event_task)
    assert when_any.kind == "when_any"  # loop keeps running
    status_idle = next(e for e in published if e[1] == "session.status_idle")
    assert status_idle[2]["background_task_count"] == 2

    # Clean exit → the terminal status carries the last completion edge's count.
    event_task = driver.event_task()
    event_task.result = {"events": [{"type": "cli.exited", "exitCode": 0}]}
    yielded = driver.gen.send(event_task)
    with pytest.raises(StopIteration):
        _drive_terminal_to_result(driver, yielded)
    terminated = next(e for e in published if e[1] == "session.status_terminated")
    assert terminated[2]["background_task_count"] == 2


def test_status_idle_includes_zero_background_task_count(monkeypatch):
    """A real zero (all background tasks terminal) is DATA and rides as 0 — the
    `is not None` guard must not drop it like the absent (no-data) case."""
    published = _publish_capture(monkeypatch)
    ctx = FakeCtx()
    driver = WorkflowDriver(ctx, dict(BASE_INPUT), monkeypatch)
    _start_to_first_when_any(driver)
    event_task = driver.event_task()
    event_task.result = {
        "events": [
            {"type": "turn.completed", "lastAssistantText": "x", "backgroundTaskCount": 0}
        ]
    }
    driver.gen.send(event_task)
    status_idle = next(e for e in published if e[1] == "session.status_idle")
    assert status_idle[2]["background_task_count"] == 0


def test_status_idle_omits_background_task_count_when_absent(monkeypatch):
    """No backgroundTaskCount on the edge (Claude Code reported no background_tasks)
    → status_idle omits the field entirely (no data)."""
    published = _publish_capture(monkeypatch)
    ctx = FakeCtx()
    driver = WorkflowDriver(ctx, dict(BASE_INPUT), monkeypatch)
    _start_to_first_when_any(driver)
    event_task = driver.event_task()
    event_task.result = {
        "events": [{"type": "turn.completed", "lastAssistantText": "the answer"}]
    }
    driver.gen.send(event_task)
    status_idle = next(e for e in published if e[1] == "session.status_idle")
    assert "background_task_count" not in status_idle[2]


def test_auto_terminate_terminal_status_carries_background_task_count(monkeypatch):
    """Auto-terminate runs emit NO idle event, so the terminal status is where the
    count surfaces — exactly the case a future drain would target. Control flow is
    unchanged: the run still terminates at turn end."""
    published = _publish_capture(monkeypatch)
    ctx = FakeCtx()
    driver = WorkflowDriver(
        ctx, {**BASE_INPUT, "autoTerminateAfterEndTurn": True}, monkeypatch
    )
    _start_to_first_when_any(driver)
    event_task = driver.event_task()
    event_task.result = {
        "events": [
            {"type": "turn.completed", "content": "done", "backgroundTaskCount": 3}
        ]
    }
    yielded = driver.gen.send(event_task)
    with pytest.raises(StopIteration) as stop:
        _drive_terminal_to_result(driver, yielded)
    assert stop.value.value["status"] == "completed"  # behavior unchanged
    assert not any(e[1] == "session.status_idle" for e in published)
    terminated = next(e for e in published if e[1] == "session.status_terminated")
    assert terminated[2]["background_task_count"] == 3


def test_non_int_background_task_count_is_ignored(monkeypatch):
    """A malformed backgroundTaskCount (bool / non-int) is dropped, not surfaced —
    the workflow only threads a genuine int."""
    published = _publish_capture(monkeypatch)
    ctx = FakeCtx()
    driver = WorkflowDriver(ctx, dict(BASE_INPUT), monkeypatch)
    _start_to_first_when_any(driver)
    event_task = driver.event_task()
    event_task.result = {
        "events": [
            {"type": "turn.completed", "lastAssistantText": "x", "backgroundTaskCount": True}
        ]
    }
    driver.gen.send(event_task)
    status_idle = next(e for e in published if e[1] == "session.status_idle")
    assert "background_task_count" not in status_idle[2]
