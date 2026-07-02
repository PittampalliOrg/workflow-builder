"""
CNCF Serverless Workflow 1.0 Interpreter

Executes SW 1.0 workflow documents using Dapr Workflows as the durable runtime.
All workflow execution goes through this interpreter.

Task type -> Dapr primitive mapping:
  - call (http/function) -> ctx.call_activity(execute_action)
  - switch                -> evaluate conditions, determine next task
  - wait                  -> ctx.create_timer()
  - set                   -> update state variables
  - emit                  -> ctx.call_activity(publish_phase_changed)
  - listen                -> ctx.wait_for_external_event()
  - for                   -> loop over items with sub-task execution
  - fork                  -> parallel task execution
  - try                   -> error handling with catch
  - run (workflow)        -> ctx.call_child_workflow()
  - run (shell/script)    -> ctx.call_activity(execute_action)
  - do                    -> sequential sub-task execution
  - raise                 -> raise error
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import timedelta
from typing import Any

import dapr.ext.workflow as wf
from dapr.ext.workflow import when_any as wf_when_any

from core.config import config
from core.sw_types import (
    TaskType,
    Workflow,
    SWWorkflowInput,
    SWWorkflowOutput,
    SWWorkflowCustomStatus,
    get_task_type,
)
from core.sw_expressions import (
    evaluate_condition,
    evaluate_structure,
    resolve_input_definition,
    resolve_output_definition,
)
from core.template_resolver import resolve_templates
from activities.execute_action import execute_action
from activities.crawl4ai import crawl4ai_get_job_status, crawl4ai_start_job
from activities.environment_build import check_environment_build, ensure_environment
from activities.persist_artifact import persist_workflow_artifact
from activities.persist_state import persist_state
from activities.publish_event import publish_phase_changed
from activities.log_external_event import (
    log_approval_request,
    log_approval_response,
    log_approval_timeout,
)
from activities.log_node_execution import (
    log_node_start,
    log_node_complete,
    update_execution_node,
)
from activities.persist_results_to_db import persist_results_to_db
from activities.finalize_otel_trace_root import finalize_otel_trace_root
from tracing import merge_workflow_activity_context

logger = logging.getLogger(__name__)

DEFAULT_WORKFLOW_GRPC_MAX_MESSAGE_BYTES = 16 * 1024 * 1024
DEFAULT_MAX_CONCURRENT_ORCHESTRATIONS = 128
DEFAULT_MAX_CONCURRENT_ACTIVITIES = 192
DEFAULT_MAX_THREAD_POOL_WORKERS = 64


def _int_env(name: str, default: int, *, minimum: int = 1) -> int:
    try:
        return max(minimum, int(os.environ.get(name, str(default))))
    except (TypeError, ValueError):
        return max(minimum, default)


def _new_workflow_runtime() -> wf.WorkflowRuntime:
    kwargs = {
        "maximum_concurrent_orchestration_work_items": _int_env(
            "DAPR_WORKFLOW_MAX_CONCURRENT_ORCHESTRATIONS",
            DEFAULT_MAX_CONCURRENT_ORCHESTRATIONS,
        ),
        "maximum_concurrent_activity_work_items": _int_env(
            "DAPR_WORKFLOW_MAX_CONCURRENT_ACTIVITIES",
            DEFAULT_MAX_CONCURRENT_ACTIVITIES,
        ),
        "maximum_thread_pool_workers": _int_env(
            "DAPR_WORKFLOW_MAX_THREAD_POOL_WORKERS",
            DEFAULT_MAX_THREAD_POOL_WORKERS,
        ),
    }
    try:
        runtime = wf.WorkflowRuntime(**kwargs)
    except TypeError:
        runtime = wf.WorkflowRuntime()
    _configure_workflow_runtime_grpc_limits(runtime)
    return runtime


def _configure_workflow_runtime_grpc_limits(runtime: wf.WorkflowRuntime) -> None:
    max_message_bytes = _int_env(
        "DAPR_WORKFLOW_GRPC_MAX_MESSAGE_BYTES",
        DEFAULT_WORKFLOW_GRPC_MAX_MESSAGE_BYTES,
    )
    worker = getattr(runtime, "_WorkflowRuntime__worker", None)
    if worker is None:
        return
    existing_options = list(getattr(worker, "_channel_options", None) or [])
    merged_options = {
        str(key): value
        for key, value in existing_options
        if isinstance(key, str) and key
    }
    merged_options.setdefault("grpc.max_receive_message_length", max_message_bytes)
    merged_options.setdefault("grpc.max_send_message_length", max_message_bytes)
    setattr(worker, "_channel_options", list(merged_options.items()))


# Workflow runtime instance
wfr = _new_workflow_runtime()


def _durable_run_parent_timer_enabled() -> bool:
    """Whether to impose the ORCHESTRATOR's per-turn timer on a durable/run child.

    Default FALSE: the timer is redundant (timeout_minutes is also passed to
    session_workflow, which raises its OWN self-timeout and ends the turn
    gracefully) and harmful (it races that self-timeout; when the timer wins it
    fatally kills the whole multi-hour run, and its Scheduler reminder can outlive
    the child completion and leave the parent instance RUNNING — the exact reason
    the benchmark path below already omits it). We instead rely on the agent's
    graceful self-termination + cancellation, with the lifecycle reaper as the
    global backstop for a genuinely hung child. Set SW_DURABLE_RUN_PARENT_TIMER=true
    to restore the old hard parent timer.
    """
    import os as _os

    return _as_bool(_os.environ.get("SW_DURABLE_RUN_PARENT_TIMER"), False)


def _child_workflow_result_with_timeout(
    ctx: wf.DaprWorkflowContext,
    child_task: Any,
    *,
    timeout_minutes: int,
    child_instance_id: str,
    workflow_name: str,
) -> Any:
    timeout_seconds = max(1, int(timeout_minutes or 1)) * 60
    timer_task = ctx.create_timer(timedelta(seconds=timeout_seconds))
    winner = yield wf_when_any([child_task, timer_task])
    if winner is not child_task:
        raise TimeoutError(
            f"Child workflow {workflow_name}/{child_instance_id} did not finish "
            f"within {timeout_seconds}s"
        )
    get_result = getattr(child_task, "get_result", None)
    if callable(get_result):
        return get_result()
    return winner


def _child_workflow_result_without_parent_timeout(child_task: Any) -> Any:
    result = yield child_task
    get_result = getattr(child_task, "get_result", None)
    if callable(get_result):
        return get_result()
    return result


def _child_workflow_result_or_cancel_event(
    ctx: wf.DaprWorkflowContext,
    child_task: Any,
    *,
    child_instance_id: str,
    workflow_name: str,
) -> Any:
    cancel_task = ctx.wait_for_external_event("workflow.cancel")
    winner = yield wf_when_any([child_task, cancel_task])
    if winner is child_task:
        get_result = getattr(child_task, "get_result", None)
        if callable(get_result):
            return get_result()
        return winner

    get_result = getattr(cancel_task, "get_result", None)
    cancel_event = get_result() if callable(get_result) else winner
    event = cancel_event if isinstance(cancel_event, dict) else {}
    reason = event.get("reason") or "workflow cancelled"
    return {
        "success": False,
        "cancelled": True,
        "error": str(reason),
        "stopReason": {
            "type": "cancelled",
            "reason": str(reason),
            "source": event.get("source") or "workflow.cancel",
        },
        "agentWorkflowId": child_instance_id,
        "daprInstanceId": child_instance_id,
        "childWorkflowName": workflow_name,
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _is_replaying(ctx: wf.DaprWorkflowContext) -> bool:
    value = getattr(ctx, "is_replaying", False)
    if callable(value):
        try:
            return bool(value())
        except Exception:
            return False
    return bool(value)


def _is_benchmark_trigger(trigger_data: Any) -> bool:
    if not isinstance(trigger_data, dict):
        return False
    return bool(trigger_data.get("runId") and trigger_data.get("instanceId"))


def _log_info(ctx: wf.DaprWorkflowContext, msg: str, *args: Any) -> None:
    if not _is_replaying(ctx):
        logger.info(msg, *args)


def _freeze(value: Any) -> Any:
    """Ensure JSON-serializable input for activities."""
    try:
        return json.loads(json.dumps(value, default=str))
    except Exception:
        return value


def _now_ms(ctx: wf.DaprWorkflowContext) -> int | None:
    current_time = getattr(ctx, "current_utc_datetime", None)
    if current_time is None:
        return None
    try:
        return int(current_time.timestamp() * 1000)
    except Exception:
        return None


def _elapsed_ms(ctx: wf.DaprWorkflowContext, start_ms: int | None) -> int:
    if start_ms is None:
        return 0
    current = _now_ms(ctx)
    return max(0, current - start_ms) if current else 0


def _as_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if not normalized:
            return default
        if normalized in {"1", "true", "yes", "y", "on"}:
            return True
        if normalized in {"0", "false", "no", "n", "off"}:
            return False
    return default


def _should_cleanup_workspaces(tc: "TaskContext") -> bool:
    trigger_data = tc.trigger_data if isinstance(tc.trigger_data, dict) else {}
    if _is_benchmark_trigger(trigger_data):
        # SWE-bench workflows have explicit cleanup steps and host-execution
        # cleanup owns sandbox deletion. Adding a final parent cleanup activity
        # after the benchmark task graph has completed creates extra durable
        # history at the least useful point in the run.
        return False

    keep_sandbox = _as_bool(trigger_data.get("keepSandbox"), False) or _as_bool(
        trigger_data.get("keep_sandbox"), False
    )
    if keep_sandbox:
        return False

    def _output_requests_keep(output: Any) -> bool:
        if not isinstance(output, dict):
            return False
        if _as_bool(output.get("keepAfterRun"), False):
            return True
        sandbox = output.get("sandbox")
        if isinstance(sandbox, dict) and _as_bool(sandbox.get("keepAfterRun"), False):
            return True
        for key in ("data", "result", "output"):
            nested = output.get(key)
            if isinstance(nested, dict) and _output_requests_keep(nested):
                return True
        return False

    for output in tc.task_outputs.values():
        if _output_requests_keep(output):
            return False

    # Inspect the workflow spec itself for any workspace/* step that declared
    # `with.keepAfterRun=true`. openshell-agent-runtime doesn't echo this flag
    # back in its response, so checking only task_outputs misses the user's
    # explicit intent. Matching on call prefix keeps it narrow — only
    # workspace-provisioning steps can signal "keep the sandbox alive".
    try:
        for _, task_data in tc.workflow.unwrap_tasks():
            if not isinstance(task_data, dict):
                continue
            call = str(task_data.get("call") or "")
            if not call.startswith("workspace/"):
                continue
            with_block = task_data.get("with")
            if isinstance(with_block, dict) and _as_bool(with_block.get("keepAfterRun"), False):
                return False
            body = with_block.get("body") if isinstance(with_block, dict) else None
            if isinstance(body, dict):
                inp = body.get("input") if isinstance(body.get("input"), dict) else body
                if isinstance(inp, dict) and _as_bool(inp.get("keepAfterRun"), False):
                    return False
    except Exception:
        # Defensive: never let a spec-inspection failure block cleanup behaviour.
        pass

    return not keep_sandbox


def _benchmark_trace_finalization_enabled() -> bool:
    return _as_bool(
        os.environ.get("WORKFLOW_ORCHESTRATOR_BENCHMARK_TRACE_FINALIZE_ENABLED"),
        False,
    )


def _should_finalize_otel_trace_for_trigger(trigger_data: Any) -> bool:
    if _is_benchmark_trigger(trigger_data):
        # Benchmark terminal state must not depend on trace reconciliation.
        # The per-agent/session traces remain best-effort, but parent SWE-bench
        # workflows should finish as soon as their work is done.
        return _benchmark_trace_finalization_enabled()
    return True


def _parse_duration(duration: str | dict[str, Any]) -> timedelta:
    """Parse a SW 1.0 Duration into a timedelta."""
    if isinstance(duration, dict):
        return timedelta(
            days=duration.get("days", 0),
            hours=duration.get("hours", 0),
            minutes=duration.get("minutes", 0),
            seconds=duration.get("seconds", 0),
            milliseconds=duration.get("milliseconds", 0),
        )
    # ISO 8601 duration string (e.g., "PT30S", "PT5M", "PT1H")
    s = duration.upper().replace("PT", "").replace("P", "")
    total_seconds = 0
    num = ""
    for c in s:
        if c.isdigit() or c == ".":
            num += c
        elif c == "H":
            total_seconds += float(num) * 3600
            num = ""
        elif c == "M":
            total_seconds += float(num) * 60
            num = ""
        elif c == "S":
            total_seconds += float(num)
            num = ""
        elif c == "D":
            total_seconds += float(num) * 86400
            num = ""
    return timedelta(seconds=total_seconds)


def calculate_progress(completed: int, total: int) -> int:
    if total <= 0:
        return 0
    return min(100, int((completed / total) * 100))


def _trace_id_from_otel(otel_ctx: object) -> str | None:
    """Extract trace ID from OTEL context dict."""
    if not isinstance(otel_ctx, dict):
        return None
    trace_id = (
        str(otel_ctx.get("traceId") or otel_ctx.get("trace_id") or "").strip() or None
    )
    if trace_id:
        return trace_id
    traceparent = otel_ctx.get("traceparent")
    if isinstance(traceparent, str) and traceparent.count("-") >= 2:
        parts = traceparent.split("-")
        return parts[1] if len(parts) > 1 else None
    return None


def _workflow_trace_name(
    workflow_id: str | None,
    execution_id: str | None,
    db_execution_id: str | None,
) -> str:
    short_exec = (db_execution_id or execution_id or "").strip()
    normalized_workflow_id = str(workflow_id or "workflow").strip() or "workflow"
    return f"{normalized_workflow_id}/{short_exec}" if short_exec else normalized_workflow_id


def _otel_finalizer_input(
    *,
    status: str,
    trace_id: str | None,
    otel_ctx: dict[str, Any],
    workflow_id: str | None,
    workflow_name: str | None,
    execution_id: str,
    db_execution_id: str | None,
    duration_ms: int | None = None,
    start_time_ms: int | None = None,
    error: str | None = None,
) -> dict[str, Any]:
    end_time_ms = (
        start_time_ms + duration_ms
        if start_time_ms is not None and duration_ms is not None
        else None
    )
    return {
        "status": status,
        "traceId": trace_id,
        "workflowId": workflow_id,
        "workflowName": workflow_name,
        "executionId": execution_id,
        "dbExecutionId": db_execution_id,
        "daprInstanceId": execution_id,
        "durationMs": duration_ms,
        "startTimeMs": start_time_ms,
        "endTimeMs": end_time_ms,
        "error": error,
        "traceName": _workflow_trace_name(workflow_id, execution_id, db_execution_id),
        "_otel": otel_ctx,
    }


def _json_size_chars(value: Any) -> int | None:
    try:
        return len(json.dumps(value, default=str))
    except Exception:
        return None


def _string_or_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _action_type_for_task(
    task_type: TaskType,
    task_data: dict[str, Any],
    tc: "TaskContext",
) -> str:
    action_type = str(task_type.value)
    try:
        if task_type == TaskType.CALL:
            resolved = _resolve_function_call(task_data, tc.workflow)
            action_type = str(
                resolved.get("actionType")
                or resolved.get("functionName")
                or action_type
            )
        elif task_type == TaskType.RUN:
            run_config = task_data.get("run") if isinstance(task_data, dict) else None
            if isinstance(run_config, dict) and "workflow" in run_config:
                child_input = (
                    run_config.get("workflow", {}).get("input", {})
                    if isinstance(run_config.get("workflow"), dict)
                    else {}
                )
                if isinstance(child_input, dict) and child_input.get("actionType"):
                    action_type = str(child_input.get("actionType"))
    except Exception:
        pass
    return action_type


def _workflow_activity_attrs(
    *,
    tc: "TaskContext",
    task_name: str,
    task_type: TaskType,
    task_data: dict[str, Any],
    task_sequence: int,
) -> dict[str, Any]:
    display_execution_id = tc.db_execution_id or tc.execution_id
    return {
        "workflow.activity.correlation_id": (
            f"{display_execution_id}:{task_name}:{task_sequence}"
        ),
        "workflow.node.id": task_name,
        "workflow.node.name": task_name,
        "workflow.node.sequence": task_sequence,
        "workflow.node.action_type": _action_type_for_task(task_type, task_data, tc),
        "workflow.execution.id": display_execution_id,
        "workflow.id": tc.workflow_id,
        "session.id": display_execution_id,
    }


def _workflow_activity_otel_context(
    *,
    tc: "TaskContext",
    task_name: str,
    task_type: TaskType,
    task_data: dict[str, Any],
    task_sequence: int,
) -> dict[str, str]:
    return merge_workflow_activity_context(
        tc.workflow_otel_ctx,
        _workflow_activity_attrs(
            tc=tc,
            task_name=task_name,
            task_type=task_type,
            task_data=task_data,
            task_sequence=task_sequence,
        ),
    )


def _canonical_agent_context(
    *,
    flattened_args: dict[str, Any],
    agent_config: dict[str, Any] | None,
    instruction_bundle: dict[str, Any] | None,
    tc: "TaskContext",
    task_name: str,
    agent_runtime: str,
    agent_app_id: str | None,
    workspace_ref: str | None,
) -> dict[str, Any]:
    instruction_agent = (
        instruction_bundle.get("agent")
        if isinstance(instruction_bundle, dict)
        and isinstance(instruction_bundle.get("agent"), dict)
        else {}
    )
    effective_agent = (
        flattened_args.get("effectiveAgentConfig")
        if isinstance(flattened_args.get("effectiveAgentConfig"), dict)
        else {}
    )
    config = agent_config if isinstance(agent_config, dict) else {}
    sandbox_name = _string_or_none(flattened_args.get("sandboxName"))
    return {
        "workflowId": _string_or_none(tc.workflow_id),
        "workflowExecutionId": _string_or_none(tc.db_execution_id or tc.execution_id),
        "nodeId": _string_or_none(task_name),
        "nodeName": _string_or_none(flattened_args.get("nodeName")) or _string_or_none(task_name),
        "agentId": (
            _string_or_none(flattened_args.get("agentId"))
            or _string_or_none(instruction_agent.get("id"))
            or _string_or_none(effective_agent.get("id"))
            or _string_or_none(config.get("id"))
        ),
        "agentVersion": (
            flattened_args.get("agentVersion")
            if flattened_args.get("agentVersion") is not None
            else instruction_agent.get("version")
            if instruction_agent.get("version") is not None
            else effective_agent.get("version")
            if effective_agent.get("version") is not None
            else config.get("version")
        ),
        "agentSlug": (
            _string_or_none(flattened_args.get("agentSlug"))
            or _string_or_none(instruction_agent.get("slug"))
            or _string_or_none(effective_agent.get("slug"))
            or _string_or_none(config.get("slug"))
        ),
        "agentAppId": (
            _string_or_none(agent_app_id)
            or _string_or_none(flattened_args.get("agentAppId"))
            or _string_or_none(config.get("agentAppId"))
        ),
        "agentRuntime": _string_or_none(agent_runtime),
        "sandboxName": sandbox_name,
        "workspaceRef": _string_or_none(workspace_ref),
    }


def _finalize_otel_trace(ctx: wf.DaprWorkflowContext, payload: dict[str, Any]):
    try:
        yield ctx.call_activity(
            finalize_otel_trace_root,
            input=_freeze(payload),
        )
    except Exception as exc:  # noqa: BLE001
        _log_info(
            ctx,
            "[SW Workflow] OTel trace finalization failed (non-fatal): %s",
            exc,
        )


def _unwrap_standardized_output(value: Any) -> Any:
    if (
        isinstance(value, dict)
        and isinstance(value.get("success"), bool)
        and "data" in value
    ):
        return value.get("data")
    return value


def _loose_extract_json(text: str) -> dict[str, Any] | None:
    """Tolerant JSON object extraction from LLM/agent text. Mirrors the
    extractJson shape in src/lib/server/goals/plan-goal.ts: try the raw string,
    then a ```json fenced block, then the first {...} match. Returns the parsed
    dict or None. Used by the `parseJson` node affordance so an agent that ends
    its turn with a STRICT JSON verdict surfaces as real fields (e.g. a critic's
    {meets_criteria, score, feedback})."""
    if not isinstance(text, str) or not text.strip():
        return None
    candidates: list[str] = [text.strip()]
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fenced and fenced.group(1).strip():
        candidates.append(fenced.group(1).strip())
    braces = re.search(r"\{[\s\S]*\}", text)
    if braces:
        candidates.append(braces.group(0).strip())
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except (ValueError, TypeError):
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def _coerce_parse_json(value: Any) -> dict[str, Any] | None:
    """Extract a JSON object from a node's unwrapped output. The text is the
    value itself (string) or its `content` field (agent durable/run output)."""
    if isinstance(value, str):
        return _loose_extract_json(value)
    if isinstance(value, dict):
        content = value.get("content")
        if isinstance(content, str):
            return _loose_extract_json(content)
    return None


def _apply_parse_json_affordance(tc: "TaskContext", task_name: str) -> None:
    """Merge an agent/text node's JSON-string output into its stored output so
    downstream refs (e.g. ${ .evaluate.meets_criteria }) resolve to real fields.
    Triggered by `parseJson: true` on the task. Best-effort: if no JSON object is
    found the stored output is left untouched (the raw content stays available)."""
    stored = tc.task_outputs.get(task_name)
    if not isinstance(stored, dict) or "data" not in stored:
        return
    data = stored["data"]
    # Standardized envelope {success, data}: merge into the inner data.
    if isinstance(data, dict) and isinstance(data.get("success"), bool) and "data" in data:
        inner = data["data"]
        parsed = _coerce_parse_json(inner)
        if parsed is not None:
            data["data"] = {**inner, **parsed} if isinstance(inner, dict) else parsed
        return
    # Already-unwrapped output: merge into it directly.
    parsed = _coerce_parse_json(data)
    if parsed is not None:
        stored["data"] = {**data, **parsed} if isinstance(data, dict) else parsed


def _build_expression_context(
    tc: "TaskContext",
    *,
    task_input: Any = None,
    has_task_input: bool = False,
    task_output: Any = None,
    has_task_output: bool = False,
) -> dict[str, Any]:
    context: dict[str, Any] = {
        "input": tc.trigger_data,
        "state": tc.state_vars,
        "workflow": tc.workflow.model_dump(mode="json"),
        "runtime": {
            "executionId": tc.execution_id,
            "dbExecutionId": tc.db_execution_id,
            "workflowId": tc.workflow_id,
            # Stable across resume — use this (not executionId) for workspaceRef so a
            # resumed node re-mounts the original run's shared /sandbox/work.
            "workspaceExecutionId": getattr(tc, "workspace_execution_id", None)
            or tc.execution_id,
        },
    }
    context.update(tc.state_vars)
    for key, output in tc.task_outputs.items():
        if key == "__trigger__":
            continue
        if isinstance(output, dict):
            normalized_output = _unwrap_standardized_output(output.get("data", output))
            if isinstance(normalized_output, dict) and "result" not in normalized_output:
                context[key] = {
                    **normalized_output,
                    "result": normalized_output,
                }
            else:
                context[key] = normalized_output
    if has_task_input:
        context["input"] = task_input
        context["taskInput"] = task_input
    if has_task_output:
        unwrapped_output = _unwrap_standardized_output(task_output)
        context["task"] = unwrapped_output
        context["output"] = unwrapped_output
    return context


def _resolve_task_input(task_data: dict[str, Any], tc: "TaskContext") -> Any:
    base_context = _build_expression_context(tc)
    return resolve_input_definition(
        task_data.get("input"),
        base_context,
        default_input=base_context.get("input"),
    )


def _apply_task_output_definition(
    task_data: dict[str, Any],
    tc: "TaskContext",
    *,
    task_input: Any,
    raw_output: Any,
) -> Any:
    context = _build_expression_context(
        tc,
        task_input=task_input,
        has_task_input=True,
        task_output=raw_output,
        has_task_output=True,
    )
    return resolve_output_definition(
        task_data.get("output"),
        context,
        default_output=raw_output,
    )


def _action_type_from_endpoint(uri: str | None) -> str | None:
    if not uri:
        return None
    marker = "/v1.0/invoke/"
    marker_index = uri.find(marker)
    if marker_index == -1:
        return None
    method_marker = "/method/"
    method_index = uri.find(method_marker, marker_index + len(marker))
    if method_index == -1:
        return None
    method = uri[method_index + len(method_marker) :].strip("/")
    return method or None


def _store_task_output(
    tc: "TaskContext",
    task_name: str,
    action_type: str,
    result: Any,
    *,
    label: str | None = None,
) -> None:
    """Store task output in the legacy NodeOutputs-compatible envelope."""
    tc.task_outputs[task_name] = {
        "label": label or task_name,
        "actionType": action_type,
        "data": result,
    }


def _call_task_uses_direct_node_logging(
    task_data: dict[str, Any],
    workflow: Workflow,
) -> bool:
    _ = workflow
    # Most call-task execution paths already persist their own node logs (function-router
    # single-shot AP/system actions; tracked agent child workflows), so the orchestrator
    # skips direct logging to avoid duplicate rows.
    #
    # EXCEPTION: workspace/* nodes (clone_repo, publish_*, pr, …) route to
    # openshell-agent-runtime, which does NOT write a workflow_execution_logs row. Without
    # direct logging they're invisible in the run console / timeline / progress — a
    # non-agent run (or a non-agent-suffix FORK like publish_contract→pr→summary) shows no
    # steps at all. Log these directly so every node is represented.
    call = str(task_data.get("call") or "")
    if call.startswith("workspace/"):
        return True
    return False


def _run_task_uses_direct_node_logging(task_data: dict[str, Any]) -> bool:
    run_config = task_data.get("run", {})
    if not isinstance(run_config, dict):
        return True

    if "workflow" in run_config:
        wf_config = run_config.get("workflow", {})
        child_input = (
            wf_config.get("input", {}) if isinstance(wf_config, dict) else {}
        )
        agent_action_type = (
            child_input.get("actionType", "")
            if isinstance(child_input, dict)
            else ""
        )
        # Agent child workflow paths persist their own node logs.
        return agent_action_type not in _AGENT_ACTION_TYPES

    # Shell/script/container runs go through function-router, which already logs them.
    return False


def _should_log_task_directly(
    task_type: TaskType,
    task_data: dict[str, Any],
    workflow: Workflow,
) -> bool:
    if task_type == TaskType.CALL:
        return _call_task_uses_direct_node_logging(task_data, workflow)
    if task_type == TaskType.RUN:
        return _run_task_uses_direct_node_logging(task_data)
    return True


# ---------------------------------------------------------------------------
# Task execution context
# ---------------------------------------------------------------------------

class TaskContext:
    """Mutable state carried through task execution."""

    def __init__(
        self,
        workflow: Workflow,
        workflow_id: str | None,
        trigger_data: dict[str, Any],
        execution_id: str,
        db_execution_id: str | None,
        integrations: dict[str, dict[str, str]] | None,
    ):
        self.workflow = workflow
        self.workflow_id = str(workflow_id or workflow.document.name)
        self.trigger_data = trigger_data
        self.execution_id = execution_id
        self.db_execution_id = db_execution_id
        self.integrations = integrations
        # Stable per-workspace key, surfaced as runtime.workspaceExecutionId. On a
        # normal run it equals execution_id; on a RESUME (rerun-from-node) the caller
        # threads the SOURCE run's id so the resumed node re-mounts the SAME shared
        # /sandbox/work (executionId changes each instance and would point at an empty
        # workspace otherwise). Resumable fixtures use ${ .runtime.workspaceExecutionId }.
        self.workspace_execution_id = execution_id
        # Hermetic fork: when set (the source run's workspace key), the per-session
        # sandbox seeds this fork's fresh workspace from that subPath on first mount.
        self.seed_workspace_from: str | None = None
        # Resumable workflows retain their workspace + Dapr history on failure so the
        # run can be resumed from the failed node (set from x-workflow-builder.resumable).
        self.resumable = False

        # OTEL context
        self.otel_ctx: dict[str, str] = {}
        self.workflow_otel_ctx: dict[str, str] = {}
        self.trace_id: str | None = None

        # Runtime state - NodeOutputs format for resolve_templates compatibility
        # Each entry: {label: str, actionType: str, data: Any}
        self.task_outputs: dict[str, Any] = {
            "trigger": {
                "label": "Trigger",
                "actionType": "",
                "data": trigger_data,
            },
            "state": {
                "label": "State",
                "actionType": "state",
                "data": {"success": True, "data": {}},
            },
        }
        self.state_vars: dict[str, Any] = {}
        self.completed_tasks: set[str] = set()
        self.task_execution_counts: dict[str, int] = {}


# ---------------------------------------------------------------------------
# Task dispatchers
# ---------------------------------------------------------------------------

def _resolve_function_call(
    task_data: dict[str, Any],
    workflow: Workflow,
) -> dict[str, Any]:
    """
    Resolve a call task to an HTTP invocation.
    If the call references a function from use.functions, merge the definition.
    """
    call_value = task_data.get("call", "")
    with_args = task_data.get("with", {})

    # Built-in protocols
    if call_value in ("http", "grpc", "openapi", "asyncapi"):
        return {
            "protocol": call_value,
            "args": with_args,
        }

    # User-defined function from use.functions
    if workflow.use and workflow.use.functions:
        func_def = workflow.use.functions.get(call_value)
        if func_def:
            # Merge function definition with task-level overrides
            merged_args = {}
            if func_def.with_:
                merged_args.update(func_def.with_)
            if with_args:
                merged_args.update(with_args)
            endpoint_uri = None
            endpoint = merged_args.get("endpoint")
            if isinstance(endpoint, dict):
                endpoint_uri = endpoint.get("uri")
            return {
                "protocol": func_def.call,
                "args": merged_args,
                "functionName": call_value,
                "actionType": _action_type_from_endpoint(str(endpoint_uri)) if endpoint_uri else None,
            }

    # AP piece function: auto-resolve ap_{piece}_{action} naming convention
    # Requires metadata.pieceName/actionName in the with args for correct routing,
    # since underscores in the ap_ name are ambiguous (piece names can contain hyphens).
    if call_value.startswith("ap_"):
        metadata = with_args.get("metadata") or with_args.get("body", {}).get("metadata", {})
        piece_name = metadata.get("pieceName", "")
        action_name = metadata.get("actionName", "")
        if piece_name and action_name:
            action_type = f"{piece_name}/{action_name}"
        else:
            # Fallback: best-effort conversion (may be wrong for multi-word piece names)
            suffix = call_value[3:]
            action_type = suffix.replace("_", "-")
        return {
            "protocol": "http",
            "actionType": action_type,
            "args": with_args,
            "functionName": call_value,
        }

    # AP piece function: piece/action slash format (e.g., "gmail/send_email")
    # Used by the AI workflow builder and spec-first architecture.
    # Extracts piece name and action name from the call value,
    # and flattens body.input into top-level input for the AP piece-runtime.
    if "/" in call_value and not call_value.startswith("http"):
        parts = call_value.split("/", 1)
        piece_name = parts[0]
        action_name = parts[1] if len(parts) > 1 else ""
        action_type = call_value

        # Flatten: move body.input to top-level input for the AP piece-runtime
        resolved_args = dict(with_args)
        body = resolved_args.get("body", {})
        if isinstance(body, dict):
            body_input = body.get("input", {})
            body_metadata = body.get("metadata", {})
            if body_input and isinstance(body_input, dict):
                resolved_args["input"] = body_input
            if body_metadata and isinstance(body_metadata, dict):
                resolved_args.setdefault("metadata", body_metadata)

        # Ensure metadata has pieceName/actionName
        metadata = resolved_args.get("metadata", {})
        if isinstance(metadata, dict):
            metadata.setdefault("pieceName", piece_name)
            metadata.setdefault("actionName", action_name)
            resolved_args["metadata"] = metadata

        return {
            "protocol": "http",
            "actionType": action_type,
            "args": resolved_args,
            "functionName": call_value,
        }

    # Fallback: treat as custom function name
    return {
        "protocol": "function",
        "functionName": call_value,
        "args": with_args,
    }


# Agent action types dispatched via native Dapr child workflows
# (ctx.call_child_workflow -> dapr-agent-py @workflow_entry). The agent owns the
# multi-turn loop; orchestrator relies on native retry policy configured on the
# callee in dapr-agent-py/src/main.py.
_AGENT_ACTION_TYPES: set[str] = {"durable/run"}
_NATIVE_DURABLE_AGENT_ACTION_TYPES = {"durable/run"}
_DURABLE_CRAWL4AI_ACTION_TYPES = {"web/crawl.async"}
_ENVIRONMENT_ACTION_TYPES = {"environment/ensure"}
_REMOVED_AGENT_ACTION_TYPES = {
    "claude/run",
    "openshell/run",
    "openshell/session-start",
    "openshell-langgraph/run",
    "openshell-langgraph-observable/run",
    "dapr-agent-py/run",
    "dapr-swe/run",
    "durable/plan",
}

# Slug prefixes with explicit (non-AP) function-registry routes. Anything else
# of the form "<piece>/<action>" is an Activepieces piece action dispatched to
# the per-piece piece-runtime (ap-<piece>-service) and gets the AP durability
# contract: RetryPolicy + idempotency key + pause mapping.
_NON_AP_SLUG_PREFIXES: set[str] = {
    "system",
    "code",
    "_code",
    "browser",
    "openshell",
    "workspace",
    "web",
    "durable",
    "environment",
    "workflow-orchestrator",
    # goal/plan — deterministic goal-authoring activity; function-router proxies
    # it to the BFF planGoal endpoint (NOT an AP piece; no AP durability contract).
    "goal",
    # dev/preview (+ dev/preview-teardown) — per-run ephemeral dev-server Sandbox;
    # function-router proxies to the BFF dev-preview endpoint (NOT an AP piece).
    "dev",
    # session/spawn — workflow → interactive dev-session handoff; function-router
    # proxies to the BFF interactive-session endpoint (NOT an AP piece).
    "session",
}

# Retry policy for AP piece activities (docs/activepieces-integration-architecture.md
# §2.4). The piece-runtime classifies failures; execute_action raises
# RetryableActivityError ONLY for retryable ones, so permanent failures fail
# deterministically without burning attempts.
_AP_RETRY_POLICY = wf.RetryPolicy(
    first_retry_interval=timedelta(
        seconds=int(os.environ.get("AP_RETRY_FIRST_INTERVAL_SECONDS", "2"))
    ),
    max_number_of_attempts=int(os.environ.get("AP_RETRY_MAX_ATTEMPTS", "5")),
    backoff_coefficient=float(os.environ.get("AP_RETRY_BACKOFF_COEFFICIENT", "2")),
    max_retry_interval=timedelta(
        seconds=int(os.environ.get("AP_RETRY_MAX_INTERVAL_SECONDS", "60"))
    ),
)

# Defensive bound on repeated piece pauses (delay → run → delay → ...).
_AP_MAX_PAUSE_ROUNDS = int(os.environ.get("AP_MAX_PAUSE_ROUNDS", "5"))


def _is_ap_piece_action(action_type: str) -> bool:
    """True for AP piece slugs ("<piece>/<action>" with a non-reserved prefix)."""
    if not isinstance(action_type, str) or "/" not in action_type:
        return False
    prefix = action_type.split("/", 1)[0]
    return prefix not in _NON_AP_SLUG_PREFIXES

def _resolve_native_agent_runtime(
    flattened_args: dict[str, Any],
    agent_config: dict[str, Any] | None,
) -> tuple[str, dict[str, str]]:
    """Resolve the durable/run dispatch target (runtime name + target dict).

    Thin shim over the declarative runtime registry (``core.runtime_registry``),
    the single source of truth for runtime identity + capabilities. The
    registry's ``resolve()`` reproduces the historical precedence EXACTLY:
    ``agentAppId`` (a per-agent ``agent-runtime-<slug>`` / pool pod) >
    legacy ``agentRuntime``/``runtime`` enum (default ``dapr-agent-py``) >
    ``agentSlug``-derived ``agent-runtime-<slug>`` > hard-fail.

    Returns the legacy-compatible ``(name, target)`` tuple. ``target`` keeps the
    historical ``workflow_name`` (== the bridge gate token ``agent_workflow``),
    ``app_id`` and ``instance_prefix`` keys, plus additive
    ``dispatch_workflow_name`` (``session_workflow``) + ``bridge_gate_token`` so
    the dispatch site no longer hard-codes the two workflow-name literals.
    """
    from core import runtime_registry

    name, descriptor = runtime_registry.resolve(flattened_args, agent_config)
    if descriptor.capabilities.get("workflowDispatch") != "auto-turn":
        raise RuntimeError(
            f"durable/run cannot dispatch runtime '{name}' "
            f"(family {descriptor.family}, workflowDispatch="
            f"{descriptor.capabilities.get('workflowDispatch')!r})."
        )
    return name, descriptor.to_target_dict()


def _parse_optional_int(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return int(text)
        except ValueError:
            return None
    return None


_HISTORY_PROPAGATION_LABELS = {
    "none": "none",
    "ownhistory": "ownHistory",
    "lineage": "lineage",
}
_HISTORY_PROPAGATION_SCOPE_NAMES = {
    "ownHistory": "OWN_HISTORY",
    "lineage": "LINEAGE",
}


def _history_propagation_setting(flattened_args: dict[str, Any]) -> Any:
    if "historyPropagation" in flattened_args:
        return flattened_args.get("historyPropagation")
    if "history_propagation" in flattened_args:
        return flattened_args.get("history_propagation")
    return None


def _normalize_history_propagation(value: Any, task_name: str) -> str:
    if value is None:
        return "none"
    if isinstance(value, str):
        compact = re.sub(r"[\s_-]+", "", value.strip()).lower()
        if not compact:
            return "none"
        label = _HISTORY_PROPAGATION_LABELS.get(compact)
        if label is not None:
            return label
    raise RuntimeError(
        "durable/run historyPropagation for task "
        f"'{task_name}' must be one of: none, ownHistory, lineage."
    )


def _dapr_history_propagation_scope(
    flattened_args: dict[str, Any], task_name: str
) -> tuple[str, Any | None]:
    label = _normalize_history_propagation(
        _history_propagation_setting(flattened_args), task_name
    )
    if label == "none":
        return label, None

    propagation_enum = getattr(wf, "PropagationScope", None)
    scope = getattr(
        propagation_enum,
        _HISTORY_PROPAGATION_SCOPE_NAMES[label],
        None,
    )
    if scope is None:
        raise RuntimeError(
            "durable/run historyPropagation requires dapr-ext-workflow 1.18+ "
            f"for task '{task_name}'."
        )
    return label, scope


def _call_child_workflow_with_history_propagation(
    ctx: wf.DaprWorkflowContext,
    workflow_name: str,
    *,
    input: Any,
    instance_id: str | None = None,
    app_id: str | None = None,
    propagation: Any | None = None,
) -> Any:
    kwargs: dict[str, Any] = {"input": input}
    if instance_id is not None:
        kwargs["instance_id"] = instance_id
    if app_id is not None:
        kwargs["app_id"] = app_id
    if propagation is not None:
        kwargs["propagation"] = propagation
    return ctx.call_child_workflow(workflow_name, **kwargs)


def _tool_set(value: Any) -> set[str]:
    if not isinstance(value, list):
        return set()
    return {str(item).strip() for item in value if str(item).strip()}


def _skill_key(item: dict[str, Any]) -> str:
    return str(item.get("name") or "").strip().lower()


def _skill_when_to_use(item: dict[str, Any]) -> str:
    return str(item.get("whenToUse") or item.get("when_to_use") or "").strip()


def _skill_argument_hint(item: dict[str, Any]) -> str:
    return str(item.get("argumentHint") or item.get("argument_hint") or "").strip()


def _skill_bool(
    item: dict[str, Any],
    camel_key: str,
    snake_key: str,
    default: bool,
) -> bool:
    value = item.get(camel_key, item.get(snake_key, default))
    return bool(value)


def _canonical_skill(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": _skill_key(item),
        "description": str(item.get("description") or "").strip(),
        "whenToUse": _skill_when_to_use(item),
        "allowedTools": sorted(
            _tool_set(item.get("allowedTools") or item.get("allowed_tools"))
        ),
        "registryId": str(item.get("registryId") or "").strip(),
        "slug": str(item.get("slug") or "").strip(),
        "sourceType": str(item.get("sourceType") or "").strip(),
        "installSource": str(item.get("installSource") or item.get("sourceRepo") or "").strip(),
        "skillName": str(item.get("skillName") or item.get("name") or "").strip(),
        "registryUrl": str(item.get("registryUrl") or "").strip(),
        "installAgent": str(item.get("installAgent") or "universal").strip(),
        "version": str(item.get("version") or "").strip(),
    }


def _validate_agent_skill_profile_policy(agent_config: Any) -> None:
    if not isinstance(agent_config, dict) or not agent_config.get("profileRef"):
        return
    profile_snapshot = (
        agent_config.get("profileSnapshot")
        if isinstance(agent_config.get("profileSnapshot"), dict)
        else {}
    )
    profile_policy = (
        agent_config.get("runtimeOverridePolicy")
        if isinstance(agent_config.get("runtimeOverridePolicy"), dict)
        else profile_snapshot.get("runtimeOverridePolicy")
        if isinstance(profile_snapshot.get("runtimeOverridePolicy"), dict)
        else {}
    )
    skill_list = [
        item
        for item in (
            agent_config.get("skills")
            if isinstance(agent_config.get("skills"), list)
            else []
        )
        if isinstance(item, dict)
    ]
    profile_skills = [
        item
        for item in (
            profile_snapshot.get("skills")
            if isinstance(profile_snapshot.get("skills"), list)
            else []
        )
        if isinstance(item, dict)
    ]
    profile_skills_by_key = {
        _skill_key(item): item for item in profile_skills if _skill_key(item)
    }
    for item in skill_list:
        key = _skill_key(item)
        profile_skill = profile_skills_by_key.get(key)
        if profile_skill is None:
            if profile_policy.get("allowSkillAdditions") is True:
                continue
            raise RuntimeError(
                f"Skill '{key or 'unknown'}' is not allowed by the selected agent profile."
            )
        if (
            profile_policy.get("allowSkillNarrowing") is False
            and _canonical_skill(item) != _canonical_skill(profile_skill)
        ):
            raise RuntimeError(
                f"Skill '{key}' cannot be modified by this selected agent profile."
            )
        requested_tools = _tool_set(item.get("allowedTools") or item.get("allowed_tools"))
        profile_tools = _tool_set(
            profile_skill.get("allowedTools") or profile_skill.get("allowed_tools")
        )
        if requested_tools and profile_tools and not requested_tools.issubset(profile_tools):
            raise RuntimeError(
                f"Skill '{key}' requested tools outside the selected agent profile."
            )


def _stop_condition_implies_file_changes(stop_condition: str) -> bool:
    normalized = stop_condition.lower()
    requires_change_terms = [
        "file changes",
        "files are updated",
        "code changes",
        "files updated",
        "changes are complete",
        "edited files",
        "modified files",
        "apply changes",
        "write files",
        "edit files",
    ]
    return any(term in normalized for term in requires_change_terms)


def _build_agent_graph_prompt_context(agent_graph: Any) -> str:
    if not isinstance(agent_graph, dict):
        return ""
    nodes = agent_graph.get("nodes")
    if not isinstance(nodes, list) or not nodes:
        return ""
    steps: list[str] = []
    for index, node in enumerate(nodes[:12]):
        if not isinstance(node, dict):
            steps.append(f"- Step {index + 1}")
            continue
        data = node.get("data") if isinstance(node.get("data"), dict) else {}
        step_type = "step"
        if isinstance(data.get("stepType"), str) and data.get("stepType").strip():
            step_type = data.get("stepType").strip()
        elif isinstance(data.get("kind"), str) and data.get("kind").strip():
            step_type = data.get("kind").strip()
        label = (
            data.get("label").strip()
            if isinstance(data.get("label"), str) and data.get("label").strip()
            else f"Step {index + 1}"
        )
        steps.append(f"- {label} [{step_type}]")
    edge_count = (
        len(agent_graph.get("edges"))
        if isinstance(agent_graph.get("edges"), list)
        else 0
    )
    version = (
        agent_graph.get("version").strip()
        if isinstance(agent_graph.get("version"), str)
        and agent_graph.get("version").strip()
        else "v1"
    )
    return (
        "## Durable Agent Graph\n"
        "Use this graph as the durable control loop for planning, tools, memory, approvals, and completion.\n"
        f"Graph version: {version}\n"
        f"Graph topology: {len(nodes)} steps, {edge_count} edges\n"
        + "\n".join(steps)
        + "\n\n"
    )


def _build_native_run_prompt(
    base_prompt: str,
    stop_condition: str | None,
    require_file_changes: bool,
    cwd: str | None = None,
    agent_graph: Any = None,
    agent_runtime: str | None = None,
) -> str:
    normalized_cwd = cwd.strip() if isinstance(cwd, str) and cwd.strip() else None
    normalized_agent_runtime = (
        agent_runtime.strip()
        if isinstance(agent_runtime, str) and agent_runtime.strip()
        else None
    )
    normalized_stop_condition = (
        stop_condition.strip()
        if isinstance(stop_condition, str) and stop_condition.strip()
        else None
    )
    graph_context = _build_agent_graph_prompt_context(agent_graph)
    if normalized_cwd and normalized_agent_runtime == "agy-cli":
        cwd_context = (
            f"Repository root: {normalized_cwd}\n"
            "Antigravity file and directory tools require absolute paths. "
            f"Use absolute paths under {normalized_cwd} for every file or directory tool call; "
            "do not pass '.' or other relative paths to file tools.\n\n"
        )
    elif normalized_cwd:
        cwd_context = (
            f"Repository root: {normalized_cwd}\n"
            "Always operate relative to this repository root for file and directory paths.\n\n"
        )
    else:
        cwd_context = ""
    if not normalized_stop_condition:
        return f"{cwd_context}{graph_context}{base_prompt}"

    file_change_guard = (
        "\n\nCRITICAL: You must make real file mutations (write/edit/delete/mkdir) "
        "before finalizing. Do not stop at analysis or directory listing."
        if require_file_changes
        else ""
    )
    return (
        f"{cwd_context}{graph_context}{base_prompt}\n\n"
        "## Stop Condition\n"
        f"{normalized_stop_condition}\n\n"
        "Execute autonomously until the stop condition is satisfied. "
        f"Do not ask for confirmation before proceeding.{file_change_guard}"
    )


def _prompt_runtime_label(
    agent_runtime: str | None,
    agent_config: dict[str, Any] | None,
) -> str | None:
    config_record = agent_config if isinstance(agent_config, dict) else {}
    for value in (
        config_record.get("runtime"),
        config_record.get("agentRuntime"),
        config_record.get("cliAdapter"),
        config_record.get("slug"),
        config_record.get("id"),
        agent_runtime,
    ):
        if not isinstance(value, str):
            continue
        normalized = value.strip().lower()
        if normalized in {"agy-cli", "antigravity"}:
            return "agy-cli"
        if normalized:
            return normalized
    return None


def _is_antigravity_runtime(
    agent_runtime: str | None,
    agent_config: dict[str, Any] | None,
) -> bool:
    return _prompt_runtime_label(agent_runtime, agent_config) == "agy-cli"


def _should_include_project_mcp_connections(
    mcp_connection_mode: str,
    agent_runtime: str | None,
    agent_config: dict[str, Any] | None,
) -> bool:
    mode = str(mcp_connection_mode or "").strip().lower()
    if mode in {"project", "all"}:
        return True
    if mode == "auto" and not _is_antigravity_runtime(agent_runtime, agent_config):
        return True
    return False


def _next_task_execution_count(tc: "TaskContext", task_name: str) -> int:
    current = tc.task_execution_counts.get(task_name, 0)
    tc.task_execution_counts[task_name] = current + 1
    return current


def _workflow_ephemeral_slug(workflow_id: str, node_id: str) -> str:
    short_wf = str(workflow_id or "").strip().lower()[:12]
    short_node = re.sub(r"[^a-z0-9-]", "-", str(node_id or "").strip().lower())
    short_node = re.sub(r"-+", "-", short_node)[:24]
    return f"wf-{short_wf}-{short_node}"


def _run_native_durable_agent_child_workflow(
    ctx: wf.DaprWorkflowContext,
    task_name: str,
    action_type: str,
    resolved_args: dict[str, Any],
    tc: "TaskContext",
):
    flattened_args = dict(resolved_args or {})
    body_args = flattened_args.get("body")
    if isinstance(body_args, dict):
        flattened_args = {
            **body_args,
            **{k: v for k, v in flattened_args.items() if k != "body"},
        }
    history_propagation_label, history_propagation_scope = (
        _dapr_history_propagation_scope(flattened_args, task_name)
    )

    prompt = ""
    for key in ("prompt", "task"):
        value = flattened_args.get(key)
        if isinstance(value, str) and value.strip():
            prompt = value.strip()
            break
    if not prompt:
        raise RuntimeError(f"Agent action missing prompt/task: {task_name}")

    agent_config = (
        flattened_args.get("agentConfig")
        if isinstance(flattened_args.get("agentConfig"), dict)
        else None
    )
    # Billing-safety fail-closed. A durable/run node carrying an ``agentRef`` is a
    # NAMED-agent node; the BFF's ``resolveSpecAgentRefs`` resolves it and stamps
    # ``agentSlug``/``agentAppId``/``agentRuntime`` into the ``with`` block BEFORE
    # dispatch. If we see an agentRef but NONE of those stamps, the resolver was
    # bypassed (e.g. a raw spec POSTed straight to ``/api/v2/sw-workflows``), and
    # ``_resolve_native_agent_runtime`` would SILENTLY fall back to the default
    # runtime (``dapr-agent-py``), which authenticates the LLM via
    # ``ANTHROPIC_API_KEY``. For an interactive-cli agent (claude-code-cli/codex/agy)
    # that flips subscription → metered-API billing — exactly the invariant we must
    # never violate. Refuse rather than fall back.
    agent_ref = flattened_args.get("agentRef")
    if agent_ref and not any(
        _string_or_none(flattened_args.get(key))
        for key in ("agentSlug", "agentAppId", "agentRuntime", "runtime")
    ):
        raise RuntimeError(
            f"durable/run task '{task_name}' has an UNRESOLVED agentRef "
            f"({agent_ref!r}): agentSlug/agentAppId/agentRuntime were not stamped. "
            "Named-agent nodes MUST be resolved by the BFF (resolveSpecAgentRefs) "
            "before dispatch — refusing to fall back to the default runtime, which "
            "would authenticate via ANTHROPIC_API_KEY (metered) instead of the "
            "agent's linked credential. Execute via POST /api/workflows/{id}/execute, "
            "not the orchestrator's /api/v2/sw-workflows endpoint directly."
        )
    agent_runtime, target = _resolve_native_agent_runtime(flattened_args, agent_config)
    if (
        agent_runtime == "browser-use-agent"
        and target.get("app_id") == config.BROWSER_USE_AGENT_APP_ID
    ):
        derived_slug = _workflow_ephemeral_slug(tc.workflow_id, task_name)
        target = {
            **target,
            "app_id": f"agent-runtime-{derived_slug}",
        }
    child_execution_index = _next_task_execution_count(tc, task_name)
    # Sanitize task_name for the child workflow instance id: a durable/run task
    # nested in a `for` loop is named "<loop>/<sub>[<idx>]" (e.g. "refine/generate[0]"),
    # and the resulting Dapr workflow instance id becomes an actor id — `/` and `[]`
    # are not routable there, so the child is created but never executes (the parent
    # waits forever / the session stays "rescheduling"). Replace any non
    # [A-Za-z0-9_.-] char with `-` so loop-nested agents dispatch. The sanitized id
    # is used consistently as the session id + dispatch target below.
    safe_task_name = re.sub(r"[^A-Za-z0-9_.-]", "-", task_name)
    child_instance_id = (
        f"{ctx.instance_id}__{target['instance_prefix']}__{safe_task_name}__run__{child_execution_index}"
    )

    timeout_minutes = max(
        1,
        _parse_optional_int(flattened_args.get("timeoutMinutes")) or 30,
    )
    max_iterations = _parse_optional_int(flattened_args.get("maxTurns"))
    stop_condition = (
        flattened_args.get("stopCondition").strip()
        if isinstance(flattened_args.get("stopCondition"), str)
        and flattened_args.get("stopCondition").strip()
        else ""
    )
    explicit_require_file_changes = None
    if "requireFileChanges" in flattened_args:
        explicit_require_file_changes = _as_bool(
            flattened_args.get("requireFileChanges"),
            default=False,
        )
    require_file_changes = (
        explicit_require_file_changes
        if explicit_require_file_changes is not None
        else bool(stop_condition)
        and _stop_condition_implies_file_changes(stop_condition)
    )
    cwd = (
        flattened_args.get("cwd").strip()
        if isinstance(flattened_args.get("cwd"), str)
        and flattened_args.get("cwd").strip()
        else None
    )
    # Optional goal-driven mode: a goalSpec block ({objective, tokenBudget?,
    # maxIterations?}) on the durable/run task makes the bridged session run
    # multi-turn toward the objective until session.goal_completed (the BFF
    # bridge sets up the goal + flips off auto-terminate). Forwarded as-is.
    # NOTE: the spec key is `goalSpec`, NOT `goal` — the BFF spec-resolver
    # strips `goal` (it's an agent-persona override field).
    _goal_raw = flattened_args.get("goalSpec")
    goal_spec = (
        _goal_raw
        if isinstance(_goal_raw, dict)
        and isinstance(_goal_raw.get("objective"), str)
        and _goal_raw.get("objective").strip()
        else None
    )
    agent_graph = flattened_args.get("agentGraph")
    loop_config = agent_config.get("loop") if isinstance(agent_config, dict) else None
    loop_strategy_name = (
        flattened_args.get("loopStrategyName").strip()
        if isinstance(flattened_args.get("loopStrategyName"), str)
        and flattened_args.get("loopStrategyName").strip()
        else loop_config.get("strategy").strip()
        if isinstance(loop_config, dict)
        and isinstance(loop_config.get("strategy"), str)
        and loop_config.get("strategy").strip()
        else None
    )
    run_prompt = _build_native_run_prompt(
        prompt,
        stop_condition or None,
        require_file_changes,
        cwd,
        agent_graph,
        _prompt_runtime_label(agent_runtime, agent_config),
    )
    workspace_ref = (
        flattened_args.get("workspaceRef").strip()
        if isinstance(flattened_args.get("workspaceRef"), str)
        and flattened_args.get("workspaceRef").strip()
        else None
    )
    if not workspace_ref and agent_runtime in {
        "dapr-agent-py",
        "dapr-agent-py-testing",
        "browser-use-agent",
    }:
        workspace_ref = "local"
    if not workspace_ref:
        raise RuntimeError(
            "SW 1.0 durable/run tasks require an explicit workspaceRef. "
            "Provision a workspace/profile step in the parent workflow and pass "
            "with.workspaceRef into the durable/run task."
        )

    existing_config = agent_config if isinstance(agent_config, dict) else {}
    existing_mcp_servers = existing_config.get("mcpServers")
    existing_mcp_server_list = [
        item
        for item in (
            existing_mcp_servers if isinstance(existing_mcp_servers, list) else []
        )
        if isinstance(item, dict)
    ]
    profile_snapshot = (
        existing_config.get("profileSnapshot")
        if isinstance(existing_config.get("profileSnapshot"), dict)
        else {}
    )
    profile_policy = (
        existing_config.get("runtimeOverridePolicy")
        if isinstance(existing_config.get("runtimeOverridePolicy"), dict)
        else profile_snapshot.get("runtimeOverridePolicy")
        if isinstance(profile_snapshot.get("runtimeOverridePolicy"), dict)
        else {}
    )

    def _mcp_key(item: dict[str, Any]) -> str:
        return str(
            item.get("server_name")
            or item.get("serverName")
            or item.get("name")
            or item.get("pieceName")
            or item.get("displayName")
            or item.get("url")
            or item.get("serverUrl")
            or item.get("command")
            or ""
        ).strip()

    profile_mcp_servers = [
        item
        for item in (
            profile_snapshot.get("mcpServers")
            if isinstance(profile_snapshot.get("mcpServers"), list)
            else []
        )
        if isinstance(item, dict)
    ]
    def _validate_mcp_profile_policy(server_list: list[dict[str, Any]]) -> None:
        if not profile_mcp_servers or profile_policy.get("allowServerAdditions") is True:
            return
        profile_servers_by_key = {
            _mcp_key(item): item for item in profile_mcp_servers if _mcp_key(item)
        }
        for item in server_list:
            key = _mcp_key(item)
            if key not in profile_servers_by_key:
                raise RuntimeError(
                    f"MCP server '{key or 'unknown'}' is not allowed by the selected agent profile."
                )
            requested_tools = _tool_set(item.get("allowedTools"))
            profile_tools = _tool_set(profile_servers_by_key[key].get("allowedTools"))
            if (
                requested_tools
                and profile_tools
                and not requested_tools.issubset(profile_tools)
            ):
                raise RuntimeError(
                    f"MCP server '{key}' requested tools outside the selected agent profile."
                )

    if profile_mcp_servers and profile_policy.get("allowServerAdditions") is not True:
        _validate_mcp_profile_policy(existing_mcp_server_list)
    elif existing_config.get("profileRef") and existing_mcp_server_list and not profile_mcp_servers:
        raise RuntimeError(
            "Selected agent profile did not include a profileSnapshot.mcpServers baseline."
        )
    _validate_agent_skill_profile_policy(existing_config)

    mcp_connection_mode = (
        str(existing_config.get("mcpConnectionMode") or "").strip().lower()
    )
    should_resolve_project_mcp = _should_include_project_mcp_connections(
        mcp_connection_mode,
        agent_runtime,
        existing_config,
    )
    has_unresolved_mcp_servers = any(
        not (
            str(item.get("url") or item.get("serverUrl") or "").strip()
            or str(item.get("command") or "").strip()
        )
        for item in existing_mcp_server_list
    )

    resolved_mcp_servers: list[dict[str, Any]] = []
    resolved_mcp_warnings: list[str] = []
    if existing_mcp_server_list or should_resolve_project_mcp or has_unresolved_mcp_servers:
        try:
            from activities.resolve_mcp_config import resolve_agent_mcp_servers

            mcp_resolution = yield ctx.call_activity(
                resolve_agent_mcp_servers,
                input=_freeze(
                    {
                        "workflowId": tc.workflow_id,
                        "requestedServers": existing_mcp_server_list,
                        "includeProjectConnections": should_resolve_project_mcp,
                        "_otel": tc.otel_ctx,
                    }
                ),
            )
            if isinstance(mcp_resolution, dict):
                if isinstance(mcp_resolution.get("mcpServers"), list):
                    resolved_mcp_servers = [
                        item
                        for item in mcp_resolution["mcpServers"]
                        if isinstance(item, dict)
                    ]
                if isinstance(mcp_resolution.get("warnings"), list):
                    resolved_mcp_warnings = [
                        str(item)
                        for item in mcp_resolution["warnings"]
                        if str(item).strip()
                    ]
        except Exception as mcp_err:
            logger.warning(
                "[SW Workflow] Failed to resolve MCP connections for workflow %s: %s",
                tc.workflow_id,
                mcp_err,
            )

    if resolved_mcp_servers or resolved_mcp_warnings:
        agent_config = {
            **existing_config,
            "mcpServers": resolved_mcp_servers,
        }
        if resolved_mcp_warnings:
            existing_warnings = existing_config.get("mcpConnectionWarnings")
            agent_config["mcpConnectionWarnings"] = [
                *(
                    existing_warnings
                    if isinstance(existing_warnings, list)
                    else []
                ),
                *resolved_mcp_warnings,
            ]
        _validate_mcp_profile_policy(
            [
                item
                for item in agent_config.get("mcpServers", [])
                if isinstance(item, dict)
            ]
        )

    instruction_bundle = (
        flattened_args.get("instructionBundle")
        if isinstance(flattened_args.get("instructionBundle"), dict)
        else None
    )
    environment_config = (
        flattened_args.get("environmentConfig")
        if isinstance(flattened_args.get("environmentConfig"), dict)
        else None
    )
    output_sync = (
        flattened_args.get("outputSync")
        if isinstance(flattened_args.get("outputSync"), dict)
        else None
    )
    canonical_context = _canonical_agent_context(
        flattened_args=flattened_args,
        agent_config=agent_config,
        instruction_bundle=instruction_bundle,
        tc=tc,
        task_name=task_name,
        agent_runtime=agent_runtime,
        agent_app_id=target.get("app_id"),
        workspace_ref=workspace_ref,
    )

    child_input = {
        "task": run_prompt,
        "prompt": prompt,
        "sessionId": child_instance_id,
        "workflow_instance_id": child_instance_id,
        "parentExecutionId": ctx.instance_id,
        "executionId": canonical_context["workflowExecutionId"],
        "workflowExecutionId": canonical_context["workflowExecutionId"],
        "workflowActivityCorrelationId": tc.otel_ctx.get(
            "workflow.activity.correlation_id"
        ),
        "workflowId": canonical_context["workflowId"],
        "nodeId": canonical_context["nodeId"],
        "nodeName": canonical_context["nodeName"],
        "agentId": canonical_context["agentId"],
        "agentVersion": canonical_context["agentVersion"],
        "agentSlug": canonical_context["agentSlug"],
        "agentAppId": canonical_context["agentAppId"],
        "agentRunId": child_instance_id,
        "workspaceRef": canonical_context["workspaceRef"],
        "sandboxName": canonical_context["sandboxName"],
        "agentRuntime": canonical_context["agentRuntime"],
        "workflowHistoryPropagation": {
            "requestedScope": history_propagation_label,
        },
        "stopCondition": stop_condition or None,
        "cwd": cwd,
        "requireFileChanges": require_file_changes,
        "timeoutMinutes": timeout_minutes,
        "agentConfig": agent_config,
        "instructionBundle": instruction_bundle,
        "environmentConfig": environment_config,
        "outputSync": output_sync,
        "agentGraph": agent_graph if isinstance(agent_graph, dict) else None,
        "autoTerminateAfterEndTurn": True,
        "loopPolicy": flattened_args.get("loopPolicy")
        if isinstance(flattened_args.get("loopPolicy"), dict)
        else None,
        "loopStrategyName": loop_strategy_name,
        "maxIterations": max_iterations,
        "_message_metadata": {
            "source": action_type,
            "triggering_workflow_instance_id": ctx.instance_id,
            "executionId": canonical_context["workflowExecutionId"],
            "workflowExecutionId": canonical_context["workflowExecutionId"],
            "workflowActivityCorrelationId": tc.otel_ctx.get(
                "workflow.activity.correlation_id"
            ),
            "workflowId": canonical_context["workflowId"],
            "nodeId": canonical_context["nodeId"],
            "nodeName": canonical_context["nodeName"],
            "agentId": canonical_context["agentId"],
            "agentVersion": canonical_context["agentVersion"],
            "agentSlug": canonical_context["agentSlug"],
            "agentAppId": canonical_context["agentAppId"],
            "agentRunId": child_instance_id,
            "agentRuntime": canonical_context["agentRuntime"],
            "workflowHistoryPropagation": {
                "requestedScope": history_propagation_label,
            },
            "sandboxName": canonical_context["sandboxName"],
            "workspaceRef": canonical_context["workspaceRef"],
            "cwd": cwd,
        },
        "_otel_span_context": tc.otel_ctx,
    }
    code_checkpoint_restore = tc.task_outputs.get("codeCheckpointRestore")
    if isinstance(code_checkpoint_restore, dict) and isinstance(
        code_checkpoint_restore.get("data"), dict
    ):
        child_input["codeCheckpointRestore"] = code_checkpoint_restore["data"]
        child_input["_message_metadata"]["codeCheckpointRestore"] = code_checkpoint_restore[
            "data"
        ]

    is_benchmark_run = _is_benchmark_trigger(tc.trigger_data)

    if tc.db_execution_id and not is_benchmark_run:
        try:
            from activities.track_agent_run import track_agent_run_scheduled

            yield ctx.call_activity(
                track_agent_run_scheduled,
                input=_freeze(
                    {
                        "id": child_instance_id,
                        "workflowExecutionId": tc.db_execution_id,
                        "workflowId": tc.workflow_id,
                        "nodeId": task_name,
                        "mode": "run",
                        "agentWorkflowId": child_instance_id,
                        "daprInstanceId": child_instance_id,
                        "parentExecutionId": ctx.instance_id,
                        "workspaceRef": workspace_ref,
                        "agentRuntime": agent_runtime,
                        "_otel": tc.otel_ctx,
                    }
                ),
            )
        except Exception as track_err:
            logger.warning(
                "[SW Workflow] Failed to persist scheduled durable child row for %s: %s",
                child_instance_id,
                track_err,
            )

    if tc.db_execution_id and not is_benchmark_run:
        try:
            from activities.track_agent_run import track_agent_run_running

            yield ctx.call_activity(
                track_agent_run_running,
                input=_freeze(
                    {
                        "id": child_instance_id,
                        "result": {
                            "agentWorkflowId": child_instance_id,
                            "daprInstanceId": child_instance_id,
                            "status": "running",
                        },
                        "_otel": tc.otel_ctx,
                    }
                ),
            )
        except Exception as track_err:
            logger.warning(
                "[SW Workflow] Failed to persist running durable child row for %s: %s",
                child_instance_id,
                track_err,
            )

    # Workflow↔Session bridge is now a structural invariant: every durable/run
    # against any durable agent runtime routes through session_workflow so the
    # run appears in /sessions/{id} with full event history and reuses the
    # same runtime path as UI-initiated sessions. The previous
    # WORKFLOW_USE_SESSIONS feature flag (OFF branch = direct
    # call_child_workflow("agent_workflow", ...)) was removed in Deploy B of
    # the CMA-alignment plan after the flag had been on in production since
    # 2026-04-17 with no issues.
    # Applies uniformly across dapr-agent-py (legacy shared app_id and
    # per-agent agent-runtime-<slug>) AND browser-use-agent — browser-use
    # registers both session_workflow + agent_workflow on the per-agent pod
    # (browser_use/dapr_runtime/service.py:335-340) with the same childInput
    # shape the BFF's ensure-for-workflow endpoint produces, so no per-runtime
    # branching is needed. Skipping the bridge for browser-use left the
    # per-agent Deployment unwoken (no spawn_session_for_workflow activity
    # → no ensure-for-workflow POST → no wakeAgentRuntime), stalling Dapr's
    # CreateWorkflowInstance with "context deadline exceeded".
    # Two-name dispatch (see core.runtime_registry): the bridge-eligibility
    # sentinel is the gate token (== config.DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME,
    # "agent_workflow"), NOT the dispatched workflow name ("session_workflow").
    # target["workflow_name"] historically holds the gate token; compare it to
    # the descriptor's bridge_gate_token rather than a bare literal so an
    # overridden DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME can't silently drop every
    # runtime into the (unreachable) non-bridge branch below.
    session_bridge_eligible = target.get("workflow_name") == target.get(
        "bridge_gate_token", "agent_workflow"
    )

    if session_bridge_eligible:
        from activities.spawn_session import spawn_session_for_workflow

        # userId + projectId are resolved server-side from workflow_executions
        # by the internal endpoint, so we don't need them in TaskContext.
        bridge_payload = {
            "sessionId": child_instance_id,
            "workflowId": tc.workflow_id,
            "nodeId": task_name,
            "nodeName": canonical_context["nodeName"],
            "workflowExecutionId": canonical_context["workflowExecutionId"],
            "parentExecutionId": ctx.instance_id,
            "benchmarkRunId": tc.trigger_data.get("runId")
            if isinstance(tc.trigger_data, dict)
            else None,
            "benchmarkInstanceId": tc.trigger_data.get("instanceId")
            if isinstance(tc.trigger_data, dict)
            else None,
            "benchmarkExecutionClass": tc.trigger_data.get("executionClass")
            if isinstance(tc.trigger_data, dict)
            else None,
            "agentConfig": agent_config,
            "instructionBundle": child_input.get("instructionBundle"),
            "environmentConfig": child_input.get("environmentConfig"),
            "outputSync": child_input.get("outputSync"),
            "workflowHistoryPropagation": child_input.get(
                "workflowHistoryPropagation"
            ),
            "vaultIds": child_input.get("vaultIds") or [],
            "initialMessage": run_prompt or prompt,
            "title": f"Workflow {tc.workflow_id} · {task_name}",
            # Per-agent runtime target identity. The BFF needs agentAppId
            # (or agentSlug) to wake the target pod BEFORE the parent yields
            # ctx.call_child_workflow(app_id=target["app_id"]) — otherwise
            # Dapr's CreateWorkflowInstance RPC times out with
            # "the app may not be available: context deadline exceeded"
            # and the parent orchestrator silently stalls on the task-5
            # completion event.
            "agentId": canonical_context["agentId"],
            "agentVersion": canonical_context["agentVersion"],
            "agentAppId": canonical_context["agentAppId"],
            "agentSlug": canonical_context["agentSlug"],
            # Sandbox plumbing — forwarded to ensure-for-workflow which in turn
            # embeds these in childInput so session_workflow can forward them
            # to agent_workflow. Required for any durable/run that uses
            # OpenShell tools (the runtime refuses to bind a sandbox without
            # a non-empty sandboxName or a workspaceRef starting with "ws_").
            "workspaceRef": canonical_context["workspaceRef"],
            # Hermetic fork: seed this fork's FRESH workspace subPath from the source
            # run's retained subPath (read-only copy at startup) so repeated forks don't
            # share + drift. None on normal runs.
            "seedWorkspaceFrom": getattr(tc, "seed_workspace_from", None),
            "sandboxName": canonical_context["sandboxName"],
            "cwd": cwd,
            # Preserve durable/run execution guards across the workflow↔session
            # bridge. session_workflow uses timeoutMinutes to raise its own
            # per-turn timer above the runtime default for long benchmark tasks.
            "timeoutMinutes": timeout_minutes,
            "maxIterations": max_iterations,
            # Goal-driven mode (optional). The BFF bridge creates the goal +
            # runs the session multi-turn when this is present.
            "goal": goal_spec,
            "_otel": tc.otel_ctx,
        }
        bridge_result = yield ctx.call_activity(
            spawn_session_for_workflow, input=_freeze(bridge_payload)
        )
        if isinstance(bridge_result, dict) and bridge_result.get("cancelled"):
            reason = bridge_result.get("error") or "workflow cancelled"
            stop_reason = bridge_result.get("stopReason")
            return {
                "success": False,
                "cancelled": True,
                "error": str(reason),
                "stopReason": stop_reason
                if isinstance(stop_reason, dict)
                else {
                    "type": "cancelled",
                    "reason": str(reason),
                    "source": "benchmark_cleanup",
                },
                "agentWorkflowId": child_instance_id,
                "daprInstanceId": child_instance_id,
                "childWorkflowName": "session_workflow",
            }
        bridge_child_input = bridge_result.get("childInput") if isinstance(
            bridge_result, dict
        ) else None
        if not isinstance(bridge_child_input, dict):
            raise RuntimeError(
                f"workflow↔session bridge: invalid bridge_result for {child_instance_id}"
            )
        bridge_runtime_sandbox_name = None
        if isinstance(bridge_result, dict):
            returned_runtime_sandbox = bridge_result.get("runtimeSandboxName")
            if isinstance(returned_runtime_sandbox, str) and returned_runtime_sandbox.strip():
                bridge_runtime_sandbox_name = returned_runtime_sandbox.strip()
        if not bridge_runtime_sandbox_name:
            child_runtime_sandbox = bridge_child_input.get("runtimeSandboxName")
            if isinstance(child_runtime_sandbox, str) and child_runtime_sandbox.strip():
                bridge_runtime_sandbox_name = child_runtime_sandbox.strip()
        bridge_child_input = {
            **bridge_child_input,
            "workflowId": canonical_context["workflowId"],
            "workflowExecutionId": canonical_context["workflowExecutionId"],
            "dbExecutionId": canonical_context["workflowExecutionId"],
            "workflowActivityCorrelationId": tc.otel_ctx.get(
                "workflow.activity.correlation_id"
            ),
            "nodeId": canonical_context["nodeId"],
            "nodeName": canonical_context["nodeName"],
            "agentId": bridge_result.get("agentId") or canonical_context["agentId"],
            "agentVersion": bridge_result.get("agentVersion")
            if bridge_result.get("agentVersion") is not None
            else canonical_context["agentVersion"],
            "agentSlug": bridge_result.get("agentSlug") or canonical_context["agentSlug"],
            "agentAppId": bridge_result.get("agentAppId") or canonical_context["agentAppId"],
            "runtimeSandboxName": bridge_child_input.get("runtimeSandboxName")
            or bridge_runtime_sandbox_name,
            "outputSync": bridge_child_input.get("outputSync") or output_sync,
            "workflowHistoryPropagation": bridge_child_input.get(
                "workflowHistoryPropagation"
            )
            or child_input.get("workflowHistoryPropagation"),
            "sandboxName": bridge_child_input.get("sandboxName")
            or canonical_context["sandboxName"],
            "workspaceRef": bridge_child_input.get("workspaceRef")
            or canonical_context["workspaceRef"],
            "_otel_span_context": tc.otel_ctx,
            "_otel": tc.otel_ctx,
            "_message_metadata": {
                **(
                    bridge_child_input.get("_message_metadata")
                    if isinstance(bridge_child_input.get("_message_metadata"), dict)
                    else {}
                ),
                **child_input["_message_metadata"],
                "runtimeSandboxName": bridge_runtime_sandbox_name,
                "workflowActivityCorrelationId": tc.otel_ctx.get(
                    "workflow.activity.correlation_id"
                ),
            },
        }
        bridge_app_id = target["app_id"]
        if isinstance(bridge_result, dict):
            returned_app_id = bridge_result.get("agentAppId")
            if isinstance(returned_app_id, str) and returned_app_id.strip():
                bridge_app_id = returned_app_id.strip()

        child_task = _call_child_workflow_with_history_propagation(
            ctx,
            # Two-name dispatch: every durable-session runtime registers the
            # outer workflow under descriptor.dispatch_workflow_name
            # ("session_workflow"); this is distinct from the bridge gate token
            # ("agent_workflow"). Sourced from the runtime registry instead of a
            # bare literal so a new runtime can change it by data.
            target.get("dispatch_workflow_name") or "session_workflow",
            input=_freeze(bridge_child_input),
            instance_id=child_instance_id,
            # Runtime routing plan: dispatch session_workflow to the selected
            # Dapr app id, which may be a dedicated agent runtime, a shared
            # runtime pool, or a legacy shared app id.
            app_id=bridge_app_id,
            propagation=history_propagation_scope,
        )
        if is_benchmark_run:
            # Benchmark runs already have a stronger timeout owner: the
            # benchmark service terminates stalled session instances. Adding a
            # parent workflow timer here creates Scheduler reminders that can
            # outlive the child completion event and leave the parent instance
            # RUNNING. Still listen for explicit cancellation so benchmark
            # cleanup can let the parent exit cooperatively before escalating
            # to hard Dapr termination.
            child_result = yield from _child_workflow_result_or_cancel_event(
                ctx,
                child_task,
                child_instance_id=child_instance_id,
                workflow_name="session_workflow",
            )
        elif not _durable_run_parent_timer_enabled():
            # Default: NO orchestrator per-turn timer (see
            # _durable_run_parent_timer_enabled). The agent self-terminates at its
            # own timeout_minutes; a long turn yields a partial result the loop can
            # act on instead of fatally killing the run. Cancellation still works.
            child_result = yield from _child_workflow_result_or_cancel_event(
                ctx,
                child_task,
                child_instance_id=child_instance_id,
                workflow_name="session_workflow",
            )
        else:
            child_result = yield from _child_workflow_result_with_timeout(
                ctx,
                child_task,
                timeout_minutes=timeout_minutes,
                child_instance_id=child_instance_id,
                workflow_name="session_workflow",
            )
    else:
        child_task = _call_child_workflow_with_history_propagation(
            ctx,
            target["workflow_name"],
            input=_freeze(child_input),
            instance_id=child_instance_id,
            app_id=target["app_id"],
            propagation=history_propagation_scope,
        )
        child_result = yield from _child_workflow_result_with_timeout(
            ctx,
            child_task,
            timeout_minutes=timeout_minutes,
            child_instance_id=child_instance_id,
            workflow_name=target["workflow_name"],
        )

    child_result = (
        child_result if isinstance(child_result, dict) else {"content": str(child_result)}
    )
    child_result.setdefault("agentWorkflowId", child_instance_id)
    child_result.setdefault("daprInstanceId", child_instance_id)
    if session_bridge_eligible:
        # Bridge path: session_workflow wrapped agent_workflow. Report the
        # accurate outer child workflow name + the session id.
        child_result.setdefault("childWorkflowName", "session_workflow")
        child_result.setdefault("childAppId", bridge_app_id)
        child_result.setdefault("sessionId", child_instance_id)
        if bridge_runtime_sandbox_name:
            child_result.setdefault("runtimeSandboxName", bridge_runtime_sandbox_name)
        child_result.setdefault("workspaceRef", canonical_context["workspaceRef"])
        child_result.setdefault("sandboxName", canonical_context["sandboxName"])
    else:
        child_result.setdefault("childWorkflowName", target["workflow_name"])
        child_result.setdefault("childAppId", target["app_id"])
    child_result.setdefault("agentRuntime", agent_runtime)
    if "success" not in child_result:
        child_result["success"] = not bool(child_result.get("error"))
    success = bool(child_result.get("success", True))

    # WARN-first bridge-side return-shape check (roadmap item 6 / the item-5
    # deferral): surface a non-conforming durable/run result in logs rather than
    # silently mis-mapping it downstream (e.g. SWE-bench reading a missing
    # .solve.modelPatch). Replay-guarded to avoid duplicate noise.
    if not _is_replaying(ctx):
        from core.conformance import return_shape_violations

        shape_issues = return_shape_violations(child_result)
        if shape_issues:
            logger.warning(
                "[SW Workflow] durable/run child %s (runtime=%s) return shape non-conforming: %s",
                child_instance_id,
                agent_runtime,
                "; ".join(shape_issues),
            )
    if tc.db_execution_id and not is_benchmark_run:
        try:
            from activities.track_agent_run import track_agent_run_completed

            yield ctx.call_activity(
                track_agent_run_completed,
                input=_freeze(
                    {
                        "id": child_instance_id,
                        "success": success,
                        "result": child_result,
                        "error": child_result.get("error"),
                        "_otel": tc.otel_ctx,
                    }
                ),
            )
        except Exception as track_err:
            logger.warning(
                "[SW Workflow] Failed to persist completion durable child row for %s: %s",
                child_instance_id,
                track_err,
            )
    return child_result


def _resolve_native_agent_args(
    tc: "TaskContext",
    task_input: Any,
    native_args: dict[str, Any],
) -> dict[str, Any]:
    """Resolve legacy templates and SW expressions for native agent actions."""
    if not isinstance(native_args, dict):
        return {}
    template_resolved_args = resolve_templates(native_args, tc.task_outputs)
    if not isinstance(template_resolved_args, dict):
        template_resolved_args = native_args
    expr_context = _build_expression_context(
        tc,
        task_input=task_input,
        has_task_input=True,
    )
    resolved_native_args = evaluate_structure(template_resolved_args, expr_context)
    if not isinstance(resolved_native_args, dict):
        resolved_native_args = (
            template_resolved_args if isinstance(template_resolved_args, dict) else {}
        )
    return resolved_native_args


def _resolved_call_args(
    task_data: dict[str, Any],
    tc: "TaskContext",
    resolved: dict[str, Any],
) -> tuple[Any, dict[str, Any], dict[str, Any]]:
    """Resolve a standard call task's input and function arguments."""
    task_input = _resolve_task_input(task_data, tc)
    expr_context = _build_expression_context(
        tc,
        task_input=task_input,
        has_task_input=True,
    )
    resolved_args = evaluate_structure(resolved.get("args", {}) or {}, expr_context)
    if not isinstance(resolved_args, dict):
        resolved_args = {}

    action_input = {}
    if isinstance(resolved_args.get("input"), dict):
        action_input = resolved_args["input"]
    elif isinstance(resolved_args.get("body"), dict) and isinstance(
        resolved_args["body"].get("input"), dict
    ):
        action_input = resolved_args["body"]["input"]

    return task_input, resolved_args, action_input


def _crawl4ai_timeout_ms(value: Any, default_ms: int) -> int:
    parsed = _parse_optional_int(value)
    if parsed is None:
        return default_ms
    return max(1_000, min(parsed, 1_800_000))


def _crawl4ai_poll_ms(value: Any) -> int:
    parsed = _parse_optional_int(value)
    if parsed is None:
        return 5_000
    return max(1_000, min(parsed, 60_000))


def _run_durable_crawl4ai_job(
    ctx: wf.DaprWorkflowContext,
    task_name: str,
    task_data: dict[str, Any],
    tc: "TaskContext",
    resolved: dict[str, Any],
    action_type: str,
) -> Any:
    task_input, resolved_args, action_input = _resolved_call_args(task_data, tc, resolved)
    input_payload = action_input or resolved_args
    timeout_ms = _crawl4ai_timeout_ms(input_payload.get("timeoutMs"), 900_000)
    poll_ms = _crawl4ai_poll_ms(input_payload.get("pollMs"))
    start_ms = _now_ms(ctx)

    started = yield ctx.call_activity(
        crawl4ai_start_job,
        input=_freeze(
            {
                "input": input_payload,
                "workflowId": tc.workflow_id,
                "executionId": tc.execution_id,
                "dbExecutionId": tc.db_execution_id,
                "nodeId": task_name,
                "_otel": tc.otel_ctx,
            }
        ),
    )
    if not isinstance(started, dict) or not started.get("jobId"):
        raise RuntimeError("Crawl4AI async job did not return a jobId")

    job_id = str(started["jobId"])
    _log_info(
        ctx,
        "[SW Workflow] Crawl4AI async job started: task=%s jobId=%s",
        task_name,
        job_id,
    )

    while True:
        status = yield ctx.call_activity(
            crawl4ai_get_job_status,
            input=_freeze(
                {
                    "jobId": job_id,
                    "workflowId": tc.workflow_id,
                    "executionId": tc.execution_id,
                    "dbExecutionId": tc.db_execution_id,
                    "nodeId": task_name,
                    "_otel": tc.otel_ctx,
                }
            ),
        )
        if isinstance(status, dict) and status.get("complete"):
            result = {
                "success": bool(status.get("success")),
                "data": status,
                "error": status.get("error") if isinstance(status.get("error"), str) else None,
                "duration_ms": _elapsed_ms(ctx, start_ms),
            }
            result = _apply_task_output_definition(
                task_data,
                tc,
                task_input=task_input,
                raw_output=result,
            )
            _store_task_output(tc, task_name, action_type, result)
            tc.completed_tasks.add(task_name)
            if not result.get("success", True):
                raise RuntimeError(result.get("error") or f"Crawl4AI job failed: {job_id}")
            return result

        if _elapsed_ms(ctx, start_ms) >= timeout_ms:
            result = {
                "success": False,
                "data": {
                    "jobId": job_id,
                    "status": status if isinstance(status, dict) else None,
                },
                "error": f"Crawl4AI job {job_id} did not complete within {timeout_ms}ms",
                "duration_ms": _elapsed_ms(ctx, start_ms),
            }
            result = _apply_task_output_definition(
                task_data,
                tc,
                task_input=task_input,
                raw_output=result,
            )
            _store_task_output(tc, task_name, action_type, result)
            tc.completed_tasks.add(task_name)
            raise RuntimeError(result.get("error") or f"Crawl4AI job timed out: {job_id}")

        yield ctx.create_timer(timedelta(milliseconds=poll_ms))


def _environment_timeout_ms(value: Any, default_ms: int) -> int:
    parsed = _parse_optional_int(value)
    if parsed is None:
        return default_ms
    return max(60_000, min(parsed, 7_200_000))


def _environment_poll_ms(value: Any) -> int:
    parsed = _parse_optional_int(value)
    if parsed is None:
        return 15_000
    return max(5_000, min(parsed, 120_000))


def _run_environment_prepare(
    ctx: wf.DaprWorkflowContext,
    task_name: str,
    task_data: dict[str, Any],
    tc: "TaskContext",
    resolved: dict[str, Any],
    action_type: str,
) -> Any:
    task_input, resolved_args, action_input = _resolved_call_args(task_data, tc, resolved)
    input_payload = action_input or resolved_args
    timeout_ms = _environment_timeout_ms(input_payload.get("timeoutMs"), 3_600_000)
    poll_ms = _environment_poll_ms(input_payload.get("pollMs"))
    start_ms = _now_ms(ctx)

    result = yield ctx.call_activity(
        ensure_environment,
        input=_freeze(
            {
                "input": input_payload,
                "workflowId": tc.workflow_id,
                "executionId": tc.execution_id,
                "dbExecutionId": tc.db_execution_id,
                "nodeId": task_name,
                "_otel": tc.otel_ctx,
            }
        ),
    )
    if not isinstance(result, dict):
        raise RuntimeError("Environment preparation returned an invalid result")

    while not result.get("complete"):
        if not result.get("success", True):
            break
        if _elapsed_ms(ctx, start_ms) >= timeout_ms:
            result = {
                **result,
                "success": False,
                "complete": True,
                "environmentStatus": "failed",
                "status": "failed",
                "error": f"Environment build did not complete within {timeout_ms}ms",
                "duration_ms": _elapsed_ms(ctx, start_ms),
            }
            break
        yield ctx.create_timer(timedelta(milliseconds=poll_ms))
        result = yield ctx.call_activity(
            check_environment_build,
            input=_freeze(
                {
                    "input": {
                        "buildId": result.get("buildId"),
                        "envSpecHash": result.get("envSpecHash"),
                        "environmentKey": result.get("environmentKey"),
                    },
                    "workflowId": tc.workflow_id,
                    "executionId": tc.execution_id,
                    "dbExecutionId": tc.db_execution_id,
                    "nodeId": task_name,
                    "_otel": tc.otel_ctx,
                }
            ),
        )
        if not isinstance(result, dict):
            raise RuntimeError("Environment build status returned an invalid result")

    result["duration_ms"] = result.get("duration_ms") or _elapsed_ms(ctx, start_ms)
    result = _apply_task_output_definition(
        task_data,
        tc,
        task_input=task_input,
        raw_output=result,
    )
    _store_task_output(tc, task_name, action_type, result)
    tc.completed_tasks.add(task_name)
    if not result.get("success", True) or result.get("environmentStatus") == "failed":
        raise RuntimeError(result.get("error") or f"Environment preparation failed: {task_name}")
    return result


def _handle_call_task(
    ctx: wf.DaprWorkflowContext,
    task_name: str,
    task_data: dict[str, Any],
    tc: TaskContext,
) -> Any:
    """Execute a call task via function-router / Dapr service invocation.

    Embedded agent actions are dispatched through the native durable child
    workflow path. All other calls go through execute_action as single-shot HTTP.
    """
    resolved = _resolve_function_call(task_data, tc.workflow)
    action_type = (
        resolved.get("actionType")
        or resolved.get("functionName")
        or f"{resolved['protocol']}-call"
    )

    _log_info(ctx, "[SW Workflow] call task: %s (action=%s)", task_name, action_type)

    if action_type in _REMOVED_AGENT_ACTION_TYPES:
        raise RuntimeError(
            f"Removed SW 1.0 agent action '{action_type}' in workflow task '{task_name}'. "
            "Use 'durable/run' for all embedded agent execution."
        )

    if action_type in _DURABLE_CRAWL4AI_ACTION_TYPES:
        result = yield from _run_durable_crawl4ai_job(
            ctx,
            task_name,
            task_data,
            tc,
            resolved,
            action_type,
        )
        return result

    if action_type in _ENVIRONMENT_ACTION_TYPES:
        result = yield from _run_environment_prepare(
            ctx,
            task_name,
            task_data,
            tc,
            resolved,
            action_type,
        )
        return result

    # Agent actions: prefer native durable child workflows when available
    if action_type in _AGENT_ACTION_TYPES:
        if action_type in _NATIVE_DURABLE_AGENT_ACTION_TYPES:
            task_input = _resolve_task_input(task_data, tc)
            native_args = resolved.get("args", {}) or {}
            resolved_native_args = _resolve_native_agent_args(
                tc,
                task_input,
                native_args,
            )
            result = yield from _run_native_durable_agent_child_workflow(
                ctx,
                task_name,
                action_type,
                resolved_native_args,
                tc,
            )
            _store_task_output(tc, task_name, action_type, result)
            tc.completed_tasks.add(task_name)

            if (
                isinstance(result, dict)
                and not result.get("success", True)
                and not result.get("cancelled")
            ):
                raise RuntimeError(result.get("error") or f"Agent action failed: {task_name}")

            return result

        raise RuntimeError(
            f"Unsupported agent action '{action_type}' in SW 1.0 workflow. "
            "Only native durable child workflow agent actions are supported."
        )

    # Standard call: single-shot HTTP via function-router.
    # Materialize task input and call arguments through SW `${ ... }` expressions.
    task_input, resolved_args, action_input = _resolved_call_args(task_data, tc, resolved)

    raw_config = {
        "actionType": action_type,
        **resolved_args,
    }

    # For piece/action calls: extract input fields from nested body.input or top-level input
    # so the AP piece-runtime receives them as flat propsValue fields while preserving
    # the original resolved arguments for generic OpenShell/function-router actions.
    if action_input:
        raw_config["input"] = action_input

    if not raw_config.get("metadata") and isinstance(resolved_args.get("body"), dict):
        body_metadata = resolved_args["body"].get("metadata")
        if body_metadata is not None:
            raw_config["metadata"] = body_metadata

    resolved_config = raw_config
    if action_type in _NATIVE_DURABLE_AGENT_ACTION_TYPES and isinstance(resolved_config, dict):
        agent_config = resolved_config.get("agentConfig")
        if not isinstance(agent_config, dict) and isinstance(resolved_config.get("body"), dict):
            agent_config = resolved_config["body"].get("agentConfig")
        _validate_agent_skill_profile_policy(agent_config)

    node_compat = {
        "id": task_name,
        "type": "action",
        "label": task_name,
        "config": resolved_config if isinstance(resolved_config, dict) else raw_config,
    }

    # Extract connectionExternalId from task config if present
    final_config = resolved_config if isinstance(resolved_config, dict) else raw_config
    connection_external_id = final_config.pop("connectionExternalId", None) if isinstance(final_config, dict) else None

    activity_input: dict[str, Any] = {
        "node": node_compat,
        "nodeOutputs": tc.task_outputs,
        "executionId": tc.execution_id,
        "workflowId": tc.workflow_id,
        "integrations": tc.integrations,
        "dbExecutionId": tc.db_execution_id,
        "connectionExternalId": connection_external_id,
        "_otel": tc.otel_ctx,
    }

    # AP piece actions get the durability contract: a deterministic
    # idempotency key (stable across retries AND replay), retryable-failure
    # raising (so the RetryPolicy fires), and DELAY/WEBHOOK pause mapping.
    is_ap_action = _is_ap_piece_action(action_type)
    call_kwargs: dict[str, Any] = {}
    if is_ap_action:
        activity_input["idempotencyKey"] = (
            f"{tc.workflow_id}:{tc.db_execution_id or tc.execution_id}:{task_name}"
        )
        activity_input["raiseOnRetryable"] = True
        # Node-level opt-out for actions the author marks safe to re-run.
        if isinstance(final_config, dict) and _as_bool(final_config.get("idempotent"), False):
            activity_input["skipIdempotencyGate"] = True
        call_kwargs["retry_policy"] = _AP_RETRY_POLICY

    # interactive-cli shared-workspace gate: a `workspace/command` with
    # `cliWorkspace: true` can't reach the CLI agents' files via openshell
    # (they write to the per-execution JuiceFS mount at /sandbox/work that only
    # CLI pods see). Route the FIXED command to the execution's live CLI pod via
    # the BFF (cli-direct /internal/workspace/command). Deterministic (command is
    # spec-fixed, not LLM-decided) and independent of the generator agent.
    cli_workspace_gate = (
        action_type == "workspace/command"
        and isinstance(final_config, dict)
        and _as_bool(final_config.get("cliWorkspace"), False)
    )
    if cli_workspace_gate:
        from activities.cli_workspace_command import cli_workspace_command

        gate_command = final_config.get("command")
        if not isinstance(gate_command, str) and isinstance(final_config.get("body"), dict):
            gate_command = final_config["body"].get("command")
        gate_cwd = final_config.get("cwd") or "/sandbox/work"
        # Optional readFile: return a large file's FULL contents (chunked) instead
        # of cli-agent-py's 8 KiB-tailed stdout — used by the capture node to grab
        # the built standalone.html.
        gate_read_file = final_config.get("readFile")
        if not isinstance(gate_read_file, str) and isinstance(final_config.get("body"), dict):
            gate_read_file = final_config["body"].get("readFile")
        # Optional persistBrowserVideo: an absolute path (on the CLI pod) to a .webm
        # the command produced; the BFF persists it as a `video` browser-artifact so
        # the run page's Browser tab renders it inline (e.g. the dashboard walkthrough).
        gate_persist_video = final_config.get("persistBrowserVideo")
        if not isinstance(gate_persist_video, str) and isinstance(final_config.get("body"), dict):
            gate_persist_video = final_config["body"].get("persistBrowserVideo")
        result = yield ctx.call_activity(
            cli_workspace_command,
            input=_freeze({
                "executionId": tc.db_execution_id or tc.execution_id,
                "command": gate_command,
                "cwd": gate_cwd,
                "readFile": gate_read_file if isinstance(gate_read_file, str) else None,
                # The node's timeoutMs governs the slow gate command (install/build
                # on JuiceFS); threaded down through the BFF to the cli pod so the
                # 180s HTTP default doesn't cap a multi-minute build.
                "timeoutMs": final_config.get("timeoutMs"),
                "persistBrowserVideo": gate_persist_video if isinstance(gate_persist_video, str) else None,
                # nodeId/workflowId let the BFF key the video browser-artifact to
                # this run + node (task_name IS the node id).
                "nodeId": task_name,
                "workflowId": tc.workflow_id,
                "_otel": tc.otel_ctx,
            }),
        )
    else:
        result = yield ctx.call_activity(
            execute_action,
            input=_freeze({**activity_input, "executionType": "BEGIN"}),
            **call_kwargs,
        )

    # AP pause contract: DELAY → durable timer then RESUME re-invoke;
    # WEBHOOK → wait for the BFF-raised external event (ap.resume.<requestId>)
    # then RESUME re-invoke carrying the callback payload.
    pause_rounds = 0
    while (
        is_ap_action
        and isinstance(result, dict)
        and isinstance(result.get("pause"), dict)
        and pause_rounds < _AP_MAX_PAUSE_ROUNDS
    ):
        pause_rounds += 1
        pause = result["pause"]
        pause_type = pause.get("type")
        resume_payload: Any = None

        if pause_type == "DELAY":
            delay_seconds = int(pause.get("delaySeconds") or 0)
            _log_info(
                ctx,
                "[SW Workflow] %s paused (DELAY %ss, round %s)",
                task_name,
                delay_seconds,
                pause_rounds,
            )
            if delay_seconds > 0:
                yield ctx.create_timer(timedelta(seconds=delay_seconds))
        elif pause_type == "WEBHOOK":
            request_id = str(pause.get("requestId") or "").strip()
            if not request_id:
                raise RuntimeError(
                    f"AP WEBHOOK pause for task '{task_name}' is missing requestId"
                )
            _log_info(
                ctx,
                "[SW Workflow] %s paused (WEBHOOK, waiting for ap.resume.%s)",
                task_name,
                request_id,
            )
            resume_payload = yield ctx.wait_for_external_event(f"ap.resume.{request_id}")
        else:
            break

        result = yield ctx.call_activity(
            execute_action,
            input=_freeze({
                **activity_input,
                "executionType": "RESUME",
                "resumePayload": resume_payload,
            }),
            **call_kwargs,
        )

    result = _apply_task_output_definition(
        task_data,
        tc,
        task_input=task_input,
        raw_output=result,
    )

    # Persist workspace_profile rows so the BFF sandbox-preview proxy can resolve
    # the run's retained sandbox. Legacy workspace-runtime did this upsert; the
    # port to openshell-agent-runtime (2026-04-19 commit 5c74e218) never ported
    # the DB write. Orchestrator now owns the row.
    if (
        action_type == "workspace/profile"
        and isinstance(result, dict)
        and result.get("success", True)
    ):
        keep_after_run = _as_bool(
            (resolved_config or {}).get("keepAfterRun")
            if isinstance(resolved_config, dict)
            else False,
            False,
        )
        if not keep_after_run and isinstance(task_input, dict):
            keep_after_run = _as_bool(task_input.get("keepAfterRun"), False)
        if keep_after_run:
            yield ctx.call_activity(
                "persist_workspace_session",
                input=_freeze({
                    "workflowExecutionId": tc.db_execution_id,
                    "actionType": action_type,
                    "keepAfterRun": True,
                    "taskName": task_name,
                    "result": result,
                    "_otel": tc.otel_ctx,
                }),
            )

    if action_type == "goal/plan":
        artifact_input = _build_goal_plan_artifact_input(tc, task_name, task_input, result)
        if artifact_input:
            try:
                from activities.persist_plan_artifact import persist_plan_artifact

                persisted_plan = yield ctx.call_activity(
                    persist_plan_artifact,
                    input=_freeze(artifact_input),
                )
                if isinstance(persisted_plan, dict) and not persisted_plan.get("success", True):
                    logger.warning(
                        "[SW Workflow] Failed to persist plan artifact for %s: %s",
                        task_name,
                        persisted_plan.get("error") or persisted_plan,
                    )
            except Exception as plan_err:
                logger.warning(
                    "[SW Workflow] Failed to schedule plan artifact persistence for %s: %s",
                    task_name,
                    plan_err,
                )

    # Store in NodeOutputs format for cross-node template resolution
    _store_task_output(tc, task_name, action_type, result)
    tc.completed_tasks.add(task_name)

    if not result.get("success", True):
        # Honor `with.allowFailure`: a node that opts in (e.g. the GAN build gate,
        # whose cli_workspace_command surfaces a transient dispatch/transport error
        # as success:false ON PURPOSE) tolerates the failure — it becomes the node's
        # output (loop `while` guards read its stdout) instead of aborting the whole
        # run. Without this, a single transient infra blip kills a multi-hour run.
        allow_failure = _as_bool((task_data.get("with") or {}).get("allowFailure"), False)
        if allow_failure:
            _log_info(
                ctx,
                "[SW Workflow] call task failed but allowFailure=true; continuing: %s",
                task_name,
            )
            return result
        raise RuntimeError(result.get("error") or f"Call task failed: {task_name}")

    return result


def _stable_plan_artifact_ref(db_execution_id: str, task_name: str) -> str:
    execution_part = re.sub(r"[^a-zA-Z0-9_-]+", "_", db_execution_id).strip("_")
    task_part = re.sub(r"[^a-zA-Z0-9_-]+", "_", task_name).strip("_")
    return f"plan_{execution_part[:64]}_{task_part[:64]}"


def _build_goal_plan_artifact_input(
    tc: TaskContext,
    task_name: str,
    task_input: Any,
    result: Any,
) -> dict[str, Any] | None:
    if not tc.db_execution_id or not isinstance(result, dict) or not result.get("success", True):
        return None

    data_envelope = result.get("data") if isinstance(result.get("data"), dict) else {}
    data = (
        data_envelope.get("data")
        if isinstance(data_envelope.get("data"), dict)
        else data_envelope
    )
    goal_spec = data.get("goalSpec") or data_envelope.get("goalSpec") or result.get("goalSpec")
    if not isinstance(goal_spec, dict):
        return None

    task_input_dict = task_input if isinstance(task_input, dict) else {}
    goal = str(
        goal_spec.get("objective")
        or task_input_dict.get("intent")
        or task_input_dict.get("prompt")
        or task_name
    ).strip()
    source_prompt = str(
        task_input_dict.get("fromText")
        or task_input_dict.get("intent")
        or task_input_dict.get("prompt")
        or goal
    ).strip()

    metadata: dict[str, Any] = {}
    if "rationale" in data:
        metadata["rationale"] = data.get("rationale")
    if "lint" in data:
        metadata["lint"] = data.get("lint")

    return {
        "artifactRef": _stable_plan_artifact_ref(tc.db_execution_id, task_name),
        "dbExecutionId": tc.db_execution_id,
        "workflowId": tc.workflow_id,
        "nodeId": task_name,
        "goal": goal or task_name,
        "sourcePrompt": source_prompt or goal or task_name,
        "planJson": {
            "goalSpec": goal_spec,
            "rationale": data.get("rationale"),
            "lint": data.get("lint"),
        },
        "planMarkdown": (
            result.get("content")
            if isinstance(result.get("content"), str)
            else data.get("content") if isinstance(data.get("content"), str) else None
        ),
        "artifactType": "goal_spec_v1",
        "status": "draft",
        "workspaceRef": task_input_dict.get("workspaceRef"),
        "clonePath": task_input_dict.get("clonePath"),
        "metadata": metadata or None,
        "_otel": tc.otel_ctx,
    }


def _handle_set_task(
    ctx: wf.DaprWorkflowContext,
    task_name: str,
    task_data: dict[str, Any],
    tc: TaskContext,
) -> Any:
    """Execute a set task: update state variables."""
    task_input = _resolve_task_input(task_data, tc)
    expr_context = _build_expression_context(tc, task_input=task_input, has_task_input=True)
    assignments = evaluate_structure(task_data.get("set", {}), expr_context)
    _log_info(ctx, "[SW Workflow] set task: %s (keys=%s)", task_name, list(assignments.keys()))

    for key, value in assignments.items():
        tc.state_vars[key] = value

    # Store in NodeOutputs format for resolve_templates compatibility
    result = _apply_task_output_definition(
        task_data,
        tc,
        task_input=task_input,
        raw_output={"success": True, "data": dict(tc.state_vars)},
    )
    _store_task_output(tc, task_name, "set", result)
    # Keep state virtual node updated
    tc.task_outputs["state"] = {
        "label": "State",
        "actionType": "state",
        "data": {"success": True, "data": tc.state_vars},
    }
    tc.completed_tasks.add(task_name)
    return result


def _handle_switch_task(
    ctx: wf.DaprWorkflowContext,
    task_name: str,
    task_data: dict[str, Any],
    tc: TaskContext,
) -> str | None:
    """
    Execute a switch task: evaluate cases and return the FlowDirective.
    Returns the `then` value of the matching case, or None for default flow.
    """
    cases = task_data.get("switch", [])
    _log_info(ctx, "[SW Workflow] switch task: %s (%d cases)", task_name, len(cases))

    task_input = _resolve_task_input(task_data, tc)
    eval_context = _build_expression_context(tc, task_input=task_input, has_task_input=True)

    for case_item in cases:
        for case_name, case_def in case_item.items():
            when_expr = case_def.get("when")

            # Default case (no when condition)
            if when_expr is None:
                tc.completed_tasks.add(task_name)
                _store_task_output(tc, task_name, "switch", {"matched": case_name})
                return case_def.get("then")

            try:
                matched = evaluate_condition(when_expr, eval_context)
            except Exception:
                logger.warning(
                    "[SW Workflow] switch condition evaluation failed for %s case %s: %s",
                    task_name,
                    case_name,
                    when_expr,
                    exc_info=True,
                )
                matched = False

            if matched:
                tc.completed_tasks.add(task_name)
                switch_result = _apply_task_output_definition(
                    task_data,
                    tc,
                    task_input=task_input,
                    raw_output={"matched": case_name},
                )
                _store_task_output(tc, task_name, "switch", switch_result)
                return case_def.get("then")

    tc.completed_tasks.add(task_name)
    switch_result = _apply_task_output_definition(
        task_data,
        tc,
        task_input=task_input,
        raw_output={"matched": None},
    )
    _store_task_output(tc, task_name, "switch", switch_result)
    return None  # No case matched, continue default flow


def _handle_wait_task(
    ctx: wf.DaprWorkflowContext,
    task_name: str,
    task_data: dict[str, Any],
    tc: TaskContext,
) -> Any:
    """Execute a wait task: create a Dapr timer."""
    task_input = _resolve_task_input(task_data, tc)
    expr_context = _build_expression_context(tc, task_input=task_input, has_task_input=True)
    duration = evaluate_structure(task_data.get("wait", "PT0S"), expr_context)
    td = _parse_duration(duration)
    _log_info(ctx, "[SW Workflow] wait task: %s (duration=%s)", task_name, td)

    yield ctx.create_timer(td)

    result = _apply_task_output_definition(
        task_data,
        tc,
        task_input=task_input,
        raw_output={"success": True, "data": {"waited": str(td)}},
    )
    _store_task_output(tc, task_name, "wait", result)
    tc.completed_tasks.add(task_name)
    return result


def _handle_emit_task(
    ctx: wf.DaprWorkflowContext,
    task_name: str,
    task_data: dict[str, Any],
    tc: TaskContext,
) -> Any:
    """Execute an emit task: publish an event via Dapr pub/sub."""
    emit_config = task_data.get("emit", {})
    event_def = emit_config.get("event", {})
    task_input = _resolve_task_input(task_data, tc)
    event_with = evaluate_structure(
        event_def.get("with", {}),
        _build_expression_context(tc, task_input=task_input, has_task_input=True),
    )
    _log_info(ctx, "[SW Workflow] emit task: %s (type=%s)", task_name, event_with.get("type"))

    result = yield ctx.call_activity(
        publish_phase_changed,
        input=_freeze({
            "executionId": tc.execution_id,
            "phase": event_with.get("type", "custom"),
            "message": event_with.get("subject", task_name),
            "data": event_with.get("data"),
            "_otel": tc.otel_ctx,
        }),
    )

    emit_result = _apply_task_output_definition(
        task_data,
        tc,
        task_input=task_input,
        raw_output={"success": True, "data": result},
    )
    _store_task_output(tc, task_name, "emit", emit_result)
    tc.completed_tasks.add(task_name)
    return result


def _handle_listen_task(
    ctx: wf.DaprWorkflowContext,
    task_name: str,
    task_data: dict[str, Any],
    tc: TaskContext,
) -> Any:
    """Execute a listen task: wait for an external event."""
    listen_config = task_data.get("listen", {})
    to_config = listen_config.get("to", {})
    task_input = _resolve_task_input(task_data, tc)
    expr_context = _build_expression_context(tc, task_input=task_input, has_task_input=True)
    to_config = evaluate_structure(to_config, expr_context)
    _log_info(ctx, "[SW Workflow] listen task: %s", task_name)

    # Determine event name from filter
    event_filter = to_config.get("one") or (to_config.get("any") or [{}])[0] if isinstance(to_config.get("any"), list) else to_config.get("one", {})
    event_type = event_filter.get("with", {}).get("type", task_name) if isinstance(event_filter, dict) else task_name

    # Log approval request if this is an approval pattern
    if tc.db_execution_id:
        yield ctx.call_activity(
            log_approval_request,
            input=_freeze({
                "executionId": tc.execution_id,
                "taskName": task_name,
                "eventType": event_type,
                "dbExecutionId": tc.db_execution_id,
                "_otel": tc.otel_ctx,
            }),
        )

    # Wait for external event
    timeout_config = task_data.get("timeout")
    timeout_td = _parse_duration(timeout_config["after"]) if timeout_config and timeout_config.get("after") else None

    try:
        if timeout_td:
            event_data = yield ctx.wait_for_external_event(event_type, timeout=timeout_td)
        else:
            event_data = yield ctx.wait_for_external_event(event_type)

        result = {"success": True, "data": event_data}
    except TimeoutError:
        if tc.db_execution_id:
            yield ctx.call_activity(
                log_approval_timeout,
                input=_freeze({
                    "executionId": tc.execution_id,
                    "taskName": task_name,
                    "eventType": event_type,
                    "dbExecutionId": tc.db_execution_id,
                    "_otel": tc.otel_ctx,
                }),
            )
        result = {"success": False, "data": {"timedOut": True}}

    listen_result = _apply_task_output_definition(
        task_data,
        tc,
        task_input=task_input,
        raw_output=result,
    )
    _store_task_output(tc, task_name, "listen", listen_result)
    tc.completed_tasks.add(task_name)
    return result


def _handle_for_task(
    ctx: wf.DaprWorkflowContext,
    task_name: str,
    task_data: dict[str, Any],
    tc: TaskContext,
) -> Any:
    """Execute a for task: iterate over items and run sub-tasks."""
    for_config = task_data.get("for", {})
    each_var = for_config.get("each", "item")
    in_expr = for_config.get("in", "[]")
    at_var = for_config.get("at", "index")
    sub_tasks = task_data.get("do", [])
    while_expr = task_data.get("while")
    task_input = _resolve_task_input(task_data, tc)
    expr_context = _build_expression_context(tc, task_input=task_input, has_task_input=True)

    _log_info(ctx, "[SW Workflow] for task: %s (each=%s)", task_name, each_var)

    # Resolve the collection to iterate.
    items = evaluate_structure(in_expr, expr_context) if isinstance(in_expr, str) else evaluate_structure(in_expr, expr_context)
    if not isinstance(items, list):
        items = list(items) if hasattr(items, "__iter__") else [items]

    # Loop-state ergonomic: expose the PREVIOUS iteration's sub-task outputs under
    # a stable handle so the `while` guard + sub-task inputs can read them without
    # dynamic-index jq (e.g. ${ .loop.last.evaluate.feedback }). This is the
    # generator↔critic feedback channel for the evaluator-optimizer pattern.
    #   .loop.last.<subtask>  → previous iteration's unwrapped output
    #   .loop.index           → current iteration index
    #   .loop.accepted        → True once any sub-task output set meets_criteria:true
    #   .loop.iterations      → completed iteration count
    loop_state: dict[str, Any] = {"last": {}, "index": 0, "accepted": False, "iterations": 0}
    tc.state_vars["loop"] = loop_state

    iteration_results = []
    for idx, item in enumerate(items):
        # Set iteration variables in state
        tc.state_vars[each_var] = item
        tc.state_vars[at_var] = idx
        loop_state["index"] = idx

        # `while` is a per-iteration BREAK guard, re-evaluated against current
        # state (incl. the previous iteration's verdict via .loop.last/.loop.accepted).
        if while_expr is not None:
            loop_context = _build_expression_context(tc, task_input=task_input, has_task_input=True)
            if not evaluate_condition(while_expr, loop_context):
                break

        # Execute sub-tasks; after each, publish its unwrapped output to
        # .loop.last.<subtask> for the next iteration (and the verdict convenience
        # flag .loop.accepted).
        for sub_item in sub_tasks:
            for sub_name, sub_data in sub_item.items():
                iter_task_name = f"{task_name}/{sub_name}[{idx}]"
                yield from _dispatch_task(ctx, iter_task_name, sub_data, tc)
                stored = tc.task_outputs.get(iter_task_name)
                sub_output = (
                    _unwrap_standardized_output(stored.get("data", stored))
                    if isinstance(stored, dict)
                    else stored
                )
                loop_state["last"][sub_name] = sub_output
                if isinstance(sub_output, dict) and sub_output.get("meets_criteria") is True:
                    loop_state["accepted"] = True

        iteration_results.append(item)
        loop_state["iterations"] = len(iteration_results)

    result = _apply_task_output_definition(
        task_data,
        tc,
        task_input=task_input,
        raw_output={"success": True, "data": {"iterations": len(iteration_results)}},
    )
    _store_task_output(tc, task_name, "for", result)
    tc.completed_tasks.add(task_name)
    return result


def _handle_fork_task(
    ctx: wf.DaprWorkflowContext,
    task_name: str,
    task_data: dict[str, Any],
    tc: TaskContext,
) -> Any:
    """Execute a fork task: run branches (sequentially for now, parallel TBD)."""
    fork_config = task_data.get("fork", {})
    branches = fork_config.get("branches", [])
    task_input = _resolve_task_input(task_data, tc)
    _log_info(ctx, "[SW Workflow] fork task: %s (%d branches)", task_name, len(branches))

    # Execute branches sequentially (Dapr doesn't natively support parallel activities
    # within a single workflow function without fan-out/fan-in patterns)
    branch_results = {}
    for branch_item in branches:
        for branch_name, branch_data in branch_item.items():
            branch_task_name = f"{task_name}/{branch_name}"
            result = yield from _dispatch_task(ctx, branch_task_name, branch_data, tc)
            branch_results[branch_name] = result

    fork_result = _apply_task_output_definition(
        task_data,
        tc,
        task_input=task_input,
        raw_output={"success": True, "data": branch_results},
    )
    _store_task_output(tc, task_name, "fork", fork_result)
    tc.completed_tasks.add(task_name)
    return branch_results


def _handle_try_task(
    ctx: wf.DaprWorkflowContext,
    task_name: str,
    task_data: dict[str, Any],
    tc: TaskContext,
) -> Any:
    """Execute a try task: run sub-tasks with error handling."""
    try_tasks = task_data.get("try", [])
    catch_config = task_data.get("catch", {})
    task_input = _resolve_task_input(task_data, tc)
    _log_info(ctx, "[SW Workflow] try task: %s", task_name)
    subtask_results: dict[str, Any] = {}

    try:
        for sub_item in try_tasks:
            for sub_name, sub_data in sub_item.items():
                subtask_result = yield from _dispatch_task(
                    ctx,
                    f"{task_name}/try/{sub_name}",
                    sub_data,
                    tc,
                )
                subtask_results[sub_name] = _unwrap_standardized_output(subtask_result)
        result = {"success": True, "tasks": subtask_results}
    except Exception as e:
        logger.warning("[SW Workflow] try task caught error: %s", e)
        # Execute catch tasks if defined
        catch_tasks = catch_config.get("do", [])
        if catch_tasks:
            error_var = catch_config.get("as", "error")
            tc.state_vars[error_var] = str(e)
            for sub_item in catch_tasks:
                for sub_name, sub_data in sub_item.items():
                    yield from _dispatch_task(ctx, f"{task_name}/catch/{sub_name}", sub_data, tc)
        result = {"success": False, "error": str(e), "tasks": subtask_results}

    try_result = _apply_task_output_definition(
        task_data,
        tc,
        task_input=task_input,
        raw_output=result,
    )
    _store_task_output(tc, task_name, "try", try_result)
    tc.completed_tasks.add(task_name)
    return result


def _handle_run_task(
    ctx: wf.DaprWorkflowContext,
    task_name: str,
    task_data: dict[str, Any],
    tc: TaskContext,
) -> Any:
    """Execute a run task: run shell commands, scripts, containers, or child workflows.

    For agent workflows (openshell/langgraph), delegates to process_agent_child_workflow
    which handles multi-turn LLM loops, plan approval, and progress tracking.
    """
    run_config = task_data.get("run", {})
    task_input = _resolve_task_input(task_data, tc)
    expr_context = _build_expression_context(tc, task_input=task_input, has_task_input=True)
    run_config = evaluate_structure(run_config, expr_context)
    _log_info(ctx, "[SW Workflow] run task: %s (type=%s)", task_name, list(run_config.keys()))

    if "workflow" in run_config:
        wf_config = run_config["workflow"]
        child_wf_name = wf_config.get("name", "")
        child_input = wf_config.get("input", {})

        # Check if this is an agent workflow that needs the full orchestration
        agent_action_type = child_input.get("actionType", "")
        if agent_action_type in _REMOVED_AGENT_ACTION_TYPES:
            raise RuntimeError(
                f"Removed SW 1.0 agent workflow action '{agent_action_type}' in task '{task_name}'. "
                "Use 'durable/run' for all embedded agent execution."
            )
        if agent_action_type in _AGENT_ACTION_TYPES:
            if agent_action_type in _NATIVE_DURABLE_AGENT_ACTION_TYPES:
                result = yield from _run_native_durable_agent_child_workflow(
                    ctx,
                    task_name,
                    agent_action_type,
                    child_input,
                    tc,
                )
                run_result = _apply_task_output_definition(
                    task_data,
                    tc,
                    task_input=task_input,
                    raw_output=result,
                )
                _store_task_output(tc, task_name, agent_action_type, run_result)
                tc.completed_tasks.add(task_name)
                if isinstance(result, dict) and not result.get("success", True):
                    raise RuntimeError(result.get("error") or f"Agent action failed: {task_name}")
                return result

            raise RuntimeError(
                f"Unsupported agent workflow action '{agent_action_type}' in SW 1.0 workflow. "
                "Only native durable child workflow agent actions are supported."
            )

        # Standard child workflow invocation
        _log_info(ctx, "[SW Workflow] Running child workflow: %s", child_wf_name)
        result = yield ctx.call_child_workflow(
            child_wf_name,
            input=_freeze(child_input),
        )
        run_result = _apply_task_output_definition(
            task_data,
            tc,
            task_input=task_input,
            raw_output=result,
        )
        _store_task_output(tc, task_name, child_wf_name, run_result)
        tc.completed_tasks.add(task_name)
        return result

    if "shell" in run_config:
        # Shell command via function-router workspace action
        shell_config = run_config["shell"]
        node_compat = {
            "id": task_name,
            "type": "action",
            "label": task_name,
            "config": {
                "actionType": "workspace/command",
                "command": shell_config.get("command", ""),
                "arguments": shell_config.get("arguments", {}),
                "environment": shell_config.get("environment", {}),
            },
        }
        result = yield ctx.call_activity(
            execute_action,
            input=_freeze({
                "node": node_compat,
                "nodeOutputs": tc.task_outputs,
                "executionId": tc.execution_id,
                "workflowId": tc.workflow_id,
                "dbExecutionId": tc.db_execution_id,
                "_otel": tc.otel_ctx,
            }),
        )
        run_result = _apply_task_output_definition(
            task_data,
            tc,
            task_input=task_input,
            raw_output=result,
        )
        _store_task_output(tc, task_name, "shell", run_result)
        tc.completed_tasks.add(task_name)
        return result

    # Container and script runs: route through function-router
    node_compat = {
        "id": task_name,
        "type": "action",
        "label": task_name,
        "config": {
            "actionType": "system/run",
            **run_config,
        },
    }
    result = yield ctx.call_activity(
        execute_action,
        input=_freeze({
            "node": node_compat,
            "nodeOutputs": tc.task_outputs,
            "executionId": tc.execution_id,
            "workflowId": tc.workflow_id,
            "dbExecutionId": tc.db_execution_id,
            "_otel": tc.otel_ctx,
        }),
    )
    run_result = _apply_task_output_definition(
        task_data,
        tc,
        task_input=task_input,
        raw_output=result,
    )
    _store_task_output(tc, task_name, "run", run_result)
    tc.completed_tasks.add(task_name)
    return result


def _handle_raise_task(
    ctx: wf.DaprWorkflowContext,
    task_name: str,
    task_data: dict[str, Any],
    tc: TaskContext,
) -> Any:
    """Execute a raise task: raise an error."""
    raise_config = task_data.get("raise", {})
    error_def = raise_config.get("error", {})
    task_input = _resolve_task_input(task_data, tc)
    resolved_error = evaluate_structure(
        error_def,
        _build_expression_context(tc, task_input=task_input, has_task_input=True),
    )
    error_msg = resolved_error.get("detail") or resolved_error.get("title") or f"Error raised at {task_name}"
    _log_info(ctx, "[SW Workflow] raise task: %s (%s)", task_name, error_msg)
    raise RuntimeError(error_msg)


def _handle_do_task(
    ctx: wf.DaprWorkflowContext,
    task_name: str,
    task_data: dict[str, Any],
    tc: TaskContext,
) -> Any:
    """Execute a do task: run sub-tasks sequentially."""
    sub_tasks = task_data.get("do", [])
    task_input = _resolve_task_input(task_data, tc)
    _log_info(ctx, "[SW Workflow] do task: %s (%d sub-tasks)", task_name, len(sub_tasks))

    for sub_item in sub_tasks:
        for sub_name, sub_data in sub_item.items():
            yield from _dispatch_task(ctx, f"{task_name}/{sub_name}", sub_data, tc)

    result = _apply_task_output_definition(
        task_data,
        tc,
        task_input=task_input,
        raw_output={"success": True},
    )
    _store_task_output(tc, task_name, "do", result)
    tc.completed_tasks.add(task_name)
    return result


# ---------------------------------------------------------------------------
# Task dispatcher
# ---------------------------------------------------------------------------

def _persist_task_artifacts(
    ctx: wf.DaprWorkflowContext,
    task_name: str,
    task_data: dict[str, Any],
    tc: "TaskContext",
):
    """Best-effort post-task persistence of declarative artifacts.

    SW 1.0 task spec may carry an ``artifacts: [...]`` list. After the task's
    output is in ``tc.task_outputs``, walk each entry, evaluate jq expressions
    against the same expression context the task itself just resolved against,
    and yield a ``persist_workflow_artifact`` activity per entry.

    Each entry shape::

        - kind: markdown | json | text | table | image | link | card | <other>
          slot: primary | secondary | aux              # optional, controls UI placement
          title: "<jq or literal>"                     # required
          description: "<jq or literal>"               # optional
          from: "${ .data.content }"                   # jq → inlinePayload
          fileId: "<jq or literal>"                    # alternative to `from`
          contentType: "text/markdown"                 # optional
          metadata: { ... }                            # optional jq-evaluated dict
          if: "${ .data.success }"                     # optional gate

    Persistence is best-effort: a failed activity logs but does not propagate
    (see persist_workflow_artifact). The activity itself is idempotent under
    Dapr retry via deterministic id (workflowId|executionId|nodeId|kind|title).
    """
    artifacts_spec = task_data.get("artifacts")
    if not isinstance(artifacts_spec, list) or not artifacts_spec:
        return

    # Build expression context with the just-completed task's data exposed at
    # the top level so artifact expressions stay uniform regardless of the
    # producer's envelope depth. Two access patterns work for `from:` /
    # `title:` / `if:` expressions:
    #   - Canonical: `${ .data.X }` — `.data` is the unwrapped task payload
    #     (crawl4ai naturally nests {tier, markdown, …} under .data; agents
    #     return flat {content, turn, …} which we wrap so the same idiom
    #     works for both).
    #   - Shorthand: `${ .X }` — top-level fields of the payload are
    #     promoted into the root context, so `${ .content }` /
    #     `${ .markdown }` also work (unless they collide with reserved keys
    #     like input/state/task/output/workflow/runtime/result).
    # Also exposes `.input` (trigger), `.state.X`, and every previously-
    # completed task by its name.
    task_record = tc.task_outputs.get(task_name)
    # Layer 1: strip {label, actionType, data} wrapper from _store_task_output.
    layer1 = task_record.get("data") if isinstance(task_record, dict) else None
    # Layer 2: strip one {success, data, error} envelope if present (the
    # `_apply_task_output_definition` shape used by call tasks).
    if isinstance(layer1, dict) and isinstance(layer1.get("success"), bool) and "data" in layer1:
        payload = layer1.get("data")
    else:
        payload = layer1

    # Canonical `.data` view: if payload already has a `data` field (crawl4ai
    # case), keep payload as the context root and the user accesses
    # `.data.X` directly. Otherwise wrap so `.data.X` works for flat payloads
    # (agent case: payload is `{content, turn, …}` → `data = payload`).
    if isinstance(payload, dict) and "data" in payload:
        root = payload
    else:
        root = {"data": payload if payload is not None else {}}

    expr_context = _build_expression_context(
        tc,
        task_output=payload,
        has_task_output=True,
    )
    # Promote root fields to the top level. Don't shadow reserved keys.
    PROTECTED = {"input", "state", "task", "output", "workflow", "runtime", "result"}
    if isinstance(root, dict):
        for k, v in root.items():
            if k not in PROTECTED and k not in expr_context:
                expr_context[k] = v
    workflow_id = tc.workflow_id

    for raw in artifacts_spec:
        if not isinstance(raw, dict):
            continue
        # Optional gate.
        guard = raw.get("if")
        if guard is not None:
            try:
                if not evaluate_condition(guard, expr_context):
                    continue
            except Exception:  # pragma: no cover — bad jq shouldn't break workflow
                logger.warning(
                    "[SW Workflow] artifact `if` failed to evaluate (task=%s); skipping entry",
                    task_name,
                )
                continue

        try:
            kind = evaluate_structure(raw.get("kind"), expr_context)
            if not isinstance(kind, str) or not kind.strip():
                continue
            title = evaluate_structure(raw.get("title"), expr_context)
            if not isinstance(title, str) or not title.strip():
                continue

            slot = evaluate_structure(raw.get("slot"), expr_context) if raw.get("slot") is not None else None
            description = (
                evaluate_structure(raw.get("description"), expr_context)
                if raw.get("description") is not None
                else None
            )
            content_type = (
                evaluate_structure(raw.get("contentType"), expr_context)
                if raw.get("contentType") is not None
                else None
            )
            metadata = (
                evaluate_structure(raw.get("metadata"), expr_context)
                if raw.get("metadata") is not None
                else None
            )

            # Either inline payload (from) or a file_id reference.
            inline_payload: Any = None
            file_id: Any = None
            if raw.get("from") is not None:
                from_value = evaluate_structure(raw.get("from"), expr_context)
                # Wrap by kind for renderer expectations.
                if kind == "markdown":
                    inline_payload = {"markdown": str(from_value or "")}
                elif kind == "text":
                    inline_payload = {"text": str(from_value or "")}
                elif kind == "html":
                    # Self-contained HTML rendered live in a sandboxed iframe by
                    # artifact-renderer.svelte. `from` yields the raw HTML string.
                    inline_payload = {"html": str(from_value or "")}
                elif kind == "json":
                    inline_payload = {"value": from_value}
                elif kind == "link":
                    inline_payload = {"url": str(from_value or "")}
                elif kind == "table":
                    # Caller must hand a {columns,rows} object; pass through.
                    inline_payload = from_value if isinstance(from_value, dict) else {"value": from_value}
                else:
                    # Unknown kind — pass through; UI falls back to JSON dump.
                    inline_payload = from_value
            if raw.get("fileId") is not None:
                file_id = evaluate_structure(raw.get("fileId"), expr_context)

            if inline_payload is None and not file_id:
                logger.warning(
                    "[SW Workflow] artifact entry has neither `from` nor `fileId` (task=%s, title=%s); skipping",
                    task_name,
                    title,
                )
                continue
        except SWExpressionError as exc:
            logger.warning(
                "[SW Workflow] artifact expression eval failed (task=%s): %s", task_name, exc
            )
            continue

        try:
            yield ctx.call_activity(
                persist_workflow_artifact,
                input=_freeze(
                    {
                        "executionId": tc.db_execution_id or tc.execution_id,
                        "workflowId": workflow_id,
                        "nodeId": task_name,
                        "slot": slot if slot in ("primary", "secondary", "aux") else None,
                        "kind": kind,
                        "title": title,
                        "description": description if isinstance(description, str) else None,
                        "inlinePayload": inline_payload,
                        "fileId": file_id if isinstance(file_id, str) else None,
                        "contentType": content_type if isinstance(content_type, str) else None,
                        "metadata": metadata if isinstance(metadata, dict) else None,
                        "_otel": tc.otel_ctx,
                    }
                ),
            )
        except Exception as exc:  # pragma: no cover — never let observability break the workflow
            logger.warning(
                "[SW Workflow] persist_workflow_artifact yield failed (task=%s, title=%s): %s",
                task_name,
                title,
                exc,
            )


def _dispatch_task(
    ctx: wf.DaprWorkflowContext,
    task_name: str,
    task_data: dict[str, Any],
    tc: TaskContext,
) -> Any:
    """Dispatch a task by its SW 1.0 type to the appropriate handler."""
    task_type = get_task_type(task_data)

    # Check conditional execution (if field)
    if_expr = task_data.get("if")
    if if_expr is not None and not evaluate_condition(
        if_expr,
        _build_expression_context(
            tc,
            task_input=_resolve_task_input(task_data, tc),
            has_task_input=True,
        ),
    ):
        _log_info(ctx, "[SW Workflow] Skipping task (if=false): %s", task_name)
        _store_task_output(tc, task_name, "skip", {"skipped": True})
        tc.completed_tasks.add(task_name)
        return {"skipped": True}

    match task_type:
        case TaskType.CALL:
            result = yield from _handle_call_task(ctx, task_name, task_data, tc)
        case TaskType.SET:
            result = _handle_set_task(ctx, task_name, task_data, tc)
        case TaskType.SWITCH:
            result = _handle_switch_task(ctx, task_name, task_data, tc)
        case TaskType.WAIT:
            result = yield from _handle_wait_task(ctx, task_name, task_data, tc)
        case TaskType.EMIT:
            result = yield from _handle_emit_task(ctx, task_name, task_data, tc)
        case TaskType.LISTEN:
            result = yield from _handle_listen_task(ctx, task_name, task_data, tc)
        case TaskType.FOR:
            result = yield from _handle_for_task(ctx, task_name, task_data, tc)
        case TaskType.FORK:
            result = yield from _handle_fork_task(ctx, task_name, task_data, tc)
        case TaskType.TRY:
            result = yield from _handle_try_task(ctx, task_name, task_data, tc)
        case TaskType.RUN:
            result = yield from _handle_run_task(ctx, task_name, task_data, tc)
        case TaskType.RAISE:
            result = _handle_raise_task(ctx, task_name, task_data, tc)
        case TaskType.DO:
            result = yield from _handle_do_task(ctx, task_name, task_data, tc)
        case _:
            logger.warning("[SW Workflow] Unknown task type: %s for task: %s", task_type, task_name)
            tc.completed_tasks.add(task_name)
            return None

    # parseJson affordance: when a task declares `parseJson: true`, parse a JSON
    # object out of its (agent/text) output and merge it into the stored output
    # so downstream refs resolve real fields — e.g. a critic node ending its turn
    # with {meets_criteria, feedback} becomes ${ .evaluate.meets_criteria }.
    if isinstance(task_data, dict) and task_data.get("parseJson"):
        _apply_parse_json_affordance(tc, task_name)

    # Post-task hook: persist any declared artifacts. Best-effort — never
    # raises out of this point. See _persist_task_artifacts for the full
    # spec, including supported kinds and idempotency under Dapr retry.
    yield from _persist_task_artifacts(ctx, task_name, task_data, tc)

    return result


# ---------------------------------------------------------------------------
# Main workflow function
# ---------------------------------------------------------------------------

def sw_workflow(ctx: wf.DaprWorkflowContext, input_data: dict) -> dict:
    """
    CNCF Serverless Workflow 1.0 Interpreter

    Parses a SW 1.0 workflow document and executes each task in the `do` list
    using Dapr Workflows as the durable runtime.

    Args:
        ctx: Dapr workflow context
        input_data: SWWorkflowInput as dict (workflow, triggerData, etc.)

    Returns:
        SWWorkflowOutput as dict
    """
    start_time_ms = _now_ms(ctx)
    execution_id = ctx.instance_id

    # Parse input
    workflow_data = input_data.get("workflow", {})
    workflow_id = input_data.get("workflowId")
    trigger_data = input_data.get("triggerData", {})
    code_checkpoint_restore = (
        input_data.get("codeCheckpointRestore")
        if isinstance(input_data.get("codeCheckpointRestore"), dict)
        else None
    )
    integrations = input_data.get("integrations")
    db_execution_id = input_data.get("dbExecutionId")
    otel_ctx = input_data.get("_otel") if isinstance(input_data.get("_otel"), dict) else {}
    trace_id = _trace_id_from_otel(otel_ctx)

    try:
        workflow = Workflow.model_validate(workflow_data)
    except Exception as e:
        logger.error("[SW Workflow] Failed to parse workflow: %s", e)
        if trace_id and _should_finalize_otel_trace_for_trigger(trigger_data):
            workflow_name_for_trace = None
            if isinstance(workflow_data, dict):
                document = workflow_data.get("document")
                if isinstance(document, dict):
                    workflow_name_for_trace = document.get("name")
            yield from _finalize_otel_trace(
                ctx,
                _otel_finalizer_input(
                    status="ERROR",
                    trace_id=trace_id,
                    otel_ctx=otel_ctx,
                    workflow_id=workflow_id or workflow_name_for_trace,
                    workflow_name=workflow_name_for_trace,
                    execution_id=execution_id,
                    db_execution_id=db_execution_id,
                    duration_ms=_elapsed_ms(ctx, start_time_ms),
                    start_time_ms=start_time_ms,
                    error=f"Invalid workflow document: {e}",
                ),
            )
        return SWWorkflowOutput(
            success=False,
            error=f"Invalid workflow document: {e}",
            phase="failed",
        ).model_dump()

    workflow_name = workflow.document.name
    _log_info(ctx, "[SW Workflow] Starting: %s (%s)", workflow_name, execution_id)

    # Initialize task context
    tc = TaskContext(
        workflow=workflow,
        workflow_id=workflow_id,
        trigger_data=trigger_data,
        execution_id=execution_id,
        db_execution_id=db_execution_id,
        integrations=integrations,
    )
    tc.otel_ctx = otel_ctx
    tc.workflow_otel_ctx = otel_ctx
    tc.trace_id = trace_id
    # Resume support: a stable workspace key threaded by the resume caller (defaults to
    # this run's id) + the resumable flag from the spec's x-workflow-builder extension.
    resume_workspace_id = input_data.get("workspaceExecutionId")
    if isinstance(resume_workspace_id, str) and resume_workspace_id.strip():
        tc.workspace_execution_id = resume_workspace_id.strip()
    seed_from = input_data.get("seedWorkspaceFrom")
    if isinstance(seed_from, str) and seed_from.strip():
        tc.seed_workspace_from = seed_from.strip()
    try:
        _xwb = (workflow_data.get("document") or {}).get("x-workflow-builder") or {}
        tc.resumable = _as_bool(_xwb.get("resumable"), False)
    except Exception:
        tc.resumable = False
    tc.trigger_data = resolve_input_definition(
        workflow.input.model_dump(by_alias=True) if workflow.input else None,
        _build_expression_context(tc),
        default_input=tc.trigger_data,
    )
    if not isinstance(tc.trigger_data, dict):
        tc.trigger_data = {"value": tc.trigger_data}
    tc.task_outputs["trigger"]["data"] = tc.trigger_data

    if not _is_replaying(ctx):
        try:
            from tracing import start_activity_span

            short_exec = (db_execution_id or execution_id or "").strip()
            with start_activity_span(
                "workflow.init",
                otel_ctx,
                attributes={
                    "workflow.id": tc.workflow_id,
                    "workflow.name": workflow_name,
                    "workflow.execution.id": short_exec,
                },
            ):
                pass
            try:
                from opentelemetry import trace as ot_trace
                tp = ot_trace.get_tracer_provider()
                if hasattr(tp, "force_flush"):
                    tp.force_flush(timeout_millis=2000)
            except Exception as flush_exc:  # noqa: BLE001
                logger.debug("[SW Workflow] tracer force_flush failed: %s", flush_exc)
            logger.info(
                "[SW Workflow] OTel workflow.init span recorded: trace_id=%s execution=%s",
                tc.trace_id or "<none>",
                short_exec,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("[SW Workflow] workflow.init trace span failed: %s", exc)
    if code_checkpoint_restore:
        tc.task_outputs["codeCheckpointRestore"] = {
            "label": "Code checkpoint restore",
            "actionType": "code_checkpoint_restore",
            "data": code_checkpoint_restore,
        }

    # Unwrap the top-level task list
    tasks = workflow.unwrap_tasks()
    total_tasks = len(tasks)

    # Set initial status (field names match legacy for UI compat)
    ctx.set_custom_status(json.dumps({
        "phase": "running",
        "progress": 0,
        "message": f"Starting workflow: {workflow_name}",
        "traceId": trace_id,
    }
    ))

    try:
        # Execute tasks sequentially, respecting `then` directives
        task_index = 0
        task_name_to_index = {name: idx for idx, (name, _) in enumerate(tasks)}

        # Resume / fork-from-node: this is a FRESH execution (so it runs the CURRENT,
        # possibly edited, spec) that REUSES the source run's retained /sandbox/work
        # and SKIPS every top-level node before `resumeFromNode`. We skip rather than
        # use Dapr's rerun-from-event because that primitive copies the source's
        # workflow input verbatim and cannot apply an edited spec. Skipped prefix
        # nodes do not run (no dispatch) and produce no task output — resumable
        # workflows must hand off via the shared workspace (files), not context refs.
        resume_from_node = input_data.get("resumeFromNode")
        resume_from_index = (
            task_name_to_index.get(resume_from_node)
            if isinstance(resume_from_node, str) and resume_from_node
            else None
        )
        if resume_from_index is not None:
            _log_info(
                ctx,
                "[SW Workflow] Resume/fork: skipping %d node(s) before '%s'; reusing workspace %s",
                resume_from_index,
                resume_from_node,
                getattr(tc, "workspace_execution_id", execution_id),
            )
            # Hermetic fork: seed this fork's fresh workspace from the source run's
            # subPath BEFORE any resumed node runs — node-type-agnostic (covers
            # non-agent suffix nodes that wouldn't get the agent-pod seed init). Blocks
            # until the copy completes; raises if seeding fails (a fork must not run
            # against an empty workspace).
            seed_from = getattr(tc, "seed_workspace_from", None)
            if seed_from:
                yield ctx.call_activity(
                    "seed_workspace",
                    input=_freeze({
                        "workspaceExecutionId": getattr(
                            tc, "workspace_execution_id", execution_id
                        ),
                        "seedWorkspaceFrom": seed_from,
                        "_otel": tc.otel_ctx,
                    }),
                )

        while task_index < total_tasks:
            task_name, task_data = tasks[task_index]

            if resume_from_index is not None and task_index < resume_from_index:
                # Prefix node already ran in the source run — skip (no dispatch).
                _store_task_output(tc, task_name, "skip", {"skipped": True, "resumed": True})
                tc.completed_tasks.add(task_name)
                task_index += 1
                continue

            task_type = get_task_type(task_data)
            tc.otel_ctx = _workflow_activity_otel_context(
                tc=tc,
                task_name=task_name,
                task_type=task_type,
                task_data=task_data,
                task_sequence=task_index,
            )

            # Update status (field names match legacy WorkflowCustomStatus for UI compat)
            ctx.set_custom_status(json.dumps({
                "phase": "running",
                "progress": calculate_progress(len(tc.completed_tasks), total_tasks),
                "message": f"Executing: {task_name}",
                "currentNodeId": task_name,
                "currentNodeName": task_name,
                "traceId": trace_id,
            }))

            # Push the current node onto the DB read-model so current_node_id is
            # fresh at every task start (the custom status above is only synced to
            # the DB lazily on a status/run-detail fetch; unattended/API-triggered
            # runs would otherwise show a stale node — e.g. frozen through the
            # approval gate). Best-effort; never breaks execution.
            if db_execution_id:
                yield ctx.call_activity(
                    update_execution_node,
                    input=_freeze({
                        "executionId": db_execution_id,
                        "nodeId": task_name,
                        "nodeName": task_name,
                    }),
                )

            # Log task start
            log_id = None
            task_start_ms = _now_ms(ctx)
            should_log_directly = _should_log_task_directly(task_type, task_data, workflow)
            if db_execution_id and should_log_directly:
                start_result = yield ctx.call_activity(
                    log_node_start,
                    input=_freeze({
                        "executionId": db_execution_id,
                        "nodeId": task_name,
                        "nodeName": task_name,
                        "nodeType": task_type.value,
                        "actionType": task_type.value,
                        "input": task_data,
                        "_otel": tc.otel_ctx,
                    }),
                )
                log_id = start_result.get("logId")

            # Dispatch the task
            try:
                result = yield from _dispatch_task(ctx, task_name, task_data, tc)
            except Exception as task_err:
                task_duration_ms = _elapsed_ms(ctx, task_start_ms)
                if db_execution_id and log_id:
                    yield ctx.call_activity(
                        log_node_complete,
                        input=_freeze({
                            "executionId": db_execution_id,
                            "logId": log_id,
                            "status": "error",
                            "output": None,
                            "error": str(task_err),
                            "durationMs": task_duration_ms,
                            "_otel": tc.otel_ctx,
                        }),
                    )
                raise

            # Log task completion
            task_duration_ms = _elapsed_ms(ctx, task_start_ms)
            if db_execution_id and log_id:
                if result is None:
                    task_success = True
                elif isinstance(result, dict):
                    task_success = result.get("success", True)
                else:
                    task_success = True
                yield ctx.call_activity(
                    log_node_complete,
                    input=_freeze({
                        "executionId": db_execution_id,
                        "logId": log_id,
                        "status": "success" if task_success else "error",
                        "output": result if isinstance(result, dict) else {"raw": str(result)},
                        "durationMs": task_duration_ms,
                        "_otel": tc.otel_ctx,
                    }),
                )
            if result is None:
                task_success = True
            elif isinstance(result, dict):
                task_success = result.get("success", True)
            else:
                task_success = True
            # Handle `then` flow directive
            then_directive = task_data.get("then")

            if task_type == TaskType.SWITCH and isinstance(result, str):
                # Switch returns the matched case's `then` directive
                then_directive = result

            if then_directive == "end" or then_directive == "exit":
                _log_info(ctx, "[SW Workflow] Flow directive: %s at task: %s", then_directive, task_name)
                tc.otel_ctx = tc.workflow_otel_ctx
                break
            elif then_directive and then_directive != "continue":
                # Jump to named task
                target_index = task_name_to_index.get(then_directive)
                if target_index is not None:
                    tc.otel_ctx = tc.workflow_otel_ctx
                    task_index = target_index
                    continue
                else:
                    logger.warning(
                        "[SW Workflow] then directive references unknown task: %s",
                        then_directive,
                    )

            tc.otel_ctx = tc.workflow_otel_ctx
            task_index += 1

        # Workflow completed successfully
        duration_ms = _elapsed_ms(ctx, start_time_ms)
        ctx.set_custom_status(json.dumps({
            "phase": "completed",
            "progress": 100,
            "message": "Workflow completed",
            "traceId": trace_id,
        }))

        # Persist results
        workflow_output = resolve_output_definition(
            workflow.output.model_dump(by_alias=True) if workflow.output else None,
            _build_expression_context(tc),
            default_output=tc.task_outputs,
        )
        if db_execution_id:
            yield ctx.call_activity(
                persist_results_to_db,
                input=_freeze({
                    "executionId": execution_id,
                    "dbExecutionId": db_execution_id,
                    "success": True,
                    "outputs": tc.task_outputs,
                    "workflowOutput": workflow_output,
                    "durationMs": duration_ms,
                    "phase": "completed",
                    "_otel": tc.otel_ctx,
                }),
            )

        # Workspace cleanup unless
        # the caller explicitly asked to keep the sandbox alive for post-run use.
        # Resumable workflows retain their workspace on ANY terminal state (success
        # too) so a completed run can be FORKED from a later node for fast iteration
        # without re-running the prefix. (Bounded by the 168h Dapr-history window; an
        # abandoned-resumable-workspace reaper is a tracked follow-up.)
        if getattr(tc, "resumable", False):
            _log_info(
                ctx,
                "[SW Workflow] Retaining workspace after success (resumable=true) for resume/fork-from-step",
            )
            yield ctx.call_activity(
                "register_resumable_workspace",
                input=_freeze({
                    "workspaceRef": getattr(tc, "workspace_execution_id", execution_id),
                    "dbExecutionId": db_execution_id,
                    "_otel": tc.otel_ctx,
                }),
            )
        elif _should_cleanup_workspaces(tc):
            try:
                from activities.call_agent_service import cleanup_execution_workspaces

                yield ctx.call_activity(
                    cleanup_execution_workspaces,
                    input=_freeze({
                        "executionId": execution_id,
                        "dbExecutionId": db_execution_id,
                        "_otel": tc.otel_ctx,
                    }),
                )
            except Exception as cleanup_err:
                _log_info(
                    ctx,
                    "[SW Workflow] Workspace cleanup failed (non-fatal): %s",
                    cleanup_err,
                )
        else:
            _log_info(
                ctx,
                "[SW Workflow] Skipping workspace cleanup because keepSandbox was requested",
            )

        if _should_finalize_otel_trace_for_trigger(tc.trigger_data):
            yield from _finalize_otel_trace(
                ctx,
                _otel_finalizer_input(
                    status="OK",
                    trace_id=trace_id,
                    otel_ctx=tc.otel_ctx,
                    workflow_id=tc.workflow_id,
                    workflow_name=workflow_name,
                    execution_id=execution_id,
                    db_execution_id=db_execution_id,
                    duration_ms=duration_ms,
                    start_time_ms=start_time_ms,
                ),
            )

        return SWWorkflowOutput(
            success=True,
            outputs=tc.task_outputs,
            workflowOutput=workflow_output,
            duration_ms=duration_ms,
            phase="completed",
        ).model_dump(by_alias=True)

    except Exception as e:
        tc.otel_ctx = tc.workflow_otel_ctx
        duration_ms = _elapsed_ms(ctx, start_time_ms)
        error_msg = str(e)
        logger.error("[SW Workflow] Failed: %s - %s", workflow_name, error_msg)
        workflow_output = resolve_output_definition(
            workflow.output.model_dump(by_alias=True) if workflow.output else None,
            _build_expression_context(tc),
            default_output=tc.task_outputs,
        )

        ctx.set_custom_status(json.dumps({
            "phase": "failed",
            "progress": calculate_progress(len(tc.completed_tasks), total_tasks),
            "message": f"Failed: {error_msg}",
            "traceId": trace_id,
        }))

        if db_execution_id:
            yield ctx.call_activity(
                persist_results_to_db,
                input=_freeze({
                    "executionId": execution_id,
                    "dbExecutionId": db_execution_id,
                    "success": False,
                    "outputs": tc.task_outputs,
                    "workflowOutput": workflow_output,
                    "error": error_msg,
                    "durationMs": duration_ms,
                    "phase": "failed",
                    "_otel": tc.otel_ctx,
                }),
            )

        if getattr(tc, "resumable", False):
            # Retain the shared workspace on failure so the run can be resumed from the
            # failed node against the same /sandbox/work (cleanup would delete the
            # cloned repo + SPEC.md/contract.json the resume needs).
            _log_info(
                ctx,
                "[SW Workflow] Retaining workspace after failure (resumable=true) for resume-from-step",
            )
            yield ctx.call_activity(
                "register_resumable_workspace",
                input=_freeze({
                    "workspaceRef": getattr(tc, "workspace_execution_id", execution_id),
                    "dbExecutionId": db_execution_id,
                    "_otel": tc.otel_ctx,
                }),
            )
        elif _should_cleanup_workspaces(tc):
            try:
                from activities.call_agent_service import cleanup_execution_workspaces

                yield ctx.call_activity(
                    cleanup_execution_workspaces,
                    input=_freeze({
                        "executionId": execution_id,
                        "dbExecutionId": db_execution_id,
                        "_otel": tc.otel_ctx,
                    }),
                )
            except Exception as cleanup_err:
                _log_info(
                    ctx,
                    "[SW Workflow] Workspace cleanup after failure failed (non-fatal): %s",
                    cleanup_err,
                )

        if _should_finalize_otel_trace_for_trigger(tc.trigger_data):
            yield from _finalize_otel_trace(
                ctx,
                _otel_finalizer_input(
                    status="ERROR",
                    trace_id=trace_id,
                    otel_ctx=tc.otel_ctx,
                    workflow_id=tc.workflow_id,
                    workflow_name=workflow_name,
                    execution_id=execution_id,
                    db_execution_id=db_execution_id,
                    duration_ms=duration_ms,
                    start_time_ms=start_time_ms,
                    error=error_msg,
                ),
            )

        return SWWorkflowOutput(
            success=False,
            outputs=tc.task_outputs,
            workflowOutput=workflow_output,
            error=error_msg,
            duration_ms=duration_ms,
            phase="failed",
        ).model_dump(by_alias=True)
