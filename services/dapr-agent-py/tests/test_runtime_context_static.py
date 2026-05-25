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
    assert "def run_tool_activity_workflow" not in source
    assert "runtime.register_workflow(self.run_tool_activity_workflow)" not in source
    assert "def _native_tool_hooks_configured(" in source
    assert "and not _native_tool_hooks_configured(self)" in source
    assert "def _tool_child_workflow_enabled(" not in source
    assert "DAPR_AGENT_TOOL_CHILD_WORKFLOW_ENABLED" not in source
    assert "DAPR_AGENT_SWEBENCH_TOOL_CHILD_WORKFLOW_ENABLED" not in source
    assert "DAPR_AGENT_TOOL_CHILD_WORKFLOW_TIMEOUT_SECONDS" not in source
    assert "DAPR_AGENT_TOOL_CHILD_WORKFLOW_RETRY_ATTEMPTS" not in source
    assert "use_tool_child_workflow" not in source
    assert "def _run_tool_child_workflow_with_watchdog(" not in source
    assert "durable_task.when_any([child_task, timer_task])" not in source
    assert "ctx.create_timer(timedelta(seconds=timeout_seconds))" not in source
    assert "terminate_tool_child_workflow_instance" not in source
    assert "[tool-dispatch] yielding sequential tool child workflow" not in source
    assert "[tool-dispatch] tool child workflow timed out" not in source
    assert "[tool-dispatch] yielding sequential inline tool activity" in source
    assert 'f"{ctx.instance_id}__tool__{turn}__{idx}__{safe_call_id}"' not in source
    assert 'ctx.call_child_workflow(\n                "run_tool_activity_workflow"' not in source
    assert "self._activity_name(self.run_tool)" in source
    assert "yield from self._agent_workflow_strict_sequential(" in source


def test_tool_dispatch_evidence_events_are_emitted() -> None:
    source = MAIN_SOURCE.read_text()

    assert '"tool_activity.scheduled"' in source
    assert '"tool_activity.started"' in source
    assert "[tool-dispatch] scheduled" in source
    assert "[tool-dispatch] run_tool entry" in source


def test_native_dapr_agent_llm_hooks_are_debug_only() -> None:
    source = MAIN_SOURCE.read_text()

    assert "from dapr_agents.hooks import Hooks as NativeHooks" in source
    assert "def _install_native_llm_debug_hooks(" in source
    assert '"DAPR_AGENT_NATIVE_LLM_HOOK_LOGGING_ENABLED"' in source
    assert '"dapr_agents.native_llm_hook"' in source
    assert "return Proceed()" in source
    assert "_install_native_llm_debug_hooks(agent)" in source
    assert "Policy/tool gating remains on the repo-owned hook" in source


def test_session_bridge_uses_child_workflow_without_debug_flag() -> None:
    source = MAIN_SOURCE.read_text()

    assert "def _one_shot_turn_child_workflow_enabled(" not in source
    assert "DAPR_AGENT_SESSION_ONE_SHOT_CHILD_WORKFLOW_ENABLED" not in source
    assert "DAPR_AGENT_SWEBENCH_SESSION_ONE_SHOT_CHILD_WORKFLOW_ENABLED" not in source
    assert 'f"{workflow_instance_id}__turn__{turn_counter}"' in source
    assert "if use_child_turn_workflow" not in source
    assert "_session_bridge_startup_settle_seconds()" not in source
    assert "def _session_bridge_startup_jitter_seconds(" not in source
    assert "DAPR_AGENT_SESSION_BRIDGE_STARTUP_SETTLE_SECONDS" not in source
    assert "DAPR_AGENT_SWEBENCH_SESSION_BRIDGE_STARTUP_JITTER_SECONDS" not in source
    assert "DAPR_AGENT_SESSION_BRIDGE_STARTUP_JITTER_SECONDS" not in source
    assert "startup_delay_seconds" not in source
    assert "ctx.create_timer(timedelta(seconds=startup_delay_seconds))" not in source
    assert 'child_input["agentWorkflowMode"] = "strict_sequential"' in source
    assert 'child_metadata_for_mode["agentWorkflowMode"] = "strict_sequential"' in source
    assert '"agentWorkflowMode": child_input.get("agentWorkflowMode")' in source
    assert "if not use_child_turn_workflow:" not in source
    assert "if auto_terminate:" in source
    assert "turn_result = yield ctx.call_child_workflow(" in source
    assert 'getattr(self, "agent_workflow_name", "agent_workflow")' in source
    assert "else:\n                    # Long-lived UI sessions keep the agent turn inline" in source
    assert 'turn_result = yield from self.agent_workflow(ctx, child_input)' in source


def test_swebench_one_shot_turn_skips_replay_unsafe_agent_wrapper_mutations() -> None:
    source = MAIN_SOURCE.read_text()

    assert "strict_one_shot_agent_turn = (" in source
    assert 'requested_agent_workflow_mode == "strict_sequential"' in source
    assert "or is_swebench_execution_context(instance_id, message)" in source
    assert "if not strict_one_shot_agent_turn and not ctx.is_replaying:" in source
    assert "custom_hooks_enabled = hooks_enabled() and not strict_one_shot_agent_turn" in source
    assert "session_seeded_one_shot_turn = bool(session_id_raw) and strict_one_shot_agent_turn" in source
    assert "using session-seeded context" in source
    assert "if custom_hooks_enabled:" in source
    assert "def _custom_hooks_enabled_for_instance(" in source
    assert "if is_swebench_execution_context(instance_id, context):" in source
    assert "return mode != \"strict_sequential\"" in source
    assert "strict_one_shot_agent_turn\n                or requested_agent_workflow_mode" in source
    assert source.index("strict_one_shot_agent_turn = (") < source.index(
        "# Inject plan from PLAN.md if it exists"
    )
    assert source.index("if custom_hooks_enabled:") < source.index(
        "session_seeded_one_shot_turn = bool(session_id_raw)"
    )
    assert source.index("session_seeded_one_shot_turn = bool(session_id_raw)") < source.index(
        "yield ctx.call_activity(\n                self.seed_runtime_context_for_instance"
    )
    assert source.index("if not strict_one_shot_agent_turn and not ctx.is_replaying:") < source.index(
        "_save_plan_to_state(execution_id, plan_content)"
    )
