import json
from typing import Any

from src.mcp_config_state import load_mcp_config_state, save_mcp_config_state


class JsonOnlyStateStore:
    """Fake the JSON boundary shared by independently scheduled replicas."""

    def __init__(self) -> None:
        self.documents: dict[str, str] = {}

    def save(
        self,
        *,
        key: str,
        value: Any,
        ttl_in_seconds: int,
    ) -> None:
        assert ttl_in_seconds == 24 * 3600
        self.documents[key] = json.dumps(value, sort_keys=True)

    def load(self, *, key: str, default: Any = None) -> Any:
        document = self.documents.get(key)
        return json.loads(document) if document is not None else default


def test_mcp_config_state_round_trips_allowed_tools_across_replicas() -> None:
    store = JsonOnlyStateStore()
    configs = {
        "browser": {"transport": "streamable_http", "url": "http://browser/mcp"},
        "workflow": {"transport": "stdio", "command": "workflow-mcp"},
    }

    # Replica one owns capability compilation, where allowlists are sets.
    save_mcp_config_state(
        store,
        key="mcpcfg_instance-1",
        configs=configs,
        allowed_tools_by_server={
            "browser": {"browser_screenshot", "browser_open"},
            "workflow": {"trace_get_browser_screenshot"},
        },
        ttl_in_seconds=24 * 3600,
    )

    persisted = json.loads(store.documents["mcpcfg_instance-1"])
    assert persisted["allowedTools"] == {
        "browser": ["browser_open", "browser_screenshot"],
        "workflow": ["trace_get_browser_screenshot"],
    }

    # Replica two has no process-local cache and hydrates only from JSON state.
    hydrated = load_mcp_config_state(store, key="mcpcfg_instance-1")

    assert hydrated is not None
    assert hydrated.configs == configs
    assert hydrated.allowed_tools_by_server == {
        "browser": {"browser_open", "browser_screenshot"},
        "workflow": {"trace_get_browser_screenshot"},
    }
    assert all(
        isinstance(tools, set)
        for tools in hydrated.allowed_tools_by_server.values()
    )


def test_mcp_config_state_rejects_invalid_config_documents() -> None:
    store = JsonOnlyStateStore()
    store.documents["mcpcfg_invalid"] = json.dumps(
        {"configs": {"browser": "not-an-object"}, "allowedTools": {}}
    )

    assert load_mcp_config_state(store, key="mcpcfg_missing") is None
    assert load_mcp_config_state(store, key="mcpcfg_invalid") is None
