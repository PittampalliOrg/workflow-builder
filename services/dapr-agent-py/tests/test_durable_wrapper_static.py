from __future__ import annotations

import pathlib


ROOT = pathlib.Path(__file__).resolve().parents[1]


def test_wrapper_compacts_tool_results_in_existing_activity_path():
    source = (ROOT / "src/main.py").read_text()
    assert "def save_tool_results(self, ctx, payload: dict)" in source
    assert "compact_save_tool_results_payload" in source
    assert "return super().save_tool_results(ctx, compacted_payload)" in source


def test_summary_is_best_effort_for_session_native_workflows():
    source = (ROOT / "src/main.py").read_text()
    assert "session_native_compaction_owns_context" in source
    assert "build_bounded_summary_task" in source
    assert "agent.summary_failed" in source
    assert "return self._bounded_summarize_conversation(instance_id, entry)" in source
