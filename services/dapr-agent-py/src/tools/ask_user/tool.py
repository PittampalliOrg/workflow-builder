"""AskUserQuestion tool -- structured user questions via Dapr pub/sub (async, non-blocking).

Model-facing surface mirrors kimi-code v2's ``AskUserQuestion`` tool: 1-4
questions, each with optional structured options. The tool is fire-and-forget
by construction (no ``background`` param): the questions are published to the
broadcast topic and the user's answer arrives later as an event.

Note: the runtime can suppress this tool entirely via the agent config
``interactionMode`` (non-interactive sessions should not offer it); that
mechanism lives outside this module.
"""

from __future__ import annotations

import json
import os
import urllib.request
from typing import Any, List, Optional

from pydantic import BaseModel, ConfigDict, Field

from .prompt import get_ask_user_description


class Option(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    label: str = Field(
        description="Concise display text (1-5 words). If recommended, append '(Recommended)'.",
    )
    description: Optional[str] = Field(
        default=None,
        description="Brief explanation of trade-offs or implications.",
    )


class Question(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    question: str = Field(
        description="A specific, actionable question. End with '?'.",
    )
    header: Optional[str] = Field(
        default=None,
        max_length=12,
        description="Short category tag (max 12 chars, e.g. 'Auth', 'Style').",
    )
    options: Optional[List[Option]] = Field(
        default=None,
        min_length=2,
        max_length=4,
        description=(
            "2-4 meaningful, distinct options. Do NOT include an 'Other' "
            "option — the system adds one automatically."
        ),
    )
    multi_select: bool = Field(
        default=False,
        description="Whether the user can select multiple options.",
    )


class AskUserQuestionArgs(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    questions: List[Question] = Field(
        min_length=1,
        max_length=4,
        description="The questions to ask the user (1-4 questions).",
    )


def _as_dict(item: Any) -> dict:
    """Normalize a question/option entry (pydantic model or mapping) to a dict."""
    if isinstance(item, BaseModel):
        return item.model_dump(exclude_none=True)
    if isinstance(item, dict):
        return item
    return {}


def _validate_and_normalize(questions: Any) -> tuple[Optional[list], Optional[str]]:
    """Validate the raw ``questions`` argument.

    Returns ``(normalized_questions, None)`` on success or ``(None, error)``
    on failure — user-facing failures are strings, never exceptions.
    """
    if not isinstance(questions, list) or not questions:
        return None, "Error: Expected 1-4 questions, got 0."
    if len(questions) > 4:
        return None, f"Error: Expected 1-4 questions, got {len(questions)}."

    normalized: list = []
    seen_texts: set = set()
    for i, raw in enumerate(questions, start=1):
        q = _as_dict(raw)
        text = str(q.get("question") or "").strip()
        if not text:
            return None, f"Error: Question {i} has no question text."
        if text in seen_texts:
            return None, f"Error: Duplicate question text: {text!r}. Question texts must be unique."
        seen_texts.add(text)

        header = q.get("header")
        if header is not None:
            header = str(header).strip()
            if len(header) > 12:
                return None, f"Error: Question {i} header exceeds 12 characters: {header!r}."

        multi_select = bool(q.get("multi_select", False))

        options = q.get("options")
        norm_options = None
        if options is not None:
            if not isinstance(options, list) or not 2 <= len(options) <= 4:
                count = len(options) if isinstance(options, list) else 0
                return None, f"Error: Question {i} must have 2-4 options, got {count}."
            norm_options = []
            seen_labels: set = set()
            for j, raw_opt in enumerate(options, start=1):
                opt = _as_dict(raw_opt)
                label = str(opt.get("label") or "").strip()
                if not label:
                    return None, f"Error: Option {j} of question {i} has no label."
                if label in seen_labels:
                    return None, (
                        f"Error: Duplicate option label {label!r} in question {i}. "
                        "Option labels must be unique within each question."
                    )
                seen_labels.add(label)
                norm_opt: dict = {"label": label}
                opt_desc = opt.get("description")
                if opt_desc:
                    norm_opt["description"] = str(opt_desc)
                norm_options.append(norm_opt)

        norm_q: dict = {"question": text, "multi_select": multi_select}
        if header:
            norm_q["header"] = header
        if norm_options is not None:
            norm_q["options"] = norm_options
        normalized.append(norm_q)

    return normalized, None


def ask_user(questions: list) -> str:
    """Ask the user one or more structured questions. Publishes the questions via Dapr pub/sub; the user's response arrives later as an event."""
    normalized, error = _validate_and_normalize(questions)
    if error is not None:
        return error

    message = {
        "type": "user_question",
        "questions": normalized,
    }

    # Publish to broadcast topic via Dapr pub/sub
    pubsub_name = os.environ.get("DAPR_PUBSUB_NAME", "pubsub")
    topic = os.environ.get("DAPR_BROADCAST_TOPIC", "dapr-agent-py.broadcast")
    sidecar = (
        f"http://{os.environ.get('DAPR_HOST', '127.0.0.1')}:"
        f"{os.environ.get('DAPR_HTTP_PORT', '3500')}"
    )
    url = f"{sidecar}/v1.0/publish/{pubsub_name}/{topic}"

    summary_lines = [
        f"{i}. [{q['header']}] {q['question']}" if q.get("header") else f"{i}. {q['question']}"
        for i, q in enumerate(normalized, start=1)
    ]
    summary = "\n".join(summary_lines)

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
        return f"Warning: Could not publish question via pub/sub ({exc}). Questions:\n{summary}"

    return f"Published {len(normalized)} question(s) for the user:\n{summary}\nAwaiting user response via event."

ask_user.__doc__ = get_ask_user_description()
