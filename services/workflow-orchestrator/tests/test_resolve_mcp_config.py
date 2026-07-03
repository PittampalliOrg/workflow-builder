from __future__ import annotations

import builtins
import sys
import types
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

if "activities" not in sys.modules:
    activities_module = types.ModuleType("activities")
    activities_module.__path__ = [str(ROOT / "activities")]
    sys.modules["activities"] = activities_module

if "requests" not in sys.modules:
    requests_module = types.ModuleType("requests")
    requests_module.get = lambda *_args, **_kwargs: None
    requests_module.post = lambda *_args, **_kwargs: None
    requests_module.request = lambda *_args, **_kwargs: None
    requests_module.Session = lambda *_args, **_kwargs: types.SimpleNamespace(
        request=lambda *_req_args, **_req_kwargs: None
    )
    requests_module.exceptions = types.SimpleNamespace(RequestException=Exception)
    sys.modules["requests"] = requests_module

MODULE_PATH = ROOT / "activities" / "resolve_mcp_config.py"
SPEC = importlib.util.spec_from_file_location("resolve_mcp_config", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module from {MODULE_PATH}")
resolve_mcp_config = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(resolve_mcp_config)


def _block_psycopg2_imports(monkeypatch):
    original_import = builtins.__import__

    def guarded_import(name, *args, **kwargs):
        if name == "psycopg2" or name.startswith("psycopg2."):
            raise AssertionError(
                "psycopg2 should not be imported in strict http mode"
            )
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded_import)


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


class FakeResponse:
    def __init__(self, payload, status_code=200):
        self.payload = payload
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self.payload


def test_prefers_workflow_data_api_when_configured(monkeypatch):
    calls = []

    class FakeWorkflowDataClient:
        def resolve_mcp_config(self, payload):
            calls.append(payload)
            return {
                "mcpServers": [
                    {
                        "server_name": "piece_github",
                        "url": "http://ap-github-service.workflow-builder.svc.cluster.local/mcp",
                    }
                ],
                "warnings": ["resolved through workflow-data"],
            }

    def fail_connect(_url):
        raise AssertionError("Postgres should not be used when workflow-data resolves")

    monkeypatch.setenv("WORKFLOW_DATA_API_MODE", "http")
    _block_psycopg2_imports(monkeypatch)
    monkeypatch.setattr(resolve_mcp_config, "workflow_data_client", FakeWorkflowDataClient())
    monkeypatch.setattr(resolve_mcp_config, "_connect_postgres", fail_connect)

    result = resolve_mcp_config.resolve_agent_mcp_servers(
        None,
        {
            "workflowId": "wf-1",
            "projectId": "project-1",
            "requestedServers": [{"pieceName": "github"}],
            "includeProjectConnections": True,
        },
    )

    assert result == {
        "mcpServers": [
            {
                "server_name": "piece_github",
                "url": "http://ap-github-service.workflow-builder.svc.cluster.local/mcp",
            }
        ],
        "warnings": ["resolved through workflow-data"],
    }
    assert calls == [
        {
            "workflowId": "wf-1",
            "projectId": "project-1",
            "requestedServers": [{"pieceName": "github"}],
            "includeProjectConnections": True,
        }
    ]


def test_workflow_data_api_falls_back_to_postgres_by_default(monkeypatch):
    rows = [
        {
            "id": "mcp_gh",
            "project_id": "default",
            "source_type": "nimble_piece",
            "piece_name": "github",
            "server_key": None,
            "connection_external_id": "conn_gh",
            "display_name": "GitHub",
            "registry_ref": "ap-github-service",
            "server_url": "http://ap-github-service:3100/mcp",
            "metadata": {"transport": "streamable_http"},
        }
    ]

    monkeypatch.setenv("WORKFLOW_DATA_API_MODE", "http-fallback-db")
    monkeypatch.setattr(
        resolve_mcp_config,
        "workflow_data_client",
        types.SimpleNamespace(
            resolve_mcp_config=lambda *_args, **_kwargs: (_ for _ in ()).throw(
                RuntimeError("api down")
            )
        ),
    )
    monkeypatch.setattr(resolve_mcp_config, "_get_database_url", lambda: "postgres://test")
    monkeypatch.setattr(
        resolve_mcp_config,
        "_connect_postgres",
        lambda _url: FakeConnection(rows),
    )

    result = resolve_mcp_config.resolve_agent_mcp_servers(
        None,
        {
            "projectId": "default",
            "requestedServers": [{"pieceName": "github"}],
        },
    )

    assert result["warnings"] == []
    assert result["mcpServers"][0]["pieceName"] == "github"
    assert (
        result["mcpServers"][0]["url"]
        == "http://ap-github-service.workflow-builder.svc.cluster.local/mcp"
    )


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
        resolve_mcp_config,
        "_connect_postgres",
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
            # per-agent allowedTools now reaches the piece server's ?tools=
            "url": "http://piece-mcp-server.workflow-builder.svc.cluster.local/mcp?tools=list_repositories",
            "headers": {"X-Connection-External-Id": "conn_1"},
            "allowedTools": ["list_repositories"],
        }
    ]


def test_narrows_piece_tools_to_project_ceiling_agent_intersection(monkeypatch):
    rows = [
        {
            "id": "mcp_gh",
            "project_id": "default",
            "source_type": "nimble_piece",
            "piece_name": "github",
            "server_key": None,
            "connection_external_id": "conn_gh",
            "display_name": "GitHub",
            "registry_ref": "ap-github-service",
            "server_url": "http://ap-github-service:3100/mcp",
            # project ceiling
            "metadata": {
                "transport": "streamable_http",
                "toolSelection": {"tools": ["create_issue", "find_issue", "find_user"]},
            },
        }
    ]
    monkeypatch.setattr(resolve_mcp_config, "_get_database_url", lambda: "postgres://test")
    monkeypatch.setattr(
        resolve_mcp_config, "_connect_postgres", lambda _url: FakeConnection(rows)
    )

    # agent narrows to two; delete_branch is outside the ceiling -> dropped
    result = resolve_mcp_config.resolve_agent_mcp_servers(
        None,
        {
            "projectId": "default",
            "requestedServers": [
                {
                    "pieceName": "github",
                    "allowedTools": ["create_issue", "delete_branch"],
                }
            ],
        },
    )

    server = result["mcpServers"][0]
    assert (
        server["url"]
        == "http://ap-github-service.workflow-builder.svc.cluster.local/mcp?tools=create_issue"
    )
    assert server["allowedTools"] == ["create_issue"]


def test_carries_project_ceiling_when_agent_does_not_narrow(monkeypatch):
    rows = [
        {
            "id": "mcp_gh",
            "project_id": "default",
            "source_type": "nimble_piece",
            "piece_name": "github",
            "server_key": None,
            "connection_external_id": "conn_gh",
            "display_name": "GitHub",
            "registry_ref": "ap-github-service",
            "server_url": "http://ap-github-service:3100/mcp",
            "metadata": {"toolSelection": {"tools": ["create_issue", "find_issue"]}},
        }
    ]
    monkeypatch.setattr(resolve_mcp_config, "_get_database_url", lambda: "postgres://test")
    monkeypatch.setattr(
        resolve_mcp_config, "_connect_postgres", lambda _url: FakeConnection(rows)
    )

    # project mode, no per-agent narrowing -> full ceiling on the URL
    result = resolve_mcp_config.resolve_agent_mcp_servers(
        None,
        {"projectId": "default", "includeProjectConnections": True},
    )

    server = result["mcpServers"][0]
    assert (
        server["url"]
        == "http://ap-github-service.workflow-builder.svc.cluster.local/mcp?tools=create_issue%2Cfind_issue"
    )


def test_matches_piece_descriptor_by_piece_name_not_source_type(monkeypatch):
    rows = [
        {
            "id": "mcp_excel",
            "project_id": "default",
            "source_type": "nimble_piece",
            "piece_name": "microsoft-excel-365",
            "server_key": None,
            "connection_external_id": "conn_excel",
            "display_name": "Microsoft Excel 365",
            "registry_ref": "ap-microsoft-excel-365-service",
            "server_url": "http://ap-microsoft-excel-365-service:3100/mcp",
            "metadata": {"transport": "streamable_http"},
        },
        {
            "id": "mcp_outlook",
            "project_id": "default",
            "source_type": "nimble_piece",
            "piece_name": "microsoft-outlook",
            "server_key": None,
            "connection_external_id": "conn_outlook",
            "display_name": "Microsoft Outlook",
            "registry_ref": "ap-microsoft-outlook-service",
            "server_url": "http://ap-microsoft-outlook-service:3100/mcp",
            "metadata": {"transport": "streamable_http"},
        },
    ]
    monkeypatch.setattr(resolve_mcp_config, "_get_database_url", lambda: "postgres://test")
    monkeypatch.setattr(
        resolve_mcp_config,
        "_connect_postgres",
        lambda _url: FakeConnection(rows),
    )

    result = resolve_mcp_config.resolve_agent_mcp_servers(
        None,
        {
            "projectId": "default",
            "requestedServers": [
                {
                    "server_name": "piece_microsoft-outlook",
                    "sourceType": "nimble_piece",
                    "pieceName": "microsoft-outlook",
                }
            ],
        },
    )

    assert result["warnings"] == []
    assert result["mcpServers"][0]["pieceName"] == "microsoft-outlook"
    assert result["mcpServers"][0]["connectionExternalId"] == "conn_outlook"
    assert (
        result["mcpServers"][0]["url"]
        == "http://ap-microsoft-outlook-service.workflow-builder.svc.cluster.local/mcp"
    )


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
                # direct-endpoint piece server: per-agent allowlist reaches ?tools=
                "url": "http://ap-microsoft-onedrive-service.workflow-builder.svc.cluster.local/mcp?tools=list_files%2Clist_folders",
                "allowedTools": ["list_files", "list_folders"],
            }
        ],
        "warnings": [],
    }


def test_resolves_hosted_workflow_connection_with_project_token(monkeypatch):
    rows = [
        {
            "id": "mcp_hosted",
            "project_id": "project-1",
            "source_type": "hosted_workflow",
            "piece_name": None,
            "server_key": "workflow-tools",
            "connection_external_id": None,
            "display_name": "Workflow Tools",
            "registry_ref": "mcp-gateway",
            "server_url": "",
            "metadata": {
                "transport": "streamable_http",
                "endpointPath": "/api/v1/projects/:projectId/mcp-server/http",
            },
        }
    ]
    monkeypatch.setattr(resolve_mcp_config, "_get_database_url", lambda: "postgres://test")
    monkeypatch.setattr(resolve_mcp_config, "_hosted_mcp_token", lambda project_id: f"token:{project_id}")
    monkeypatch.setattr(
        resolve_mcp_config,
        "_connect_postgres",
        lambda _url: FakeConnection(rows),
    )

    result = resolve_mcp_config.resolve_agent_mcp_servers(
        None,
        {"projectId": "project-1", "includeProjectConnections": True},
    )

    assert result == {
        "mcpServers": [
            {
                "server_name": "hosted_workflow-tools",
                "displayName": "Workflow Tools",
                "sourceType": "hosted_workflow",
                "transport": "streamable_http",
                "url": "http://mcp-gateway:8080/api/v1/projects/project-1/mcp-server/http",
                "headers": {"Authorization": "Bearer token:project-1"},
            }
        ],
        "warnings": [],
    }
