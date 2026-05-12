"""Dapr workflow attribute key constants — centralized for forward-compat
with the Dapr OpenTelemetry Weaver semantic-conventions work (initial PR
landed Jan 2026, tracked in research-the-most-popular-stateful-hinton.md
Phase 1 / Alignment section).

When Dapr Weaver mandates a different naming (e.g. switches
`durabletask.task.instance_id` → `dapr.workflow.instance_id`), update
the constants here in ONE place — every call site reads from this
module.

Mirror of the workflow-orchestrator's `telemetry/dapr_attributes.py` so
both Python services emit the same trace-tag set.
"""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

# Our application-emitted attribute names.
SESSION_ID_ATTRIBUTE = "session.id"
WORKFLOW_EXECUTION_ATTRIBUTE = "workflow.execution.id"
WORKFLOW_ID_ATTRIBUTE = "workflow.id"
WORKFLOW_NAME_ATTRIBUTE = "workflow.name"

# Dapr Weaver-aligned mirror keys. Listed alongside, never replacing,
# our app keys until Weaver stabilizes upstream.
DAPR_WORKFLOW_INSTANCE_ID = "dapr.workflow.instance_id"
DAPR_WORKFLOW_NAME = "dapr.workflow.name"

# User / org / agent identity.
USER_ID_ATTRIBUTE = "user.id"
ORGANIZATION_ID_ATTRIBUTE = "organization.id"
AGENT_SLUG_ATTRIBUTE = "agent.slug"
AGENT_MODEL_SPEC_ATTRIBUTE = "agent.model_spec"
AGENT_LLM_COMPONENT_ATTRIBUTE = "agent.llm_component"
AGENT_CONFIG_REVISION_ATTRIBUTE = "agent.config_revision"
AGENT_TURN_ATTRIBUTE = "agent.turn"
AGENT_INSTRUCTION_HASH_ATTRIBUTE = "agent.instruction_hash"

# Prompt registry. `prompt_version` carries comma-joined MLflow Prompt
# Registry URIs (Phase 3a). `prompt_version_id` carries comma-joined
# `resource_prompt_versions.id` PKs (Phase 3a v2) — useful for joining
# back to the BFF's DB when the MLflow URI isn't sufficient.
PROMPT_VERSION_ATTRIBUTE = "prompt_version"
PROMPT_VERSION_ID_ATTRIBUTE = "prompt_version_id"


def _clean_trace_id(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower().removeprefix("tr-").replace("-", "")
    if len(normalized) != 32:
        return None
    if not all(c in "0123456789abcdef" for c in normalized):
        return None
    if int(normalized, 16) == 0:
        return None
    return normalized


def _trace_id_from_traceparent(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    parts = value.strip().split("-")
    if len(parts) < 4:
        return None
    return _clean_trace_id(parts[1])


def trace_tags_from_attrs(attrs: dict[str, Any] | None) -> dict[str, str]:
    """Build a curated trace-tag dict from a span-attrs dict.

    Picks only the keys that make sense as TRACE-level tags (one per
    trace, used for search/filter) rather than per-span attributes.
    Returns string-only values; MLflow rejects non-strings on tags.

    Keys it promotes (when present in `attrs`):
      - session.id, workflow.execution.id, workflow.id, workflow.name
      - dapr.workflow.instance_id (mirror)
      - dapr.workflow.name (mirror)
      - user.id, organization.id
      - agent.slug, agent.model_spec, agent.llm_component,
        agent.config_revision
      - prompt_version
    """
    if not isinstance(attrs, dict):
        return {}

    promote = (
        SESSION_ID_ATTRIBUTE,
        WORKFLOW_EXECUTION_ATTRIBUTE,
        WORKFLOW_ID_ATTRIBUTE,
        WORKFLOW_NAME_ATTRIBUTE,
        USER_ID_ATTRIBUTE,
        ORGANIZATION_ID_ATTRIBUTE,
        AGENT_SLUG_ATTRIBUTE,
        AGENT_MODEL_SPEC_ATTRIBUTE,
        AGENT_LLM_COMPONENT_ATTRIBUTE,
        AGENT_CONFIG_REVISION_ATTRIBUTE,
        PROMPT_VERSION_ATTRIBUTE,
        PROMPT_VERSION_ID_ATTRIBUTE,
    )

    tags: dict[str, str] = {}
    for k in promote:
        v = attrs.get(k)
        if v is None:
            continue
        s = str(v).strip()
        if s:
            tags[k] = s

    # Add Dapr-Weaver mirror keys when the corresponding app keys exist.
    exec_id = tags.get(WORKFLOW_EXECUTION_ATTRIBUTE) or tags.get(SESSION_ID_ATTRIBUTE)
    if exec_id:
        tags[DAPR_WORKFLOW_INSTANCE_ID] = exec_id
    wf_name = tags.get(WORKFLOW_NAME_ATTRIBUTE)
    if wf_name:
        tags[DAPR_WORKFLOW_NAME] = wf_name

    return tags


def set_mlflow_trace_tags(
    tags: dict[str, Any],
    *,
    trace_name: str | None = None,
    trace_id_hex: str | None = None,
) -> None:
    """Promote a curated tag dict onto the active MLflow trace.

    Two-stage approach because MLflow's `update_current_trace()` only
    works when an MLflow-managed tracing context is active — which it
    isn't for spans created via the bare OTel `tracer.start_as_current_span`
    API (our case for Dapr workflow activities + dapr-agent-py manual
    spans). The warning "No active trace found" surfaces when called
    without that context.

    Strategy:
      1. Try `mlflow.update_current_trace(tags=..., session_id=...)` —
         cheap, works for `@mlflow.trace`-decorated paths.
      2. If that fails OR we have an active OTel span, ALSO call
         `MlflowClient().set_trace_tag(trace_id, k, v)` per tag, using
         the OTel trace_id translated to MLflow's `tr-<hex>` format.

    If `trace_name` is provided, ALSO set the `mlflow.traceName` tag —
    this is what MLflow's Traces UI shows as the trace's display name
    in the list. Phase 4 uses this to render agent-aware names like
    `agent.pr-reviewer/<session-id>` instead of the default span name.

    Best-effort: silent no-op when mlflow isn't installed or no OTel
    span is active. Strings only (MLflow's tag API rejects non-strings).
    """
    if not tags and not trace_name:
        return
    tags = dict(tags or {})
    clean = {
        k: str(v).strip()
        for k, v in tags.items()
        if v is not None and isinstance(v, (str, int, float))
        and str(v).strip()
    }
    if not clean:
        return
    try:
        import mlflow  # type: ignore[import-not-found]
    except Exception:
        return
    session_id = clean.pop(SESSION_ID_ATTRIBUTE, None)

    # Try the fluent API first (works when MLflow tracing context is active).
    try:
        if session_id:
            mlflow.update_current_trace(tags=clean, session_id=session_id)
        else:
            mlflow.update_current_trace(tags=clean)
    except Exception as exc:  # noqa: BLE001
        logger.debug("update_current_trace failed (will fall back to client.set_trace_tag): %s", exc)

    # Always also call set_trace_tag via the OTel-derived trace_id —
    # the fluent API silently no-ops when context isn't active. This
    # belt-and-suspenders pass guarantees the tags land on the trace.
    try:
        otel_trace_hex = _clean_trace_id(trace_id_hex)
        if not otel_trace_hex:
            from opentelemetry import trace as ot_trace
            span = ot_trace.get_current_span()
            if span is not None:
                ctx = span.get_span_context()
                if ctx and ctx.trace_id != 0:
                    otel_trace_hex = format(ctx.trace_id, "032x")
        if not otel_trace_hex:
            otel_trace_hex = _trace_id_from_traceparent(
                os.environ.get("WORKFLOW_BUILDER_TRACEPARENT")
            )
        if not otel_trace_hex:
            return
        mlflow_trace_id = f"tr-{otel_trace_hex}"
        client = mlflow.MlflowClient()
        # Re-add session.id (we popped it earlier for the fluent kwarg).
        if session_id:
            clean[SESSION_ID_ATTRIBUTE] = session_id
        for k, v in clean.items():
            try:
                client.set_trace_tag(mlflow_trace_id, k, v)
            except Exception as exc:  # noqa: BLE001
                logger.debug("client.set_trace_tag(%s)=%s failed: %s", k, v, exc)
        if trace_name:
            try:
                client.set_trace_tag(mlflow_trace_id, "mlflow.traceName", str(trace_name).strip())
            except Exception as exc:  # noqa: BLE001
                logger.debug("set_trace_tag(mlflow.traceName) failed: %s", exc)
    except Exception as exc:  # noqa: BLE001
        logger.debug("set_trace_tag fallback path failed: %s", exc)
