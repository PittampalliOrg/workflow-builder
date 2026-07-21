"""Telemetry for dapr-agent-py.

Python port of the OpenTelemetry instrumentation in claude-code-src. Mirrors
span names (`claude_code.*`), counter names, and event names from the TS
source so dashboards and queries transfer.

Layered on top of DaprAgentsInstrumentor's OpenInference spans — both
coexist; `claude_code.*` spans are rooted under whatever Dapr workflow span
is active.
"""

from __future__ import annotations

from .attributes import get_telemetry_attributes, set_session_context
from .beta import (
    is_beta_tracing_enabled,
    truncate_content,
)
from .events import emit_user_prompt_event, log_otel_event
from .metrics import (
    record_active_time,
    record_code_edit_decision,
    record_cost,
    record_lines_of_code,
    record_session_start,
    record_tokens,
)
from .providers import (
    flush_telemetry,
    init_telemetry,
    is_telemetry_ready,
    shutdown_telemetry,
)
from .session_tracing import (
    current_interaction_span,
    end_hook_span,
    end_interaction_span,
    end_llm_request_span,
    end_tool_blocked_on_user_span,
    end_tool_execution_span,
    end_tool_span,
    get_span_trace_context,
    start_hook_span,
    start_interaction_span,
    start_llm_request_span,
    start_tool_blocked_on_user_span,
    start_tool_execution_span,
    start_tool_span,
)

__all__ = [
    # providers
    "init_telemetry",
    "shutdown_telemetry",
    "is_telemetry_ready",
    "flush_telemetry",
    # attributes
    "get_telemetry_attributes",
    "set_session_context",
    # spans
    "start_interaction_span",
    "end_interaction_span",
    "current_interaction_span",
    "get_span_trace_context",
    "start_llm_request_span",
    "end_llm_request_span",
    "start_tool_span",
    "end_tool_span",
    "start_tool_blocked_on_user_span",
    "end_tool_blocked_on_user_span",
    "start_tool_execution_span",
    "end_tool_execution_span",
    "start_hook_span",
    "end_hook_span",
    # metrics
    "record_session_start",
    "record_tokens",
    "record_cost",
    "record_code_edit_decision",
    "record_lines_of_code",
    "record_active_time",
    # events
    "log_otel_event",
    "emit_user_prompt_event",
    # beta
    "is_beta_tracing_enabled",
    "truncate_content",
]
