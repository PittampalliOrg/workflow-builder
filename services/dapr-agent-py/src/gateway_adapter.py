"""MLflow AI Gateway adapter (Phase 2c v2).

Routes all six OpenAI-protocol providers (DeepSeek, NVIDIA, Foundry, Kimi,
Alibaba, Together) through a single Gateway endpoint instead of direct
provider HTTP calls. Replaces ~3,622 lines of near-duplicate per-provider
HTTP plumbing with one route-by-name shim.

Architecture:

  dapr-agent-py → MLflow AI Gateway (LiteLLM) → upstream provider

The Gateway exposes an OpenAI-compatible `/v1/chat/completions` shim, so the
request/response shape is identical to what each per-provider adapter
already builds. The component name (`llm-deepseek-v4-pro`) maps to a Gateway
route name (`deepseek-v4-pro`) via the `DAPR_AGENT_PY_GATEWAY_ROUTE_MAP_JSON`
env var; if no mapping exists for a component, this adapter doesn't patch
and the legacy per-provider adapter handles the call.

Feature flagging:
  - `DAPR_AGENT_PY_GATEWAY_ADAPTER_ENABLED=true` (default false) — master switch.
  - `DAPR_AGENT_PY_GATEWAY_<PROVIDER>=true` (default false) — per-provider
    rollout knob. PROVIDER is one of DEEPSEEK, NVIDIA, FOUNDRY, KIMI, ALIBABA,
    TOGETHER. Each falls through to its legacy adapter when disabled.

Observability:
  - `mlflow.litellm.autolog()` (enabled in providers.py) auto-emits
    `LiteLLM.completion` spans on the Gateway side with full
    `gen_ai.input.messages` / `gen_ai.output.messages` / `gen_ai.usage.*`.
    No manual `claude_code.llm_request` span needed here.
  - `record_tokens()` still fires for Prometheus dashboards.
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any
from urllib.error import HTTPError
import urllib.request

from src.provider_conformance import (
    build_llm_chat_response,
    parse_structured_response,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Route resolution
# ---------------------------------------------------------------------------


# Built-in fallback map. Component name in Dapr → Gateway route name in
# `packages/components/hub-management/manifests/mlflow/ConfigMap-mlflow-ai-gateway-config.yaml`.
# Overridable via `DAPR_AGENT_PY_GATEWAY_ROUTE_MAP_JSON` env. Keep this map
# 1:1 with the Component-llm-*.yaml file slugs we ship; if you add a new
# LLM Component, add a matching Gateway route AND an entry here.
_DEFAULT_ROUTE_MAP: dict[str, str] = {
    # DeepSeek
    "llm-deepseek": "deepseek-v4-pro",                   # default DeepSeek route
    "llm-deepseek-v4-pro": "deepseek-v4-pro",
    "llm-deepseek-v4-flash": "deepseek-v4-flash",
    # NVIDIA NIM (6 routes)
    "llm-nvidia-llama31-8b": "nvidia-llama31-8b",
    "llm-nvidia-glm47": "nvidia-glm47",
    "llm-nvidia-kimi-k2-0905": "nvidia-kimi-k2-thinking",
    "llm-nvidia-kimi-k2-thinking": "nvidia-kimi-k2-thinking",
    "llm-nvidia-devstral-2-123b": "nvidia-devstral-2-123b",
    "llm-nvidia-mistral-medium-35-128b": "nvidia-mistral-medium-35-128b",
    "llm-nvidia-qwen3-coder-480b": "nvidia-qwen3-coder-480b",
    # Azure AI Foundry — 2 routes
    "llm-foundry-kimi-k26": "foundry-kimi-k26",
    "llm-foundry-deepseek-v4-flash": "foundry-deepseek-v4-flash",
    # Moonshot Kimi
    "llm-kimi-k25": "kimi-k25",
    "llm-kimi-k26": "kimi-k25",                          # fall back to k25 — no k26 Gateway route
    # Alibaba DashScope
    "llm-alibaba-qwen3-coder-plus": "alibaba-qwen3-coder-plus",
    # Together (3 routes)
    "llm-together-deepseek-v4-pro": "together-deepseek-v4-pro",
    "llm-together-qwen3-coder-480b": "together-qwen3-coder-480b",
    "llm-together-glm-51": "together-glm-51",
    # OpenAI (2 routes)
    "llm-openai-gpt5": "gpt-5.4",
    "llm-openai-o3": "o3",
    # Anthropic (3 routes)
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
}


def _is_truthy(value: str | None) -> bool:
    if not value:
        return False
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _gateway_enabled() -> bool:
    return _is_truthy(os.environ.get("DAPR_AGENT_PY_GATEWAY_ADAPTER_ENABLED"))


def _gateway_base_url() -> str:
    return (
        os.environ.get("MLFLOW_AI_GATEWAY_BASE_URL", "").strip().rstrip("/")
    )


def _load_route_map() -> dict[str, str]:
    """Merge `DAPR_AGENT_PY_GATEWAY_ROUTE_MAP_JSON` over the default map.
    Allows operators to add/override routes via stacks ConfigMap without
    a code change. JSON env should be a `{"component": "route"}` object.
    """
    override_raw = os.environ.get("DAPR_AGENT_PY_GATEWAY_ROUTE_MAP_JSON")
    if not override_raw:
        return dict(_DEFAULT_ROUTE_MAP)
    try:
        parsed = json.loads(override_raw)
        if not isinstance(parsed, dict):
            logger.warning(
                "[gateway-adapter] DAPR_AGENT_PY_GATEWAY_ROUTE_MAP_JSON is not an object; ignoring"
            )
            return dict(_DEFAULT_ROUTE_MAP)
        merged = dict(_DEFAULT_ROUTE_MAP)
        for k, v in parsed.items():
            if isinstance(k, str) and isinstance(v, str) and k.strip() and v.strip():
                merged[k.strip()] = v.strip()
        return merged
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "[gateway-adapter] failed to parse DAPR_AGENT_PY_GATEWAY_ROUTE_MAP_JSON: %s", exc
        )
        return dict(_DEFAULT_ROUTE_MAP)


def _provider_for_component(component: str) -> str | None:
    """Return the provider key (used for the feature-flag lookup) for the
    given component, or None if the component isn't one we route through
    Gateway."""
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
    return None


def _route_for_component(component: str) -> str | None:
    """Return the Gateway route name for `component`, or None if no route
    is configured (or the provider's feature flag is disabled)."""
    if not _gateway_enabled() or not _gateway_base_url():
        return None
    route_map = _load_route_map()
    route = route_map.get((component or "").strip())
    if not route:
        return None
    provider = _provider_for_component(component)
    if provider is None:
        return None
    flag = _PROVIDER_FLAGS.get(provider)
    if flag and not _is_truthy(os.environ.get(flag)):
        return None
    return route


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


def _convert_tools(tools: list[Any] | None) -> list[dict[str, Any]] | None:
    if not tools:
        return None
    converted: list[dict[str, Any]] = []
    for tool in tools:
        if isinstance(tool, dict) and tool.get("type") == "function" and isinstance(tool.get("function"), dict):
            converted.append(tool)
            continue
        if isinstance(tool, dict) and "name" in tool:
            converted.append(
                {
                    "type": "function",
                    "function": {
                        "name": str(tool["name"]),
                        "description": str(tool.get("description") or "")[:1024],
                        "parameters": tool.get("input_schema") or tool.get("parameters") or {"type": "object"},
                    },
                }
            )
            continue
        # Pydantic-style with .model_dump()
        if hasattr(tool, "model_dump"):
            dumped = tool.model_dump()
            if isinstance(dumped, dict) and dumped.get("type") == "function":
                converted.append(dumped)
                continue
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


def _retry_after_seconds(exc: HTTPError) -> float:
    retry_after = None
    if exc.headers:
        retry_after = exc.headers.get("Retry-After") or exc.headers.get("retry-after")
    if retry_after:
        try:
            return max(0.0, float(retry_after))
        except ValueError:
            pass
    return 1.0


def _call_gateway_chat(
    component: str,
    route: str,
    messages: list[dict[str, Any]],
    *,
    tools: list[Any] | None = None,
    max_tokens: int | None = None,
    response_format: Any = None,
    tool_choice: Any = None,
) -> dict[str, Any]:
    """Issue a single chat-completions request to the MLflow AI Gateway."""

    base = _gateway_base_url()
    if not base:
        raise RuntimeError("MLFLOW_AI_GATEWAY_BASE_URL is not set")

    url = f"{base}/v1/chat/completions"
    converted_tools = _convert_tools(tools)
    output_cap = max_tokens or int(os.environ.get("DAPR_AGENT_PY_GATEWAY_MAX_TOKENS", "4096"))
    timeout = int(os.environ.get("DAPR_AGENT_PY_GATEWAY_TIMEOUT_SECONDS", "300"))

    body: dict[str, Any] = {
        "model": route,
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

    logger.info(
        "[gateway-adapter] %s → route=%s msgs=%d tools=%d",
        component,
        route,
        len(messages),
        len(converted_tools or []),
    )

    started = time.monotonic()
    rate_limit_retries = int(os.environ.get("DAPR_AGENT_PY_GATEWAY_RATE_LIMIT_RETRIES", "3"))
    attempt = 0
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
            if exc.code == 429 and attempt < rate_limit_retries:
                delay = _retry_after_seconds(exc)
                attempt += 1
                logger.warning(
                    "[gateway-adapter] 429 from route=%s; retry in %.1fs (attempt %d/%d): %s",
                    route,
                    delay,
                    attempt,
                    rate_limit_retries,
                    detail[:300],
                )
                time.sleep(delay)
                continue
            raise RuntimeError(
                f"MLflow AI Gateway returned HTTP {exc.code} for route={route}: {detail[:500]}"
            ) from exc

    content, tool_calls, _finish = _extract_response(data)
    usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
    duration_ms = (time.monotonic() - started) * 1000.0

    if response_format is not None and not content.strip():
        raise RuntimeError(
            f"MLflow AI Gateway route={route} returned empty content for structured response_format"
        )

    # Prometheus token metrics — autolog handles the per-call span content,
    # but our Grafana dashboards still read these counters.
    try:
        from src.telemetry import record_tokens

        record_tokens(
            type_="input",
            count=int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0),
            model=route,
        )
        record_tokens(
            type_="output",
            count=int(usage.get("completion_tokens") or usage.get("output_tokens") or 0),
            model=route,
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("[gateway-adapter] token metric emit failed: %s", exc)

    return {
        "content": content,
        "tool_calls": tool_calls,
        "metadata": {
            "route": route,
            "component": component,
            "usage": usage,
            "duration_ms": duration_ms,
        },
    }


# ---------------------------------------------------------------------------
# DaprChatClient patching
# ---------------------------------------------------------------------------


def patch_for_gateway(llm_client: Any) -> None:
    """Patch DaprChatClient.generate to route OpenAI-protocol components
    through the MLflow AI Gateway. No-op when the master switch is off or
    no route is configured for the active component."""

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
        route = _route_for_component(str(component or ""))
        if route is None:
            return original_generate(self, *args, **kwargs)

        prompt = args[0] if args else kwargs.get("prompt", "")
        raw_messages = kwargs.get("messages")
        tools = kwargs.get("tools")
        max_tokens = kwargs.get("max_tokens")
        response_format = kwargs.get("response_format")
        tool_choice = kwargs.get("tool_choice")

        messages = _normalize_messages(
            prompt,
            raw_messages if isinstance(raw_messages, list) else None,
        )
        result = _call_gateway_chat(
            str(component),
            route,
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
        "[gateway-adapter] DaprChatClient.generate patched (routes=%d, base=%s)",
        len(_load_route_map()),
        _gateway_base_url(),
    )
