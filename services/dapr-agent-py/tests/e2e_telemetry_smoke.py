"""End-to-end telemetry smoke: emit every `claude_code.*` span/metric/event
kind to a live OTLP collector and print what we sent.

Run against a port-forwarded Ryzen OTEL collector:
  kubectl -n observability port-forward svc/otel-collector 14318:4318 &
  OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:14318 \
    OTEL_SERVICE_NAME=dapr-agent-py-e2e \
    OTEL_LOG_USER_PROMPTS=1 \
    ENABLE_BETA_TRACING_DETAILED=1 \
    python tests/e2e_telemetry_smoke.py

After it runs, spans should show up in the observability ClickHouse +
Jaeger within ~30s under service.name=dapr-agent-py-e2e. The `trace_id`
printed here is the query key.
"""

from __future__ import annotations

import os
import sys
import time
import uuid


def main() -> int:
    root = os.path.join(os.path.dirname(__file__), "..")
    if root not in sys.path:
        sys.path.insert(0, root)

    if not os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
        print("ERROR: OTEL_EXPORTER_OTLP_ENDPOINT must be set", file=sys.stderr)
        return 2

    os.environ.setdefault("OTEL_SERVICE_NAME", "dapr-agent-py-e2e")

    from src.telemetry import (
        end_hook_span,
        end_interaction_span,
        end_llm_request_span,
        end_tool_blocked_on_user_span,
        end_tool_execution_span,
        end_tool_span,
        init_telemetry,
        is_telemetry_ready,
        log_otel_event,
        record_code_edit_decision,
        record_cost,
        record_session_start,
        record_tokens,
        set_session_context,
        shutdown_telemetry,
        start_hook_span,
        start_interaction_span,
        start_llm_request_span,
        start_tool_blocked_on_user_span,
        start_tool_execution_span,
        start_tool_span,
    )
    from src.telemetry.metrics import init_metrics

    ok = init_telemetry()
    print(f"init_telemetry returned: {ok}, ready={is_telemetry_ready()}")
    if not ok:
        return 3
    init_metrics()

    run_id = uuid.uuid4().hex[:12]
    instance_id = f"e2e-wf-{run_id}"
    execution_id = f"e2e-exec-{run_id}"
    print(f"e2e run_id={run_id} instance_id={instance_id}")

    set_session_context(
        instance_id=instance_id,
        execution_id=execution_id,
        user_id="e2e-user",
        organization_id="e2e-org",
    )

    interaction_span = start_interaction_span("Smoke test the telemetry port")
    trace_id = format(interaction_span.get_span_context().trace_id, "032x")
    print(f"interaction trace_id={trace_id}")
    record_session_start()
    log_otel_event("user_prompt", {"prompt": "Smoke test the telemetry port"})

    # Simulate an LLM call with full attribute surface.
    llm_span = start_llm_request_span(
        "claude-opus-4-7",
        fast_mode=False,
        query_source="e2e_smoke",
        system_prompt="You are a test assistant.",
        tools_json='[{"name":"Edit","description":"Edit a file"}]',
        messages_for_api=[
            {"role": "user", "content": "Smoke test the telemetry port"}
        ],
    )
    time.sleep(0.05)
    end_llm_request_span(
        llm_span,
        input_tokens=1200,
        output_tokens=340,
        cache_read_tokens=200,
        cache_creation_tokens=50,
        ttft_ms=420.0,
        success=True,
        status_code=200,
        has_tool_call=True,
        model_output="Test assistant reply.",
    )
    record_tokens(type_="input", count=1200, model="claude-opus-4-7")
    record_tokens(type_="output", count=340, model="claude-opus-4-7")
    record_tokens(type_="cacheRead", count=200, model="claude-opus-4-7")
    record_tokens(type_="cacheCreation", count=50, model="claude-opus-4-7")
    record_cost(cost_usd=0.0123, model="claude-opus-4-7")

    # Simulate a tool call: blocked_on_user (approval) then execution.
    start_tool_span(
        "Edit",
        tool_attributes={"tool.call_id": "tc-e2e-1"},
        tool_input='{"file":"test.txt","old":"a","new":"b"}',
    )
    blocked = start_tool_blocked_on_user_span()
    time.sleep(0.02)
    end_tool_blocked_on_user_span(blocked, decision="allow", source="PreToolUse")
    record_code_edit_decision(decision="accept", tool="Edit")

    exec_span = start_tool_execution_span()
    time.sleep(0.05)
    end_tool_execution_span(exec_span, success=True)
    end_tool_span(tool_result="file updated", result_tokens=12)

    # Hook span (beta-gated).
    hook = start_hook_span("PreToolUse", "PreToolUse:Edit", 1, "[]")
    if hook is not None:
        end_hook_span(hook, num_success=1)

    end_interaction_span()

    # Force flush so the exporter pushes before we exit.
    print("flushing telemetry...")
    shutdown_telemetry()
    print(f"DONE. Query by trace_id: {trace_id}")
    print(f"ClickHouse filter: service.name='dapr-agent-py-e2e' AND TraceId='{trace_id}'")
    return 0


if __name__ == "__main__":
    sys.exit(main())
