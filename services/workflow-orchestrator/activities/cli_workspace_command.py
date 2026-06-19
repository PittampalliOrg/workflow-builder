"""Activity: run a deterministic gate command in an interactive-cli run's shared workspace.

A SW 1.0 `workspace/command` task with `cliWorkspace: true` (the gate of a CLI
generator/critic loop) can't reach the agents' files via openshell-agent-runtime:
the CLI agents write to the per-execution JuiceFS mount at `/sandbox/work` that
only CLI pods see. This activity POSTs the FIXED command to the BFF, which runs it
in the execution's live CLI pod via cli-agent-py `/internal/workspace/command`
(cli-direct). The command is spec-fixed (not LLM-decided), so the gate stays
deterministic and independent of the generator agent.

Returns the same envelope the workspace runtime would
(`{success, result: {exitCode, stdout, stderr}}`) so the loop's
`${ .loop.last.gate.result.stdout }` refs resolve unchanged. Non-zero exit is
DATA (an OBJECTIVE FAIL), not a transport error — the gate node uses
`allowFailure: true`.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import requests

from tracing import set_current_span_attrs, start_activity_span

logger = logging.getLogger("activities.cli_workspace_command")


def cli_workspace_command(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    execution_id = str(input_data.get("executionId") or "").strip()
    command = input_data.get("command")
    cwd = str(input_data.get("cwd") or "/sandbox/work")
    if not execution_id:
        return {"success": False, "result": {"exitCode": -1, "stdout": "", "stderr": "cli_workspace_command: executionId is required"}}
    if not isinstance(command, str) or not command.strip():
        return {"success": False, "result": {"exitCode": -1, "stdout": "", "stderr": "cli_workspace_command: command is required"}}

    otel = input_data.get("_otel") if isinstance(input_data.get("_otel"), dict) else None
    with start_activity_span("activity.cli_workspace_command", otel, {"workflow.execution.id": execution_id}):
        set_current_span_attrs({"workflow.execution.id": execution_id, "cli.workspace.cwd": cwd})
        url = os.environ.get(
            "WORKFLOW_BUILDER_URL",
            "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
        ).rstrip("/")
        internal_token = os.environ.get("INTERNAL_API_TOKEN", "")
        if not internal_token:
            raise RuntimeError("INTERNAL_API_TOKEN is not configured — cli_workspace_command requires it")
        try:
            response = requests.post(
                f"{url}/api/internal/workflows/executions/{execution_id}/cli-workspace-command",
                json={"command": command, "cwd": cwd},
                headers={"X-Internal-Token": internal_token},
                timeout=120,
            )
            if response.status_code >= 400:
                detail = response.text[:2000]
                logger.warning(
                    "cli_workspace_command failed: status=%s body=%s exec=%s",
                    response.status_code, detail, execution_id,
                )
                # Surface as DATA so the gate reports a failure (allowFailure node).
                return {"success": False, "result": {"exitCode": -1, "stdout": "", "stderr": f"gate dispatch error {response.status_code}: {detail}"}}
            data = response.json()
            if not isinstance(data, dict):
                return {"success": False, "result": {"exitCode": -1, "stdout": "", "stderr": "gate returned non-object"}}
            return data
        except Exception as exc:
            logger.warning("cli_workspace_command transport error: %s exec=%s", exc, execution_id)
            return {"success": False, "result": {"exitCode": -1, "stdout": "", "stderr": f"gate transport error: {exc}"}}
