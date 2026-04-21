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
from datetime import timedelta
from typing import Any

import dapr.ext.workflow as wf

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


def _unwrap_standardized_output(value: Any) -> Any:
    if (
        isinstance(value, dict)
        and isinstance(value.get("success"), bool)
        and "data" in value
    ):
        return value.get("data")
    return value


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
    _ = task_data, workflow
    # All call-task execution paths already persist their own node logs:
    # - function-router single-shot actions
    # - tracked agent child workflows
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
    # and flattens body.input into top-level input for fn-activepieces.
    if "/" in call_value and not call_value.startswith("http"):
        parts = call_value.split("/", 1)
        piece_name = parts[0]
        action_name = parts[1] if len(parts) > 1 else ""
        action_type = call_value

        # Flatten: move body.input to top-level input for fn-activepieces
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

_NATIVE_DURABLE_AGENT_TARGETS = {
    "dapr-agent-py": {
        "workflow_name": config.DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME,
        "app_id": config.DAPR_AGENT_PY_APP_ID,
        "instance_prefix": "durable",
    },
    "dapr-agent-py-testing": {
        "workflow_name": config.DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME,
        "app_id": config.DAPR_AGENT_PY_TESTING_APP_ID,
        "instance_prefix": "durable-testing",
    },
}


def _resolve_native_agent_runtime(
    flattened_args: dict[str, Any],
    agent_config: dict[str, Any] | None,
) -> tuple[str, dict[str, str]]:
    """Resolve the Dapr app-id + child workflow name to dispatch a durable/run.

    Per-agent-runtime plan: the resolver stamps `agentAppId` (e.g.
    `agent-runtime-<slug>`) into the body, derived from agents.runtime_app_id.
    When present, it takes precedence over the legacy `agentRuntime` enum
    (`dapr-agent-py` | `dapr-agent-py-testing`). Legacy enum stays supported
    through the rollout window; unrecognized runtimes default to
    agent-runtime-<slug> if agentSlug is known, else hard-fail.
    """
    agent_app_id = (
        flattened_args.get("agentAppId").strip()
        if isinstance(flattened_args.get("agentAppId"), str)
        and flattened_args.get("agentAppId").strip()
        else agent_config.get("agentAppId").strip()
        if isinstance(agent_config, dict)
        and isinstance(agent_config.get("agentAppId"), str)
        and agent_config.get("agentAppId").strip()
        else ""
    )

    if agent_app_id:
        return agent_app_id, {
            "workflow_name": config.DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME,
            "app_id": agent_app_id,
            "instance_prefix": "durable",
        }

    # Fallback to the legacy shared-pod enum during the rollout window.
    runtime = (
        flattened_args.get("agentRuntime").strip()
        if isinstance(flattened_args.get("agentRuntime"), str)
        and flattened_args.get("agentRuntime").strip()
        else flattened_args.get("runtime").strip()
        if isinstance(flattened_args.get("runtime"), str)
        and flattened_args.get("runtime").strip()
        else agent_config.get("runtime").strip()
        if isinstance(agent_config, dict)
        and isinstance(agent_config.get("runtime"), str)
        and agent_config.get("runtime").strip()
        else agent_config.get("agentRuntime").strip()
        if isinstance(agent_config, dict)
        and isinstance(agent_config.get("agentRuntime"), str)
        and agent_config.get("agentRuntime").strip()
        else "dapr-agent-py"
    )
    if runtime in _NATIVE_DURABLE_AGENT_TARGETS:
        return runtime, _NATIVE_DURABLE_AGENT_TARGETS[runtime]

    # Per-agent-runtime plan: if the resolver didn't stamp agentAppId but
    # agentSlug is present, derive the per-agent runtime on the fly. This
    # keeps older workflow specs working without re-publishing.
    agent_slug = (
        flattened_args.get("agentSlug").strip()
        if isinstance(flattened_args.get("agentSlug"), str)
        and flattened_args.get("agentSlug").strip()
        else agent_config.get("slug").strip()
        if isinstance(agent_config, dict)
        and isinstance(agent_config.get("slug"), str)
        and agent_config.get("slug").strip()
        else ""
    )
    if agent_slug:
        derived = f"agent-runtime-{agent_slug}"
        return derived, {
            "workflow_name": config.DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME,
            "app_id": derived,
            "instance_prefix": "durable",
        }

    allowed = ", ".join(sorted(_NATIVE_DURABLE_AGENT_TARGETS))
    raise RuntimeError(
        f"Unsupported durable/run agentRuntime '{runtime}' and no agentAppId/agentSlug in body. "
        f"Allowed legacy runtimes: {allowed}"
    )


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
) -> str:
    normalized_cwd = cwd.strip() if isinstance(cwd, str) and cwd.strip() else None
    normalized_stop_condition = (
        stop_condition.strip()
        if isinstance(stop_condition, str) and stop_condition.strip()
        else None
    )
    graph_context = _build_agent_graph_prompt_context(agent_graph)
    cwd_context = (
        f"Repository root: {normalized_cwd}\n"
        "Always operate relative to this repository root for file and directory paths.\n\n"
        if normalized_cwd
        else ""
    )
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


def _next_task_execution_count(tc: "TaskContext", task_name: str) -> int:
    current = tc.task_execution_counts.get(task_name, 0)
    tc.task_execution_counts[task_name] = current + 1
    return current


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
    agent_runtime, target = _resolve_native_agent_runtime(flattened_args, agent_config)
    child_execution_index = _next_task_execution_count(tc, task_name)
    child_instance_id = (
        f"{ctx.instance_id}__{target['instance_prefix']}__{task_name}__run__{child_execution_index}"
    )

    timeout_minutes = max(
        1,
        _parse_optional_int(flattened_args.get("timeoutMinutes")) or 30,
    )
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
    )
    workspace_ref = (
        flattened_args.get("workspaceRef").strip()
        if isinstance(flattened_args.get("workspaceRef"), str)
        and flattened_args.get("workspaceRef").strip()
        else None
    )
    if not workspace_ref and agent_runtime in {"dapr-agent-py", "dapr-agent-py-testing"}:
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
    should_resolve_project_mcp = mcp_connection_mode in {
        "project",
        "auto",
        "all",
    }
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

    child_input = {
        "task": run_prompt,
        "prompt": prompt,
        "workflow_instance_id": child_instance_id,
        "parentExecutionId": ctx.instance_id,
        "executionId": tc.db_execution_id or tc.execution_id,
        "workflowExecutionId": tc.db_execution_id or tc.execution_id,
        "workflowId": tc.workflow_id,
        "nodeId": task_name,
        "nodeName": task_name,
        "agentRunId": child_instance_id,
        "workspaceRef": workspace_ref,
        "agentRuntime": agent_runtime,
        "stopCondition": stop_condition or None,
        "cwd": cwd,
        "requireFileChanges": require_file_changes,
        "timeoutMinutes": timeout_minutes,
        "agentConfig": agent_config,
        "agentGraph": agent_graph if isinstance(agent_graph, dict) else None,
        "loopPolicy": flattened_args.get("loopPolicy")
        if isinstance(flattened_args.get("loopPolicy"), dict)
        else None,
        "loopStrategyName": loop_strategy_name,
        "maxIterations": _parse_optional_int(flattened_args.get("maxTurns")),
        "_message_metadata": {
            "source": action_type,
            "triggering_workflow_instance_id": ctx.instance_id,
            "executionId": tc.db_execution_id or tc.execution_id,
            "workflowExecutionId": tc.db_execution_id or tc.execution_id,
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

    if tc.db_execution_id:
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

    if tc.db_execution_id:
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
    # against dapr-agent-py routes through session_workflow so the run appears
    # in /sessions/{id} with full event history and reuses the same runtime
    # path as UI-initiated sessions. The previous WORKFLOW_USE_SESSIONS feature
    # flag (OFF branch = direct call_child_workflow("agent_workflow", ...))
    # was removed in Deploy B of the CMA-alignment plan after the flag had
    # been on in production since 2026-04-17 with no issues.
    # Route every agent_workflow dispatch through session_workflow. This
    # matches both the legacy shared-pod path (app_id=dapr-agent-py) and the
    # per-agent runtime path (app_id=agent-runtime-<slug>); session_workflow
    # is registered on both pods via the same source tree.
    session_bridge_eligible = target.get("workflow_name") == "agent_workflow"

    if session_bridge_eligible:
        from activities.spawn_session import spawn_session_for_workflow

        # userId + projectId are resolved server-side from workflow_executions
        # by the internal endpoint, so we don't need them in TaskContext.
        bridge_payload = {
            "sessionId": child_instance_id,
            "workflowId": tc.workflow_id,
            "nodeId": task_name,
            "workflowExecutionId": tc.db_execution_id or tc.execution_id,
            "parentExecutionId": ctx.instance_id,
            "agentConfig": agent_config,
            "environmentConfig": child_input.get("environmentConfig"),
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
            "agentAppId": target.get("app_id"),
            "agentSlug": flattened_args.get("agentSlug")
            or (agent_config.get("slug") if isinstance(agent_config, dict) else None),
            # Sandbox plumbing — forwarded to ensure-for-workflow which in turn
            # embeds these in childInput so session_workflow can forward them
            # to agent_workflow. Required for any durable/run that uses
            # OpenShell tools (the runtime refuses to bind a sandbox without
            # a non-empty sandboxName or a workspaceRef starting with "ws_").
            "workspaceRef": workspace_ref,
            "sandboxName": flattened_args.get("sandboxName"),
            "cwd": cwd,
            "_otel": tc.otel_ctx,
        }
        bridge_result = yield ctx.call_activity(
            spawn_session_for_workflow, input=_freeze(bridge_payload)
        )
        bridge_child_input = bridge_result.get("childInput") if isinstance(
            bridge_result, dict
        ) else None
        if not isinstance(bridge_child_input, dict):
            raise RuntimeError(
                f"workflow↔session bridge: invalid bridge_result for {child_instance_id}"
            )

        child_result = yield ctx.call_child_workflow(
            "session_workflow",
            input=_freeze(bridge_child_input),
            instance_id=child_instance_id,
            # Per-agent-runtime plan: dispatch session_workflow to the
            # agent's dedicated pod (target["app_id"] == "agent-runtime-<slug>"
            # or legacy "dapr-agent-py" / "dapr-agent-py-testing").
            app_id=target["app_id"],
        )
    else:
        child_result = yield ctx.call_child_workflow(
            target["workflow_name"],
            input=_freeze(child_input),
            instance_id=child_instance_id,
            app_id=target["app_id"],
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
        child_result.setdefault("childAppId", target["app_id"])
        child_result.setdefault("sessionId", child_instance_id)
    else:
        child_result.setdefault("childWorkflowName", target["workflow_name"])
        child_result.setdefault("childAppId", target["app_id"])
    child_result.setdefault("agentRuntime", agent_runtime)
    if "success" not in child_result:
        child_result["success"] = not bool(child_result.get("error"))
    success = bool(child_result.get("success", True))
    if tc.db_execution_id:
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

            if isinstance(result, dict) and not result.get("success", True):
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
    # so fn-activepieces receives them as flat propsValue fields while preserving
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

    result = yield ctx.call_activity(
        execute_action,
        input=_freeze({
            "node": node_compat,
            "nodeOutputs": tc.task_outputs,
            "executionId": tc.execution_id,
            "workflowId": tc.workflow_id,
            "integrations": tc.integrations,
            "dbExecutionId": tc.db_execution_id,
            "connectionExternalId": connection_external_id,
            "_otel": tc.otel_ctx,
        }),
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

    # Store in NodeOutputs format for cross-node template resolution
    _store_task_output(tc, task_name, action_type, result)
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

    iteration_results = []
    for idx, item in enumerate(items):
        # Set iteration variables in state
        tc.state_vars[each_var] = item
        tc.state_vars[at_var] = idx

        if while_expr is not None:
            loop_context = _build_expression_context(tc, task_input=task_input, has_task_input=True)
            if not evaluate_condition(while_expr, loop_context):
                break

        # Execute sub-tasks
        for sub_item in sub_tasks:
            for sub_name, sub_data in sub_item.items():
                iter_task_name = f"{task_name}/{sub_name}[{idx}]"
                yield from _dispatch_task(ctx, iter_task_name, sub_data, tc)

        iteration_results.append(item)

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
    workflow_id = input_data.get("workflowId")
    trigger_data = input_data.get("triggerData", {})
    code_checkpoint_restore = (
        input_data.get("codeCheckpointRestore")
        if isinstance(input_data.get("codeCheckpointRestore"), dict)
        else None
    )
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
        workflow_id=workflow_id,
        trigger_data=trigger_data,
        execution_id=execution_id,
        db_execution_id=db_execution_id,
        integrations=integrations,
    )
    tc.otel_ctx = otel_ctx
    tc.trace_id = trace_id
    tc.trigger_data = resolve_input_definition(
        workflow.input.model_dump(by_alias=True) if workflow.input else None,
        _build_expression_context(tc),
        default_input=tc.trigger_data,
    )
    if not isinstance(tc.trigger_data, dict):
        tc.trigger_data = {"value": tc.trigger_data}
    tc.task_outputs["trigger"]["data"] = tc.trigger_data
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

        while task_index < total_tasks:
            task_name, task_data = tasks[task_index]
            task_type = get_task_type(task_data)

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
                if db_execution_id and log_id:
                    task_duration_ms = _elapsed_ms(ctx, task_start_ms)
                    yield ctx.call_activity(
                        log_node_complete,
                        input=_freeze({
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
            if db_execution_id and log_id:
                task_duration_ms = _elapsed_ms(ctx, task_start_ms)
                if result is None:
                    task_success = True
                elif isinstance(result, dict):
                    task_success = result.get("success", True)
                else:
                    task_success = True
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
        if _should_cleanup_workspaces(tc):
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

        return SWWorkflowOutput(
            success=True,
            outputs=tc.task_outputs,
            workflowOutput=workflow_output,
            duration_ms=duration_ms,
            phase="completed",
        ).model_dump(by_alias=True)

    except Exception as e:
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

        if _should_cleanup_workspaces(tc):
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

        return SWWorkflowOutput(
            success=False,
            outputs=tc.task_outputs,
            workflowOutput=workflow_output,
            error=error_msg,
            duration_ms=duration_ms,
            phase="failed",
        ).model_dump(by_alias=True)
