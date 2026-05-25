from __future__ import annotations

from pathlib import Path


MAIN_SOURCE = Path(__file__).resolve().parents[1] / "src" / "main.py"


def test_session_seeded_runtime_context_carries_mlflow_context() -> None:
    source = MAIN_SOURCE.read_text()

    assert '"mlflowContext": child_mlflow_context' in source
    assert '"mlflowRunId": child_mlflow_context.get("runId")' in source
    assert '"mlflowParentRunId": child_mlflow_context.get("parentRunId")' in source
    assert '"mlflowTraceExperimentId": child_mlflow_context.get(' in source


def test_runtime_context_memory_cache_preserves_mlflow_context() -> None:
    source = MAIN_SOURCE.read_text()

    assert 'if isinstance(clean.get("mlflowContext"), dict):' in source
    assert 'agent_context["mlflowContext"] = dict(clean["mlflowContext"])' in source


def test_call_llm_emits_active_context_usage_before_provider_call() -> None:
    source = MAIN_SOURCE.read_text()

    assert "def _emit_active_context_usage(" in source
    assert '"agent.context_usage"' in source
    assert "**fields" in source
    assert '"llm.context.count_method": fields.get("context_count_method")' in source
    assert 'f"{instance_id}:{turn_id or \'turn\'}:context_usage:{request_hash}"' in source
    assert source.index("self._emit_active_context_usage(") < source.index(
        "result = super().call_llm(ctx, payload)"
    )


def test_durable_agent_uses_sequential_tool_execution() -> None:
    source = MAIN_SOURCE.read_text()

    assert "ToolExecutionMode" in source
    assert "tool_execution_mode=ToolExecutionMode.SEQUENTIAL" in source
    assert "def _agent_workflow_strict_sequential" in source
    assert "force_repo_sequential: bool = False" in source
    assert "Always record this activity in durable history" in source
    assert "if self._orchestration_strategy and not force_repo_sequential:" in source
    assert "if self._orchestration_strategy or self.executor is not None" not in source
    assert "is_swebench_execution_context(instance_id, runtime_context)" in source
    assert 'requested_agent_workflow_mode == "strict_sequential"' in source
    assert "force_repo_sequential=force_repo_sequential" in source
    assert "def run_tool_activity_workflow" in source
    assert 'runtime.register_workflow(self.run_tool_activity_workflow)' in source
    assert "def _tool_child_workflow_enabled(" in source
    assert '"DAPR_AGENT_TOOL_CHILD_WORKFLOW_ENABLED"' in source
    assert '"DAPR_AGENT_SWEBENCH_TOOL_CHILD_WORKFLOW_ENABLED"' not in source
    tool_child_gate = source.split("def _tool_child_workflow_enabled(", 1)[1].split(
        "\n\ndef _tool_child_workflow_retry_attempts",
        1,
    )[0]
    assert "return False" in tool_child_gate
    assert "return True" in tool_child_gate
    assert tool_child_gate.index('"DAPR_AGENT_TOOL_CHILD_WORKFLOW_ENABLED"') < (
        tool_child_gate.index("is_swebench_execution_context(")
    )
    assert tool_child_gate.index("is_swebench_execution_context(") < tool_child_gate.index(
        "return True"
    )
    assert '"DAPR_AGENT_TOOL_CHILD_WORKFLOW_TIMEOUT_SECONDS"' in source
    assert '"DAPR_AGENT_SWEBENCH_TOOL_CHILD_WORKFLOW_TIMEOUT_SECONDS"' not in source
    assert '"DAPR_AGENT_TOOL_CHILD_WORKFLOW_RETRY_ATTEMPTS"' in source
    assert '"DAPR_AGENT_SWEBENCH_TOOL_CHILD_WORKFLOW_RETRY_ATTEMPTS"' not in source
    assert "use_tool_child_workflow = _tool_child_workflow_enabled(" in source
    assert "def _run_tool_child_workflow_with_watchdog(" in source
    assert "durable_task.when_any([child_task, timer_task])" in source
    assert "ctx.create_timer(timedelta(seconds=timeout_seconds))" in source
    assert "terminate_tool_child_workflow_instance" in source
    assert "[tool-dispatch] yielding sequential tool child workflow" in source
    assert "[tool-dispatch] tool child workflow timed out" in source
    assert "[tool-dispatch] yielding sequential inline tool activity" in source
    assert 'f"{ctx.instance_id}__tool__{turn}__{idx}__{safe_call_id}"' in source
    assert 'ctx.call_child_workflow(\n                "run_tool_activity_workflow"' in source
    assert "self._activity_name(self.run_tool)" in source
    assert "yield from self._agent_workflow_strict_sequential(" in source


def test_tool_dispatch_evidence_events_are_emitted() -> None:
    source = MAIN_SOURCE.read_text()

    assert '"tool_activity.scheduled"' in source
    assert '"tool_activity.started"' in source
    assert "[tool-dispatch] scheduled" in source
    assert "[tool-dispatch] run_tool entry" in source


def test_one_shot_session_bridge_keeps_swebench_inline() -> None:
    source = MAIN_SOURCE.read_text()

    assert "def _one_shot_turn_child_workflow_enabled(" in source
    assert '"DAPR_AGENT_SESSION_ONE_SHOT_CHILD_WORKFLOW_ENABLED"' in source
    assert '"DAPR_AGENT_SWEBENCH_SESSION_ONE_SHOT_CHILD_WORKFLOW_ENABLED"' not in source
    one_shot_gate = source.split("def _one_shot_turn_child_workflow_enabled(", 1)[
        1
    ].split("\n\ndef _tool_child_workflow_enabled", 1)[0]
    assert "return True" in one_shot_gate
    assert "is_swebench_execution_context(" in one_shot_gate
    assert "return False" in one_shot_gate
    assert one_shot_gate.index("is_swebench_execution_context(") < one_shot_gate.index(
        '"DAPR_AGENT_SESSION_ONE_SHOT_CHILD_WORKFLOW_ENABLED"'
    )
    assert "use_child_turn_workflow = False" not in source
    assert "agent_turn_instance_id = (" in source
    assert 'f"{workflow_instance_id}__turn__{turn_counter}"' in source
    assert "if use_child_turn_workflow" in source
    assert "_session_bridge_startup_settle_seconds()" in source
    assert "def _session_bridge_startup_jitter_seconds(" in source
    assert '"DAPR_AGENT_SESSION_BRIDGE_STARTUP_SETTLE_SECONDS",\n                "60",' in source
    assert '"DAPR_AGENT_SWEBENCH_SESSION_BRIDGE_STARTUP_JITTER_SECONDS"' in source
    assert '"DAPR_AGENT_SESSION_BRIDGE_STARTUP_JITTER_SECONDS"' in source
    assert "settle_seconds = _session_bridge_startup_settle_seconds() if auto_terminate else 0" in source
    assert "startup_delay_seconds = settle_seconds + jitter_seconds" in source
    assert "ctx.create_timer(timedelta(seconds=startup_delay_seconds))" in source
    assert 'child_input["agentWorkflowMode"] = "strict_sequential"' in source
    assert 'child_metadata_for_mode["agentWorkflowMode"] = "strict_sequential"' in source
    assert '"agentWorkflowMode": child_input.get("agentWorkflowMode")' in source
    assert "if not use_child_turn_workflow:" in source
    assert 'turn_result = yield ctx.call_child_workflow(' in source
    child_turn_call = source.split('if use_child_turn_workflow:', 1)[1].split(
        'else:\n                    # Session-native cutover',
        1,
    )[0]
    assert "retry_policy=" not in child_turn_call
    assert "while SWE-bench still disables per-tool child workflows" not in source
    assert 'else:\n                    # Session-native cutover' in source
    assert 'turn_result = yield from self.agent_workflow(ctx, child_input)' in source
