"""Raw TaskHub gRPC helpers (StartInstance / RaiseEvent).

Mirrors claude-agent-py's ``_taskhub_call`` (services/claude-agent-py/src/main.py)
but lives in its own module so the FastAPI endpoints (main.py), the herdr
session supervisor, and the hooks receiver can all raise workflow events
without import cycles. All calls are BLOCKING — callers on the event loop must
wrap them in ``asyncio.to_thread``.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

# External-event lane the lifecycle workflow listens on. Distinct from
# claude-agent-py's `session.user_events`: user messages do NOT enter this
# runtime's workflow (they are injected into the TUI), only lifecycle events do.
LIFECYCLE_EVENT_NAME = "session.lifecycle_events"


def taskhub_call(method: str, request: Any) -> Any:
    import grpc
    import durabletask.internal.orchestrator_service_pb2_grpc as pb_grpc

    target = (
        f"{os.environ.get('DAPR_HOST', '127.0.0.1')}:"
        f"{os.environ.get('DAPR_GRPC_PORT', '50001')}"
    )
    timeout_seconds = float(os.environ.get("TASKHUB_RPC_TIMEOUT_SECONDS", "15"))
    stub = pb_grpc.TaskHubSidecarServiceStub(grpc.insecure_channel(target))
    return getattr(stub, method)(request, timeout=timeout_seconds)


def start_instance(
    instance_id: str, payload: Any, *, workflow_name: str = "session_workflow"
) -> None:
    import durabletask.internal.orchestrator_service_pb2 as pb
    from google.protobuf import wrappers_pb2

    create_request = pb.CreateInstanceRequest(
        instanceId=instance_id,
        name=workflow_name,
        input=wrappers_pb2.StringValue(value=json.dumps(payload)),
    )
    taskhub_call("StartInstance", create_request)


def raise_event(instance_id: str, event_name: str, payload: Any) -> None:
    import durabletask.internal.orchestrator_service_pb2 as pb
    from google.protobuf import wrappers_pb2

    raise_request = pb.RaiseEventRequest(
        instanceId=instance_id,
        name=event_name,
        input=wrappers_pb2.StringValue(value=json.dumps(payload)),
    )
    taskhub_call("RaiseEvent", raise_request)


def raise_lifecycle_events(instance_id: str, events: list[dict[str, Any]]) -> None:
    """Raise a batch of lifecycle events onto the session workflow instance."""
    if not instance_id or not events:
        return
    raise_event(instance_id, LIFECYCLE_EVENT_NAME, {"events": events})
