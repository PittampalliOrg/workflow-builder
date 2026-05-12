"""SendMessage tool -- send messages to user via Dapr pub/sub (BriefTool equivalent)."""

from __future__ import annotations

import json
import os
import urllib.request


def send_message(message: str) -> str:
    """Send a message or status update to the user."""
    if not message or not message.strip():
        return "Error: No message provided."

    message = message.strip()

    payload = {
        "type": "user_message",
        "message": message,
    }

    # Publish to broadcast topic via Dapr pub/sub
    pubsub_name = os.environ.get("DAPR_PUBSUB_NAME", "pubsub")
    topic = os.environ.get("DAPR_BROADCAST_TOPIC", "dapr-agent-py.broadcast")
    sidecar = (
        f"http://{os.environ.get('DAPR_HOST', '127.0.0.1')}:"
        f"{os.environ.get('DAPR_HTTP_PORT', '3500')}"
    )
    url = f"{sidecar}/v1.0/publish/{pubsub_name}/{topic}"

    try:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            resp.read()
    except Exception as exc:
        return f"Warning: Could not publish message via pub/sub ({exc}). Message delivered locally only."

    preview = message[:100] + ("..." if len(message) > 100 else "")
    return f"Message sent: {preview}"

from .prompt import get_send_message_description
send_message.__doc__ = get_send_message_description()
