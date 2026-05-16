from __future__ import annotations

from pathlib import Path


MAIN_SOURCE = Path(__file__).resolve().parents[1] / "src" / "main.py"


def test_session_seeded_runtime_context_carries_mlflow_context() -> None:
    source = MAIN_SOURCE.read_text()

    assert '"mlflowContext": child_mlflow_context' in source
    assert '"mlflowRunId": child_mlflow_context.get("runId")' in source
    assert '"mlflowParentRunId": child_mlflow_context.get("parentRunId")' in source
    assert '"mlflowTraceExperimentId": child_mlflow_context.get(' in source


def test_runtime_context_memory_cache_preserves_mlflow_context() -> None:
    source = MAIN_SOURCE.read_text()

    assert 'if isinstance(clean.get("mlflowContext"), dict):' in source
    assert 'agent_context["mlflowContext"] = dict(clean["mlflowContext"])' in source


def test_call_llm_emits_active_context_usage_before_provider_call() -> None:
    source = MAIN_SOURCE.read_text()

    assert "def _emit_active_context_usage(" in source
    assert '"agent.context_usage"' in source
    assert "**fields" in source
    assert '"llm.context.count_method": fields.get("context_count_method")' in source
    assert 'f"{instance_id}:{turn_id or \'turn\'}:context_usage:{request_hash}"' in source
    assert source.index("self._emit_active_context_usage(") < source.index(
        "result = super().call_llm(ctx, payload)"
    )
