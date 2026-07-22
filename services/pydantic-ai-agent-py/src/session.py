"""Platform ``session_workflow`` — the dispatch contract wrapper.

Minimal-but-faithful port of the proven browser-use-agent/dapr-agent-py
session loop: same BFF childInput shape, ``session.status_*`` vocabulary,
``autoTerminateAfterEndTurn`` one-shot semantics with ``__turn__N`` child
instances, terminal control events, and multi-turn continuity (the durable
message history from each turn feeds the next).
"""

from __future__ import annotations

import json
import logging
from datetime import timedelta
from typing import Any

import dapr.ext.workflow as wf

from src.event_publisher import publish_session_event
from src.runtime_start_authority import authorize_session_runtime_start
from src.session_config import apply_session_control_events
from src.session_native import (
    accept_team_mailbox_delivery,
    logical_turn_id,
    session_native_event_fields,
    session_workflow_instance_id,
    session_workflow_state_from_message,
    terminal_stop_reason_from_events,
)
from src.workflow import agent_workflow

logger = logging.getLogger(__name__)

_START_AUTHORITY_PENDING_DELAYS_SECONDS = (1, 2, 4, 8, 15, 30) + (60,) * 14


def _stamp_workflow_mcp_session_token(
    agent_cfg: dict[str, Any], session_id: str, token: str
) -> None:
    """Stamp X-Wfb-Session-Token + X-Wfb-Session-Id onto the workflow-mcp-server
    MCP entry in place.

    workflow-mcp-server hosts the team tools and only exposes them when the
    request carries the signed session credential (unlike the `X-Wfb-Team-*`
    headers, which grant no capability on the current server). The token is a
    top-level dispatch field, not an MCP header, so we fold it into the entry's
    headers here — once per session, before the router hashes/caches the config
    — and toolsets.py forwards those headers into the pydantic-ai MCP client.
    """
    if not token or not session_id:
        return
    servers = agent_cfg.get("mcpServers")
    if not isinstance(servers, list):
        return
    for server in servers:
        if not isinstance(server, dict):
            continue
        url = str(server.get("url") or server.get("serverUrl") or "")
        if "workflow-mcp-server" not in url:
            continue
        headers = server.get("headers")
        if not isinstance(headers, dict):
            headers = {}
            server["headers"] = headers
        headers.setdefault("X-Wfb-Session-Token", token)
        headers.setdefault("X-Wfb-Session-Id", session_id)


def _coerce_agent_config(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return dict(raw)
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            return {}
        if isinstance(parsed, dict):
            return parsed
    return {}


def _compose_turn_task(events: list[dict]) -> str:
    """user.message text blocks concatenate; other events append as notes
    (same shape as dapr-agent-py)."""
    parts: list[str] = []
    for ev in events:
        if not isinstance(ev, dict):
            continue
        et = ev.get("type") or ""
        if et == "user.message":
            content = ev.get("content") or ev.get("data", {}).get("content") or []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    text = str(block.get("text") or "")
                    if text:
                        parts.append(text)
        elif et == "user.tool_confirmation":
            result = ev.get("result") or ev.get("data", {}).get("result")
            tool_use_id = ev.get("tool_use_id") or ev.get("data", {}).get("tool_use_id")
            parts.append(
                f"[tool_confirmation tool_use_id={tool_use_id} result={result}]"
            )
        elif et == "user.custom_tool_result":
            tool_use_id = ev.get("tool_use_id") or ev.get("data", {}).get("tool_use_id")
            content = ev.get("content") or ev.get("data", {}).get("content") or []
            text = "".join(
                str(b.get("text") or "") for b in content if isinstance(b, dict)
            )
            parts.append(f"[custom_tool_result tool_use_id={tool_use_id}] {text}")
    return "\n\n".join(parts)


def _resolve_max_iterations(agent_cfg: dict[str, Any]) -> int | None:
    for key in ("maxTurns", "maxIterations"):
        raw = agent_cfg.get(key)
        try:
            value = int(raw)
        except (TypeError, ValueError):
            continue
        if value > 0:
            return value
    return None


def session_workflow(ctx: wf.DaprWorkflowContext, message: dict):
    """Session loop bridging the platform dispatch contract onto
    ``agent_workflow``.

    Input shape (produced by the BFF ensure-for-workflow handler / spawn
    path)::

        {
            "sessionId": "sesn_abc",
            "agentConfig": { ... },
            "initialEvents": [{"type": "user.message", "content": [...]}],
            "autoTerminateAfterEndTurn": true,   # workflow-bridge one-shot
            "dbExecutionId": "...",
        }
    """
    message = message or {}
    session_id = str(message.get("sessionId") or "")
    if not session_id:
        raise RuntimeError("session_workflow requires sessionId")

    # The Dapr instance can be accepted before its session row publishes the
    # exact runtime generation. Revalidate that persisted authority as the first
    # durable step, before status events, model requests, or tool execution.
    if bool(message.get("requiresStartAuthority")):
        for pending_attempt in range(
            len(_START_AUTHORITY_PENDING_DELAYS_SECONDS) + 1
        ):
            start_authority = yield ctx.call_activity(
                authorize_session_runtime_start,
                input={
                    "sessionId": session_id,
                    "workflowMcpSessionToken": message.get(
                        "workflowMcpSessionToken"
                    ),
                    "runtimeAppId": message.get("runtimeAppId")
                    or message.get("agentAppId"),
                    "runtimeInstanceId": ctx.instance_id,
                },
            )
            if isinstance(start_authority, dict) and start_authority.get(
                "authorized"
            ):
                break
            retryable_pending = bool(
                isinstance(start_authority, dict)
                and start_authority.get("retryable") is True
                and start_authority.get("code")
                in {"team_pending", "runtime_unpublished"}
            )
            if (
                not retryable_pending
                or pending_attempt >= len(_START_AUTHORITY_PENDING_DELAYS_SECONDS)
            ):
                return {
                    "success": False,
                    "cancelled": True,
                    "status": "cancelled",
                    "content": "",
                    "sessionId": session_id,
                    "error": (
                        "session start authority remained pending"
                        if retryable_pending
                        else "session start was not authorized"
                    ),
                }
            yield ctx.create_timer(
                timedelta(
                    seconds=_START_AUTHORITY_PENDING_DELAYS_SECONDS[pending_attempt]
                )
            )

    agent_cfg = _coerce_agent_config(message.get("agentConfig"))
    # BFF-signed platform credential (top-level dispatch field, NOT an MCP
    # header): workflow-mcp-server only exposes the team tools
    # (claim_task/update_task/…) when the MCP request carries
    # X-Wfb-Session-Token + X-Wfb-Session-Id. Thread it into the agent context
    # so call_llm can stamp it onto the workflow-mcp-server MCP entry.
    workflow_mcp_session_token = str(message.get("workflowMcpSessionToken") or "")
    if workflow_mcp_session_token:
        _stamp_workflow_mcp_session_token(
            agent_cfg, session_id, workflow_mcp_session_token
        )
    vault_ids = message.get("vaultIds") or []
    db_execution_id = str(message.get("dbExecutionId") or "")
    workflow_instance_id = session_workflow_instance_id(
        getattr(ctx, "instance_id", None), session_id
    )
    continuation_state = session_workflow_state_from_message(message)
    pending = list(message.get("initialEvents") or [])
    auto_terminate = bool(message.get("autoTerminateAfterEndTurn"))
    turn_counter = int(continuation_state["turnCounter"])
    config_revision = int(continuation_state["configRevision"])
    accepted_team_mailbox_batch_ids = set(
        continuation_state["teamMailboxBatchIds"]
    )
    accepted_team_mailbox_event_ids = set(
        continuation_state["teamMailboxEventIds"]
    )
    # Durable multi-turn continuity: the serialized pydantic-ai message
    # history from each turn seeds the next (held as workflow-local state,
    # durable via replay).
    history: list[dict] = []

    if not ctx.is_replaying:
        publish_session_event(
            session_id,
            "session.status_rescheduled",
            {"vaultIds": vault_ids, **session_native_event_fields(workflow_instance_id)},
        )

    while True:
        if not pending:
            if not ctx.is_replaying:
                publish_session_event(
                    session_id,
                    "session.status_idle",
                    {
                        "stop_reason": {"type": "end_turn"},
                        **session_native_event_fields(workflow_instance_id),
                    },
                )
            try:
                batch = yield ctx.wait_for_external_event("session.user_events")
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "[session] %s wait_for_external_event failed: %s", session_id, exc
                )
                break
            pending = accept_team_mailbox_delivery(
                batch,
                accepted_batch_ids=accepted_team_mailbox_batch_ids,
                accepted_event_ids=accepted_team_mailbox_event_ids,
            )
            if not pending:
                continue

        agent_cfg, pending, config_changes = apply_session_control_events(
            agent_cfg, pending
        )
        if config_changes:
            config_revision += 1
            if not ctx.is_replaying:
                publish_session_event(
                    session_id,
                    "session.config_updated",
                    {
                        "changes": config_changes,
                        "applies": "next_turn",
                        "configRevision": config_revision,
                        "modelSpec": agent_cfg.get("modelSpec"),
                        **session_native_event_fields(workflow_instance_id),
                    },
                )
            if not pending:
                continue

        terminal_stop_reason = terminal_stop_reason_from_events(pending)
        if terminal_stop_reason:
            if not ctx.is_replaying:
                for event_type in ("session.status_terminating", "session.status_terminated"):
                    publish_session_event(
                        session_id,
                        event_type,
                        {
                            "stop_reason": terminal_stop_reason,
                            **session_native_event_fields(workflow_instance_id),
                        },
                    )
            return

        task_text = _compose_turn_task(pending)
        pending = []
        turn_counter += 1
        turn_id = logical_turn_id(session_id, turn_counter)
        agent_turn_instance_id = (
            f"{workflow_instance_id}__turn__{turn_counter}"
            if auto_terminate
            else workflow_instance_id
        )

        if not ctx.is_replaying:
            publish_session_event(
                session_id,
                "session.status_running",
                {
                    "turn": turn_counter,
                    "turnId": turn_id,
                    **session_native_event_fields(workflow_instance_id),
                },
            )
            publish_session_event(
                session_id,
                "session.turn_started",
                {
                    "turn": turn_counter,
                    "turnId": turn_id,
                    "childInstanceId": agent_turn_instance_id,
                    "configRevision": config_revision,
                    "modelSpec": agent_cfg.get("modelSpec"),
                    **session_native_event_fields(workflow_instance_id),
                },
            )

        child_input = {
            "task": task_text,
            "history": history,
            "maxIterations": _resolve_max_iterations(agent_cfg),
            "context": {
                "sessionId": session_id,
                "agentConfig": agent_cfg,
                "turn": turn_counter,
                "turnId": turn_id,
                "workflowInstanceId": workflow_instance_id,
                "cancellationScopeId": agent_turn_instance_id,
                "dbExecutionId": db_execution_id,
                "workflowMcpSessionToken": workflow_mcp_session_token,
            },
        }

        try:
            if auto_terminate:
                # One-shot durable/run turn: a real child workflow so the
                # session wrapper and the agent loop don't share action IDs.
                turn_result = yield ctx.call_child_workflow(
                    agent_workflow,
                    input=child_input,
                    instance_id=agent_turn_instance_id,
                )
            else:
                turn_result = yield from agent_workflow(ctx, child_input)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "[session] %s turn %d failed: %s", session_id, turn_counter, exc
            )
            if not ctx.is_replaying:
                publish_session_event(
                    session_id,
                    "session.error",
                    {
                        "turn": turn_counter,
                        "turnId": turn_id,
                        "error": str(exc)[:500],
                        **session_native_event_fields(workflow_instance_id),
                    },
                )
                publish_session_event(
                    session_id,
                    "session.status_terminated",
                    session_native_event_fields(workflow_instance_id),
                )
            if auto_terminate:
                return {
                    "success": False,
                    "content": str(exc)[:500],
                    "error": str(exc)[:500],
                    "sessionId": session_id,
                    "turn": turn_counter,
                    **session_native_event_fields(workflow_instance_id),
                }
            return

        result_dict = (
            turn_result
            if isinstance(turn_result, dict)
            else {"content": str(turn_result or "")}
        )
        history = list(result_dict.pop("messages", None) or history)

        if auto_terminate:
            cancelled = bool(result_dict.get("cancelled"))
            if not ctx.is_replaying:
                if cancelled:
                    stop_reason = (
                        result_dict.get("stop_reason")
                        if isinstance(result_dict.get("stop_reason"), dict)
                        else {"type": "terminated"}
                    )
                    publish_session_event(
                        session_id,
                        "session.status_terminating",
                        {
                            "stop_reason": stop_reason,
                            **session_native_event_fields(workflow_instance_id),
                        },
                    )
                else:
                    publish_session_event(
                        session_id,
                        "session.status_idle",
                        {
                            "stop_reason": {"type": "end_turn"},
                            **session_native_event_fields(workflow_instance_id),
                        },
                    )
                publish_session_event(
                    session_id,
                    "session.status_terminated",
                    {
                        "reason": "cancelled"
                        if cancelled
                        else "auto_terminate_after_end_turn",
                        **(
                            {"stop_reason": result_dict.get("stop_reason")}
                            if cancelled
                            and isinstance(result_dict.get("stop_reason"), dict)
                            else {}
                        ),
                        **session_native_event_fields(workflow_instance_id),
                    },
                )
            result_dict.setdefault("success", not bool(result_dict.get("error")))
            result_dict.setdefault("sessionId", session_id)
            result_dict.setdefault("turn", turn_counter)
            for key, value in session_native_event_fields(workflow_instance_id).items():
                result_dict.setdefault(key, value)
            return result_dict
