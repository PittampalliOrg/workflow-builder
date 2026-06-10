from __future__ import annotations

import importlib
import json
import os
import sys

root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

adapter = importlib.import_module("src.openai_adapter")


class _Response:
    def __init__(self, payload: dict):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self) -> bytes:
        return json.dumps(self.payload).encode()


def test_openai_auth_headers_use_api_key_only(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    assert adapter._auth_headers() == (
        {"Authorization": "Bearer sk-test"},
        "openai-api-key",
    )


def test_openai_auth_headers_require_api_key(monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    try:
        adapter._auth_headers()
    except RuntimeError as exc:
        assert str(exc) == "No OpenAI authentication configured. Set OPENAI_API_KEY."
    else:
        raise AssertionError("Expected missing OPENAI_API_KEY to raise RuntimeError")


def test_openai_responses_uses_api_key(monkeypatch) -> None:
    calls: list[str] = []

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setattr(
        adapter,
        "_auth_headers",
        lambda: ({"Authorization": "Bearer sk-test"}, "openai-api-key"),
    )

    def urlopen(req, timeout: int):
        calls.append(req.headers["Authorization"])
        return _Response({
            "id": "resp_test",
            "status": "completed",
            "output": [{
                "type": "message",
                "content": [{"type": "output_text", "text": "ok"}],
            }],
        })

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    result = adapter._call_openai_responses(
        "llm-openai-gpt5",
        [{"role": "user", "content": "hello"}],
        None,
    )

    assert calls == ["Bearer sk-test"]
    assert result["content"] == "ok"
    assert result["metadata"]["auth_mode"] == "openai-api-key"


def test_response_format_schema_is_sent_as_strict_json_schema(monkeypatch) -> None:
    bodies: list[dict] = []

    class ConversationSummary:
        __name__ = "ConversationSummary"

        @staticmethod
        def model_json_schema() -> dict:
            return {
                "type": "object",
                "properties": {
                    "summary": {"type": "string"},
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {"name": {"type": "string"}},
                        },
                    },
                },
            }

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setattr(
        adapter,
        "_auth_headers",
        lambda: ({"Authorization": "Bearer sk-test"}, "openai-api-key"),
    )

    def urlopen(req, timeout: int):
        bodies.append(json.loads(req.data.decode()))
        return _Response({
            "id": "resp_test",
            "status": "completed",
            "output": [{
                "type": "message",
                "content": [{"type": "output_text", "text": "{}"}],
            }],
        })

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    adapter._call_openai_responses(
        "llm-openai-gpt5",
        [{"role": "user", "content": "summarize"}],
        None,
        response_format=ConversationSummary,
    )

    schema_format = bodies[0]["text"]["format"]
    schema = schema_format["schema"]
    nested_schema = schema["properties"]["items"]["items"]

    assert schema_format["strict"] is True
    assert schema["additionalProperties"] is False
    assert schema["required"] == ["summary", "items"]
    assert nested_schema["additionalProperties"] is False
    assert nested_schema["required"] == ["name"]


def test_openai_llm_usage_event_includes_effective_config_audit_fields(monkeypatch) -> None:
    events: list[tuple[str, str, dict, str | None]] = []
    publisher = importlib.import_module("src.event_publisher")

    monkeypatch.setattr(publisher, "get_scoped_session", lambda: ("sesn_1", "turn_1"))
    monkeypatch.setattr(
        publisher,
        "get_scoped_audit_fields",
        lambda: {
            "modelSpec": "openai/o3",
            "llmComponent": "llm-openai-o3",
            "configRevision": 2,
            "configHash": "abc123",
        },
    )

    def capture(session_id: str, event_type: str, data: dict, *, instance_id=None, **_):
        events.append((session_id, event_type, data, instance_id))

    monkeypatch.setattr(publisher, "publish_session_event", capture)

    adapter._publish_llm_usage(
        model="o3",
        usage={
            "input_tokens": 11,
            "output_tokens": 7,
            "input_tokens_details": {"cached_tokens": 3},
        },
        ttft_ms=42.5,
        success=True,
    )

    assert events == [
        (
            "sesn_1",
            "agent.llm_usage",
            {
                "model": "o3",
                "modelSpec": "openai/o3",
                "llmComponent": "llm-openai-o3",
                "configRevision": 2,
                "configHash": "abc123",
                # input_tokens is emitted NET of cache reads: OpenAI reports
                # 11 gross with 3 cached, so 8 non-cached (disjoint convention
                # shared by all adapters; budgets/cost/context % rely on it).
                "input_tokens": 8,
                "output_tokens": 7,
                "cache_read_input_tokens": 3,
                "cache_creation_input_tokens": 0,
                "ttft_ms": 42.5,
                "recovery_attempts": 0,
                "success": True,
            },
            "turn_1",
        )
    ]


def test_openai_llm_usage_nets_cache_reads_for_chat_completions_shape(monkeypatch) -> None:
    """prompt_tokens (gross) + prompt_tokens_details.cached_tokens also nets."""
    events: list[dict] = []
    publisher = importlib.import_module("src.event_publisher")

    monkeypatch.setattr(publisher, "get_scoped_session", lambda: ("sesn_1", "turn_1"))
    monkeypatch.setattr(publisher, "get_scoped_audit_fields", lambda: {})
    monkeypatch.setattr(
        publisher,
        "publish_session_event",
        lambda _sid, _type, data, *, instance_id=None, **_: events.append(data),
    )

    adapter._publish_llm_usage(
        model="gpt-5.5",
        usage={
            "prompt_tokens": 17906,
            "completion_tokens": 36,
            "prompt_tokens_details": {"cached_tokens": 17664},
        },
        ttft_ms=10.0,
        success=True,
    )

    assert events[0]["input_tokens"] == 242
    assert events[0]["cache_read_input_tokens"] == 17664
    assert events[0]["output_tokens"] == 36


def test_openai_llm_usage_event_preserves_llm_span_context(monkeypatch) -> None:
    events: list[dict] = []
    publisher = importlib.import_module("src.event_publisher")

    monkeypatch.setattr(publisher, "get_scoped_session", lambda: ("sesn_1", "turn_1"))
    monkeypatch.setattr(publisher, "get_scoped_audit_fields", lambda: {})

    def capture(session_id: str, event_type: str, data: dict, *, instance_id=None, **_):
        events.append(data)

    monkeypatch.setattr(publisher, "publish_session_event", capture)

    adapter._publish_llm_usage(
        model="gpt-5.5",
        usage={"input_tokens": 1, "output_tokens": 2},
        ttft_ms=1.5,
        success=True,
        trace_context=("trace-1", "span-1"),
    )

    assert events[0]["traceId"] == "trace-1"
    assert events[0]["spanId"] == "span-1"


# ---------------------------------------------------------------------------
# Prompt-cache telemetry parity (OpenAI side)
# ---------------------------------------------------------------------------

import importlib  # noqa: E402

ib = importlib.import_module("src.instruction_bundle")


def _build_with_boundary(prefix_chars: int, dynamic: str = "Tail content.") -> str:
    static = "S" * prefix_chars
    return f"{static}\n\n{ib.SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\n\n{dynamic}"


def test_convert_tools_for_openai_sorts_by_name() -> None:
    class _Tool:
        def __init__(self, name: str) -> None:
            self.name = name
            self.description = name

    out = adapter._convert_tools_for_openai([_Tool("zebra"), _Tool("apple"), _Tool("mango")])
    assert [t["name"] for t in out] == ["apple", "mango", "zebra"]


def test_convert_tools_for_openai_handles_empty_or_none() -> None:
    assert adapter._convert_tools_for_openai(None) is None
    assert adapter._convert_tools_for_openai([]) is None


def test_measure_openai_prompt_returns_none_for_empty() -> None:
    out, tel = adapter._measure_openai_prompt(None)
    assert out is None
    assert tel["cache_eligible"] is False
    assert tel["cache_breakpoints"] == 0
    assert tel["cache_ttl"] == "auto"


def test_measure_openai_prompt_no_boundary_below_threshold() -> None:
    out, tel = adapter._measure_openai_prompt("Short system prompt.")
    assert out == "Short system prompt."
    assert tel["prefix_chars"] == len("Short system prompt.")
    assert tel["tail_chars"] == 0
    assert tel["cache_eligible"] is False
    assert tel["cache_breakpoints"] == 0
    assert tel["cache_ttl"] == "auto"


def test_measure_openai_prompt_no_boundary_above_threshold_is_eligible() -> None:
    threshold = adapter.SYSTEM_PROMPT_CACHE_THRESHOLD_CHARS
    big = "A" * (threshold + 100)
    out, tel = adapter._measure_openai_prompt(big)
    # No boundary, so the whole thing is the prefix and gets sent verbatim.
    assert out == big
    assert tel["prefix_chars"] == len(big)
    assert tel["cache_eligible"] is True
    assert tel["cache_breakpoints"] == 1
    assert tel["cache_ttl"] == "auto"


def test_measure_openai_prompt_above_threshold_strips_sentinel() -> None:
    threshold = adapter.SYSTEM_PROMPT_CACHE_THRESHOLD_CHARS
    s = _build_with_boundary(prefix_chars=threshold + 10, dynamic="dynamic part")
    out, tel = adapter._measure_openai_prompt(s)
    # OpenAI doesn't understand the sentinel — must be removed before send.
    assert ib.SYSTEM_PROMPT_DYNAMIC_BOUNDARY not in out
    assert "dynamic part" in out
    assert out.startswith("S")
    assert tel["prefix_chars"] == threshold + 10
    assert tel["tail_chars"] == len("dynamic part")
    assert tel["cache_eligible"] is True
    assert tel["cache_breakpoints"] == 1
    assert tel["cache_ttl"] == "auto"


def test_measure_openai_prompt_below_threshold_with_boundary_strips_sentinel() -> None:
    s = _build_with_boundary(prefix_chars=200, dynamic="dyn")
    out, tel = adapter._measure_openai_prompt(s)
    assert ib.SYSTEM_PROMPT_DYNAMIC_BOUNDARY not in out
    assert "dyn" in out
    assert tel["prefix_chars"] == 200
    assert tel["tail_chars"] == 3
    assert tel["cache_eligible"] is False
    assert tel["cache_breakpoints"] == 0
    assert tel["cache_ttl"] == "auto"


def test_publish_llm_usage_stamps_prompt_cache_telemetry(monkeypatch) -> None:
    events: list[dict] = []
    publisher = importlib.import_module("src.event_publisher")

    monkeypatch.setattr(publisher, "get_scoped_session", lambda: ("sesn_2", "turn_2"))
    monkeypatch.setattr(publisher, "get_scoped_audit_fields", lambda: {})

    def capture(session_id, event_type, data, *, instance_id=None, **_):
        events.append(data)

    monkeypatch.setattr(publisher, "publish_session_event", capture)

    adapter._publish_llm_usage(
        model="gpt-5.5",
        usage={
            "input_tokens": 100,
            "output_tokens": 20,
            "input_tokens_details": {"cached_tokens": 80},
        },
        ttft_ms=200.0,
        success=True,
        prompt_cache_telemetry={
            "prefix_chars": 6000,
            "tail_chars": 300,
            "cache_eligible": True,
            "cache_breakpoints": 1,
            "cache_ttl": "auto",
        },
    )

    assert len(events) == 1
    payload = events[0]
    # Existing usage fields preserved.
    assert payload["cache_read_input_tokens"] == 80
    assert payload["cache_creation_input_tokens"] == 0  # always 0 on OpenAI
    # New fields stamped from the telemetry dict.
    assert payload["prompt_prefix_chars"] == 6000
    assert payload["prompt_tail_chars"] == 300
    assert payload["prompt_cache_eligible"] is True
    assert payload["prompt_cache_breakpoints"] == 1
    assert payload["prompt_cache_ttl"] == "auto"


def test_publish_llm_usage_omits_prompt_cache_fields_when_no_telemetry(monkeypatch) -> None:
    """Backward compat: legacy callers that don't pass telemetry should not
    suddenly grow the new fields on their event payload."""
    events: list[dict] = []
    publisher = importlib.import_module("src.event_publisher")

    monkeypatch.setattr(publisher, "get_scoped_session", lambda: ("sesn_3", "turn_3"))
    monkeypatch.setattr(publisher, "get_scoped_audit_fields", lambda: {})

    def capture(session_id, event_type, data, *, instance_id=None, **_):
        events.append(data)

    monkeypatch.setattr(publisher, "publish_session_event", capture)

    adapter._publish_llm_usage(
        model="gpt-5.5",
        usage={"input_tokens": 5, "output_tokens": 1},
        ttft_ms=10.0,
        success=True,
    )

    payload = events[0]
    assert "prompt_prefix_chars" not in payload
    assert "prompt_cache_ttl" not in payload


# ---------------------------------------------------------------------------
# prompt_cache_key derivation + request wiring
# ---------------------------------------------------------------------------


def test_derive_openai_cache_key_prefers_id_version() -> None:
    bundle = {"agent": {"id": "agnt_abc", "version": 7, "slug": "x", "configHash": "deadbeef"}}
    assert adapter.derive_openai_cache_key(bundle) == "agnt_abc:7"


def test_derive_openai_cache_key_falls_back_to_slug_version() -> None:
    bundle = {"agent": {"slug": "code-runner", "version": 3, "configHash": "deadbeef"}}
    assert adapter.derive_openai_cache_key(bundle) == "code-runner:3"


def test_derive_openai_cache_key_falls_back_to_config_hash() -> None:
    bundle = {"agent": {"configHash": "abcdef0123456789xxxxxxxx"}}
    # Truncated to first 16 chars so it stays bounded.
    assert adapter.derive_openai_cache_key(bundle) == "cfg:abcdef0123456789"


def test_derive_openai_cache_key_returns_none_for_ephemeral_inline_bundle() -> None:
    # Workflow-driven sessions with inline agentConfig and no agent.id/version
    # land here. Returning None keeps the request body clean and lets OpenAI's
    # default routing kick in.
    assert adapter.derive_openai_cache_key({"agent": {}}) is None
    assert adapter.derive_openai_cache_key({}) is None
    assert adapter.derive_openai_cache_key(None) is None


def test_derive_openai_cache_key_drops_id_without_version() -> None:
    # Version is the part that captures content identity. Without it, the key
    # would be unstable across publishes — we'd rather defer to default.
    assert adapter.derive_openai_cache_key({"agent": {"id": "agnt_abc"}}) is None


def test_call_openai_responses_stamps_cache_key_on_request_body(monkeypatch) -> None:
    bodies: list[dict] = []

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setattr(
        adapter,
        "_auth_headers",
        lambda: ({"Authorization": "Bearer sk-test"}, "openai-api-key"),
    )

    def urlopen(req, timeout: int):
        bodies.append(json.loads(req.data.decode()))
        return _Response({
            "id": "resp_test",
            "status": "completed",
            "output": [{
                "type": "message",
                "content": [{"type": "output_text", "text": "ok"}],
            }],
        })

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    adapter._call_openai_responses(
        "llm-openai-gpt5",
        [{"role": "user", "content": "hi"}],
        None,
        cache_key="agnt_abc:7",
    )

    assert bodies[0]["prompt_cache_key"] == "agnt_abc:7"


def test_call_openai_responses_omits_cache_key_when_not_provided(monkeypatch) -> None:
    bodies: list[dict] = []

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setattr(
        adapter,
        "_auth_headers",
        lambda: ({"Authorization": "Bearer sk-test"}, "openai-api-key"),
    )

    def urlopen(req, timeout: int):
        bodies.append(json.loads(req.data.decode()))
        return _Response({
            "id": "resp_test",
            "status": "completed",
            "output": [{
                "type": "message",
                "content": [{"type": "output_text", "text": "ok"}],
            }],
        })

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    adapter._call_openai_responses(
        "llm-openai-gpt5",
        [{"role": "user", "content": "hi"}],
        None,
    )

    assert "prompt_cache_key" not in bodies[0]


class _Tool:
    name = "Read"
    description = "Read a file"
    args_model = None


def test_call_openai_responses_disables_parallel_tool_calls_by_default(monkeypatch) -> None:
    bodies: list[dict] = []

    monkeypatch.delenv("OPENAI_PARALLEL_TOOL_CALLS", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setattr(
        adapter,
        "_auth_headers",
        lambda: ({"Authorization": "Bearer sk-test"}, "openai-api-key"),
    )

    def urlopen(req, timeout: int):
        bodies.append(json.loads(req.data.decode()))
        return _Response({
            "id": "resp_test",
            "status": "completed",
            "output": [{
                "type": "message",
                "content": [{"type": "output_text", "text": "ok"}],
            }],
        })

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    adapter._call_openai_responses(
        "llm-openai-gpt5",
        [{"role": "user", "content": "hi"}],
        None,
        [_Tool()],
    )

    assert bodies[0]["parallel_tool_calls"] is False


def test_call_openai_responses_allows_parallel_tool_calls_by_env_opt_in(monkeypatch) -> None:
    bodies: list[dict] = []

    monkeypatch.setenv("OPENAI_PARALLEL_TOOL_CALLS", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setattr(
        adapter,
        "_auth_headers",
        lambda: ({"Authorization": "Bearer sk-test"}, "openai-api-key"),
    )

    def urlopen(req, timeout: int):
        bodies.append(json.loads(req.data.decode()))
        return _Response({
            "id": "resp_test",
            "status": "completed",
            "output": [{
                "type": "message",
                "content": [{"type": "output_text", "text": "ok"}],
            }],
        })

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    adapter._call_openai_responses(
        "llm-openai-gpt5",
        [{"role": "user", "content": "hi"}],
        None,
        [_Tool()],
    )

    assert bodies[0]["parallel_tool_calls"] is True
