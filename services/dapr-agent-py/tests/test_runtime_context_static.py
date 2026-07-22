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
    assert (
        "f\"{instance_id}:{turn_id or 'turn'}:context_usage:{request_hash}\"" in source
    )
    assert source.index("self._emit_active_context_usage(") < source.index(
        "result = super().call_llm(ctx, payload)"
    )


def test_durable_agent_uses_sequential_tool_execution() -> None:
    source = MAIN_SOURCE.read_text()

    assert "ToolExecutionMode" in source
    assert "tool_execution_mode=ToolExecutionMode.SEQUENTIAL" in source
    assert "def _agent_workflow_strict_sequential" in source
    assert "def check_cancellation_for_instance" in source
    assert "self._activity_name(self.check_cancellation_for_instance)" in source
    assert "Agent %s observed cancellation after LLM turn" in source
    assert (
        "runtime.register_activity(self.check_cancellation_for_instance)" not in source
    )
    assert "self._named(activity, self._activity_name(activity))" in source
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
    assert (
        'ctx.call_child_workflow(\n                "run_tool_activity_workflow"'
        not in source
    )
    assert "self._activity_name(self.run_tool)" in source
    assert "yield from self._agent_workflow_strict_sequential(" in source


def test_tool_dispatch_evidence_events_are_emitted() -> None:
    source = MAIN_SOURCE.read_text()

    assert '"tool_activity.scheduled"' in source
    assert '"tool_activity.started"' in source
    assert "[tool-dispatch] scheduled" in source
    assert "[tool-dispatch] run_tool entry" in source


def test_tool_dispatch_passes_encoded_failures_to_canonical_span() -> None:
    source = MAIN_SOURCE.read_text()

    assert 'success=locals().get("_exec_success")' in source
    assert 'error=locals().get("_exec_error")' in source


def test_terminal_session_events_are_persisted_for_in_turn_cancellation() -> None:
    source = MAIN_SOURCE.read_text()

    assert "TERMINAL_CONTROL_EVENT_TYPES" in source
    assert "def _session_cancel_state_key" in source
    assert "def _save_session_cancellation_request" in source
    assert "if event_name in TERMINAL_CONTROL_EVENT_TYPES:" in source
    assert (
        "_save_session_cancellation_request(instance_id, event_name, payload)" in source
    )


def test_native_dapr_agent_llm_hooks_are_debug_only() -> None:
    source = MAIN_SOURCE.read_text()

    assert "from dapr_agents.hooks import Hooks as NativeHooks" in source
    assert "def _install_native_llm_debug_hooks(" in source
    assert '"DAPR_AGENT_NATIVE_LLM_HOOK_LOGGING_ENABLED"' in source
    assert '"dapr_agents.native_llm_hook"' in source
    assert "return Proceed()" in source
    assert "_install_native_llm_debug_hooks(agent)" in source
    assert "Policy/tool gating remains on the repo-owned hook" in source


def test_agent_host_readyz_requires_connected_workflow_worker() -> None:
    source = MAIN_SOURCE.read_text()

    assert "def _agent_workflow_runtime_status(" in source
    assert "/v1.0/metadata" in source
    assert '"connectedWorkers"' in source
    assert '"workflowConnectedWorkers": connected_workers' in source
    assert "workflow runtime has no connected Dapr workflow workers" in source
    assert "def readiness_check()" in source
    assert '"code": "workflow_runtime_unavailable"' in source


def test_session_bridge_uses_child_workflow_for_non_swebench_only() -> None:
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
    assert (
        'child_metadata_for_mode["agentWorkflowMode"] = "strict_sequential"' in source
    )
    assert '"agentWorkflowMode": child_input.get("agentWorkflowMode")' in source
    assert "if not use_child_turn_workflow:" not in source
    assert "if auto_terminate and not is_swebench_execution_context(" in source
    assert "turn_result = yield ctx.call_child_workflow(" in source
    assert 'getattr(self, "agent_workflow_name", "agent_workflow")' in source
    assert "SWE-bench launches brand-new ephemeral agent-host app IDs" in source
    assert "turn_result = yield from self.agent_workflow(ctx, child_input)" in source
    assert '"session.status_terminating"' in source
    assert '"reason": "cancelled"' in source


def test_workflow_tool_direct_bff_calls_carry_session_lineage_and_token_when_available() -> (
    None
):
    source = MAIN_SOURCE.read_text()
    bridge_start = source.index("def run_workflow_script_bridge")
    bridge_end = source.index("def seed_mcp_for_instance", bridge_start)
    bridge_source = source[bridge_start:bridge_end]

    assert '"parentInstanceId": message.get("parentInstanceId")' in bridge_source
    assert (
        "session_id = self._workflow_tool_session_id(parent_instance)" in bridge_source
    )
    assert (
        "session_token = self._workflow_tool_session_token(parent_instance)"
        in bridge_source
    )
    assert '"X-Wfb-Session-Id": session_id' in bridge_source
    assert 'headers["X-Wfb-Session-Token"] = session_token' in bridge_source
    assert "if session_token:" in bridge_source
    assert "if not session_id:" in bridge_source
    assert "requires Workflow Builder session lineage" in bridge_source
    assert "A token is mandatory at workflow-mcp-server" in bridge_source
    assert "bounded legacy-resource" in bridge_source


def test_session_start_authority_is_first_replay_durable_session_step() -> None:
    source = MAIN_SOURCE.read_text()
    pending_schedule = (1, 2, 4, 8, 15, 30) + (60,) * 14
    register_start = source.index("def register_workflows")
    wrapper_start = source.index("def call_peer_session_workflow", register_start)
    activity_start = source.index("def authorize_session_runtime_start", wrapper_start)
    session_start = source.index("def session_workflow", activity_start)
    session_end = source.index("\ndef _compose_turn_task", session_start)

    registration_source = source[register_start:wrapper_start]
    wrapper_source = source[wrapper_start:activity_start]
    activity_source = source[activity_start:session_start]
    session_source = source[session_start:session_end]

    assert "self.authorize_session_runtime_start," in registration_source
    assert '"requiresStartAuthority": bool(' in wrapper_source
    assert "retry_policy=self._retry_policy" in wrapper_source
    assert "if response_status == 202:" in wrapper_source
    assert '"workflowMcpSessionToken": row.get(' in wrapper_source
    assert 'row.get("runtimeAppId") or message.get("peerAppId")' in wrapper_source
    assert '"runtimeAppId": runtime_app_id' in wrapper_source
    assert '"X-Wfb-Session-Id": session_id' in activity_source
    assert '"X-Wfb-Session-Token": session_token' in activity_source
    assert 'payload.get("runtimeAppId")' in activity_source
    assert 'payload.get("runtimeInstanceId")' in activity_source
    assert '"runtimeInstanceId": runtime_instance_id' in activity_source
    assert "if exc.code in {403, 404, 409}:" in activity_source
    assert 'code in {"team_pending", "runtime_unpublished"}' in activity_source
    assert 'denial.get("retryable") is True' in activity_source

    authority_yield = session_source.index(
        "start_authority = yield ctx.call_activity(\n"
        "                    self._activity_name(self.authorize_session_runtime_start)"
    )
    config_resolution = session_source.index(
        'agent_cfg = _coerce_agent_config(message.get("agentConfig"))'
    )
    first_event = session_source.index("publish_session_event(")
    first_turn = session_source.index("turn_counter =")
    pending_timer = session_source.index("yield ctx.create_timer(")
    assert authority_yield < config_resolution < first_event
    assert authority_yield < first_turn
    assert authority_yield < pending_timer < config_resolution
    assert '"runtimeAppId": message.get("runtimeAppId")' in session_source
    assert '"runtimeInstanceId": ctx.instance_id' in session_source
    assert 'in {"team_pending", "runtime_unpublished"}' in session_source
    assert "not retryable_pending" in session_source
    compact_session_source = "".join(session_source.split())
    assert (
        "pending_attempt>=len(_START_AUTHORITY_PENDING_DELAYS_SECONDS)"
        in compact_session_source
    )
    assert (
        "_START_AUTHORITY_PENDING_DELAYS_SECONDS = "
        "(1, 2, 4, 8, 15, 30) + (60,) * 14" in source
    )
    assert sum(pending_schedule) >= 15 * 60
    assert '"session start was not authorized"' in session_source
    assert '"session start authority remained pending"' in session_source


def test_swebench_one_shot_turn_skips_replay_unsafe_agent_wrapper_mutations() -> None:
    source = MAIN_SOURCE.read_text()

    assert "strict_one_shot_agent_turn = (" in source
    assert 'requested_agent_workflow_mode == "strict_sequential"' in source
    assert "or is_swebench_execution_context(instance_id, message)" in source
    assert "if not strict_one_shot_agent_turn and not ctx.is_replaying:" in source
    assert (
        "custom_hooks_enabled = hooks_enabled() and not strict_one_shot_agent_turn"
        in source
    )
    assert "session_seeded_one_shot_turn" not in source
    assert "using session-seeded context" not in source
    assert "if custom_hooks_enabled:" in source
    assert "def _custom_hooks_enabled_for_instance(" in source
    assert "if is_swebench_execution_context(instance_id, context):" in source
    assert 'return mode != "strict_sequential"' in source
    assert (
        "strict_one_shot_agent_turn\n                or requested_agent_workflow_mode"
        in source
    )
    assert source.index("strict_one_shot_agent_turn = (") < source.index(
        "# Inject plan from PLAN.md if it exists"
    )
    assert source.index("if custom_hooks_enabled:") < source.index(
        "yield ctx.call_activity(\n            self._activity_name(self.seed_runtime_context_for_instance)"
    )
    assert source.index(
        "self._remember_runtime_context(instance_id, runtime_context)"
    ) < source.index(
        "yield ctx.call_activity(\n            self._activity_name(self.seed_runtime_context_for_instance)"
    )
    assert source.index(
        "yield ctx.call_activity(\n            self._activity_name(self.seed_runtime_context_for_instance)"
    ) < source.index("yield from self._agent_workflow_strict_sequential(")
    assert source.index(
        "if not strict_one_shot_agent_turn and not ctx.is_replaying:"
    ) < source.index("_save_plan_to_state(execution_id, plan_content)")


def test_agent_runtime_has_no_leftover_hot_path_debug_probes() -> None:
    source = MAIN_SOURCE.read_text()
    # Slice exactly the _telemetry_context_kwargs function: from its def to the
    # next top-level def. (The old upper bound, _runtime_reachable_mcp_url, was
    # removed in PR #136 and left this test permanently red.)
    start = source.index("def _telemetry_context_kwargs")
    end = source.index("\ndef ", start + 1)
    telemetry_kwargs_source = source[start:end]

    assert "[call-llm-probe]" not in source
    assert "[mcp] get_llm_tools called" not in source
    assert '"extra": {' not in telemetry_kwargs_source
