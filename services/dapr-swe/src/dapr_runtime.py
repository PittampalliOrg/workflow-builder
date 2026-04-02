"""Dapr-backed runtime config and secret helpers for dapr-swe."""

from __future__ import annotations

import os
import time
from typing import Any

import httpx

_CACHE_TTL_SECONDS = 30
_config_cache: dict[str, tuple[float, dict[str, str]]] = {}
_secret_cache: dict[str, tuple[float, str]] = {}


def _dapr_base_url() -> str:
    host = os.environ.get("DAPR_HOST", "localhost").strip() or "localhost"
    port = os.environ.get("DAPR_HTTP_PORT", "3500").strip() or "3500"
    return f"http://{host}:{port}"


def _cache_get(cache: dict[str, tuple[float, Any]], key: str) -> Any | None:
    entry = cache.get(key)
    if not entry:
        return None
    expires_at, value = entry
    if expires_at <= time.time():
        cache.pop(key, None)
        return None
    return value


def _cache_set(cache: dict[str, tuple[float, Any]], key: str, value: Any) -> None:
    cache[key] = (time.time() + _CACHE_TTL_SECONDS, value)


def get_configuration_values(store_name: str, keys: list[str]) -> dict[str, str]:
    normalized_keys = [key.strip() for key in keys if key and key.strip()]
    if not store_name or not normalized_keys:
        return {}

    cache_key = f"{store_name}:{','.join(sorted(normalized_keys))}"
    cached = _cache_get(_config_cache, cache_key)
    if cached is not None:
        return dict(cached)

    params: list[tuple[str, str]] = []
    for key in normalized_keys:
        params.append(("key", key))

    try:
        with httpx.Client(timeout=5) as client:
            response = client.get(
                f"{_dapr_base_url()}/v1.0/configuration/{store_name}",
                params=params,
            )
            response.raise_for_status()
            payload = response.json()
    except Exception:
        return {}

    values: dict[str, str] = {}
    if isinstance(payload, dict):
        for key, item in payload.items():
            if isinstance(item, dict):
                value = item.get("value")
                if isinstance(value, str):
                    values[key] = value

    _cache_set(_config_cache, cache_key, values)
    return dict(values)


def get_secret_value(store_name: str, secret_name: str) -> str:
    normalized_name = secret_name.strip()
    if not store_name or not normalized_name:
        return ""

    cache_key = f"{store_name}:{normalized_name}"
    cached = _cache_get(_secret_cache, cache_key)
    if cached is not None:
        return str(cached)

    try:
        with httpx.Client(timeout=5) as client:
            response = client.get(
                f"{_dapr_base_url()}/v1.0/secrets/{store_name}/{normalized_name}"
            )
            response.raise_for_status()
            payload = response.json()
    except Exception:
        return ""

    value = ""
    if isinstance(payload, dict):
        direct = payload.get(normalized_name)
        if isinstance(direct, str):
            value = direct
        elif len(payload) == 1:
            only_value = next(iter(payload.values()))
            if isinstance(only_value, str):
                value = only_value

    _cache_set(_secret_cache, cache_key, value)
    return value
