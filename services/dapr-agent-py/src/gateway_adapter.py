"""OpenAI-compatible gateway adapter.

Routes OpenAI-protocol providers (DeepSeek, NVIDIA, Foundry, Kimi, Alibaba,
Together, Z.AI) through a single gateway endpoint instead of direct
provider HTTP calls. Replaces ~3,622 lines of near-duplicate per-provider
HTTP plumbing with one model-by-component shim.

Architecture:

  dapr-agent-py → fixed OpenAI-compatible gateway → upstream provider

The gateway exposes an OpenAI-compatible `/v1/chat/completions` endpoint, so the
request/response shape is identical to what each per-provider adapter
already builds. The component name (`llm-deepseek-v4-pro`) maps to a Gateway
model ID (`deepseek-v4-pro`) via the `DAPR_AGENT_PY_GATEWAY_MODEL_MAP_JSON`
env var; if no mapping exists for a component, this adapter doesn't patch
and the legacy per-provider adapter handles the call.

Feature flagging:
  - `DAPR_AGENT_PY_GATEWAY_ADAPTER_ENABLED=true` (default false) — master switch.
  - `DAPR_AGENT_PY_GATEWAY_<PROVIDER>=true` (default false) — per-provider
    rollout knob. PROVIDER is one of DEEPSEEK, NVIDIA, FOUNDRY, KIMI, ALIBABA,
    TOGETHER, ZAI. Each falls through to its legacy adapter when disabled.

Observability:
  - `record_tokens()` still fires for Prometheus dashboards.
  - GenAI semantic-convention attributes are stamped on the active Dapr span.
"""

from __future__ import annotations

import json
import logging
import os
import random
import time
from typing import Any
from urllib.error import HTTPError
import urllib.request

from src.provider_conformance import (
    build_llm_chat_response,
    parse_structured_response,
    strict_json_schema,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Model resolution
# ---------------------------------------------------------------------------


# Built-in fallback map. Component name in Dapr → OpenAI-compatible model ID.
# Overridable via `DAPR_AGENT_PY_GATEWAY_MODEL_MAP_JSON` env. Keep this map 1:1
# with the Component-llm-*.yaml file slugs we ship; if you add a new LLM
# Component, add its upstream model ID here.
_DEFAULT_MODEL_MAP: dict[str, str] = {
    # DeepSeek
    "llm-deepseek": "deepseek-v4-pro",                   # default DeepSeek model
    "llm-deepseek-v4-pro": "deepseek-v4-pro",
    "llm-deepseek-v4-flash": "deepseek-v4-flash",
    # NVIDIA NIM (6 models)
    "llm-nvidia-llama31-8b": "nvidia-llama31-8b",
    "llm-nvidia-glm47": "nvidia-glm47",
    "llm-nvidia-kimi-k2-0905": "nvidia-kimi-k2-thinking",
    "llm-nvidia-kimi-k2-thinking": "nvidia-kimi-k2-thinking",
    "llm-nvidia-devstral-2-123b": "nvidia-devstral-2-123b",
    "llm-nvidia-mistral-medium-35-128b": "nvidia-mistral-medium-35-128b",
    "llm-nvidia-qwen3-coder-480b": "nvidia-qwen3-coder-480b",
    # Azure AI Foundry — 2 models
    "llm-foundry-kimi-k26": "foundry-kimi-k26",
    "llm-foundry-deepseek-v4-flash": "foundry-deepseek-v4-flash",
    # Moonshot Kimi
    "llm-kimi-k25": "kimi-k25",
    "llm-kimi-k26": "kimi-k25",                          # fall back to k25
    # Alibaba DashScope
    "llm-alibaba-qwen3-coder-plus": "alibaba-qwen3-coder-plus",
    # Together (3 models)
    "llm-together-deepseek-v4-pro": "together-deepseek-v4-pro",
    "llm-together-qwen3-coder-480b": "together-qwen3-coder-480b",
    "llm-together-glm-51": "together-glm-51",
    # Z.AI
    "llm-glm-5.2": "glm-5.2",
    # OpenAI (2 models)
    "llm-openai-gpt5": "gpt-5.5",
    "llm-openai-o3": "o3",
    # Anthropic (3 models)
    "llm-anthropic-opus": "anthropic-opus",
    "llm-anthropic-sonnet": "anthropic-sonnet",
    "llm-anthropic-haiku": "anthropic-haiku",
    # Google
    "llm-google-gemini": "google-gemini",
}


# Which env-var flag controls each provider's rollout.
_PROVIDER_FLAGS: dict[str, str] = {
    "deepseek": "DAPR_AGENT_PY_GATEWAY_DEEPSEEK",
    "nvidia": "DAPR_AGENT_PY_GATEWAY_NVIDIA",
    "foundry": "DAPR_AGENT_PY_GATEWAY_FOUNDRY",
    "kimi": "DAPR_AGENT_PY_GATEWAY_KIMI",
    "alibaba": "DAPR_AGENT_PY_GATEWAY_ALIBABA",
    "together": "DAPR_AGENT_PY_GATEWAY_TOGETHER",
    "zai": "DAPR_AGENT_PY_GATEWAY_ZAI",
}


def _is_truthy(value: str | None) -> bool:
    if not value:
        return False
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _gateway_enabled() -> bool:
    return _is_truthy(os.environ.get("DAPR_AGENT_PY_GATEWAY_ADAPTER_ENABLED"))


def _gateway_base_url() -> str:
    return (
        os.environ.get("LLM_GATEWAY_OPENAI_BASE_URL", "").strip().rstrip("/")
    )


def _load_model_map() -> dict[str, str]:
    """Merge `DAPR_AGENT_PY_GATEWAY_MODEL_MAP_JSON` over the default map.
    Allows operators to add or override model IDs without a code change. JSON
    should be a `{"component": "model"}` object.
    """
    override_raw = os.environ.get("DAPR_AGENT_PY_GATEWAY_MODEL_MAP_JSON")
    if not override_raw:
        return dict(_DEFAULT_MODEL_MAP)
    try:
        parsed = json.loads(override_raw)
        if not isinstance(parsed, dict):
            logger.warning(
                "[gateway-adapter] DAPR_AGENT_PY_GATEWAY_MODEL_MAP_JSON is not an object; ignoring"
            )
            return dict(_DEFAULT_MODEL_MAP)
        merged = dict(_DEFAULT_MODEL_MAP)
        for k, v in parsed.items():
            if isinstance(k, str) and isinstance(v, str) and k.strip() and v.strip():
                merged[k.strip()] = v.strip()
        return merged
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "[gateway-adapter] failed to parse DAPR_AGENT_PY_GATEWAY_MODEL_MAP_JSON: %s", exc
        )
        return dict(_DEFAULT_MODEL_MAP)


def _provider_for_component(component: str) -> str | None:
    """Return the provider key (used for the feature-flag lookup) for the
    given component, or None if the component isn't handled by this adapter."""
    text = (component or "").lower()
    if "deepseek" in text:
        return "deepseek"
    if "nvidia" in text:
        return "nvidia"
    if "foundry" in text:
        return "foundry"
    if "kimi" in text or "moonshot" in text:
        return "kimi"
    if "alibaba" in text or "dashscope" in text or "qwen" in text:
        # NVIDIA Qwen models are already caught by the "nvidia" check.
        return "alibaba"
    if "together" in text:
        return "together"
    if text.startswith("llm-glm-") or "zai" in text:
        return "zai"
    return None


def _model_for_component(component: str) -> str | None:
    """Return the gateway model ID for `component`, or None when unavailable."""
    if not _gateway_enabled() or not _gateway_base_url():
        return None
    model_map = _load_model_map()
    model = model_map.get((component or "").strip())
    if not model:
        return None
    provider = _provider_for_component(component)
    if provider is None:
        return None
    flag = _PROVIDER_FLAGS.get(provider)
    if flag and not _is_truthy(os.environ.get(flag)):
        return None
    return model


# ---------------------------------------------------------------------------
# Shared OpenAI-format helpers (kept minimal — adapters share the heavy
# lifting via `provider_conformance`)
# ---------------------------------------------------------------------------


def _as_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                if item.get("type") in {"text", "input_text", "output_text"}:
                    parts.append(str(item.get("text", "")))
                elif "content" in item:
                    parts.append(str(item.get("content", "")))
                else:
                    parts.append(json.dumps(item, ensure_ascii=False))
            else:
                parts.append(str(item))
        return "\n".join(p for p in parts if p)
    return str(content)


def _normalize_tool_call(call: Any) -> dict[str, Any] | None:
    if not isinstance(call, dict):
        return None
    function = call.get("function") if isinstance(call.get("function"), dict) else {}
    name = str(function.get("name") or call.get("name") or "").strip()
    if not name:
        return None
    raw_args = function.get("arguments", call.get("arguments", "{}"))
    arguments = raw_args if isinstance(raw_args, str) else json.dumps(raw_args or {})
    call_id = str(call.get("id") or call.get("call_id") or "").strip()
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": arguments or "{}"},
    }


def _normalize_messages(prompt: Any, raw_messages: list[Any] | None) -> list[dict[str, Any]]:
    """Coerce dapr-agents prompt/messages into OpenAI chat-completions shape."""
    if raw_messages and isinstance(raw_messages, list):
        source = raw_messages
    elif isinstance(prompt, list):
        source = prompt
    elif isinstance(prompt, str):
        source = [{"role": "user", "content": prompt}]
    else:
        return []
    out: list[dict[str, Any]] = []
    for item in source:
        if isinstance(item, dict):
            role = str(item.get("role") or "user")
            content = item.get("content")
            entry: dict[str, Any] = {"role": role, "content": _as_text(content)}
            if item.get("tool_calls"):
                entry["tool_calls"] = item["tool_calls"]
            if item.get("tool_call_id"):
                entry["tool_call_id"] = item["tool_call_id"]
            if item.get("name"):
                entry["name"] = item["name"]
            out.append(entry)
        else:
            out.append({"role": "user", "content": str(item)})
    return out


def _tool_name(tool: Any) -> str:
    """Extract a tool name from any of the shapes dapr-agents passes:
    dict (OpenAI-format), dict with bare `name`, or an object with a
    `.name` attribute (the dapr-agents Tool class)."""
    if isinstance(tool, dict):
        fn = tool.get("function")
        if isinstance(fn, dict) and fn.get("name"):
            return str(fn["name"])
        return str(tool.get("name") or "")
    return str(getattr(tool, "name", "") or "")


def _tool_description(tool: Any, name: str) -> str:
    if isinstance(tool, dict):
        fn = tool.get("function")
        if isinstance(fn, dict) and fn.get("description"):
            return str(fn["description"])
        if tool.get("description"):
            return str(tool["description"])
    return str(getattr(tool, "description", "") or name)


def _tool_parameters(tool: Any) -> dict[str, Any]:
    if isinstance(tool, dict):
        params = tool.get("parameters")
        if isinstance(params, dict):
            return params
        fn = tool.get("function")
        if isinstance(fn, dict) and isinstance(fn.get("parameters"), dict):
            return fn["parameters"]
        input_schema = tool.get("input_schema")
        if isinstance(input_schema, dict):
            return input_schema
    # dapr-agents Tool class exposes the Pydantic args model via `args_model`.
    args_model = getattr(tool, "args_model", None)
    if args_model is not None:
        try:
            schema = args_model.model_json_schema()
            if isinstance(schema, dict):
                return schema
        except Exception:
            pass
    return {"type": "object", "properties": {}}


def _convert_tools(tools: list[Any] | None) -> list[dict[str, Any]] | None:
    """Normalize any tool shape dapr-agents passes (dict, OpenAI-format dict,
    dapr-agents Tool object with .name/.description/.args_model, Pydantic
    with .model_dump()) into the OpenAI function-tool wire format."""
    if not tools:
        return None
    converted: list[dict[str, Any]] = []
    for tool in tools:
        # Already in OpenAI function-tool format
        if (
            isinstance(tool, dict)
            and tool.get("type") == "function"
            and isinstance(tool.get("function"), dict)
        ):
            converted.append(tool)
            continue
        # Pydantic-style model_dump that produces an OpenAI function-tool dict
        if hasattr(tool, "model_dump"):
            try:
                dumped = tool.model_dump()
            except Exception:
                dumped = None
            if (
                isinstance(dumped, dict)
                and dumped.get("type") == "function"
                and isinstance(dumped.get("function"), dict)
            ):
                converted.append(dumped)
                continue
        # Everything else: extract via the legacy adapter's _tool_name /
        # _tool_description / _tool_parameters helpers. This catches the
        # dapr-agents Tool class (object with .name, .description,
        # .args_model attributes) — the legacy DeepSeek adapter's path
        # that we previously dropped silently in this converter.
        name = _tool_name(tool)
        if not name:
            continue
        converted.append(
            {
                "type": "function",
                "function": {
                    "name": name,
                    "description": _tool_description(tool, name)[:1024],
                    "parameters": _tool_parameters(tool),
                },
            }
        )
    return converted or None


def _extract_response(
    response: dict[str, Any],
) -> tuple[str, list[dict[str, Any]], str | None]:
    choices = response.get("choices") or []
    if not choices or not isinstance(choices[0], dict):
        return "", [], None
    choice = choices[0]
    message = choice.get("message") if isinstance(choice.get("message"), dict) else {}
    content = _as_text(message.get("content"))
    tool_calls = [
        call
        for call in (_normalize_tool_call(c) for c in (message.get("tool_calls") or []))
        if call is not None
    ]
    finish_reason = choice.get("finish_reason")
    return content, tool_calls, str(finish_reason) if finish_reason else None


# ---------------------------------------------------------------------------
# Gateway call
# ---------------------------------------------------------------------------


def _gateway_request(url: str, body: dict[str, Any]) -> urllib.request.Request:
    return urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "workflow-builder-dapr-agent-py-gateway/1.0",
        },
        method="POST",
    )


def _retry_after_seconds(exc: HTTPError) -> float | None:
    retry_after = None
    if exc.headers:
        retry_after = exc.headers.get("Retry-After") or exc.headers.get("retry-after")
    if retry_after:
        try:
            return max(0.0, float(retry_after))
        except ValueError:
            pass
    return None


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default


def _transient_retry_codes() -> set[int]:
    raw = os.environ.get(
        "DAPR_AGENT_PY_GATEWAY_TRANSIENT_RETRY_STATUS_CODES",
        "408,425,500,502,503,504,529",
    )
    codes: set[int] = set()
    for part in raw.split(","):
        try:
            codes.add(int(part.strip()))
        except ValueError:
            continue
    return codes


def _transient_backoff_seconds(exc: HTTPError, attempt: int) -> float:
    retry_after = _retry_after_seconds(exc)
    if retry_after is not None:
        return retry_after

    initial = max(
        0.0,
        _env_float("DAPR_AGENT_PY_GATEWAY_TRANSIENT_INITIAL_BACKOFF_SECONDS", 8.0),
    )
    maximum = max(
        initial,
        _env_float("DAPR_AGENT_PY_GATEWAY_TRANSIENT_MAX_BACKOFF_SECONDS", 60.0),
    )
    jitter_fraction = max(
        0.0,
        _env_float("DAPR_AGENT_PY_GATEWAY_TRANSIENT_JITTER_FRACTION", 0.35),
    )
    base = min(maximum, initial * (2 ** max(0, attempt - 1)))
    return base + random.uniform(0.0, base * jitter_fraction)


def _call_gateway_chat(
    component: str,
    gateway_model: str,
    messages: list[dict[str, Any]],
    *,
    tools: list[Any] | None = None,
    max_tokens: int | None = None,
    response_format: Any = None,
    tool_choice: Any = None,
) -> dict[str, Any]:
    """Issue a single request to the configured OpenAI-compatible gateway."""

    base = _gateway_base_url()
    if not base:
        raise RuntimeError("LLM_GATEWAY_OPENAI_BASE_URL is not set")

    url = f"{base}/chat/completions"
    converted_tools = _convert_tools(tools)
    output_cap = max_tokens or int(os.environ.get("DAPR_AGENT_PY_GATEWAY_MAX_TOKENS", "4096"))
    timeout = int(os.environ.get("DAPR_AGENT_PY_GATEWAY_TIMEOUT_SECONDS", "300"))

    body: dict[str, Any] = {
        "model": gateway_model,
        "messages": messages,
        "max_tokens": output_cap,
        "stream": False,
    }
    if converted_tools:
        body["tools"] = converted_tools
        if isinstance(tool_choice, dict):
            body["tool_choice"] = tool_choice
        elif tool_choice in {"auto", "none", "required"}:
            body["tool_choice"] = tool_choice
        elif tool_choice is None:
            body["tool_choice"] = "auto"
    if response_format is not None:
        # Generic OpenAI shim accepts response_format as JSON-object hint.
        body["response_format"] = {"type": "json_object"}

    # DeepSeek-specific: thinking mode is enabled by default on V4 Pro/Flash
    # (https://api-docs.deepseek.com/guides/thinking_mode). When tools or
    # structured output are involved, some compatible gateways cannot parse
    # DeepSeek's chunked thinking response. This mirrors the direct-provider
    # adapter, which also disables thinking for tools or structured output.
    if gateway_model.startswith("deepseek-") or gateway_model.startswith("foundry-deepseek-"):
        body["thinking"] = {"type": "disabled"}
    if gateway_model == "glm-5.2" and (converted_tools or response_format is not None):
        body["thinking"] = {"type": "disabled"}

    logger.info(
        "[gateway-adapter] %s → model=%s msgs=%d tools=%d",
        component,
        gateway_model,
        len(messages),
        len(converted_tools or []),
    )

    started = time.monotonic()
    rate_limit_retries = _env_int("DAPR_AGENT_PY_GATEWAY_RATE_LIMIT_RETRIES", 3)
    transient_retries = _env_int("DAPR_AGENT_PY_GATEWAY_TRANSIENT_RETRIES", 5)
    transient_retry_codes = _transient_retry_codes()
    rate_attempt = 0
    transient_attempt = 0
    data: dict[str, Any]
    while True:
        req = _gateway_request(url, body)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read() or b"{}"
                data = json.loads(raw)
            break
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace") if hasattr(exc, "read") else ""
            if exc.code == 429 and rate_attempt < rate_limit_retries:
                delay = _retry_after_seconds(exc)
                if delay is None:
                    delay = _env_float("DAPR_AGENT_PY_GATEWAY_RATE_LIMIT_BACKOFF_SECONDS", 1.0)
                rate_attempt += 1
                logger.warning(
                    "[gateway-adapter] 429 from model=%s; retry in %.1fs (attempt %d/%d): %s",
                    gateway_model,
                    delay,
                    rate_attempt,
                    rate_limit_retries,
                    detail[:300],
                )
                time.sleep(delay)
                continue
            if exc.code in transient_retry_codes and transient_attempt < transient_retries:
                transient_attempt += 1
                delay = _transient_backoff_seconds(exc, transient_attempt)
                logger.warning(
                    "[gateway-adapter] transient HTTP %d from model=%s; retry in %.1fs "
                    "(attempt %d/%d): %s",
                    exc.code,
                    gateway_model,
                    delay,
                    transient_attempt,
                    transient_retries,
                    detail[:300],
                )
                time.sleep(delay)
                continue
            raise RuntimeError(
                f"OpenAI-compatible gateway returned HTTP {exc.code} "
                f"for model={gateway_model}: {detail[:500]}"
            ) from exc

    content, tool_calls, _finish = _extract_response(data)
    usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
    duration_ms = (time.monotonic() - started) * 1000.0

    if response_format is not None and not content.strip():
        raise RuntimeError(
            f"OpenAI-compatible gateway model={gateway_model} returned empty content "
            "for structured response_format"
        )

    # Prometheus token metrics — autolog handles the per-call span content,
    # but our Grafana dashboards still read these counters.
    try:
        from src.telemetry import record_tokens

        record_tokens(
            type_="input",
            count=int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0),
            model=gateway_model,
        )
        record_tokens(
            type_="output",
            count=int(usage.get("completion_tokens") or usage.get("output_tokens") or 0),
            model=gateway_model,
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("[gateway-adapter] token metric emit failed: %s", exc)

    # Stamp GenAI semconv attrs on the active Dapr activity span (the
    # `agent-session-X.call_llm` span). The dapr-agents
    # `LLMObservabilityWrapper._set_token_attributes` would also extract
    # these from `metadata.usage` below, but it only runs on calls that
    # pass through the dapr-agents observability wrapper — which our
    # patched `DaprChatClient.generate` path may not.
    try:
        from src.telemetry.genai_attrs import (
            set_genai_request_attrs,
            set_genai_response_attrs,
        )

        set_genai_request_attrs(
            system=f"gateway:{gateway_model.split('-', 1)[0]}",
            request_model=gateway_model,
            max_tokens=max_tokens,
            tools_count=len(converted_tools) if converted_tools else None,
            response_format=("json_object" if response_format is not None else None),
            tool_choice=(
                tool_choice if isinstance(tool_choice, str) else None
            ),
            streaming=False,
            extra={
                "gen_ai.gateway.model": gateway_model,
                "gen_ai.gateway.component": component,
            },
        )
        set_genai_response_attrs(
            response_model=gateway_model,
            finish_reason=_finish,
            usage=usage,
            duration_ms=duration_ms,
            tool_calls_count=len(tool_calls) if tool_calls else None,
            output_chars=len(content) if isinstance(content, str) else None,
        )
    except Exception as _attr_exc:  # noqa: BLE001
        logger.debug("[genai-attrs] gateway span enrichment failed: %s", _attr_exc)

    return {
        "content": content,
        "tool_calls": tool_calls,
        "metadata": {
            "model": gateway_model,
            "component": component,
            "usage": usage,
            "duration_ms": duration_ms,
            "finish_reason": _finish,
        },
    }


# ---------------------------------------------------------------------------
# DaprChatClient patching
# ---------------------------------------------------------------------------


def _schema_for_response_format(response_format: Any) -> dict[str, Any]:
    """Extract a JSON schema from a Pydantic response_format class for use
    as a forced tool_call parameter schema. Falls back to a permissive
    `{"type": "object"}` if the class doesn't expose `model_json_schema`."""
    try:
        schema = response_format.model_json_schema()
    except Exception:
        return {"type": "object"}
    return strict_json_schema(schema)


def _response_format_tool_name(response_format: Any) -> str:
    """Derive a stable, provider-friendly tool name from the response_format
    class name. e.g. `ConversationSummary` → `emit_conversation_summary`."""
    raw = getattr(response_format, "__name__", "response")
    import re as _re

    snake = _re.sub(r"(?<!^)(?=[A-Z])", "_", raw).lower()
    return f"emit_{snake}"


def _call_via_tool_emit(
    component: str,
    gateway_model: str,
    response_format: Any,
    *,
    prompt: Any,
    raw_messages: Any,
    max_tokens: int | None,
) -> Any:
    """Phase 2c v2 reliability layer for structured-output calls.

    DeepSeek's `response_format: json_object` mode has a known
    intermittent-empty-response bug (per DeepSeek's own docs:
    https://api-docs.deepseek.com/guides/json_mode). Tool-calling is
    significantly more reliable across OpenAI-compatible providers and
    gateways.

    Strategy: when the caller asks for a structured Pydantic
    `response_format`, transform the request into a forced tool-call where
    the tool's parameter schema IS the response_format's JSON schema.
    Provider returns a tool_call whose `arguments` field is JSON matching
    the schema. Parse those args back into the Pydantic instance.
    """
    schema = _schema_for_response_format(response_format)
    tool_name = _response_format_tool_name(response_format)
    emit_tool = [
        {
            "type": "function",
            "function": {
                "name": tool_name,
                "description": (
                    f"Emit a structured {getattr(response_format, '__name__', 'response')} "
                    "object matching the schema. ALWAYS call this tool to deliver "
                    "your response."
                ),
                "parameters": schema,
            },
        }
    ]

    # NOTE: tool_choice MUST be "auto", not a forced {type:function, name:...}
    # object. Verified 2026-05-11 from a dev pod via direct curl: DeepSeek
    # returns a chunked response for forced tool_choice but works cleanly with
    # "auto" when the user message instructs the model to call the tool.
    messages = _normalize_messages(
        prompt,
        raw_messages if isinstance(raw_messages, list) else None,
    )
    # Append a strong tool-use directive on the last user message so the model
    # reliably emits the tool_call. The legacy adapter used response_format +
    # message rewriting; this is the tool-calling equivalent.
    if messages:
        # Find last user message and append directive (idempotent — won't
        # repeat if already present from a prior attempt).
        for idx in range(len(messages) - 1, -1, -1):
            if messages[idx].get("role") == "user":
                content = str(messages[idx].get("content") or "")
                directive = (
                    f"\n\nCall the `{tool_name}` tool with the structured "
                    f"output. Do not respond with free text."
                )
                if directive.strip() not in content:
                    messages[idx] = {
                        **messages[idx],
                        "content": content + directive,
                    }
                break

    logger.info(
        "[gateway-adapter] %s: response_format=%s → tool_emit=%s (auto) via Gateway",
        component,
        getattr(response_format, "__name__", "?"),
        tool_name,
    )
    result = _call_gateway_chat(
        component,
        gateway_model,
        messages,
        tools=emit_tool,
        max_tokens=max_tokens,
        response_format=None,
        tool_choice="auto",
    )

    tool_calls = result.get("tool_calls") or []
    if tool_calls:
        args_str = tool_calls[0].get("function", {}).get("arguments", "{}")
        if not isinstance(args_str, str):
            args_str = json.dumps(args_str)
        return parse_structured_response(response_format, args_str)

    # Provider didn't emit a tool_call despite forced_choice. Fall back to
    # parsing free-form content as JSON — same behavior as our regular
    # gateway path.
    return parse_structured_response(response_format, result.get("content", "") or "")


def patch_for_gateway(llm_client: Any) -> None:
    """Patch DaprChatClient.generate to route OpenAI-protocol components
    through the configured gateway. No-op when the master switch is off or
    no model is configured for the active component."""

    if not _gateway_enabled() or not _gateway_base_url():
        logger.info(
            "[gateway-adapter] disabled (enabled=%s base_url_set=%s)",
            _gateway_enabled(),
            bool(_gateway_base_url()),
        )
        return

    from dapr_agents.llm.dapr.chat import DaprChatClient

    if getattr(DaprChatClient, "_gateway_patched", False):
        return

    original_generate = DaprChatClient.generate

    def patched_generate(self: Any, *args: Any, **kwargs: Any) -> Any:
        component = getattr(self, "_llm_component", None)
        gateway_model = _model_for_component(str(component or ""))
        if gateway_model is None:
            return original_generate(self, *args, **kwargs)

        response_format = kwargs.get("response_format")

        # Structured output via forced tool-call (Phase 2c v2 reliability fix).
        # DeepSeek's `response_format: json_object` mode is unreliable on V4:
        #   (a) compatible gateways may reject its chunked response
        #   (b) DeepSeek's own docs warn of intermittent empty content
        #       (https://api-docs.deepseek.com/guides/json_mode)
        # Tool-calling is significantly more reliable. Transform the
        # response_format Pydantic class into a forced tool_call where the
        # tool's parameter schema IS the model's JSON schema, then parse
        # the tool_call's arguments back into the Pydantic instance.
        # Plain chat + tool-chat calls (no response_format) take the regular
        # Gateway path below unchanged.
        if response_format is not None and (
            gateway_model.startswith("deepseek-")
            or gateway_model.startswith("foundry-deepseek-")
        ):
            prompt = args[0] if args else kwargs.get("prompt", "")
            raw_messages = kwargs.get("messages")
            max_tokens = kwargs.get("max_tokens")
            try:
                return _call_via_tool_emit(
                    str(component),
                    gateway_model,
                    response_format,
                    prompt=prompt,
                    raw_messages=raw_messages,
                    max_tokens=max_tokens,
                )
            except Exception as exc:  # noqa: BLE001
                # Last-ditch fallback: if the forced-tool path fails for any
                # reason (provider declines, schema rejected, etc.), fall
                # through to the legacy direct-provider adapter chain.
                logger.warning(
                    "[gateway-adapter] %s: forced tool_emit failed (%s); "
                    "falling through to legacy adapter",
                    component,
                    exc,
                )
                return original_generate(self, *args, **kwargs)

        prompt = args[0] if args else kwargs.get("prompt", "")
        raw_messages = kwargs.get("messages")
        tools = kwargs.get("tools")
        max_tokens = kwargs.get("max_tokens")
        tool_choice = kwargs.get("tool_choice")

        messages = _normalize_messages(
            prompt,
            raw_messages if isinstance(raw_messages, list) else None,
        )
        result = _call_gateway_chat(
            str(component),
            gateway_model,
            messages,
            tools=tools,
            max_tokens=max_tokens,
            response_format=response_format,
            tool_choice=tool_choice,
        )

        if response_format is not None:
            return parse_structured_response(response_format, result.get("content", "") or "")

        return build_llm_chat_response(
            content=result.get("content", "") or "",
            tool_calls=result.get("tool_calls") or None,
            metadata=result.get("metadata") or {},
        )

    DaprChatClient.generate = patched_generate
    DaprChatClient._gateway_patched = True
    logger.info(
        "[gateway-adapter] DaprChatClient.generate patched (models=%d, base=%s)",
        len(_load_model_map()),
        _gateway_base_url(),
    )
