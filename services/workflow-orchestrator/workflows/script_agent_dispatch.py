"""``_start_script_call`` — dispatch one evaluator task as a child workflow.

Mirrors the ``durable/run`` workflow↔session bridge in ``sw_workflow.py`` but for
the dynamic-script engine:

  * ``kind='agent'``    -> runtime resolution (``opts.agentType`` or
    ``defaults.agentRuntime``) + ``spawn_session_for_workflow`` + an un-awaited
    ``session_workflow`` child task (RETURNED, not awaited — the pump multiplexes
    all outstanding children through ``when_any``).
  * ``kind='workflow'`` -> resolve the referenced script + an un-awaited nested
    ``dynamic_script_workflow_v1`` child task (``nested=True``, SAME executionId so
    one usage SUM covers the tree).

The generator YIELDS its spawn/resolve activity and RETURNS the un-awaited child
``Task`` (or ``None`` when the bridge refuses, e.g. a cancelled benchmark — the
pump then journals the call as ``null``).
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

import dapr.ext.workflow as wf

from activities.spawn_session import spawn_session_for_workflow
from activities.resolve_script_workflow import resolve_script_workflow

# Reuse the ground-truth helpers so dispatch identity + child-workflow plumbing
# stay byte-compatible with the SW interpreter (avoids churn / drift).
from workflows.sw_workflow import (
    _call_child_workflow_with_history_propagation,
    _resolve_native_agent_runtime,
    _freeze,
)

logger = logging.getLogger(__name__)

DYNAMIC_SCRIPT_WORKFLOW_NAME = "dynamic_script_workflow_v1"
SESSION_WORKFLOW_NAME = "session_workflow"


def _sanitize_id_component(value: str) -> str:
    # Charset-sanitize like sw_workflow.py:1570 so a callId fragment is a routable
    # actor id component.
    return re.sub(r"[^A-Za-z0-9_.-]", "-", value)


def script_child_instance_id(parent_instance_id: str, call_id: str, retries: int) -> str:
    """Deterministic child instance id for a script call.

    MUST match the lifecycle wedge-finalize regex
    ``__durable(?:-[a-z0-9-]+)?__(.+?)__run__\\d+`` (reconciled decision) so
    ``nodeIdFromChildSessionId`` keeps resolving — hence ``durable-script`` +
    ``__run__<retries>``.
    """
    fragment = _sanitize_id_component(str(call_id)[:16])
    return f"{parent_instance_id}__durable-script__{fragment}__run__{int(retries or 0)}"


def _native_structured_enabled() -> bool:
    """Kill-switch for provider-native structured output (default ON)."""
    raw = os.environ.get("DYNAMIC_SCRIPT_NATIVE_STRUCTURED_OUTPUT", "true").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def _structured_model() -> str:
    """The model schema'd calls route to for first-class structured output
    (OpenAI strict json_schema by default). Read per-call so tests/env can
    override; empty falls back to the OpenAI default."""
    return os.environ.get("DYNAMIC_SCRIPT_STRUCTURED_MODEL", "openai/gpt-5.5").strip() or "openai/gpt-5.5"


def _structured_tool_enabled() -> bool:
    """Kill-switch for StructuredOutput TOOL mode on non-strict providers
    (default ON). Off reverts schema'd GLM-routed calls to json_object +
    prompt contract (the pre-tool behavior)."""
    raw = os.environ.get("DYNAMIC_SCRIPT_STRUCTURED_TOOL", "true").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def _schema_supports_structured_tool(schema: dict[str, Any]) -> bool:
    """Tool arguments are always JSON objects — only object-shaped schemas
    (type=object, or typeless with properties) can ride the tool."""
    schema_type = schema.get("type")
    if schema_type == "object":
        return True
    return schema_type is None and isinstance(schema.get("properties"), dict)


def _phase_model(meta: dict[str, Any] | None, phase: Any) -> str:
    """Model declared on the task's meta.phases entry (spec: per-phase model).

    ``meta.phases`` entries are ``{title, model?, ...}``; the evaluator resolves
    each task's phase (opts.phase ?? ambient phase()) into ``opts.phase``, so an
    exact title match here applies the phase's model override.
    """
    if not phase or not isinstance(phase, str) or not isinstance(meta, dict):
        return ""
    phases = meta.get("phases")
    if not isinstance(phases, list):
        return ""
    for entry in phases:
        if isinstance(entry, dict) and entry.get("title") == phase:
            model = entry.get("model")
            if isinstance(model, str) and model.strip():
                return model.strip()
            return ""
    return ""


def _build_agent_config(
    opts: dict[str, Any],
    defaults: dict[str, Any] | None = None,
    agent_runtime: str = "",
    meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    agent_config: dict[str, Any] = {}
    model = ""
    phase_model = _phase_model(meta, opts.get("phase"))
    # A schema'd call on the multi-provider runtime gets provider-native
    # structured output (Tier 1 OpenAI strict json_schema / Tier 2 GLM
    # json_object). The <output-contract> prompt block + jsonschema validation
    # remain the universal Tier-3 authority/fallback either way.
    schema = opts.get("schema") if isinstance(opts.get("schema"), dict) else None
    native_structured = (
        schema is not None
        and agent_runtime == "dapr-agent-py"
        and _native_structured_enabled()
    )
    if isinstance(opts.get("model"), str) and opts.get("model").strip():
        model = opts["model"].strip()
    elif phase_model:
        # meta.phases[].model — explicit author intent scoped to the phase
        # (same trust level as opts.model; applies regardless of runtime).
        model = phase_model
    elif native_structured:
        # Hybrid routing: a schema'd call with no explicit model defaults to the
        # configured structured model (OpenAI strict json_schema) instead of the
        # GLM default, so the schema is enforced by constrained decoding. A
        # per-call opts.model / phase model above still wins; a per-call model
        # pointed at GLM keeps json_object (Tier 2).
        model = _structured_model()
    elif (
        isinstance((defaults or {}).get("model"), str)
        and (defaults or {}).get("model").strip()
        and agent_runtime == "dapr-agent-py"
    ):
        # defaults.model applies ONLY to the multi-provider dapr-agent-py
        # runtime — a per-call agentType (e.g. claude-agent-py, Anthropic-only)
        # must never inherit a cross-provider default model key.
        model = (defaults or {})["model"].strip()
    if model:
        # `modelSpec` is the key dapr-agent-py's LLM selection actually reads
        # (effective_agent_config.resolve_llm_metadata: agentConfig.modelSpec →
        # metadata.model → message.model → default; agents/markdown.ts maps
        # frontmatter `model` → modelSpec the same way). Keep `model` too for
        # UI/agent-record parity.
        agent_config["model"] = model
        agent_config["modelSpec"] = model
    if isinstance(opts.get("effort"), str) and opts.get("effort").strip():
        agent_config["reasoningEffort"] = opts["effort"].strip()
    if native_structured:
        # The raw JSON Schema the adapter enforces provider-side (OpenAI strict
        # json_schema; GLM json_object). Read back in call_llm and stamped on the
        # chat client alongside _llm_component / _reasoning_effort.
        agent_config["responseJsonSchema"] = schema
        # Tier 2 tool mode: GLM has no strict json_schema mode, and json_object
        # never applies to tool-carrying sessions — so a schema'd call resolved
        # to GLM delivers its result via the synthetic StructuredOutput tool
        # (Claude Code mechanism): the adapter injects a per-request tool
        # definition whose parameters ARE the schema, the runtime validates the
        # call args in-loop, and the agent loop finalizes the session with the
        # canonical JSON. Object schemas only (tool args are JSON objects);
        # OpenAI keeps strict json_schema (stronger).
        if (
            model.startswith("zai/")
            and _structured_tool_enabled()
            and _schema_supports_structured_tool(schema)
        ):
            agent_config["structuredOutputMode"] = "tool"
    return agent_config


def _output_contract_block(schema: dict[str, Any], structured_tool: bool = False) -> str:
    # Deterministic (sort_keys) so replay reproduces the same initialMessage.
    schema_json = json.dumps(schema, sort_keys=True, ensure_ascii=False)
    if structured_tool:
        # Tool mode: the runtime injects a StructuredOutput tool whose
        # parameters are this schema; the model delivers the result by calling
        # it (in-loop validation + retry). The journal still validates the
        # final text (which the loop sets to the validated JSON) — Tier 3.
        return (
            "\n\n<output-contract>\n"
            "A tool named StructuredOutput is available. When you have "
            "completed the task, you MUST call the StructuredOutput tool "
            "exactly once — its arguments are your final result and MUST be a "
            "JSON object that validates against this JSON Schema:\n"
            f"{schema_json}\n"
            "Do NOT give your final answer as plain text; deliver it via the "
            "StructuredOutput tool call. If the tool reports validation "
            "errors, correct the arguments and call it again.\n"
            "</output-contract>"
        )
    return (
        "\n\n<output-contract>\n"
        "You MUST end your response with a single fenced ```json code block "
        "containing ONLY a JSON value that validates against this JSON Schema:\n"
        f"{schema_json}\n"
        "Do not include any prose after the JSON block.\n"
        "</output-contract>"
    )


def _previous_attempt_block(retries: int, feedback: str) -> str:
    return (
        "\n\n<previous-attempt>\n"
        f"Your previous output failed schema validation (attempt {int(retries)}). "
        "Validation errors:\n"
        f"{feedback}\n"
        "Produce a corrected response that satisfies the output contract.\n"
        "</previous-attempt>"
    )


def _build_initial_message(spec: dict[str, Any], structured_tool: bool = False) -> str:
    prompt = str(spec.get("prompt") or "")
    opts = spec.get("opts") if isinstance(spec.get("opts"), dict) else {}
    schema = opts.get("schema") if isinstance(opts.get("schema"), dict) else None
    message = prompt
    if schema:
        message += _output_contract_block(schema, structured_tool=structured_tool)
    retries = int(spec.get("retries") or 0)
    feedback = spec.get("feedback")
    if retries > 0 and isinstance(feedback, str) and feedback.strip():
        message += _previous_attempt_block(retries, feedback.strip())
    return message


def _start_script_call(
    ctx: wf.DaprWorkflowContext,
    *,
    call_id: str,
    spec: dict[str, Any],
    exec_id: str,
    meta: dict[str, Any],
    defaults: dict[str, Any],
    limits: dict[str, Any],
    budget_total: Any = None,
    workflow_id: str | None,
    user_id: str | None,
    project_id: str | None,
    otel: dict[str, Any],
):
    """Dispatch one call. Yields its spawn/resolve activity; returns a child
    Task, ``None`` (bridge refused / bad agentType -> journal null), or
    ``{"dispatchError": msg}`` (workflow() ref failure -> journal error so the
    script's workflow() call THROWS, per the Workflow-tool contract)."""
    kind = spec.get("kind") or "agent"
    retries = int(spec.get("retries") or 0)
    child_instance_id = script_child_instance_id(ctx.instance_id, call_id, retries)
    opts = spec.get("opts") if isinstance(spec.get("opts"), dict) else {}

    if kind == "workflow":
        workflow_ref = str(spec.get("workflowRef") or opts.get("workflowRef") or "").strip()
        resolved = yield ctx.call_activity(
            resolve_script_workflow,
            input=_freeze({"workflowRef": workflow_ref, "_otel": otel}),
        )
        if not isinstance(resolved, dict) or not resolved.get("success"):
            reason = (
                (resolved or {}).get("error") if isinstance(resolved, dict) else resolved
            )
            logger.warning(
                "[script-dispatch] workflow() ref %r could not be resolved: %s",
                workflow_ref,
                reason,
            )
            return {
                "dispatchError": (
                    f"workflow() could not resolve {workflow_ref!r}"
                    + (f": {reason}" if reason else "")
                )
            }
        child_input = {
            "executionId": exec_id,
            "script": resolved.get("script"),
            "scriptSha256": resolved.get("scriptSha256"),
            "meta": resolved.get("meta") or {},
            # Shared token pool (Workflow-tool parity): the nested child sees the
            # SAME budgetTotal and — because it aggregates usage by the SAME
            # executionId — its budget.spent() is the whole tree's spend.
            "budgetTotal": budget_total,
            "nested": True,
            "journalImportFromExecutionId": None,
            "limits": limits,
            "defaults": defaults,
            "workflowId": workflow_id,
            "userId": user_id,
            "projectId": project_id,
            "_otel": otel,
        }
        # Child args: VERBATIM any-JSON value; omit the key entirely when the
        # parent passed nothing so the child's `args` global is undefined.
        if "args" in spec:
            child_input["args"] = spec.get("args")
        return ctx.call_child_workflow(
            DYNAMIC_SCRIPT_WORKFLOW_NAME,
            input=_freeze(child_input),
            instance_id=child_instance_id,
        )

    # kind == "agent"
    agent_runtime = ""
    if isinstance(opts.get("agentType"), str) and opts.get("agentType").strip():
        agent_runtime = opts["agentType"].strip()
    elif isinstance(defaults.get("agentRuntime"), str) and defaults.get("agentRuntime").strip():
        agent_runtime = defaults["agentRuntime"].strip()

    flattened_args = {"agentRuntime": agent_runtime} if agent_runtime else {}
    agent_config = _build_agent_config(opts, defaults, agent_runtime, meta)
    # Runtime resolution + the workflowDispatch=="auto-turn" guard (sw_workflow L1090-1118).
    # opts.agentType selects the agent RUNTIME (not a Claude Code persona); an
    # unresolvable value (e.g. a persona name, or a typo'd runtime id) makes the
    # registry raise. That raise must NOT crash the whole dynamic_script workflow —
    # per the Workflow-tool contract a failed agent() call resolves to null. Catch
    # it, log loudly, and return None so the pump journals THIS call as null and the
    # script's siblings/`.filter(Boolean)` proceed.
    try:
        _name, target = _resolve_native_agent_runtime(flattened_args, agent_config)
    except Exception as exc:  # noqa: BLE001 — a bad opts.agentType must not fail the run
        logger.warning(
            "[script-dispatch] agent() call %s: could not resolve agentType %r (%s); "
            "journaling this call as null (agent() returns null on death). Valid values "
            "are runtime ids from services/shared/runtime-registry.json.",
            call_id,
            agent_runtime or "(default)",
            exc,
        )
        return None
    # Stamp the RESOLVED runtime id onto the agent config. The bridge's
    # ensure-for-workflow handler reads agentConfig.runtime to resolve the
    # runtime descriptor — which gates BOTH the swap-safety check and the
    # per-session OpenShell auto-sandbox provision. Without it, script-spawned
    # dapr-agent-py sessions got NO workspace sandbox and every OpenShell tool
    # failed with gRPC "sandbox not found" (live-caught: demo-review agents
    # could not ls/glob and honestly reported the blocker instead of reviewing).
    agent_config["runtime"] = _name

    label = str(opts.get("label") or "").strip() or str(call_id)[:8]
    workspace_ref = f"ws_script_{exec_id}" if opts.get("isolation") == "shared" else None
    timeout_minutes = None
    try:
        timeout_minutes = int(defaults.get("timeoutMinutes")) if defaults.get("timeoutMinutes") else 30
    except (TypeError, ValueError):
        timeout_minutes = 30

    bridge_payload = {
        "sessionId": child_instance_id,
        "workflowId": workflow_id,
        "nodeId": call_id,
        "nodeName": label,
        "workflowExecutionId": exec_id,
        "parentExecutionId": ctx.instance_id,
        "agentConfig": agent_config,
        "vaultIds": [],
        "initialMessage": _build_initial_message(
            spec,
            structured_tool=agent_config.get("structuredOutputMode") == "tool",
        ),
        "title": f"{meta.get('name') or 'script'} · {label}",
        "workspaceRef": workspace_ref,
        # Single auto-turn per corrective session (structured retry = NEW session).
        "timeoutMinutes": timeout_minutes,
        "maxIterations": None,
        "userId": user_id,
        "projectId": project_id,
        "_otel": otel,
    }

    bridge_result = yield ctx.call_activity(
        spawn_session_for_workflow, input=_freeze(bridge_payload)
    )
    if isinstance(bridge_result, dict) and bridge_result.get("cancelled"):
        # Bridge refused (e.g. cancelled benchmark). No child task — pump journals null.
        return None
    bridge_child_input = (
        bridge_result.get("childInput") if isinstance(bridge_result, dict) else None
    )
    if not isinstance(bridge_child_input, dict):
        raise RuntimeError(
            f"script↔session bridge: invalid bridge_result for {child_instance_id}"
        )

    bridge_app_id = target["app_id"]
    if isinstance(bridge_result, dict):
        returned_app_id = bridge_result.get("agentAppId")
        if isinstance(returned_app_id, str) and returned_app_id.strip():
            bridge_app_id = returned_app_id.strip()

    child_input = {
        **bridge_child_input,
        "workflowId": workflow_id,
        "workflowExecutionId": exec_id,
        "dbExecutionId": exec_id,
        "nodeId": call_id,
        "nodeName": label,
        "agentId": bridge_result.get("agentId") if isinstance(bridge_result, dict) else None,
        "agentAppId": bridge_app_id,
        "_otel": otel,
    }

    return _call_child_workflow_with_history_propagation(
        ctx,
        target.get("dispatch_workflow_name") or SESSION_WORKFLOW_NAME,
        input=_freeze(child_input),
        instance_id=child_instance_id,
        app_id=bridge_app_id,
    )
