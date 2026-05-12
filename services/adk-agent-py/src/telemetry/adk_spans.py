"""Manual `adk_agent.*` span helpers — layered on Diagrid's built-in spans.

Diagrid emits `LLM.generate_content` and `Tool.execute` spans inside its
`call_llm_activity` and `execute_tool_activity` (via
`diagrid.agent.core.telemetry.get_tracer("adk.agent")`). Those become
children of any active span context — including the spans we open here from
`session_workflow`.

We DON'T auto-instrument via OpenInference (`google-adk` doesn't ship an
instrumentor at audit time). The Diagrid path bypasses ADK's
`LlmAgent.run_async` so `before_model_callback` / `after_model_callback`
never fire — manual span emission is the only viable hook.

GenAI semantic conventions (`gen_ai.system`, `gen_ai.usage.input_tokens`,
etc.) are NOT stamped here — they'd need access to the LLM response object
inside `call_llm_activity`, which we don't own. Future work: monkey-patch
the call_llm_activity registration on `runner._workflow_runtime` and stamp
the active span after it returns.
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

from src.telemetry.providers import get_tracer


@contextmanager
def adk_session_span(session_id: str | None) -> Iterator[object | None]:
    """Open an `adk_agent.session` span covering the entire session_workflow.

    Yields the span object (or None when telemetry is disabled). Caller is
    responsible for the `with` block's exception handling — the contextmanager
    closes the span on exit either way.
    """
    tracer = get_tracer()
    if tracer is None:
        yield None
        return
    span = tracer.start_span("adk_agent.session")
    try:
        if session_id:
            span.set_attribute("session.id", session_id)
        yield span
    finally:
        try:
            span.end()
        except Exception:
            pass


@contextmanager
def adk_turn_span(session_id: str | None, turn_index: int) -> Iterator[object | None]:
    """Open an `adk_agent.turn` span covering one Diagrid child workflow call."""
    tracer = get_tracer()
    if tracer is None:
        yield None
        return
    span = tracer.start_span("adk_agent.turn")
    try:
        if session_id:
            span.set_attribute("session.id", session_id)
        span.set_attribute("adk_agent.turn.index", turn_index)
        yield span
    finally:
        try:
            span.end()
        except Exception:
            pass
