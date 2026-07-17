from __future__ import annotations

from pathlib import Path
import sys

import pytest


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.effective_agent_config import (  # noqa: E402
    MODEL_COMPONENT_MAP,
    provider_metadata_for_component,
    resolve_llm_component,
)


def test_kimi_k3_is_the_only_kimi_model_route() -> None:
    kimi_routes = {
        model_spec: component
        for model_spec, component in MODEL_COMPONENT_MAP.items()
        if "kimi" in model_spec.lower() or "kimi" in component.lower()
    }

    assert kimi_routes == {"kimi/kimi-k3": "llm-kimi-k3"}
    assert provider_metadata_for_component("llm-kimi-k3") == {
        "provider": "kimi",
        "providerModel": "kimi-k3",
    }


@pytest.mark.parametrize(
    "model_spec",
    [
        "kimi/kimi-k2.5",
        "kimi/kimi-k2.6",
        "nvidia/moonshotai/kimi-k2-thinking",
        "nvidia/moonshotai/kimi-k2-instruct-0905",
        "foundry/Kimi-K2.6",
    ],
)
def test_retired_kimi_routes_are_rejected(model_spec: str) -> None:
    with pytest.raises(ValueError, match="Unknown modelSpec"):
        resolve_llm_component(model_spec)
