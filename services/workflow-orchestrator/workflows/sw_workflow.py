"""
CNCF Serverless Workflow 1.0 Interpreter

Executes SW 1.0 workflow documents using Dapr Workflows as the durable runtime.
Replaces the custom dynamic_workflow interpreter by dispatching on SW 1.0 task types
instead of custom node types.

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
from datetime import timedelta
from typing import Any

import dapr.ext.workflow as wf

from core.sw_types import (
    TaskType,
    Workflow,
    SWWorkflowInput,
    SWWorkflowOutput,
    SWWorkflowCustomStatus,
    get_task_type,
)
from core.template_resolver import resolve_templates, NodeOutputs
from core.cel_loop import eval_cel_boolean
from activities.execute_action import execute_action
from activities.persist_state import persist_state
from activities.publish_event import publish_phase_changed
from activities.log_external_event import (
    log_approval_request,
    log_approval_response,
    log_approval_timeout,
)
from activities.log_node_execution import log_node_start, log_node_complete
from activities.persist_results_to_db import persist_results_to_db

logger = logging.getLogger(__name__)

# Workflow runtime instance
wfr = wf.WorkflowRuntime()


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


# ---------------------------------------------------------------------------
# Task execution context
# ---------------------------------------------------------------------------

class TaskContext:
    """Mutable state carried through task execution."""

    def __init__(
        self,
        workflow: Workflow,
        trigger_data: dict[str, Any],
        execution_id: str,
        db_execution_id: str | None,
        integrations: dict[str, dict[str, str]] | None,
    ):
        self.workflow = workflow
        self.trigger_data = trigger_data
        self.execution_id = execution_id
        self.db_execution_id = db_execution_id
        self.integrations = integrations

        # OTEL context
        self.otel_ctx: dict[str, str] = {}
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
            return {
                "protocol": func_def.call,
                "args": merged_args,
                "functionName": call_value,
            }

    # Fallback: treat as custom function name
    return {
        "protocol": "function",
        "functionName": call_value,
        "args": with_args,
    }


# Agent action types that require multi-turn child workflow execution
# (not single-shot HTTP calls through function-router)
_AGENT_ACTION_TYPES = {
    "openshell/run",
    "openshell/session-start",
    "openshell-langgraph/run",
    "openshell-langgraph-observable/run",
}


def _handle_call_task(
    ctx: wf.DaprWorkflowContext,
    task_name: str,
    task_data: dict[str, Any],
    tc: TaskContext,
) -> Any:
    """Execute a call task via function-router / Dapr service invocation.

    Agent actions (openshell/*, langgraph/*) are dispatched through the
    legacy process_agent_child_workflow which handles multi-turn LLM agent
    loops, plan approval gates, child workflow orchestration, and progress
    tracking. All other calls go through execute_action as single-shot HTTP.
    """
    resolved = _resolve_function_call(task_data, tc.workflow)
    action_type = resolved.get("functionName") or f"{resolved['protocol']}-call"

    _log_info(ctx, "[SW Workflow] call task: %s (action=%s)", task_name, action_type)

    # Agent actions: delegate to legacy child workflow orchestrator
    if action_type in _AGENT_ACTION_TYPES:
        from workflows.dynamic_workflow import process_agent_child_workflow

        node_compat = {
            "id": task_name,
            "type": "action",
            "label": task_name,
            "config": {
                "actionType": action_type,
                **resolved.get("args", {}),
            },
        }

        result = yield from process_agent_child_workflow(
            ctx=ctx,
            node=node_compat,
            node_outputs=tc.task_outputs,
            node_execution_counts={},
            action_type=action_type,
            integrations=tc.integrations,
            db_execution_id=tc.db_execution_id,
            connection_external_id=None,
            workflow_id=tc.workflow.document.name,
            execution_id=tc.execution_id,
            otel_ctx=tc.otel_ctx,
        )

        tc.task_outputs[task_name] = result
        tc.completed_tasks.add(task_name)

        if isinstance(result, dict) and not result.get("success", True):
            raise RuntimeError(result.get("error") or f"Agent action failed: {task_name}")

        return result

    # Standard call: single-shot HTTP via function-router
    # Resolve template variables ({{@nodeId:field}}) in the task args
    raw_config = {
        "actionType": action_type,
        **resolved.get("args", {}),
    }
    resolved_config = resolve_templates(raw_config, tc.task_outputs)

    node_compat = {
        "id": task_name,
        "type": "action",
        "label": task_name,
        "config": resolved_config if isinstance(resolved_config, dict) else raw_config,
    }

    result = yield ctx.call_activity(
        execute_action,
        input=_freeze({
            "node": node_compat,
            "nodeOutputs": tc.task_outputs,
            "executionId": tc.execution_id,
            "workflowId": tc.workflow.document.name,
            "integrations": tc.integrations,
            "dbExecutionId": tc.db_execution_id,
            "_otel": tc.otel_ctx,
        }),
    )

    # Store in NodeOutputs format for cross-node template resolution
    tc.task_outputs[task_name] = {
        "label": task_name,
        "actionType": action_type,
        "data": result,
    }
    tc.completed_tasks.add(task_name)

    if not result.get("success", True):
        raise RuntimeError(result.get("error") or f"Call task failed: {task_name}")

    return result


def _handle_set_task(
    ctx: wf.DaprWorkflowContext,
    task_name: str,
    task_data: dict[str, Any],
    tc: TaskContext,
) -> Any:
    """Execute a set task: update state variables."""
    assignments = task_data.get("set", {})
    _log_info(ctx, "[SW Workflow] set task: %s (keys=%s)", task_name, list(assignments.keys()))

    for key, value in assignments.items():
        tc.state_vars[key] = value

    # Store in NodeOutputs format for resolve_templates compatibility
    result = {"success": True, "data": dict(tc.state_vars)}
    tc.task_outputs[task_name] = {
        "label": task_name,
        "actionType": "set",
        "data": result,
    }
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

    # Build evaluation context from task outputs and state
    eval_context = {
        "input": tc.trigger_data,
        "state": tc.state_vars,
    }
    # Add task outputs as top-level context for CEL evaluation
    for key, val in tc.task_outputs.items():
        if key != "__trigger__" and isinstance(val, dict):
            data = val.get("data", val)
            eval_context[key] = data

    for case_item in cases:
        for case_name, case_def in case_item.items():
            when_expr = case_def.get("when")

            # Default case (no when condition)
            if when_expr is None:
                tc.completed_tasks.add(task_name)
                tc.task_outputs[task_name] = {"matched": case_name}
                return case_def.get("then")

            # Evaluate condition via CEL (strip ${ } wrapper if present)
            expr = str(when_expr).strip()
            if expr.startswith("${") and expr.endswith("}"):
                expr = expr[2:-1].strip()
            if expr.startswith("."):
                expr = expr[1:]  # Remove leading dot for CEL compat

            try:
                matched = eval_cel_boolean(expr, eval_context)
            except Exception:
                # Fallback: truthy string evaluation
                matched = expr.lower() not in ("false", "0", "")

            if matched:
                tc.completed_tasks.add(task_name)
                tc.task_outputs[task_name] = {"matched": case_name}
                return case_def.get("then")

    tc.completed_tasks.add(task_name)
    tc.task_outputs[task_name] = {"matched": None}
    return None  # No case matched, continue default flow


def _handle_wait_task(
    ctx: wf.DaprWorkflowContext,
    task_name: str,
    task_data: dict[str, Any],
    tc: TaskContext,
) -> Any:
    """Execute a wait task: create a Dapr timer."""
    duration = task_data.get("wait", "PT0S")
    td = _parse_duration(duration)
    _log_info(ctx, "[SW Workflow] wait task: %s (duration=%s)", task_name, td)

    yield ctx.create_timer(td)

    result = {"success": True, "data": {"waited": str(td)}}
    tc.task_outputs[task_name] = result
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
    event_with = event_def.get("with", {})
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

    tc.task_outputs[task_name] = {"success": True, "data": result}
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

    tc.task_outputs[task_name] = result
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

    _log_info(ctx, "[SW Workflow] for task: %s (each=%s)", task_name, each_var)

    # Resolve the collection to iterate
    # TODO: evaluate runtime expression for `in`
    items = tc.task_outputs.get(in_expr, []) if isinstance(in_expr, str) else in_expr
    if not isinstance(items, list):
        items = list(items) if hasattr(items, "__iter__") else [items]

    iteration_results = []
    for idx, item in enumerate(items):
        # Set iteration variables in state
        tc.state_vars[each_var] = item
        tc.state_vars[at_var] = idx

        # TODO: evaluate while expression for early termination

        # Execute sub-tasks
        for sub_item in sub_tasks:
            for sub_name, sub_data in sub_item.items():
                iter_task_name = f"{task_name}/{sub_name}[{idx}]"
                yield from _dispatch_task(ctx, iter_task_name, sub_data, tc)

        iteration_results.append(item)

    result = {"success": True, "data": {"iterations": len(iteration_results)}}
    tc.task_outputs[task_name] = result
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
    _log_info(ctx, "[SW Workflow] fork task: %s (%d branches)", task_name, len(branches))

    # Execute branches sequentially (Dapr doesn't natively support parallel activities
    # within a single workflow function without fan-out/fan-in patterns)
    branch_results = {}
    for branch_item in branches:
        for branch_name, branch_data in branch_item.items():
            branch_task_name = f"{task_name}/{branch_name}"
            result = yield from _dispatch_task(ctx, branch_task_name, branch_data, tc)
            branch_results[branch_name] = result

    tc.task_outputs[task_name] = {"success": True, "data": branch_results}
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
    _log_info(ctx, "[SW Workflow] try task: %s", task_name)

    try:
        for sub_item in try_tasks:
            for sub_name, sub_data in sub_item.items():
                yield from _dispatch_task(ctx, f"{task_name}/try/{sub_name}", sub_data, tc)
        result = {"success": True}
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
        result = {"success": False, "error": str(e)}

    tc.task_outputs[task_name] = result
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
    _log_info(ctx, "[SW Workflow] run task: %s (type=%s)", task_name, list(run_config.keys()))

    if "workflow" in run_config:
        wf_config = run_config["workflow"]
        child_wf_name = wf_config.get("name", "")
        child_input = wf_config.get("input", {})

        # Check if this is an agent workflow that needs the full orchestration
        agent_action_type = child_input.get("actionType", "")
        if agent_action_type in _AGENT_ACTION_TYPES:
            from workflows.dynamic_workflow import process_agent_child_workflow

            _log_info(ctx, "[SW Workflow] Running agent workflow: %s (%s)", child_wf_name, agent_action_type)
            node_compat = {
                "id": task_name,
                "type": "action",
                "label": task_name,
                "config": {
                    "actionType": agent_action_type,
                    **child_input,
                },
            }
            result = yield from process_agent_child_workflow(
                ctx=ctx,
                node=node_compat,
                node_outputs=tc.task_outputs,
                node_execution_counts={},
                action_type=agent_action_type,
                integrations=tc.integrations,
                db_execution_id=tc.db_execution_id,
                connection_external_id=None,
                workflow_id=tc.workflow.document.name,
                execution_id=tc.execution_id,
                otel_ctx=tc.otel_ctx,
            )
            tc.task_outputs[task_name] = result
            tc.completed_tasks.add(task_name)
            return result

        # Standard child workflow invocation
        _log_info(ctx, "[SW Workflow] Running child workflow: %s", child_wf_name)
        result = yield ctx.call_child_workflow(
            child_wf_name,
            input=_freeze(child_input),
        )
        tc.task_outputs[task_name] = result
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
                "workflowId": tc.workflow.document.name,
                "dbExecutionId": tc.db_execution_id,
                "_otel": tc.otel_ctx,
            }),
        )
        tc.task_outputs[task_name] = result
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
            "workflowId": tc.workflow.document.name,
            "dbExecutionId": tc.db_execution_id,
            "_otel": tc.otel_ctx,
        }),
    )
    tc.task_outputs[task_name] = result
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
    error_msg = error_def.get("detail") or error_def.get("title") or f"Error raised at {task_name}"
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
    _log_info(ctx, "[SW Workflow] do task: %s (%d sub-tasks)", task_name, len(sub_tasks))

    for sub_item in sub_tasks:
        for sub_name, sub_data in sub_item.items():
            yield from _dispatch_task(ctx, f"{task_name}/{sub_name}", sub_data, tc)

    result = {"success": True}
    tc.task_outputs[task_name] = result
    tc.completed_tasks.add(task_name)
    return result


# ---------------------------------------------------------------------------
# Task dispatcher
# ---------------------------------------------------------------------------

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
    if if_expr and str(if_expr).lower() in ("false", "0"):
        _log_info(ctx, "[SW Workflow] Skipping task (if=false): %s", task_name)
        tc.task_outputs[task_name] = {"skipped": True}
        tc.completed_tasks.add(task_name)
        return {"skipped": True}

    match task_type:
        case TaskType.CALL:
            return (yield from _handle_call_task(ctx, task_name, task_data, tc))
        case TaskType.SET:
            return _handle_set_task(ctx, task_name, task_data, tc)
        case TaskType.SWITCH:
            return _handle_switch_task(ctx, task_name, task_data, tc)
        case TaskType.WAIT:
            return (yield from _handle_wait_task(ctx, task_name, task_data, tc))
        case TaskType.EMIT:
            return (yield from _handle_emit_task(ctx, task_name, task_data, tc))
        case TaskType.LISTEN:
            return (yield from _handle_listen_task(ctx, task_name, task_data, tc))
        case TaskType.FOR:
            return (yield from _handle_for_task(ctx, task_name, task_data, tc))
        case TaskType.FORK:
            return (yield from _handle_fork_task(ctx, task_name, task_data, tc))
        case TaskType.TRY:
            return (yield from _handle_try_task(ctx, task_name, task_data, tc))
        case TaskType.RUN:
            return (yield from _handle_run_task(ctx, task_name, task_data, tc))
        case TaskType.RAISE:
            return _handle_raise_task(ctx, task_name, task_data, tc)
        case TaskType.DO:
            return (yield from _handle_do_task(ctx, task_name, task_data, tc))
        case _:
            logger.warning("[SW Workflow] Unknown task type: %s for task: %s", task_type, task_name)
            tc.completed_tasks.add(task_name)
            return None


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
    trigger_data = input_data.get("triggerData", {})
    integrations = input_data.get("integrations")
    db_execution_id = input_data.get("dbExecutionId")
    otel_ctx = input_data.get("_otel") or {}
    trace_id = _trace_id_from_otel(otel_ctx)

    try:
        workflow = Workflow.model_validate(workflow_data)
    except Exception as e:
        logger.error("[SW Workflow] Failed to parse workflow: %s", e)
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
        trigger_data=trigger_data,
        execution_id=execution_id,
        db_execution_id=db_execution_id,
        integrations=integrations,
    )
    tc.otel_ctx = otel_ctx
    tc.trace_id = trace_id

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

        while task_index < total_tasks:
            task_name, task_data = tasks[task_index]

            # Update status (field names match legacy WorkflowCustomStatus for UI compat)
            ctx.set_custom_status(json.dumps({
                "phase": "running",
                "progress": calculate_progress(len(tc.completed_tasks), total_tasks),
                "message": f"Executing: {task_name}",
                "currentNodeId": task_name,
                "currentNodeName": task_name,
                "traceId": trace_id,
            }))

            # Log task start
            log_id = None
            task_start_ms = _now_ms(ctx)
            if db_execution_id:
                task_type = get_task_type(task_data)
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
            task_type = get_task_type(task_data)
            result = yield from _dispatch_task(ctx, task_name, task_data, tc)

            # Log task completion
            if db_execution_id and log_id:
                task_duration_ms = _elapsed_ms(ctx, task_start_ms)
                task_success = isinstance(result, dict) and result.get("success", True) if result else True
                yield ctx.call_activity(
                    log_node_complete,
                    input=_freeze({
                        "logId": log_id,
                        "status": "success" if task_success else "error",
                        "output": result if isinstance(result, dict) else {"raw": str(result)},
                        "durationMs": task_duration_ms,
                        "_otel": tc.otel_ctx,
                    }),
                )

            # Handle `then` flow directive
            then_directive = task_data.get("then")

            if task_type == TaskType.SWITCH and isinstance(result, str):
                # Switch returns the matched case's `then` directive
                then_directive = result

            if then_directive == "end" or then_directive == "exit":
                _log_info(ctx, "[SW Workflow] Flow directive: %s at task: %s", then_directive, task_name)
                break
            elif then_directive and then_directive != "continue":
                # Jump to named task
                target_index = task_name_to_index.get(then_directive)
                if target_index is not None:
                    task_index = target_index
                    continue
                else:
                    logger.warning(
                        "[SW Workflow] then directive references unknown task: %s",
                        then_directive,
                    )

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
        if db_execution_id:
            yield ctx.call_activity(
                persist_results_to_db,
                input=_freeze({
                    "executionId": execution_id,
                    "dbExecutionId": db_execution_id,
                    "success": True,
                    "outputs": tc.task_outputs,
                    "durationMs": duration_ms,
                    "phase": "completed",
                    "_otel": tc.otel_ctx,
                }),
            )

        # Workspace cleanup (matches legacy dynamic_workflow behavior)
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
            _log_info(ctx, "[SW Workflow] Workspace cleanup failed (non-fatal): %s", cleanup_err)

        return SWWorkflowOutput(
            success=True,
            outputs=tc.task_outputs,
            duration_ms=duration_ms,
            phase="completed",
        ).model_dump(by_alias=True)

    except Exception as e:
        duration_ms = _elapsed_ms(ctx, start_time_ms)
        error_msg = str(e)
        logger.error("[SW Workflow] Failed: %s - %s", workflow_name, error_msg)

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
                    "error": error_msg,
                    "durationMs": duration_ms,
                    "phase": "failed",
                    "_otel": tc.otel_ctx,
                }),
            )

        return SWWorkflowOutput(
            success=False,
            outputs=tc.task_outputs,
            error=error_msg,
            duration_ms=duration_ms,
            phase="failed",
        ).model_dump(by_alias=True)
