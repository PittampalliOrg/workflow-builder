"""Kimi native Formula tools (the ``/formulas`` API) for the kimi-k3 path.

Kimi Open Platform exposes its official tools ("formulas") as ordinary
OpenAI-compatible function tools: declarations are fetched from
``GET /formulas/{uri}/tools`` and executed through
``POST /formulas/{uri}/fibers``. This module is the registry + executor for
that API inside dapr-agent-py:

- ``ensure_formula_tools`` lazily fetches declarations once per process and
  indexes ``function.name -> (formula URI, declared name)`` so the durable
  loop can route model tool calls back to the right formula.
- ``kimi_adapter._call_kimi_chat`` merges the declarations into every kimi-k3
  request's top-level ``tools`` field. Kimi's dynamic system-message tool
  loading is deliberately not used: this runtime's history-conformance layer
  collapses mid-conversation system messages, which would silently drop the
  declarations (and any encrypted tool results).
- ``OpenShellDurableAgent.run_tool`` dispatches matching calls to
  ``execute_formula_tool`` INSIDE the journaled run_tool activity, so fiber
  results are journaled like any local tool result and workflow replays never
  re-hit the non-idempotent ``/fibers`` endpoint (no idempotency key, no
  retrieval API — a POST always creates a fresh execution).

House conventions followed here: outbound HTTP uses raw urllib with explicit
timeouts, and every failure mode returns an ``"Error: ..."`` string instead of
raising (the WebFetch precedent) so the activity completes, the error is
journaled, and the model can adapt on its next turn.

Config:
- ``KIMI_FORMULAS`` — unset: the default set below (all documented formulas
  except ``web-search``, which Kimi marks as being updated and not
  recommended); set-but-empty: disabled entirely; comma-separated URIs:
  custom set (normalized with default ``moonshot/`` namespace / ``:latest``
  tag, deduped order-preserving).
- ``KIMI_FORMULA_TIMEOUT_SECONDS`` — fiber execution timeout (default 45).
- Auth and base URL reuse ``KIMI_API_KEY`` / ``KIMI_BASE_URL`` from
  ``kimi_adapter``.
"""

from __future__ import annotations

import json
import logging
import os
from urllib.error import HTTPError
import urllib.request
from typing import Any

logger = logging.getLogger(__name__)

# All documented official formulas except web-search (vendor-deprecated).
DEFAULT_FORMULA_URIS: tuple[str, ...] = (
    "moonshot/fetch:latest",
    "moonshot/code_runner:latest",
    "moonshot/quickjs:latest",
    "moonshot/excel:latest",
    "moonshot/date:latest",
    "moonshot/convert:latest",
    "moonshot/base64:latest",
    "moonshot/memory:latest",
    "moonshot/rethink:latest",
    "moonshot/random-choice:latest",
    "moonshot/mew:latest",
)

_FETCH_TIMEOUT_SECONDS = 15.0

# Process-wide declaration cache. None = not yet fetched; [] = fetched and
# empty (or disabled). Fetched once so the injected tool set is deterministic
# across the lifetime of every workflow in this process.
_formula_cache: list[dict[str, Any]] | None = None
# lookup key -> (formula_uri, declared function name); keyed by both the exact
# declared name and its normalized form so model echo variations still route.
_index: dict[str, tuple[str, str]] = {}


def normalize_formula_uri(uri: str) -> str:
    """Normalize a formula URI with default namespace and tag."""
    uri = str(uri or "").strip()
    if "/" not in uri:
        uri = f"moonshot/{uri}"
    if ":" not in uri:
        uri = f"{uri}:latest"
    return uri


def configured_formula_uris() -> list[str]:
    """Resolve the active formula set from KIMI_FORMULAS (see module docstring)."""
    raw = os.environ.get("KIMI_FORMULAS")
    if raw is None:
        uris = list(DEFAULT_FORMULA_URIS)
    else:
        raw = raw.strip()
        if not raw:
            return []
        uris = [normalize_formula_uri(part) for part in raw.split(",") if part.strip()]
    deduped = list(dict.fromkeys(uris))
    for uri in deduped:
        if uri.startswith("moonshot/web-search:"):
            logger.warning(
                "[kimi-formulas] %s: Kimi marks web-search as being updated and "
                "does not recommend it for production workflows",
                uri,
            )
    return deduped


def reset_formula_cache() -> None:
    """Drop the cached declarations + index (test hook)."""
    global _formula_cache
    _formula_cache = None
    _index.clear()


def ensure_formula_tools() -> list[dict[str, Any]]:
    """Fetch (once per process) and cache the formula tool declarations.

    Per-formula failures are logged and skipped — formula loading must never
    break a chat call. Duplicate function names across formulas are skipped:
    Kimi rejects a request containing duplicate function names with a 400.
    """
    global _formula_cache
    if _formula_cache is not None:
        return _formula_cache
    declarations: list[dict[str, Any]] = []
    _index.clear()
    for uri in configured_formula_uris():
        for tool in _fetch_formula_tools(uri):
            function = tool.get("function") if isinstance(tool, dict) else None
            name = str((function or {}).get("name") or "").strip()
            if not name:
                logger.warning("[kimi-formulas] %s: skipping tool without a name", uri)
                continue
            key = _normalize_lookup(name)
            if key in _index:
                logger.warning(
                    "[kimi-formulas] %s: skipping duplicate function name %r "
                    "(already provided by %s)",
                    uri,
                    name,
                    _index[key][0],
                )
                continue
            _index[name] = (uri, name)
            _index[key] = (uri, name)
            declarations.append(tool)
    _formula_cache = declarations
    if declarations:
        logger.info(
            "[kimi-formulas] loaded %d formula tool(s): %s",
            len(declarations),
            sorted({entry[1] for entry in _index.values()}),
        )
    elif configured_formula_uris():
        logger.warning(
            "[kimi-formulas] no formula tools could be loaded from %d configured "
            "formula(s); kimi-k3 runs will not have native tools in this process",
            len(configured_formula_uris()),
        )
    return _formula_cache


def formula_uri_for_tool(name: str) -> str | None:
    """Return the formula URI backing a tool name, or None if not a formula tool."""
    entry = _index_entry(name)
    return entry[0] if entry else None


def execute_formula_tool(name: str, arguments: Any = None) -> str:
    """Execute a formula tool via POST /formulas/{uri}/fibers.

    Returns the fiber's ``context.output`` or verbatim ``context.encrypted_output``
    on success (the encrypted blob is an opaque server-side-decrypted string that
    must round-trip byte-for-byte into the next chat request). Never raises: all
    failures return an ``"Error: ..."`` string (WebFetch convention).
    """
    entry = _index_entry(name)
    if entry is None:
        return f"Error: '{name}' is not a configured Kimi formula tool."
    uri, declared_name = entry
    url = f"{_base_url()}/formulas/{uri}/fibers"
    body = {
        "name": declared_name,
        "arguments": json.dumps({} if arguments is None else arguments),
    }
    try:
        payload = _http_json("POST", url, body, _execute_timeout_seconds())
    except HTTPError as exc:
        snippet = ""
        try:
            snippet = exc.read().decode("utf-8", errors="replace")[:300]
        except Exception:  # noqa: BLE001
            pass
        return (
            f"Error: formula '{declared_name}' ({uri}) HTTP {exc.code}: "
            f"{snippet or exc.reason}"
        )
    except Exception as exc:  # noqa: BLE001 — network/timeout/JSON failures
        return f"Error: formula '{declared_name}' ({uri}) request failed: {exc}"
    if not isinstance(payload, dict):
        return f"Error: formula '{declared_name}' ({uri}) returned a non-object response."
    context = payload.get("context")
    context = context if isinstance(context, dict) else {}
    status = str(payload.get("status") or "")
    if status == "succeeded":
        output = context.get("output")
        if output is None:
            output = context.get("encrypted_output")
        if output is None:
            return (
                f"Error: formula '{declared_name}' ({uri}) succeeded but "
                "returned no output."
            )
        return output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)
    # Failure shapes are undocumented; mirror the official client's fallback chain.
    detail = payload.get("error") or context.get("error") or context.get("output")
    if detail:
        return (
            f"Error: formula '{declared_name}' ({uri}) failed "
            f"(status={status or 'unknown'}): {detail}"
        )
    return (
        f"Error: formula '{declared_name}' ({uri}) failed with an unknown error "
        f"(status={status or 'unknown'})."
    )


def _index_entry(name: str) -> tuple[str, str] | None:
    # Warm the cache here too: a run_tool activity can execute before this
    # process served a chat call (e.g. cross-pod retry), and activities may
    # perform I/O, so lazy fetch is safe in that context.
    ensure_formula_tools()
    key = str(name or "").strip()
    if not key:
        return None
    return _index.get(key) or _index.get(_normalize_lookup(key))


def _normalize_lookup(name: str) -> str:
    """Mirror main._normalize_tool_lookup_name / AgentToolExecutor normalization."""
    return name.lower().replace(" ", "").replace("_", "")


def _base_url() -> str:
    return os.environ.get("KIMI_BASE_URL", "https://api.moonshot.ai/v1").rstrip("/")


def _execute_timeout_seconds() -> float:
    raw = os.environ.get("KIMI_FORMULA_TIMEOUT_SECONDS", "45").strip()
    try:
        return max(1.0, float(raw))
    except ValueError:
        return 45.0


def _fetch_formula_tools(uri: str) -> list[dict[str, Any]]:
    url = f"{_base_url()}/formulas/{uri}/tools"
    try:
        payload = _http_json("GET", url, None, _FETCH_TIMEOUT_SECONDS)
    except Exception as exc:  # noqa: BLE001 — per-formula failure must not break chat
        logger.warning("[kimi-formulas] failed to fetch tools for %s: %s", uri, exc)
        return []
    tools = payload.get("tools") if isinstance(payload, dict) else None
    if not isinstance(tools, list):
        logger.warning(
            "[kimi-formulas] %s: unexpected tools response shape; skipping", uri
        )
        return []
    return [tool for tool in tools if isinstance(tool, dict)]


def _http_json(
    method: str, url: str, body: dict[str, Any] | None, timeout: float
) -> Any:
    from src.kimi_adapter import _auth_headers, _user_agent

    headers, _auth_mode = _auth_headers()
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8") if body is not None else None,
        headers={
            **headers,
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": _user_agent(),
        },
        method=method,
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))
