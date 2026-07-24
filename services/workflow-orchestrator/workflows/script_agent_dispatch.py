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
from datetime import timedelta
from typing import Any

import dapr.ext.workflow as wf

from core import runtime_registry
from workflows.session_host_wait import spawn_session_with_host_wait
from workflows.action_runner_workflow import action_runner_workflow
from workflows.wait_event_workflow import wait_event_workflow
from activities.cli_workspace_command import cli_workspace_command
from activities.execute_action import PRIVILEGED_PREVIEW_ACTION_SLUGS, execute_action
from activities.resolve_script_workflow import resolve_script_workflow
from activities.team_ops import execute_team_op

# Reuse the ground-truth helpers so dispatch identity + child-workflow plumbing
# stay byte-compatible with the SW interpreter (avoids churn / drift).
from workflows.sw_workflow import (
    _as_bool,
    _call_child_workflow_with_history_propagation,
    _expects_durable_dev_preview_activation,
    _is_ap_piece_action,
    _resolve_native_agent_runtime,
    _freeze,
)

logger = logging.getLogger(__name__)

DYNAMIC_SCRIPT_WORKFLOW_NAME = "dynamic_script_workflow_v1"
SESSION_WORKFLOW_NAME = "session_workflow"
TEAM_JOIN_WORKFLOW_NAME = "team_join_workflow_v1"

#: Ops execute_team_op understands; anything else is a dispatchError.
_TEAM_OPS = {"spawn", "task", "send", "broadcast", "status", "shutdown"}

# Transport/5xx failures from the BFF team API RAISE out of execute_team_op
# (team_ops.py's documented contract) and MUST be retried here — without a
# policy one transient sidecar/BFF blip (observed on dev 2026-07-10: a 5s
# read-timeout on ensure-script-team during a rollout) throws into the script
# and fails the whole run. 4xx returns {"success": False} and never raises, so
# deterministic failures don't retry. Each activity attempt has a 60s aggregate
# HTTP budget in team_ops.py. Twenty attempts plus 902s of durable backoff bound
# the configured network/retry horizon at 2,102s (35m02s), including shutdown
# fan-out, instead of adding request time on top of a 35-minute backoff horizon.
_TEAM_OP_RETRY_POLICY = wf.RetryPolicy(
    first_retry_interval=timedelta(seconds=2),
    max_number_of_attempts=20,
    backoff_coefficient=2,
    max_retry_interval=timedelta(seconds=60),
)


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

    The fragment keeps the first 16 baseHash chars AND the ``_<occurrence>``
    tail (callId chars 40+). Without the tail, duplicate prompt+opts calls
    (same baseHash, occurrences ``_0``/``_1``/...) collide onto ONE child
    instance/session id — Dapr then serializes them through a single shared
    session (or wedges the parent), every duplicate journal lane attaches to
    the same transcript, and per-call skip kills the session all duplicates
    ride on. The occurrence counter sits at char 41+ of the frozen callId
    (baseHash[:40] + '_' + occurrence), which is exactly what ``[:16]``
    dropped.

    Deploy note: changing this derivation skews skip/stop targeting for runs
    already in flight at rollout (completed children replay from history and
    are unaffected; child-workflow replay validation checks names, not
    instance ids) — roll out in a quiet window, dev first.
    """
    cid = str(call_id)
    fragment = _sanitize_id_component(cid[:16] + cid[40:])
    return f"{parent_instance_id}__durable-script__{fragment}__run__{int(retries or 0)}"


def script_run_shared_workspace_key(exec_id: str) -> str:
    """The run's DEFAULT shared CLI-workspace subPath — the key every
    ``agent(isolation:'shared')`` call and every nested ``workflow()`` child binds.
    Matches the ref computed in `_start_script_call` / the action workspace binding.
    The BFF derives the same key (`ws_script_<execId>`) to look up node-boundary
    snapshots when seeding a resume-after-edit."""
    return f"ws_script_{exec_id}"


def resolve_call_workspace_ref(spec: dict[str, Any], exec_id: str) -> str | None:
    """The shared-workspace subPath a call binds, or ``None`` for a pod-local call.

    Mirrors `_start_script_call`'s binding: a ``workflow()`` child runs on the ROOT
    run's shared workspace; an ``agent()`` call binds an explicit
    ``opts.sandbox.workspaceRef`` (``${workspace}`` substituted) else the run's shared
    workspace when ``isolation:'shared'`` else nothing. Other kinds (action/sleep/
    event/team) return ``None`` — they don't own a forkable agent workspace."""
    kind = spec.get("kind") or "agent"
    default_ref = script_run_shared_workspace_key(exec_id)
    if kind == "workflow":
        return default_ref
    if kind != "agent":
        return None
    opts = spec.get("opts") if isinstance(spec.get("opts"), dict) else {}
    sandbox_opt = opts.get("sandbox") if isinstance(opts.get("sandbox"), dict) else {}
    sandbox_opt = _substitute_workspace(sandbox_opt, default_ref)
    if sandbox_opt.get("workspaceRef"):
        return str(sandbox_opt.get("workspaceRef"))
    if opts.get("isolation") == "shared":
        return default_ref
    return None


def _native_structured_enabled() -> bool:
    """Kill-switch for provider-native structured output (default ON)."""
    raw = os.environ.get("DYNAMIC_SCRIPT_NATIVE_STRUCTURED_OUTPUT", "true").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def _runtime_supports_native_structured_output(runtime_id: str) -> bool:
    """Read structured-output support from the canonical runtime descriptor."""
    descriptor = runtime_registry.registry.by_id(
        runtime_id or runtime_registry.registry.default_runtime_id
    )
    if descriptor is None:
        return False
    capabilities = descriptor.capabilities
    return (
        capabilities.get("structuredOutputMode") == "tool"
        and capabilities.get("structuredOutputJsonSchemaDraft") == "2020-12"
    )


def _structured_model() -> str:
    """The model schema'd calls route to for first-class structured output.
    Kimi K3 is the platform default; dynamic-script calls use its structured
    final-result tool so normal tools remain available before finalization.
    Set DYNAMIC_SCRIPT_STRUCTURED_MODEL=openai/gpt-5.5 to route schema'd calls
    to OpenAI strict json_schema instead. Read per-call so tests/env can
    override; empty falls back to the Kimi K3 default."""
    return os.environ.get("DYNAMIC_SCRIPT_STRUCTURED_MODEL", "kimi/kimi-k3").strip() or "kimi/kimi-k3"


def _structured_tool_enabled() -> bool:
    """Kill-switch for StructuredOutput TOOL mode (default ON).

    Off reverts schema'd Kimi/GLM-routed calls to provider-native structured
    output plus the prompt contract.
    """
    raw = os.environ.get("DYNAMIC_SCRIPT_STRUCTURED_TOOL", "true").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def _cli_structured_enabled() -> bool:
    """Kill-switch for schema finalization in interactive CLI runtimes."""
    raw = os.environ.get("DYNAMIC_SCRIPT_CLI_STRUCTURED_OUTPUT", "true").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def _schema_supports_structured_tool(schema: dict[str, Any]) -> bool:
    """Tool arguments are always JSON objects — only object-shaped schemas
    (type=object, or typeless with properties) can ride the tool."""
    schema_type = schema.get("type")
    if schema_type == "object":
        return True
    return schema_type is None and isinstance(schema.get("properties"), dict)


def _is_kimi_k3_model(model: str) -> bool:
    return model.strip().lower() in {
        "kimi/kimi-k3",
        "kimi-k3",
        "moonshot/kimi-k3",
    }


def _is_cli_structured_runtime(agent_runtime: str) -> bool:
    return agent_runtime in {
        "claude-code-cli",
        "claude-code-cli-glm",
        "codex-cli",
        "agy-cli",
    }


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
    # structured output (Kimi/GLM/Anthropic/DeepSeek tool finalization or
    # OpenAI strict json_schema). The <output-contract> prompt block +
    # jsonschema validation remain the universal authority/fallback either way.
    schema = opts.get("schema") if isinstance(opts.get("schema"), dict) else None
    native_structured = (
        schema is not None
        and _runtime_supports_native_structured_output(agent_runtime)
        and _native_structured_enabled()
    )
    # For opts.agent, this is only the caller's provisional runtime. The BFF
    # resolves the saved agent atomically and re-gates tool mode against that
    # resolved runtime before it creates the session; unsupported mismatches
    # are refused instead of inheriting this override.
    cli_structured = (
        schema is not None
        and _is_cli_structured_runtime(agent_runtime)
        and _cli_structured_enabled()
        and _schema_supports_structured_tool(schema)
    )
    if isinstance(opts.get("model"), str) and opts.get("model").strip():
        model = opts["model"].strip()
    elif phase_model:
        # meta.phases[].model — explicit author intent scoped to the phase
        # (same trust level as opts.model; applies regardless of runtime).
        model = phase_model
    elif native_structured:
        # Hybrid routing: a schema'd call with no explicit model defaults to
        # the configured structured model (Kimi K3 by default). A per-call
        # opts.model / phase model above still wins.
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
        # The raw JSON Schema the adapter enforces provider-side. Read back in
        # call_llm and stamped on the chat client alongside _llm_component /
        # _reasoning_effort.
        agent_config["responseJsonSchema"] = schema
        # Tool mode lets Kimi and providers without a strict json_schema mode
        # use normal coding/MCP tools before submitting the final schema via the
        # synthetic StructuredOutput tool. The runtime validates arguments
        # in-loop and finalizes the session with canonical JSON. OpenAI keeps
        # native strict json_schema. Object schemas only: tool args are objects.
        if (
            (
                _is_kimi_k3_model(model)
                or model.startswith(("zai/", "anthropic/", "deepseek/"))
            )
            and _structured_tool_enabled()
            and _schema_supports_structured_tool(schema)
        ):
            agent_config["structuredOutputMode"] = "tool"
    elif cli_structured:
        # CLI sessions expose a per-session StructuredOutput MCP tool carrying
        # this schema. The Stop hook still finalizes the turn and remains the
        # fallback, but the primary path now matches dapr-agent-py's tool mode:
        # the model delivers the final result by calling StructuredOutput.
        agent_config["responseJsonSchema"] = schema
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
            "A structured-output tool is available. In Dapr runtimes it is named "
            "StructuredOutput; in CLI MCP runtimes it is exposed through the "
            "structured MCP server as StructuredOutput, commonly surfaced as "
            "mcp__structured__StructuredOutput. When you have completed the "
            "task, you MUST call that structured-output tool exactly once — "
            "its arguments are your final result and MUST be a JSON object "
            "that validates against this JSON Schema:\n"
            f"{schema_json}\n"
            "Do NOT give your final answer as plain text; deliver it via the "
            "structured-output tool call. If the tool reports validation "
            "errors, correct the arguments and call the tool again.\n"
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
    features: dict[str, Any] | None = None,
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
        # Nested children inherit the parent's deployment capabilities so
        # action()/sleep()/approve() work at every nesting level.
        if features:
            child_input["features"] = features
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
    # Workspace/sandbox binding (contract 1.2.0, cutover P3): opts.sandbox lets a
    # script bind the agent to a workspace it created via
    # action('workspace/profile', …) — the capability the code-eval / SWE-bench /
    # GAN producers need. isolation:'shared' remains the simple path.
    sandbox_opt = opts.get("sandbox") if isinstance(opts.get("sandbox"), dict) else {}
    sandbox_opt = _substitute_workspace(sandbox_opt, script_run_shared_workspace_key(exec_id))
    workspace_ref = resolve_call_workspace_ref(spec, exec_id)
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
        "timeoutMinutes": (
            int(sandbox_opt["timeoutMinutes"])
            if isinstance(sandbox_opt.get("timeoutMinutes"), int)
            else timeout_minutes
        ),
        "maxIterations": (
            int(sandbox_opt["maxTurns"]) if isinstance(sandbox_opt.get("maxTurns"), int) else None
        ),
        **(
            {"sandboxName": sandbox_opt["sandboxName"]}
            if isinstance(sandbox_opt.get("sandboxName"), str)
            else {}
        ),
        **({"cwd": sandbox_opt["cwd"]} if isinstance(sandbox_opt.get("cwd"), str) else {}),
        **(
            {"sandboxPolicy": sandbox_opt["policy"]}
            if isinstance(sandbox_opt.get("policy"), dict)
            else {}
        ),
        "userId": user_id,
        "projectId": project_id,
        "_otel": otel,
    }
    # Named agent (cutover P1e): resolved FAIL-CLOSED in the BFF bridge —
    # unknown slug -> 422 refusal -> journal null; old-BFF skew (missing
    # resolvedAgentSlug echo) -> refusal too. Never the default runtime.
    agent_slug_opt = str(opts.get("agent") or "").strip()
    if agent_slug_opt:
        bridge_payload["resolveAgentSlug"] = agent_slug_opt
        agent_version_opt = opts.get("agentVersion")
        if isinstance(agent_version_opt, int) and agent_version_opt > 0:
            bridge_payload["resolveAgentVersion"] = agent_version_opt

    # Durable-timer readiness wait (concurrency plan P2) — see
    # workflows/session_host_wait.py.
    bridge_result = yield from spawn_session_with_host_wait(
        ctx, bridge_payload, _freeze
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


def start_team_call(
    ctx: wf.DaprWorkflowContext,
    *,
    call_id: str,
    spec: dict[str, Any],
    exec_id: str,
    meta: dict[str, Any] | None,
    otel: Any,
):
    """Dispatch one script `team.*` call. NON-generator (no activities yielded
    here — determinism lives in what we schedule):

      • op 'join'      -> an un-awaited ``team_join_workflow_v1`` CHILD task
        (poll/timer loop isolated in the child's history) with the standard
        ``script_child_instance_id`` so run-detail lineage keeps working.
      • any other op   -> an un-awaited ``execute_team_op`` ACTIVITY task —
        activity Tasks multiplex through the pump's ``when_any`` exactly like
        child-workflow Tasks.

    Returns the un-awaited Task, or {"dispatchError": ...} for unknown ops
    (journals as an error the script can catch). Team ops bypass
    prepare_script_call entirely — no session provisioning or runtime
    resolution applies.
    """
    team_op = str(spec.get("teamOp") or "").strip()
    args = spec.get("args") if isinstance(spec.get("args"), dict) else {}
    team_name = str((meta or {}).get("name") or "") or None
    team_token_budget = _team_token_budget(meta)

    if team_op == "join":
        child_instance_id = script_child_instance_id(ctx.instance_id, call_id, 0)
        return ctx.call_child_workflow(
            TEAM_JOIN_WORKFLOW_NAME,
            input=_freeze(
                {
                    "executionId": exec_id,
                    "until": args.get("until") or "tasks-complete",
                    "timeoutMinutes": args.get("timeoutMinutes"),
                    "teamTokenBudget": team_token_budget,
                    "_otel": otel,
                }
            ),
            instance_id=child_instance_id,
        )

    if team_op not in _TEAM_OPS:
        return {"dispatchError": f"unknown team op '{team_op}'"}

    return ctx.call_activity(
        execute_team_op,
        input=_freeze(
            {
                "executionId": exec_id,
                "op": team_op,
                "args": args,
                "teamName": team_name,
                "teamTokenBudget": team_token_budget,
                "_otel": otel,
            }
        ),
        retry_policy=_TEAM_OP_RETRY_POLICY,
    )


#: The `workspace` global's sentinel (script-evaluator WORKSPACE_SENTINEL).
#: Substituted with the run's real shared workspace ref at dispatch so the
#: script's action() input hashes stay stable across executions (resume reuse).
WORKSPACE_SENTINEL = "@workspace"


def _substitute_workspace(value: Any, workspace_ref: str) -> Any:
    """Deep-replace the workspace sentinel with the run's real ref. Pure +
    deterministic (replay-safe)."""
    if isinstance(value, str):
        return workspace_ref if value == WORKSPACE_SENTINEL else value
    if isinstance(value, list):
        return [_substitute_workspace(v, workspace_ref) for v in value]
    if isinstance(value, dict):
        return {k: _substitute_workspace(v, workspace_ref) for k, v in value.items()}
    return value


def start_action_call(
    ctx,
    *,
    call_id: str,
    spec: dict[str, Any],
    exec_id: str,
    workflow_id: str | None,
    otel: dict[str, Any],
):
    """Dispatch a deterministic ``action()`` call (contract 1.2.0, P1b slice).

    Non-generator (``start_team_call`` precedent): returns an un-awaited
    ``execute_action`` activity Task that multiplexes through the pump's
    ``when_any`` set, or ``{"dispatchError": ...}`` for calls this build cannot
    dispatch (the pump journals those as ``action_error`` — the evaluator
    throws the message into the script, catchable).

    Slug classes (SW-parity via ``_is_ap_piece_action``):
      * ``workspace/command`` with ``cliWorkspace: true`` dispatches directly
        to the execution's CLI workspace helper. This mirrors the SW
        interpreter and keeps it out of function-router, which intentionally
        has no ``workspace/command`` Knative registration.
      * other non-AP single-shot slugs (workspace/command, code/*, system/*,
        web/* sync, ...) dispatch here as plain activities — same call shape as
        the SW interpreter's non-AP path (no retry policy; transport failures
        come back as ``success:false``).
      * AP piece slugs dispatch as an ``action_runner_workflow_v1`` CHILD that
        carries the full SW AP durability contract (_AP_RETRY_POLICY +
        raiseOnRetryable + DELAY/WEBHOOK pause rounds) and gives the WEBHOOK
        wait a stable waiter instance id for the BFF ap-resume route.
      * ``web/crawl.async`` needs the SW start+poll state machine — not yet
        ported; use the synchronous ``web/crawl`` (dispatch-errors clearly).
    """
    slug = str(spec.get("actionSlug") or "").strip()
    if not slug or "/" not in slug:
        return {"dispatchError": f"action(): invalid slug {slug!r}"}
    if slug == "web/crawl.async":
        return {
            "dispatchError": (
                "action('web/crawl.async'): the async start+poll state machine is not "
                "ported to scripts yet — use action('web/crawl') (synchronous) or an "
                "agent with WebFetch"
            )
        }

    action_opts = spec.get("actionOpts") if isinstance(spec.get("actionOpts"), dict) else {}
    # The run's shared workspace (same key agent(isolation:'shared') binds), so
    # workspace/* actions and agents operate on ONE filesystem.
    raw_input = _substitute_workspace(spec.get("args"), f"ws_script_{exec_id}")

    if (
        slug == "workspace/command"
        and isinstance(raw_input, dict)
        and _as_bool(raw_input.get("cliWorkspace"), False)
    ):
        body = raw_input.get("body") if isinstance(raw_input.get("body"), dict) else {}
        command = raw_input.get("command")
        if not isinstance(command, str):
            command = body.get("command")

        def optional_text(name: str) -> str | None:
            value = raw_input.get(name)
            if not isinstance(value, str):
                value = body.get(name)
            return value if isinstance(value, str) and value.strip() else None

        return ctx.call_activity(
            cli_workspace_command,
            input=_freeze(
                {
                    "executionId": exec_id,
                    "command": command,
                    "cwd": raw_input.get("cwd") or body.get("cwd") or "/sandbox/work",
                    "readFile": optional_text("readFile"),
                    "timeoutMs": raw_input.get("timeoutMs") or body.get("timeoutMs"),
                    "persistBrowserVideo": optional_text("persistBrowserVideo"),
                    "nodeId": call_id,
                    "workflowId": workflow_id or "",
                    "helperPod": _as_bool(raw_input.get("helperPod"), False),
                    "helperTimeoutMinutes": raw_input.get("helperTimeoutMinutes"),
                    "_otel": otel,
                }
            ),
        )

    config: dict[str, Any] = {"actionType": slug}
    if raw_input is not None:
        config["input"] = raw_input

    connection = action_opts.get("connection")
    activity_input: dict[str, Any] = {
        "node": {
            "id": call_id,
            "type": "action",
            "label": spec.get("label") or slug,
            "config": config,
        },
        # Script inputs are concrete JS values — no {{...}} templates to resolve.
        "nodeOutputs": {},
        # SW parity (sw_workflow.py:4160 `execution_id = ctx.instance_id`): the
        # openshell tool endpoints (/api/tools/*) resolve a sandbox by
        # executionId = the DAPR INSTANCE id, not the DB row id. Passing the DB
        # id made workspace/write_file 404 while profile/command (which take a
        # workspaceRef) succeeded — live-caught on dev 2026-07-14.
        "executionId": ctx.instance_id,
        "workflowId": workflow_id or "",
        "dbExecutionId": exec_id,
        "connectionExternalId": (
            connection if isinstance(connection, str) and connection.strip() else None
        ),
        # Stronger than SW's task-name key: content-addressed and stable across
        # retries, replay, and resume (docs/code-first-cutover.md item 6).
        "idempotencyKey": f"{workflow_id or ''}:{exec_id}:{call_id}",
        "_otel": otel,
    }
    # opts.idempotent: the author marks the action safe to RE-RUN (skips the
    # idempotency gate). Default False — gate stays on (SW `idempotent` parity).
    if action_opts.get("idempotent") is True:
        activity_input["skipIdempotencyGate"] = True

    # dev/preview activation needs the runner child's durable poll (blocker B1).
    needs_activation = _expects_durable_dev_preview_activation(slug, raw_input)
    needs_preview_retry = slug in PRIVILEGED_PREVIEW_ACTION_SLUGS

    if _is_ap_piece_action(slug) or needs_activation or needs_preview_retry:
        # AP durability contract: the runner child owns BEGIN/RESUME rounds,
        # _AP_RETRY_POLICY, and the DELAY/WEBHOOK pause waits; its instance id
        # (deterministic, already stamped by the pump) is the resume target.
        if not needs_activation:
            activity_input["raiseOnRetryable"] = True
        return ctx.call_child_workflow(
            action_runner_workflow,
            input=_freeze(
                {
                    "activityInput": activity_input,
                    "journal": {
                        "executionId": exec_id,
                        "callId": call_id,
                        "seq": spec.get("seq", 0),
                        "spec": {
                            "kind": spec.get("kind") or "action",
                            "label": spec.get("label"),
                            "phase": spec.get("phase"),
                            "promptSha256": spec.get("promptSha256"),
                            "baseHash": spec.get("baseHash"),
                            "occurrence": spec.get("occurrence"),
                            "retries": int(spec.get("retries") or 0),
                            # Keep the call-site on pause-marker rewrites of the
                            # running row (they clobbered it to NULL otherwise).
                            "callSite": spec.get("position"),
                        },
                    },
                    "_otel": otel,
                }
            ),
            instance_id=str(spec.get("_instance_id") or ""),
        )

    activity_input["executionType"] = "BEGIN"
    return ctx.call_activity(execute_action, input=_freeze(activity_input))


def start_event_wait_call(
    ctx,
    *,
    call_id: str,
    spec: dict[str, Any],
    exec_id: str,
    otel: dict[str, Any],
):
    """Dispatch an ``approve()``/``waitForEvent()`` gate (contract 1.2.0, P1d)
    as a ``wait_event_workflow_v1`` child. The runtime event name is
    per-callId (``script.event.<callId>``) so scripts can hold PARALLEL gates;
    the logical name ('approval', 'deploy.finished', ...) rides as metadata.
    """
    logical_name = str(spec.get("eventName") or "").strip() or "event"
    event_opts = spec.get("eventOpts") if isinstance(spec.get("eventOpts"), dict) else {}
    return ctx.call_child_workflow(
        wait_event_workflow,
        input=_freeze(
            {
                "eventName": f"script.event.{call_id}",
                "logicalName": logical_name,
                "timeoutMinutes": event_opts.get("timeoutMinutes"),
                "message": event_opts.get("message"),
                "label": spec.get("label"),
                "journal": {
                    "executionId": exec_id,
                    "callId": call_id,
                    "seq": spec.get("seq", 0),
                    "spec": {
                        "kind": spec.get("kind") or "event",
                        "label": spec.get("label"),
                        "phase": spec.get("phase"),
                        "promptSha256": spec.get("promptSha256"),
                        "baseHash": spec.get("baseHash"),
                        "occurrence": spec.get("occurrence"),
                        "retries": int(spec.get("retries") or 0),
                        # Keep the call-site on pause-marker rewrites of the
                        # running row (they clobbered it to NULL otherwise).
                        "callSite": spec.get("position"),
                    },
                },
                "_otel": otel,
            }
        ),
        instance_id=str(spec.get("_instance_id") or ""),
    )


def _team_token_budget(meta: dict[str, Any] | None) -> int | None:
    """`meta.team.tokenBudget` — the script's team-wide token cap (input+output
    across every member session). Applied by the BFF only when the team row is
    CREATED, so passing it on every ensure is idempotent. Pure function of the
    replayed meta — deterministic."""
    team = (meta or {}).get("team")
    if not isinstance(team, dict):
        return None
    raw = team.get("tokenBudget")
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return None
    value = int(raw)
    return value if value > 0 else None


def start_prepared_script_call(ctx: wf.DaprWorkflowContext, prepared: dict[str, Any]):
    """Schedule a child workflow from a prepared dispatch descriptor.

    ``prepare_script_call`` runs as an activity and owns runtime resolution,
    session provisioning, and workflow-ref lookup. The parent workflow calls this
    helper after the activity result is recorded in history, so scheduling the
    child remains deterministic and replayable.
    """
    if not isinstance(prepared, dict):
        return {"dispatchError": "prepare_script_call returned a non-object result"}
    kind = prepared.get("kind")
    if kind == "dispatchError":
        return {"dispatchError": str(prepared.get("dispatchError") or "dispatch failed")}
    if kind == "null":
        return None

    child_instance_id = str(prepared.get("childInstanceId") or "").strip()
    child_workflow_name = str(prepared.get("childWorkflowName") or "").strip()
    child_input = prepared.get("childInput") if isinstance(prepared.get("childInput"), dict) else None
    if not child_instance_id or not child_workflow_name or child_input is None:
        return {"dispatchError": "prepare_script_call returned an invalid child descriptor"}

    if kind == "workflow":
        return ctx.call_child_workflow(
            child_workflow_name,
            input=_freeze(child_input),
            instance_id=child_instance_id,
        )

    app_id = str(prepared.get("appId") or "").strip()
    if not app_id:
        return {"dispatchError": "prepare_script_call returned an agent without appId"}
    return _call_child_workflow_with_history_propagation(
        ctx,
        child_workflow_name,
        input=_freeze(child_input),
        instance_id=child_instance_id,
        app_id=app_id,
    )
