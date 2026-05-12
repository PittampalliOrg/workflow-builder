"""AskUser tool -- request user input via Dapr pub/sub (async, non-blocking)."""

from __future__ import annotations

import json
import os
import urllib.request


def ask_user(question: str) -> str:
    """Ask the user a question and wait for their response. In durable mode, publishes the question and waits for a response event."""
    if not question or not question.strip():
        return "Error: No question provided."

    question = question.strip()

    message = {
        "type": "user_question",
        "question": question,
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
        payload = json.dumps(message).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            resp.read()
    except Exception as exc:
        return f"Warning: Could not publish question via pub/sub ({exc}). Question: {question}"

    return f"Question published: {question}\nAwaiting user response via event."

from .prompt import get_ask_user_description
ask_user.__doc__ = get_ask_user_description()
