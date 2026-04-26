from __future__ import annotations

import sys
import types
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

if "requests" not in sys.modules:
    requests_module = types.ModuleType("requests")
    requests_module.get = lambda *_args, **_kwargs: None
    sys.modules["requests"] = requests_module

if "psycopg2" not in sys.modules:
    psycopg2_module = types.ModuleType("psycopg2")
    psycopg2_module.connect = lambda *_args, **_kwargs: None
    extras_module = types.ModuleType("psycopg2.extras")
    extras_module.RealDictCursor = object
    sys.modules["psycopg2"] = psycopg2_module
    sys.modules["psycopg2.extras"] = extras_module

MODULE_PATH = ROOT / "activities" / "resolve_mcp_config.py"
SPEC = importlib.util.spec_from_file_location("resolve_mcp_config", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module from {MODULE_PATH}")
resolve_mcp_config = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(resolve_mcp_config)


class FakeCursor:
    def __init__(self, rows):
        self.rows = rows
        self.result = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def execute(self, query, _params=None):
        if "from mcp_connection" in query:
            self.result = self.rows
        else:
            self.result = []

    def fetchone(self):
        return self.result[0] if self.result else None

    def fetchall(self):
        return self.result


class FakeConnection:
    def __init__(self, rows):
        self.rows = rows

    def cursor(self, **_kwargs):
        return FakeCursor(self.rows)

    def close(self):
        return None


def test_resolves_logical_profile_server_to_project_connection(monkeypatch):
    rows = [
        {
            "id": "mcp_1",
            "project_id": "default",
            "source_type": "nimble_piece",
            "piece_name": "github",
            "server_key": None,
            "connection_external_id": "conn_1",
            "display_name": "GitHub",
            "registry_ref": None,
            "server_url": "http://piece-mcp-server/mcp",
            "metadata": {"transport": "streamable_http", "allowedTools": ["old_tool"]},
        }
    ]
    monkeypatch.setattr(resolve_mcp_config, "_get_database_url", lambda: "postgres://test")
    monkeypatch.setattr(
        resolve_mcp_config.psycopg2,
        "connect",
        lambda _url: FakeConnection(rows),
    )

    result = resolve_mcp_config.resolve_agent_mcp_servers(
        None,
        {
            "projectId": "default",
            "requestedServers": [
                {
                    "server_name": "piece_github",
                    "pieceName": "github",
                    "allowedTools": ["list_repositories"],
                }
            ],
        },
    )

    assert result["warnings"] == []
    assert result["mcpServers"] == [
        {
            "server_name": "piece_github",
            "displayName": "GitHub",
            "sourceType": "nimble_piece",
            "pieceName": "github",
            "connectionExternalId": "conn_1",
            "transport": "streamable_http",
            "url": "http://piece-mcp-server.workflow-builder.svc.cluster.local/mcp",
            "headers": {"X-Connection-External-Id": "conn_1"},
            "allowedTools": ["list_repositories"],
        }
    ]


def test_keeps_direct_stdio_server_without_database():
    result = resolve_mcp_config.resolve_agent_mcp_servers(
        None,
        {
            "requestedServers": [
                {
                    "server_name": "playwright",
                    "transport": "stdio",
                    "command": "npx",
                    "args": ["@playwright/mcp@latest"],
                    "allowedTools": ["browser_navigate"],
                }
            ],
        },
    )

    assert result == {
        "mcpServers": [
            {
                "server_name": "playwright",
                "transport": "stdio",
                "command": "npx",
                "args": ["@playwright/mcp@latest"],
                "allowedTools": ["browser_navigate"],
            }
        ],
        "warnings": [],
    }


def test_qualifies_direct_nimble_service_url_for_cross_namespace_agents():
    result = resolve_mcp_config.resolve_agent_mcp_servers(
        None,
        {
            "requestedServers": [
                {
                    "server_name": "piece_microsoft_onedrive",
                    "sourceType": "nimble_piece",
                    "registryRef": "ap-microsoft-onedrive-service",
                    "transport": "streamable_http",
                    "url": "http://ap-microsoft-onedrive-service:3100/mcp",
                    "allowedTools": ["list_files", "list_folders"],
                }
            ],
        },
    )

    assert result == {
        "mcpServers": [
            {
                "server_name": "piece_microsoft_onedrive",
                "sourceType": "nimble_piece",
                "registryRef": "ap-microsoft-onedrive-service",
                "transport": "streamable_http",
                "url": "http://ap-microsoft-onedrive-service.workflow-builder.svc.cluster.local:3100/mcp",
                "allowedTools": ["list_files", "list_folders"],
            }
        ],
        "warnings": [],
    }
