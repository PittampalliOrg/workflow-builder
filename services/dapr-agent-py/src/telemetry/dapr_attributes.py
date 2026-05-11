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

# Prompt registry (populated once Phase 3a lands).
PROMPT_VERSION_ATTRIBUTE = "prompt_version"


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


def set_mlflow_trace_tags(tags: dict[str, Any]) -> None:
    """Promote a curated tag dict onto the active MLflow trace.

    Best-effort: silent no-op when mlflow isn't installed or no active
    trace exists. Strings only (MLflow's tag API rejects non-strings).
    """
    if not tags:
        return
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
    # MLflow 3.12 exposes update_current_trace at the top level
    # (mlflow.update_current_trace). Also takes a dedicated `session_id`
    # kwarg — use it when present so MLflow's Sessions UI clusters
    # traces correctly.
    session_id = clean.pop(SESSION_ID_ATTRIBUTE, None)
    try:
        if session_id:
            mlflow.update_current_trace(tags=clean, session_id=session_id)
        else:
            mlflow.update_current_trace(tags=clean)
    except Exception as exc:  # noqa: BLE001
        logger.debug("update_current_trace(tags=...) failed: %s", exc)
