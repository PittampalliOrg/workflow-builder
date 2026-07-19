"""Tests for src/kimi_formulas.py and its wiring into the kimi-k3 path.

Covers: URI/env configuration, declaration fetch + caching, the name->URI
index, fiber execution (success / encrypted / error shapes), adapter-side
declaration injection into _call_kimi_chat, encrypted-blob round-trip through
message normalization, and the static wiring in main.py / kimi_adapter.py.
"""

from __future__ import annotations

from io import BytesIO
import importlib
import json
import os
from pathlib import Path
import sys
from urllib.error import HTTPError, URLError

import pytest

root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

adapter = importlib.import_module("src.kimi_adapter")
formulas = importlib.import_module("src.kimi_formulas")

ROOT = Path(__file__).resolve().parents[1]

ENCRYPTED_BLOB = (
    "----MOONSHOT ENCRYPTED BEGIN----+nf6abc123=----MOONSHOT ENCRYPTED END----"
)


@pytest.fixture(autouse=True)
def _clean_formula_state(monkeypatch):
    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")
    monkeypatch.delenv("KIMI_FORMULAS", raising=False)
    monkeypatch.delenv("KIMI_FORMULA_TIMEOUT_SECONDS", raising=False)
    monkeypatch.delenv("KIMI_BASE_URL", raising=False)
    formulas.reset_formula_cache()
    yield
    formulas.reset_formula_cache()


class _JsonResponse:
    def __init__(self, payload: dict):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self) -> bytes:
        return json.dumps(self.payload).encode()


class _SseResponse:
    def __init__(self, lines: list[bytes]):
        self.lines = list(lines)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def readline(self) -> bytes:
        return self.lines.pop(0) if self.lines else b""


def _sse_chat_lines(content: str = "ok") -> list[bytes]:
    chunk = {
        "id": "chatcmpl_test",
        "object": "chat.completion.chunk",
        "model": "kimi-k3",
        "choices": [
            {
                "index": 0,
                "delta": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
    }
    return [f"data: {json.dumps(chunk)}\n".encode(), b"\n", b"data: [DONE]\n", b"\n"]


def _tools_payload(name: str, description: str = "desc") -> dict:
    return {
        "object": "list",
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": name,
                    "description": description,
                    "parameters": {
                        "type": "object",
                        "properties": {"query": {"type": "string"}},
                        "required": ["query"],
                    },
                },
            }
        ],
    }


# ---------------------------------------------------------------------------
# URI / env configuration
# ---------------------------------------------------------------------------


def test_normalize_formula_uri_defaults_namespace_and_tag() -> None:
    assert formulas.normalize_formula_uri("fetch") == "moonshot/fetch:latest"
    assert formulas.normalize_formula_uri("fetch:beta") == "moonshot/fetch:beta"
    assert formulas.normalize_formula_uri("moonshot/fetch") == "moonshot/fetch:latest"
    assert (
        formulas.normalize_formula_uri("moonshot/fetch:latest")
        == "moonshot/fetch:latest"
    )


def test_configured_formula_uris_default_excludes_web_search(monkeypatch) -> None:
    uris = formulas.configured_formula_uris()
    assert uris == list(formulas.DEFAULT_FORMULA_URIS)
    assert len(uris) == 11
    assert all("web-search" not in uri for uri in uris)


def test_default_formula_uris_use_renamed_code_runner() -> None:
    # Upstream renamed code_runner -> code-runner; the underscore URI 404s.
    assert "moonshot/code-runner:latest" in formulas.DEFAULT_FORMULA_URIS
    assert not any("code_runner" in uri for uri in formulas.DEFAULT_FORMULA_URIS)


def test_normalize_formula_uri_rewrites_legacy_code_runner() -> None:
    assert formulas.normalize_formula_uri("code_runner") == "moonshot/code-runner:latest"
    assert (
        formulas.normalize_formula_uri("moonshot/code_runner:beta")
        == "moonshot/code-runner:beta"
    )
    # The current spelling is untouched.
    assert (
        formulas.normalize_formula_uri("moonshot/code-runner:latest")
        == "moonshot/code-runner:latest"
    )


def test_configured_formula_uris_empty_disables(monkeypatch) -> None:
    monkeypatch.setenv("KIMI_FORMULAS", "")
    assert formulas.configured_formula_uris() == []
    assert formulas.ensure_formula_tools() == []
    assert formulas.formula_uri_for_tool("fetch") is None


def test_configured_formula_uris_custom_normalized_and_deduped(monkeypatch) -> None:
    monkeypatch.setenv(
        "KIMI_FORMULAS", "fetch, moonshot/date:latest, moonshot/fetch:latest, ,"
    )
    assert formulas.configured_formula_uris() == [
        "moonshot/fetch:latest",
        "moonshot/date:latest",
    ]


def test_configured_formula_uris_web_search_warns(monkeypatch, caplog) -> None:
    monkeypatch.setenv("KIMI_FORMULAS", "web-search")
    with caplog.at_level("WARNING"):
        uris = formulas.configured_formula_uris()
    assert uris == ["moonshot/web-search:latest"]
    assert any("web-search" in record.message for record in caplog.records)


# ---------------------------------------------------------------------------
# Declaration fetch + cache + index
# ---------------------------------------------------------------------------


def _install_tools_urlopen(monkeypatch, payloads: dict[str, dict], record: list[str]):
    def urlopen(req, timeout: float = 0):
        url = req.full_url
        record.append(url)
        for uri, payload in payloads.items():
            if url.endswith(f"/formulas/{uri}/tools"):
                return _JsonResponse(payload)
        raise URLError(f"unexpected url {url}")

    monkeypatch.setattr(formulas.urllib.request, "urlopen", urlopen)


def test_ensure_formula_tools_fetches_caches_and_indexes(monkeypatch) -> None:
    monkeypatch.setenv("KIMI_FORMULAS", "moonshot/fetch:latest,moonshot/date:latest")
    fetched: list[str] = []
    _install_tools_urlopen(
        monkeypatch,
        {
            "moonshot/fetch:latest": _tools_payload("fetch"),
            "moonshot/date:latest": _tools_payload("date"),
        },
        fetched,
    )

    first = formulas.ensure_formula_tools()
    second = formulas.ensure_formula_tools()

    assert first is second  # cached object, no refetch
    assert len(fetched) == 3  # one catalog GET + one tools GET per URI total
    assert [t["function"]["name"] for t in first] == ["fetch", "date"]
    assert formulas.formula_uri_for_tool("fetch") == "moonshot/fetch:latest"
    assert formulas.formula_uri_for_tool("date") == "moonshot/date:latest"
    # Normalized lookup (model echo variations still route).
    assert formulas.formula_uri_for_tool("FETCH") == "moonshot/fetch:latest"
    assert formulas.formula_uri_for_tool("code_runner") is None


def test_ensure_formula_tools_skips_failed_uri(monkeypatch, caplog) -> None:
    monkeypatch.setenv("KIMI_FORMULAS", "moonshot/fetch:latest,moonshot/broken:latest")
    fetched: list[str] = []
    _install_tools_urlopen(
        monkeypatch,
        {"moonshot/fetch:latest": _tools_payload("fetch")},
        fetched,
    )

    with caplog.at_level("WARNING"):
        declarations = formulas.ensure_formula_tools()

    assert [t["function"]["name"] for t in declarations] == ["fetch"]
    assert any("moonshot/broken" in record.message for record in caplog.records)


def test_total_load_failure_is_retried_after_cooldown(monkeypatch) -> None:
    monkeypatch.setenv("KIMI_FORMULAS", "moonshot/fetch:latest")
    fetches: list[str] = []

    def failing_urlopen(req, timeout: float = 0):
        fetches.append(req.full_url)
        raise URLError("connection refused")

    monkeypatch.setattr(formulas.urllib.request, "urlopen", failing_urlopen)
    assert formulas.ensure_formula_tools() == []
    # Inside the cooldown the empty set is served from cache — no refetch storm.
    assert formulas.ensure_formula_tools() == []
    assert len(fetches) == 2  # one catalog GET + one tools GET

    # Cooldown over + network back: the next call reloads successfully instead
    # of disabling formulas for the process lifetime.
    monkeypatch.setattr(formulas, "_LOAD_RETRY_COOLDOWN_SECONDS", 0.0)
    monkeypatch.setattr(
        formulas.urllib.request,
        "urlopen",
        lambda req, timeout=0: _JsonResponse(_tools_payload("fetch")),
    )
    declarations = formulas.ensure_formula_tools()
    assert [t["function"]["name"] for t in declarations] == ["fetch"]
    assert formulas.formula_uri_for_tool("fetch") == "moonshot/fetch:latest"


def test_deliberate_empty_config_is_never_retried(monkeypatch) -> None:
    monkeypatch.setenv("KIMI_FORMULAS", "")
    fetches: list[str] = []
    monkeypatch.setattr(
        formulas.urllib.request,
        "urlopen",
        lambda req, timeout=0: fetches.append(req.full_url),
    )
    monkeypatch.setattr(formulas, "_LOAD_RETRY_COOLDOWN_SECONDS", 0.0)

    assert formulas.ensure_formula_tools() == []
    assert formulas.ensure_formula_tools() == []
    assert fetches == []


def test_ensure_formula_tools_skips_duplicate_function_names(monkeypatch, caplog) -> None:
    monkeypatch.setenv("KIMI_FORMULAS", "moonshot/fetch:latest,moonshot/date:latest")
    fetched: list[str] = []
    _install_tools_urlopen(
        monkeypatch,
        {
            "moonshot/fetch:latest": _tools_payload("fetch", "first"),
            "moonshot/date:latest": _tools_payload("fetch", "duplicate"),
        },
        fetched,
    )

    with caplog.at_level("WARNING"):
        declarations = formulas.ensure_formula_tools()

    assert len(declarations) == 1
    assert declarations[0]["function"]["description"] == "first"
    assert any("duplicate" in record.message for record in caplog.records)


# ---------------------------------------------------------------------------
# Upstream drift guards: catalog check + plugin-manifest flattening
# ---------------------------------------------------------------------------


def test_catalog_guard_skips_upstream_missing_formulas(monkeypatch, caplog) -> None:
    monkeypatch.setenv("KIMI_FORMULAS", "moonshot/fetch:latest,moonshot/ghost:latest")
    fetched: list[str] = []

    def urlopen(req, timeout: float = 0):
        url = req.full_url
        if url.endswith("/formulas"):
            return _JsonResponse(
                {
                    "object": "list",
                    "data": [
                        {"namespace": "moonshot", "name": "fetch"},
                        {"namespace": "moonshot", "name": "date"},
                    ],
                }
            )
        if url.endswith("/formulas/moonshot/fetch:latest/tools"):
            fetched.append(url)
            return _JsonResponse(_tools_payload("fetch"))
        raise URLError(f"unexpected url {url}")

    monkeypatch.setattr(formulas.urllib.request, "urlopen", urlopen)
    with caplog.at_level("WARNING"):
        declarations = formulas.ensure_formula_tools()

    assert [t["function"]["name"] for t in declarations] == ["fetch"]
    # The ghost URI is skipped before any per-URI tools fetch happens.
    assert len(fetched) == 1
    assert any(
        "not found in the Kimi formula catalog" in record.message
        and "ghost" in record.message
        for record in caplog.records
    )


def test_catalog_failure_falls_back_to_per_uri_fetch(monkeypatch, caplog) -> None:
    monkeypatch.setenv("KIMI_FORMULAS", "moonshot/fetch:latest")
    fetched: list[str] = []

    def urlopen(req, timeout: float = 0):
        url = req.full_url
        if url.endswith("/formulas"):
            raise URLError("catalog down")
        if url.endswith("/formulas/moonshot/fetch:latest/tools"):
            fetched.append(url)
            return _JsonResponse(_tools_payload("fetch"))
        raise URLError(f"unexpected url {url}")

    monkeypatch.setattr(formulas.urllib.request, "urlopen", urlopen)
    with caplog.at_level("WARNING"):
        declarations = formulas.ensure_formula_tools()

    assert [t["function"]["name"] for t in declarations] == ["fetch"]
    assert len(fetched) == 1
    assert any("catalog fetch failed" in record.message for record in caplog.records)


def test_fetch_formula_tools_flattens_plugin_manifests(monkeypatch) -> None:
    plugin_payload = {
        "object": "list",
        "tools": [
            {
                "_plugin": {
                    "name": "excel",
                    "description": "Excel analysis tool",
                    "functions": [
                        {
                            "name": "read_file",
                            "description": "inspect a file",
                            "parameters": {"type": "object", "properties": {}},
                        },
                        {"name": "groupby"},
                    ],
                }
            }
        ],
    }
    monkeypatch.setattr(
        formulas.urllib.request,
        "urlopen",
        lambda req, timeout=0: _JsonResponse(plugin_payload),
    )

    declarations = formulas._fetch_formula_tools("moonshot/excel:latest")

    # Declared as <plugin>_<function> (dots are invalid in chat tool names),
    # executed as <plugin>.<function> (the fibers lambda name).
    assert [(d["function"]["name"], fiber) for d, fiber in declarations] == [
        ("excel_read_file", "excel.read_file"),
        ("excel_groupby", "excel.groupby"),
    ]
    assert all(d["type"] == "function" for d, _ in declarations)
    # The plugin description backfills missing function descriptions, and a
    # missing parameters object gets a valid empty JSON-schema envelope.
    assert declarations[1][0]["function"]["description"] == "Excel analysis tool"
    assert declarations[1][0]["function"]["parameters"] == {
        "type": "object",
        "properties": {},
    }


def test_plugin_manifest_tools_route_to_dotted_fiber_name(monkeypatch) -> None:
    monkeypatch.setenv("KIMI_FORMULAS", "moonshot/excel:latest")
    plugin_payload = {
        "object": "list",
        "tools": [
            {
                "_plugin": {
                    "name": "excel",
                    "description": "Excel analysis tool",
                    "functions": [{"name": "read_file", "description": "inspect"}],
                }
            }
        ],
    }
    calls: list[dict] = []

    def urlopen(req, timeout: float = 0):
        url = req.full_url
        if url.endswith("/formulas"):
            raise URLError("no catalog in this test")
        if url.endswith("/tools"):
            return _JsonResponse(plugin_payload)
        if url.endswith("/fibers"):
            calls.append({"url": url, "body": json.loads(req.data.decode())})
            return _JsonResponse(
                {"status": "succeeded", "context": {"output": "3 rows"}}
            )
        raise URLError(f"unexpected url {url}")

    monkeypatch.setattr(formulas.urllib.request, "urlopen", urlopen)

    assert formulas.formula_uri_for_tool("excel_read_file") == "moonshot/excel:latest"
    content, encrypted = formulas.execute_formula_tool_result(
        "excel_read_file", {"file_path": "/tmp/x.csv"}
    )

    assert content == "3 rows"
    assert encrypted is False
    assert calls[0]["url"].endswith("/formulas/moonshot/excel:latest/fibers")
    assert calls[0]["body"]["name"] == "excel.read_file"


def test_execute_formula_tool_no_output_guides_explicit_print(monkeypatch) -> None:
    monkeypatch.setenv("KIMI_FORMULAS", "moonshot/quickjs:latest")
    calls: list[dict] = []
    _install_formula_urlopen(monkeypatch, {"status": "succeeded", "context": {}}, calls)

    content, encrypted = formulas.execute_formula_tool_result("fetch", {})

    assert content.startswith("Error:")
    assert "no output" in content
    assert "console.log" in content
    assert encrypted is False


# ---------------------------------------------------------------------------
# Fiber execution
# ---------------------------------------------------------------------------


def _install_formula_urlopen(monkeypatch, fiber_response, record: list[dict]):
    def urlopen(req, timeout: float = 0):
        url = req.full_url
        if url.endswith("/tools"):
            return _JsonResponse(_tools_payload("fetch"))
        if url.endswith("/fibers"):
            record.append(
                {"body": json.loads(req.data.decode()), "timeout": timeout}
            )
            if isinstance(fiber_response, BaseException):
                raise fiber_response
            return _JsonResponse(fiber_response)
        raise URLError(f"unexpected url {url}")

    monkeypatch.setattr(formulas.urllib.request, "urlopen", urlopen)


def test_execute_formula_tool_success_returns_output(monkeypatch) -> None:
    monkeypatch.setenv("KIMI_FORMULAS", "moonshot/fetch:latest")
    calls: list[dict] = []
    _install_formula_urlopen(
        monkeypatch,
        {"status": "succeeded", "context": {"output": "fiber-result"}},
        calls,
    )

    result = formulas.execute_formula_tool("fetch", {"url": "https://example.com"})

    assert result == "fiber-result"
    assert calls[0]["body"] == {
        "name": "fetch",
        "arguments": json.dumps({"url": "https://example.com"}),
    }
    assert calls[0]["timeout"] == 45.0


def test_execute_formula_tool_encrypted_output_verbatim(monkeypatch) -> None:
    monkeypatch.setenv("KIMI_FORMULAS", "moonshot/fetch:latest")
    calls: list[dict] = []
    _install_formula_urlopen(
        monkeypatch,
        {"status": "succeeded", "context": {"encrypted_output": ENCRYPTED_BLOB}},
        calls,
    )

    assert formulas.execute_formula_tool("fetch", {"q": "x"}) == ENCRYPTED_BLOB


def test_execute_formula_tool_result_plain_output_not_encrypted(monkeypatch) -> None:
    monkeypatch.setenv("KIMI_FORMULAS", "moonshot/fetch:latest")
    calls: list[dict] = []
    _install_formula_urlopen(
        monkeypatch,
        {"status": "succeeded", "context": {"output": "fiber-result"}},
        calls,
    )

    content, encrypted = formulas.execute_formula_tool_result("fetch", {"url": "u"})

    assert content == "fiber-result"
    assert encrypted is False


def test_execute_formula_tool_result_flags_encrypted_output(monkeypatch) -> None:
    monkeypatch.setenv("KIMI_FORMULAS", "moonshot/fetch:latest")
    calls: list[dict] = []
    _install_formula_urlopen(
        monkeypatch,
        {"status": "succeeded", "context": {"encrypted_output": ENCRYPTED_BLOB}},
        calls,
    )

    content, encrypted = formulas.execute_formula_tool_result("fetch", {})

    assert content == ENCRYPTED_BLOB
    assert encrypted is True


def test_execute_formula_tool_result_errors_are_not_encrypted(monkeypatch) -> None:
    monkeypatch.setenv("KIMI_FORMULAS", "moonshot/fetch:latest")
    calls: list[dict] = []
    _install_formula_urlopen(
        monkeypatch,
        {"status": "failed", "error": "quota exhausted"},
        calls,
    )

    content, encrypted = formulas.execute_formula_tool_result("fetch", {})

    assert content.startswith("Error:")
    assert encrypted is False
    unknown_content, unknown_encrypted = formulas.execute_formula_tool_result("nope", {})
    assert unknown_content.startswith("Error:")
    assert unknown_encrypted is False


def test_execute_formula_tool_failed_status_surfaces_error(monkeypatch) -> None:
    monkeypatch.setenv("KIMI_FORMULAS", "moonshot/fetch:latest")
    calls: list[dict] = []
    _install_formula_urlopen(
        monkeypatch,
        {"status": "failed", "error": "quota exhausted"},
        calls,
    )

    result = formulas.execute_formula_tool("fetch", {})

    assert result.startswith("Error:")
    assert "quota exhausted" in result


def test_execute_formula_tool_context_error_fallback(monkeypatch) -> None:
    monkeypatch.setenv("KIMI_FORMULAS", "moonshot/fetch:latest")
    calls: list[dict] = []
    _install_formula_urlopen(
        monkeypatch,
        {"status": "crashed", "context": {"error": "script raised"}},
        calls,
    )

    result = formulas.execute_formula_tool("fetch", {})

    assert result.startswith("Error:")
    assert "script raised" in result


def test_execute_formula_tool_http_error_includes_status(monkeypatch) -> None:
    monkeypatch.setenv("KIMI_FORMULAS", "moonshot/fetch:latest")
    calls: list[dict] = []
    _install_formula_urlopen(
        monkeypatch,
        HTTPError(
            "https://api.moonshot.ai/v1/formulas/moonshot/fetch:latest/fibers",
            500,
            "Internal Server Error",
            None,
            BytesIO(b'{"error": "boom"}'),
        ),
        calls,
    )

    result = formulas.execute_formula_tool("fetch", {})

    assert result.startswith("Error:")
    assert "500" in result
    assert "boom" in result


def test_execute_formula_tool_network_error(monkeypatch) -> None:
    monkeypatch.setenv("KIMI_FORMULAS", "moonshot/fetch:latest")
    calls: list[dict] = []
    _install_formula_urlopen(monkeypatch, URLError("connection refused"), calls)

    result = formulas.execute_formula_tool("fetch", {})

    assert result.startswith("Error:")
    assert "connection refused" in result


def test_execute_formula_tool_unknown_name(monkeypatch) -> None:
    monkeypatch.setenv("KIMI_FORMULAS", "moonshot/fetch:latest")
    calls: list[dict] = []
    _install_formula_urlopen(
        monkeypatch,
        {"status": "succeeded", "context": {"output": "unused"}},
        calls,
    )

    result = formulas.execute_formula_tool("not_a_formula", {})

    assert result.startswith("Error:")
    assert "not_a_formula" in result
    assert calls == []  # no fiber POST for unknown tools


def test_execute_formula_tool_timeout_env_override(monkeypatch) -> None:
    monkeypatch.setenv("KIMI_FORMULAS", "moonshot/fetch:latest")
    monkeypatch.setenv("KIMI_FORMULA_TIMEOUT_SECONDS", "12")
    calls: list[dict] = []
    _install_formula_urlopen(
        monkeypatch,
        {"status": "succeeded", "context": {"output": "ok"}},
        calls,
    )

    formulas.execute_formula_tool("fetch", {})

    assert calls[0]["timeout"] == 12.0


# ---------------------------------------------------------------------------
# Adapter merge helper
# ---------------------------------------------------------------------------


def test_with_formula_tools_merges_and_local_wins() -> None:
    local = [
        {
            "type": "function",
            "function": {
                "name": "fetch",
                "description": "local fetch",
                "parameters": {"type": "object", "properties": {}},
                "strict": False,
            },
        }
    ]
    merged = adapter._with_formula_tools(
        local,
        [
            _tools_payload("fetch", "formula duplicate")["tools"][0],
            _tools_payload("date")["tools"][0],
        ],
    )

    names = [t["function"]["name"] for t in merged]
    assert names == ["date", "fetch"]  # sorted, duplicate formula dropped
    fetch = next(t for t in merged if t["function"]["name"] == "fetch")
    assert fetch["function"]["description"] == "local fetch"
    assert all(t["function"]["strict"] is False for t in merged)


def test_with_formula_tools_handles_none_local() -> None:
    merged = adapter._with_formula_tools(None, [_tools_payload("date")["tools"][0]])
    assert [t["function"]["name"] for t in merged] == ["date"]


def test_with_formula_tools_shadowing_uses_normalized_names() -> None:
    # A local tool whose name differs only by case/underscores still shadows
    # the formula declaration: merge-side matching mirrors the executor and
    # the run_tool dispatch guard (case-insensitive, underscores ignored).
    local = [
        {
            "type": "function",
            "function": {
                "name": "FETCH",
                "description": "local fetch",
                "parameters": {"type": "object", "properties": {}},
                "strict": False,
            },
        }
    ]

    merged = adapter._with_formula_tools(
        local,
        [_tools_payload("fetch", "formula duplicate")["tools"][0]],
    )

    assert [t["function"]["name"] for t in merged] == ["FETCH"]


# ---------------------------------------------------------------------------
# Adapter integration: declarations ride the chat request
# ---------------------------------------------------------------------------


def test_call_kimi_chat_includes_formula_tools(monkeypatch) -> None:
    monkeypatch.setenv("KIMI_FORMULAS", "moonshot/fetch:latest,moonshot/date:latest")
    chat_bodies: list[dict] = []

    def urlopen(req, timeout: float = 0):
        url = req.full_url
        if url.endswith("/chat/completions"):
            chat_bodies.append(json.loads(req.data.decode()))
            return _SseResponse(_sse_chat_lines())
        if url.endswith("/formulas/moonshot/fetch:latest/tools"):
            return _JsonResponse(_tools_payload("fetch"))
        if url.endswith("/formulas/moonshot/date:latest/tools"):
            return _JsonResponse(_tools_payload("date"))
        raise URLError(f"unexpected url {url}")

    monkeypatch.setattr(formulas.urllib.request, "urlopen", urlopen)

    result = adapter._call_kimi_chat(
        "llm-kimi-k3",
        [{"role": "user", "content": "hello"}],
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "WebFetch",
                    "description": "local web fetch",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
        ],
    )

    assert result["content"] == "ok"
    tools = chat_bodies[0]["tools"]
    names = [t["function"]["name"] for t in tools]
    assert names == ["WebFetch", "date", "fetch"]  # ASCII-sorted
    assert all(t["function"]["strict"] is False for t in tools)
    assert chat_bodies[0]["tool_choice"] == "auto"


def test_call_kimi_chat_survives_formula_fetch_failure(monkeypatch, caplog) -> None:
    def urlopen(req, timeout: float = 0):
        url = req.full_url
        if url.endswith("/chat/completions"):
            return _SseResponse(_sse_chat_lines("chat-works"))
        raise URLError("formula API unreachable")

    monkeypatch.setattr(formulas.urllib.request, "urlopen", urlopen)

    with caplog.at_level("WARNING"):
        result = adapter._call_kimi_chat(
            "llm-kimi-k3", [{"role": "user", "content": "hello"}]
        )

    assert result["content"] == "chat-works"
    assert any("formula" in record.message.lower() for record in caplog.records)


# ---------------------------------------------------------------------------
# Encrypted blob round-trip through history normalization (replay safety)
# ---------------------------------------------------------------------------


def test_encrypted_blob_survives_message_normalization() -> None:
    messages = [
        {"role": "user", "content": "look something up"},
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "web_search:0",
                    "type": "function",
                    "function": {
                        "name": "web_search",
                        "arguments": '{"query": "sky blue RGB"}',
                    },
                }
            ],
        },
        {"role": "tool", "tool_call_id": "web_search:0", "content": ENCRYPTED_BLOB},
    ]

    normalized = adapter._normalize_messages_for_kimi("", messages)

    assistant = normalized[1]
    assert assistant["tool_calls"][0]["id"] == "web_search:0"
    tool = normalized[2]
    assert tool["role"] == "tool"
    assert tool["tool_call_id"] == "web_search:0"
    assert tool["content"] == ENCRYPTED_BLOB  # byte-verbatim


# ---------------------------------------------------------------------------
# Static wiring checks
# ---------------------------------------------------------------------------


def test_main_dispatches_formula_tools_before_executor_fallback() -> None:
    source = (ROOT / "src/main.py").read_text()
    # MCP dispatch keeps precedence over formula dispatch.
    assert source.index("if mcp_tool is not None:") < source.index(
        "and formula_uri_for_tool(tool_name)"
    )
    # Formula dispatch still runs before the executor fallback...
    assert source.index("and formula_uri_for_tool(tool_name)") < source.index(
        "result = super().run_tool(ctx, payload)"
    )
    # ...but a locally registered tool wins the collision: the formula branch is
    # guarded by the executor lookup, so on an exact-name collision the call
    # falls through to super().run_tool — matching the adapter-side contract
    # ("local tools win name collisions"; the model saw the local declaration).
    assert source.index("self.tool_executor.get_tool(tool_name) is None") < source.index(
        "and formula_uri_for_tool(tool_name)"
    )


def test_main_marks_encrypted_formula_results_for_compaction() -> None:
    source = (ROOT / "src/main.py").read_text()
    assert "execute_formula_tool_result" in source
    assert 'result["_kimi_encrypted_formula"] = True' in source
    # The payload compaction layer exempts marked blobs from the 12 KiB clamp
    # and pops the private marker before persistence.
    payloads = (ROOT / "src/compaction/payloads.py").read_text()
    assert 'item.pop("_kimi_encrypted_formula", None)' in payloads


def test_adapter_injects_formula_declarations_in_chat_path() -> None:
    source = (ROOT / "src/kimi_adapter.py").read_text()
    assert "_with_formula_tools(converted_tools, formula_tools)" in source
    assert source.index("ensure_formula_tools()") < source.index(
        "request_body: dict[str, Any] = {"
    )
