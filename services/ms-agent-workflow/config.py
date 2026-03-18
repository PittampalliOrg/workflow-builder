from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass

logger = logging.getLogger(__name__)

DEFAULT_CONFIG_STORE_NAME = os.environ.get("DAPR_CONFIG_STORE", "azureappconfig")

_LOGICAL_KEYS = {
    "model": "MODEL",
    "instructionsoverlay": "INSTRUCTIONS_OVERLAY",
    "maxiterations": "MAX_ITERATIONS",
    "toolgroup": "TOOL_GROUP",
}


def _normalize_template_name(template_id: str) -> str:
    return "".join(ch if ch.isalnum() else "_" for ch in template_id.upper())


def _normalize_config_key(key: str) -> str:
    return "".join(ch for ch in key.strip().lower() if ch.isalnum())


def parse_config_keys(value: object) -> list[str] | None:
    if isinstance(value, list):
        keys = [str(item).strip() for item in value if str(item).strip()]
        return keys or None
    if not isinstance(value, str):
        return None
    keys = [part.strip() for part in value.replace("\n", ",").split(",")]
    keys = [key for key in keys if key]
    return keys or None


def parse_config_metadata(value: object) -> dict[str, str] | None:
    if isinstance(value, dict):
        metadata = {
            str(key).strip(): str(raw).strip()
            for key, raw in value.items()
            if str(key).strip() and str(raw).strip()
        }
        return metadata or None
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    metadata = {
        str(key).strip(): str(raw).strip()
        for key, raw in parsed.items()
        if str(key).strip() and str(raw).strip()
    }
    return metadata or None


@dataclass(frozen=True)
class TemplateRuntimeConfig:
    model: str | None = None
    instructions_overlay: str | None = None
    max_iterations: int | None = None
    tool_group: str | None = None


class TemplateConfigResolver:
    def __init__(self, default_store_name: str = DEFAULT_CONFIG_STORE_NAME) -> None:
        self.default_store_name = default_store_name

    def _config_key_map(self, template_id: str) -> dict[str, str]:
        prefix = f"MS_AGENT_{_normalize_template_name(template_id)}"
        return {
            logical: f"{prefix}_{suffix}" for logical, suffix in _LOGICAL_KEYS.items()
        }

    def resolve(
        self,
        *,
        template_id: str,
        store_name: str | None = None,
        requested_keys: list[str] | None = None,
        metadata: dict[str, str] | None = None,
    ) -> TemplateRuntimeConfig:
        key_map = self._config_key_map(template_id)
        selected_logical_keys = self._select_logical_keys(requested_keys, key_map)
        if not selected_logical_keys:
            selected_logical_keys = list(key_map.keys())

        actual_keys = [key_map[logical] for logical in selected_logical_keys]
        dapr_values = self._load_from_dapr(
            store_name=store_name or self.default_store_name,
            actual_keys=actual_keys,
            metadata=metadata,
        )

        def pick(logical_key: str) -> str | None:
            actual_key = key_map[logical_key]
            candidate = dapr_values.get(actual_key) or os.environ.get(actual_key)
            if isinstance(candidate, str):
                trimmed = candidate.strip()
                return trimmed or None
            return None

        max_iterations: int | None = None
        raw_max_iterations = pick("maxiterations")
        if raw_max_iterations:
            try:
                parsed = int(raw_max_iterations)
            except ValueError:
                parsed = None
            if parsed and parsed > 0:
                max_iterations = parsed

        return TemplateRuntimeConfig(
            model=pick("model"),
            instructions_overlay=pick("instructionsoverlay"),
            max_iterations=max_iterations,
            tool_group=pick("toolgroup"),
        )

    def _select_logical_keys(
        self,
        requested_keys: list[str] | None,
        key_map: dict[str, str],
    ) -> list[str]:
        if not requested_keys:
            return list(key_map.keys())
        selected: list[str] = []
        normalized_key_map = {
            _normalize_config_key(logical): logical for logical in key_map.keys()
        }
        normalized_actual_map = {
            _normalize_config_key(actual): logical for logical, actual in key_map.items()
        }
        for raw_key in requested_keys:
            normalized = _normalize_config_key(raw_key)
            logical = normalized_key_map.get(normalized) or normalized_actual_map.get(
                normalized
            )
            if logical and logical not in selected:
                selected.append(logical)
        return selected

    def _load_from_dapr(
        self,
        *,
        store_name: str | None,
        actual_keys: list[str],
        metadata: dict[str, str] | None,
    ) -> dict[str, str]:
        if not store_name or not actual_keys:
            return {}
        try:
            from dapr.clients import DaprClient

            with DaprClient() as client:
                response = client.get_configuration(
                    store_name=store_name,
                    keys=actual_keys,
                    metadata=metadata,
                )
        except Exception as exc:  # noqa: BLE001
            logger.debug("Template config Dapr lookup failed: %s", exc)
            return {}

        values: dict[str, str] = {}
        if response and response.items:
            for key, item in response.items.items():
                if item.value:
                    values[key] = item.value
        return values
