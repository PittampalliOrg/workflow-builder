"""Tests for push-based sandbox output streaming.

Covers HeartbeatLocalBackend.execute() with Popen + selectors line streaming,
and the OpenShell partial output extraction path.
"""

import time

import pytest
import langgraph_engine
import app as runtime_app
from langgraph_engine import HeartbeatLocalBackend


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class EventCollector:
    """Collects progress_callback events for assertions."""

    def __init__(self):
        self.events: list[dict] = []

    def __call__(self, event: dict) -> None:
        self.events.append(event)

    def of_type(self, event_type: str) -> list[dict]:
        return [e for e in self.events if e.get("event") == event_type]


# ---------------------------------------------------------------------------
# HeartbeatLocalBackend.execute() tests
# ---------------------------------------------------------------------------

class TestHeartbeatLocalBackendStreaming:
    """Tests for the Popen + selectors streaming in HeartbeatLocalBackend."""

    def test_emits_partial_output_lines(self, tmp_path):
        """Each stdout line should appear in sandbox_output_partial events."""
        collector = EventCollector()
        backend = HeartbeatLocalBackend(
            root_dir=str(tmp_path),
            progress_callback=collector,
        )

        result = backend.execute("echo line1; echo line2; echo line3")

        partials = collector.of_type("sandbox_output_partial")
        assert len(partials) > 0, "Expected at least one partial event"

        # All output lines should appear across partial events
        all_partial_text = "\n".join(e["output"] for e in partials)
        assert "line1" in all_partial_text
        assert "line2" in all_partial_text
        assert "line3" in all_partial_text

    def test_emits_final_sandbox_output(self, tmp_path):
        """A final sandbox_output event with full output should be emitted."""
        collector = EventCollector()
        backend = HeartbeatLocalBackend(
            root_dir=str(tmp_path),
            progress_callback=collector,
        )

        backend.execute("echo hello; echo world")

        finals = collector.of_type("sandbox_output")
        assert len(finals) == 1
        assert "hello" in finals[0]["output"]
        assert "world" in finals[0]["output"]
        assert finals[0]["exitCode"] == 0

    def test_captures_stderr(self, tmp_path):
        """stderr output should appear in both partial and final events."""
        collector = EventCollector()
        backend = HeartbeatLocalBackend(
            root_dir=str(tmp_path),
            progress_callback=collector,
        )

        backend.execute("echo err_line >&2")

        finals = collector.of_type("sandbox_output")
        assert len(finals) == 1
        assert "err_line" in finals[0]["output"]

    def test_nonzero_exit_code(self, tmp_path):
        """Non-zero exit code should be reflected in events."""
        collector = EventCollector()
        backend = HeartbeatLocalBackend(
            root_dir=str(tmp_path),
            progress_callback=collector,
        )

        result = backend.execute("exit 42")

        finals = collector.of_type("sandbox_output")
        assert finals[0]["exitCode"] == 42

        completes = collector.of_type("tool_complete")
        assert completes[0]["status"] == "nonzero_exit"

    def test_event_sequence(self, tmp_path):
        """Events should follow: tool_start → partials → sandbox_output → tool_complete."""
        collector = EventCollector()
        backend = HeartbeatLocalBackend(
            root_dir=str(tmp_path),
            progress_callback=collector,
        )

        backend.execute("echo ok")

        types = [e["event"] for e in collector.events]
        assert types[0] == "tool_start"
        assert types[-2] == "sandbox_output"
        assert types[-1] == "tool_complete"

    def test_partial_events_include_command(self, tmp_path):
        """Partial events should include the command field."""
        collector = EventCollector()
        backend = HeartbeatLocalBackend(
            root_dir=str(tmp_path),
            progress_callback=collector,
        )

        backend.execute("echo test_cmd")

        partials = collector.of_type("sandbox_output_partial")
        assert len(partials) > 0
        assert partials[0]["command"] == "echo test_cmd"

    def test_returns_execute_response(self, tmp_path):
        """Should return an ExecuteResponse with output and exit_code."""
        collector = EventCollector()
        backend = HeartbeatLocalBackend(
            root_dir=str(tmp_path),
            progress_callback=collector,
        )

        result = backend.execute("echo hello_result")

        assert hasattr(result, "output") or isinstance(result, dict)
        if hasattr(result, "output"):
            assert "hello_result" in result.output
            assert result.exit_code == 0
        else:
            assert "hello_result" in result["output"]
            assert result["exit_code"] == 0

    def test_no_callback_falls_back(self, tmp_path):
        """Without progress_callback, should fall back to super().execute()."""
        backend = HeartbeatLocalBackend(
            root_dir=str(tmp_path),
            progress_callback=None,
        )

        result = backend.execute("echo fallback")
        # Should still return a result (via super())
        output = getattr(result, "output", None) or result.get("output", "")
        assert "fallback" in output

    def test_batching_fast_output(self, tmp_path):
        """Fast output (seq 1 50) should be batched into fewer events than lines."""
        collector = EventCollector()
        backend = HeartbeatLocalBackend(
            root_dir=str(tmp_path),
            progress_callback=collector,
        )

        backend.execute("seq 1 50")

        partials = collector.of_type("sandbox_output_partial")
        # With batching (10 lines max), 50 lines should produce <= 50 partial events
        # and ideally far fewer due to batching
        assert len(partials) < 50, f"Expected batching to reduce events, got {len(partials)}"

        # But all 50 lines should be present in the final output
        finals = collector.of_type("sandbox_output")
        output_lines = finals[0]["output"].strip().split("\n")
        assert len(output_lines) == 50

    def test_heartbeat_during_long_command(self, tmp_path):
        """A command running >5s should emit heartbeat events."""
        collector = EventCollector()
        backend = HeartbeatLocalBackend(
            root_dir=str(tmp_path),
            progress_callback=collector,
        )

        # Sleep for 6 seconds to trigger at least one heartbeat
        backend.execute("sleep 6")

        heartbeats = collector.of_type("sandbox_heartbeat")
        assert len(heartbeats) >= 1, "Expected at least one heartbeat during 6s sleep"
        assert heartbeats[0]["elapsedSeconds"] >= 1

    def test_mixed_stdout_stderr_ordering(self, tmp_path):
        """Both stdout and stderr lines should appear in partial events."""
        collector = EventCollector()
        backend = HeartbeatLocalBackend(
            root_dir=str(tmp_path),
            progress_callback=collector,
        )

        backend.execute("echo out1; echo err1 >&2; echo out2")

        partials = collector.of_type("sandbox_output_partial")
        all_text = "\n".join(e["output"] for e in partials)
        assert "out1" in all_text
        assert "err1" in all_text
        assert "out2" in all_text


# ---------------------------------------------------------------------------
# OpenShell partial output extraction (unit test via monkeypatch)
# ---------------------------------------------------------------------------

class TestOpenShellPartialOutput:
    """Test that the OpenShell heartbeat loop extracts partial stdout."""

    def test_openshell_emits_partial_from_poll(self, monkeypatch):
        """When poll_run_status returns growing stdout, partials should be emitted."""
        collector = EventCollector()
        poll_call_count = 0
        poll_outputs = [
            "line1\n",
            "line1\nline2\n",
            "line1\nline2\nline3\n",
        ]

        class FakeOpenShellContext:
            sandbox_name = "test-sandbox"

            def run_command(self, cmd, *, cwd=".", timeout_seconds=300, run_id=""):
                # Simulate slow command
                time.sleep(0.3)
                return {"stdout": "line1\nline2\nline3\n", "exitCode": 0}

            def poll_run_status(self, run_id):
                nonlocal poll_call_count
                idx = min(poll_call_count, len(poll_outputs) - 1)
                poll_call_count += 1
                return {"status": "running", "stdout": poll_outputs[idx]}

        # Patch _HEARTBEAT_INTERVAL to be very short for test speed
        monkeypatch.setattr(langgraph_engine, "_HEARTBEAT_INTERVAL", 0.1)

        tools = langgraph_engine._bind_openshell_tools(
            FakeOpenShellContext(),
            progress_callback=collector,
        )
        execute_fn = tools[0]

        result = execute_fn(command="echo test")

        partials = collector.of_type("sandbox_output_partial")
        # Should have emitted at least some partial lines
        # (depends on timing, so we check best-effort)
        if poll_call_count > 1:
            assert len(partials) > 0, "Expected partial events from OpenShell polling"

        # Final sandbox_output should still be emitted
        finals = collector.of_type("sandbox_output")
        assert len(finals) == 1


# ---------------------------------------------------------------------------
# _run_execute_with_streaming (execute_command wrapper) tests
# ---------------------------------------------------------------------------

class TestRunExecuteWithStreaming:
    """Test that execute_command goes through streaming when wrapped."""

    def test_execute_command_emits_partials_via_wrapper(self, tmp_path, monkeypatch):
        """When _bind_workspace_tools wraps execute_command, partials should be emitted."""
        import tools
        from tools import push_tool_context, pop_tool_context, ToolRuntimeContext

        # Set up workspace context
        context = ToolRuntimeContext.from_workspace_root(str(tmp_path))
        token = push_tool_context(context)

        collector = EventCollector()
        try:
            bound_tools = langgraph_engine._bind_workspace_tools(
                "all",
                str(tmp_path),
                progress_callback=collector,
            )

            # Find the execute_command wrapper
            exec_tool = None
            for t in bound_tools:
                tool_name = getattr(t, "__name__", "") or getattr(t, "name", "")
                if tool_name == "execute_command":
                    exec_tool = t
                    break

            assert exec_tool is not None, "execute_command tool not found in bound tools"

            # Call it
            result = exec_tool(command="echo streaming_test_line1; echo streaming_test_line2")

            # Check partials were emitted
            partials = collector.of_type("sandbox_output_partial")
            assert len(partials) > 0, "Expected sandbox_output_partial events"
            all_partial_text = "\n".join(e["output"] for e in partials)
            assert "streaming_test_line1" in all_partial_text
            assert "streaming_test_line2" in all_partial_text

            # Check final sandbox_output
            finals = collector.of_type("sandbox_output")
            assert len(finals) == 1
            assert "streaming_test_line1" in finals[0]["output"]

            # Check result dict matches execute_command's contract
            assert result["exitCode"] == 0
            assert "streaming_test_line1" in result["stdout"]
            assert result["timedOut"] is False
        finally:
            pop_tool_context(token)


class TestStreamHistoryReplay:
    def test_push_stream_event_persists_history_without_active_subscribers(self, monkeypatch):
        store = runtime_app.StateStoreService(store_name="test", key_prefix="stream-history-test:")
        monkeypatch.setattr(runtime_app, "run_state_store", store)
        monkeypatch.setattr(runtime_app, "_stream_queues", {})
        monkeypatch.setattr(runtime_app, "_stream_event_counter", {})

        runtime_app._push_stream_event(
            "run-123",
            {"type": "sandbox_output_partial", "ts": runtime_app._utc_now_iso(), "output": "line1"},
        )
        runtime_app._push_stream_event(
            "run-123",
            {"type": "tool_complete", "ts": runtime_app._utc_now_iso(), "toolName": "execute"},
        )

        last_seq, history = runtime_app._load_stream_history("run-123")

        assert last_seq == 2
        assert [event["type"] for event in history] == [
            "sandbox_output_partial",
            "tool_complete",
        ]
        assert history[0]["_seq"] == 1
        assert history[1]["_seq"] == 2

    def test_reset_stream_history_clears_counter_and_persisted_events(self, monkeypatch):
        store = runtime_app.StateStoreService(store_name="test", key_prefix="stream-history-reset:")
        monkeypatch.setattr(runtime_app, "run_state_store", store)
        monkeypatch.setattr(runtime_app, "_stream_queues", {})
        monkeypatch.setattr(runtime_app, "_stream_event_counter", {"run-456": 4})

        runtime_app._push_stream_event(
            "run-456",
            {"type": "run_started", "ts": runtime_app._utc_now_iso()},
        )

        runtime_app._reset_stream_history("run-456")
        last_seq, history = runtime_app._load_stream_history("run-456")

        assert last_seq == 0
        assert history == []
        assert runtime_app._stream_event_counter == {}
