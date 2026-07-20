"""Kimi native Formula tools (the ``/formulas`` API) for the kimi-k3 path.

Kimi Open Platform exposes its official tools ("formulas") as ordinary
OpenAI-compatible function tools: declarations are fetched from
``GET /formulas/{uri}/tools`` and executed through
``POST /formulas/{uri}/fibers``. This module is the registry + executor for
that API inside dapr-agent-py:

- ``ensure_formula_tools`` lazily fetches declarations once per process and
  indexes ``function.name -> (formula URI, declared name)`` so the durable
  loop can route model tool calls back to the right formula. A total load
  failure is retried after a short cooldown rather than disabling formulas
  for the process lifetime. Two upstream-drift guards: a best-effort
  ``GET /formulas`` catalog check turns removed/renamed formulas (e.g. the
  ``code_runner`` -> ``code-runner`` rename) into explicit warnings instead
  of silent 404 skips, and plugin-style manifests (``_plugin.functions[]``,
  e.g. ``moonshot/excel``) are flattened into standard declarations — named
  ``<plugin>_<function>`` on the wire (dots are invalid in chat tool names)
  and executed as ``<plugin>.<function>`` at the fibers endpoint.
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
- ``KIMI_FORMULAS`` — unset or empty: disabled; comma-separated URIs opt in a
  custom set (normalized with default ``moonshot/`` namespace / ``:latest``
  tag, deduped order-preserving).
- ``KIMI_FORMULA_TIMEOUT_SECONDS`` — fiber execution timeout (default 45).
- Auth uses ``KIMI_API_KEY``. ``KIMI_FORMULAS_BASE_URL`` must identify a
  separately verified Formula endpoint when formulas are enabled; the KFC
  chat endpoint is not assumed to expose Formula APIs.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
import logging
import os
import re
import threading
import time
from typing import Any
from urllib.error import HTTPError
import urllib.request

from src.kimi_config import kimi_formulas_base_url

logger = logging.getLogger(__name__)

# All documented official formulas except web-search (vendor-deprecated).
# Note: code_runner was renamed upstream to code-runner (the underscore URI
# now 404s); normalize_formula_uri rewrites the legacy spelling for custom
# KIMI_FORMULAS values.
DEFAULT_FORMULA_URIS: tuple[str, ...] = (
    "moonshot/fetch:latest",
    "moonshot/code-runner:latest",
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
# Single-flights the load: chat calls and run_tool activities run on different
# threads, and an unguarded first-touch could double-fetch or transiently
# empty the index mid-dispatch.
_formula_lock = threading.Lock()
# Monotonic timestamp of the last TOTAL load failure (zero declarations from a
# non-empty configured set). A total failure (e.g. a network blip at pod
# start) is retried after this cooldown instead of disabling formulas for the
# process lifetime; partial loads and deliberate disables stay permanent.
_load_failed_at: float | None = None
_LOAD_RETRY_COOLDOWN_SECONDS = 60.0


def normalize_formula_uri(uri: str) -> str:
    """Normalize a formula URI with default namespace and tag."""
    uri = str(uri or "").strip()
    if "/" not in uri:
        uri = f"moonshot/{uri}"
    if ":" not in uri:
        uri = f"{uri}:latest"
    # Upstream rename: code_runner -> code-runner. Rewrite the legacy spelling
    # so stale custom KIMI_FORMULAS values keep working (the underscore URI 404s).
    if uri.startswith("moonshot/code_runner:"):
        uri = f"moonshot/code-runner:{uri.rsplit(':', 1)[1]}"
    return uri


def configured_formula_uris() -> list[str]:
    """Resolve the active formula set from KIMI_FORMULAS (see module docstring)."""
    raw = os.environ.get("KIMI_FORMULAS")
    if raw is None or not raw.strip():
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
    global _formula_cache, _load_failed_at
    with _formula_lock:
        _formula_cache = None
        _load_failed_at = None
        _index.clear()


def ensure_formula_tools() -> list[dict[str, Any]]:
    """Fetch (once per process) and cache the formula tool declarations.

    Per-formula failures are logged and skipped — formula loading must never
    break a chat call. Duplicate function names across formulas are skipped:
    Kimi rejects a request containing duplicate function names with a 400.

    A TOTAL load failure (zero declarations from a non-empty configured set,
    e.g. a network blip at pod start) is retried after
    ``_LOAD_RETRY_COOLDOWN_SECONDS`` instead of disabling formulas for the
    process lifetime. Partial loads and a deliberately empty ``KIMI_FORMULAS``
    stay cached permanently, keeping the injected tool set deterministic.
    """
    global _formula_cache, _load_failed_at
    with _formula_lock:
        if _formula_cache is not None:
            if _load_failed_at is None:
                return _formula_cache
            if (time.monotonic() - _load_failed_at) < _LOAD_RETRY_COOLDOWN_SECONDS:
                return _formula_cache
            _formula_cache = None  # cooldown elapsed: retry the load below
        declarations: list[dict[str, Any]] = []
        _index.clear()
        uris = configured_formula_uris()
        # Upstream drift guard: one best-effort catalog fetch turns a silently
        # skipped 404 (formula removed/renamed upstream — e.g. the code_runner
        # -> code-runner rename) into an explicit, actionable warning. A catalog
        # fetch failure falls back to per-URI fetches: a transient catalog error
        # must not break loading.
        catalog = _fetch_formula_catalog() if uris else None
        if catalog is not None:
            missing = [uri for uri in uris if uri.rsplit(":", 1)[0] not in catalog]
            for uri in missing:
                logger.warning(
                    "[kimi-formulas] %s: not found in the Kimi formula catalog "
                    "(removed or renamed upstream?); skipping",
                    uri,
                )
            uris = [uri for uri in uris if uri.rsplit(":", 1)[0] in catalog]
        # Concurrent fetch so a cold start (or retry) costs ~one timeout
        # instead of N sequential ones while callers wait on the lock.
        # executor.map preserves URI order, keeping declarations deterministic.
        if uris:
            with ThreadPoolExecutor(max_workers=min(8, len(uris))) as pool:
                fetched = list(pool.map(_fetch_formula_tools, uris))
        else:
            fetched = []
        for uri, uri_tools in zip(uris, fetched):
            for tool, fiber_name in uri_tools:
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
                # fiber_name differs from the declared name for plugin-manifest
                # formulas (declared excel_read_file, executed excel.read_file).
                _index[name] = (uri, fiber_name or name)
                _index[key] = (uri, fiber_name or name)
                declarations.append(tool)
        _formula_cache = declarations
        if declarations:
            _load_failed_at = None
            logger.info(
                "[kimi-formulas] loaded %d formula tool(s): %s",
                len(declarations),
                sorted({entry[1] for entry in _index.values()}),
            )
        elif configured_formula_uris():
            _load_failed_at = time.monotonic()
            logger.warning(
                "[kimi-formulas] no formula tools could be loaded from %d configured "
                "formula(s); kimi-k3 runs will not have native tools until the "
                "load is retried in %.0fs",
                len(configured_formula_uris()),
                _LOAD_RETRY_COOLDOWN_SECONDS,
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
    content, _encrypted = execute_formula_tool_result(name, arguments)
    return content


def execute_formula_tool_result(name: str, arguments: Any = None) -> tuple[str, bool]:
    """Execute a formula tool, also reporting whether the result is encrypted.

    Same contract as ``execute_formula_tool``; the second tuple element is True
    only when the returned content is a verbatim ``context.encrypted_output``
    blob. Persistence layers use the flag to exempt the blob from lossy
    truncation — it must round-trip byte-for-byte into the next chat request.
    """
    entry = _index_entry(name)
    if entry is None:
        return f"Error: '{name}' is not a configured Kimi formula tool.", False
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
        ), False
    except Exception as exc:  # noqa: BLE001 — network/timeout/JSON failures
        return f"Error: formula '{declared_name}' ({uri}) request failed: {exc}", False
    if not isinstance(payload, dict):
        return (
            f"Error: formula '{declared_name}' ({uri}) returned a non-object response.",
            False,
        )
    context = payload.get("context")
    context = context if isinstance(context, dict) else {}
    status = str(payload.get("status") or "")
    if status == "succeeded":
        encrypted = False
        output = context.get("output")
        if output is None:
            output = context.get("encrypted_output")
            encrypted = output is not None
        if output is None:
            return (
                f"Error: formula '{declared_name}' ({uri}) succeeded but "
                "returned no output. If this is a code-execution formula, "
                "print the result explicitly (e.g. console.log in quickjs, "
                "print in code_runner) and retry the call."
            ), False
        return (
            output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)
        ), encrypted
    # Failure shapes are undocumented; mirror the official client's fallback chain.
    detail = payload.get("error") or context.get("error") or context.get("output")
    if detail:
        return (
            f"Error: formula '{declared_name}' ({uri}) failed "
            f"(status={status or 'unknown'}): {detail}"
        ), False
    return (
        f"Error: formula '{declared_name}' ({uri}) failed with an unknown error "
        f"(status={status or 'unknown'})."
    ), False


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
    base_url = kimi_formulas_base_url()
    if base_url is None:
        raise RuntimeError(
            "Kimi Formula tools require a verified KIMI_FORMULAS_BASE_URL"
        )
    return base_url


def _execute_timeout_seconds() -> float:
    raw = os.environ.get("KIMI_FORMULA_TIMEOUT_SECONDS", "45").strip()
    try:
        return max(1.0, float(raw))
    except ValueError:
        return 45.0


def _fetch_formula_catalog() -> set[str] | None:
    """Best-effort GET /formulas -> set of 'namespace/name' keys, or None.

    Powers the upstream-drift guard in ensure_formula_tools: a configured URI
    absent from the catalog is skipped with an explicit warning instead of
    being silently swallowed by a per-URI 404.
    """
    try:
        url = f"{_base_url()}/formulas"
        payload = _http_json("GET", url, None, _FETCH_TIMEOUT_SECONDS)
    except Exception as exc:  # noqa: BLE001 — catalog failure must not break loading
        logger.warning("[kimi-formulas] catalog fetch failed (continuing without): %s", exc)
        return None
    items = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        logger.warning("[kimi-formulas] unexpected catalog response shape; continuing without")
        return None
    catalog: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        namespace = str(item.get("namespace") or "").strip()
        name = str(item.get("name") or "").strip()
        if namespace and name:
            catalog.add(f"{namespace}/{name}")
    return catalog


def _fetch_formula_tools(uri: str) -> list[tuple[dict[str, Any], str | None]]:
    try:
        url = f"{_base_url()}/formulas/{uri}/tools"
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
    # Each entry is (declaration, fiber_name) — fiber_name None means "execute
    # under the declared name" (the standard shape).
    declarations: list[tuple[dict[str, Any], str | None]] = []
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        if isinstance(tool.get("function"), dict):
            declarations.append((tool, None))
            continue
        plugin = tool.get("_plugin")
        if isinstance(plugin, dict):
            # Some formulas (e.g. moonshot/excel) return a plugin-style
            # manifest instead of OpenAI function declarations, despite the
            # docs' API-compatibility guarantee. Their functions are fiber-
            # executable as "<plugin>.<function>", but dots are not valid in
            # chat-completion tool names — so declare them as
            # "<plugin>_<function>" and record the dotted fiber name for
            # execution.
            plugin_name = str(plugin.get("name") or "").strip()
            plugin_description = str(plugin.get("description") or "")
            for fn in plugin.get("functions") or []:
                if not isinstance(fn, dict):
                    continue
                fn_name = str(fn.get("name") or "").strip()
                if not plugin_name or not fn_name:
                    continue
                declared_name = _sanitize_declared_name(f"{plugin_name}_{fn_name}")
                function = dict(fn)
                function["name"] = declared_name
                if not function.get("description"):
                    function["description"] = plugin_description
                if not isinstance(function.get("parameters"), dict):
                    function["parameters"] = {"type": "object", "properties": {}}
                declarations.append(
                    (
                        {"type": "function", "function": function},
                        f"{plugin_name}.{fn_name}",
                    )
                )
            continue
        logger.warning(
            "[kimi-formulas] %s: skipping tool with an unrecognized shape", uri
        )
    return declarations


def _sanitize_declared_name(name: str) -> str:
    """Reduce a name to the chat-completion tool charset [A-Za-z0-9_-]."""
    return re.sub(r"[^A-Za-z0-9_-]", "_", name)


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
