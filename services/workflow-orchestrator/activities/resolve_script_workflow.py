"""``resolve_script_workflow`` activity — resolve a ``workflow()`` reference to its
dynamic-script body so the pump can dispatch a nested ``dynamic_script_workflow_v1``.

A ``kind='workflow'`` task from the evaluator carries only ``{workflowRef, args}``;
the referenced workflow row must be loaded (BFF workflow-data API) to obtain its
``spec.script`` / ``meta``. Kept in an activity because the lookup is I/O (must not
run inside the deterministic workflow generator).
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any

from activities.workflow_data_client import workflow_data_client
from tracing import apply_workflow_activity_context, start_activity_span

logger = logging.getLogger(__name__)


def resolve_script_workflow(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Return ``{success, script, scriptSha256, meta}`` for a ``workflowRef``."""
    workflow_ref = str(input_data.get("workflowRef") or "").strip()
    if not workflow_ref:
        return {"success": False, "error": "workflowRef is required"}

    otel = input_data.get("_otel") if isinstance(input_data.get("_otel"), dict) else {}
    otel = apply_workflow_activity_context(otel)
    attrs = {"action.type": "resolve_script_workflow", "script.workflow_ref": workflow_ref}
    with start_activity_span("activity.resolve_script_workflow", otel, attrs):
        try:
            workflow = workflow_data_client.get_workflow(workflow_ref, by="name")
            if not workflow:
                workflow = workflow_data_client.get_workflow(workflow_ref)
        except Exception as exc:  # noqa: BLE001
            logger.warning("[resolve_script_workflow] lookup failed for %s: %s", workflow_ref, exc)
            return {"success": False, "error": str(exc)}

        if not isinstance(workflow, dict):
            return {"success": False, "error": f"workflow {workflow_ref!r} not found"}

        spec = workflow.get("spec")
        if not isinstance(spec, dict):
            nodes = workflow.get("nodes")
            spec = nodes if isinstance(nodes, dict) else {}
        script = spec.get("script")
        if not isinstance(script, str) or not script.strip():
            return {
                "success": False,
                "error": f"workflow {workflow_ref!r} is not a dynamic-script workflow",
            }
        meta = spec.get("meta") if isinstance(spec.get("meta"), dict) else {}
        script_sha256 = hashlib.sha256(script.encode("utf-8")).hexdigest()
        return {
            "success": True,
            "script": script,
            "scriptSha256": script_sha256,
            "meta": meta,
        }
