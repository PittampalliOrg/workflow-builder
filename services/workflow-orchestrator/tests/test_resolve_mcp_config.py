from __future__ import annotations

import builtins
import importlib.util
import sys
import types
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
    requests_module.patch = lambda *_args, **_kwargs: None
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


class FailingPsycopg2:
    @staticmethod
    def connect(*_args, **_kwargs):
        raise AssertionError("psycopg2.connect should not be called")


def _block_psycopg2_imports(monkeypatch):
    original_import = builtins.__import__

    def guarded_import(name, *args, **kwargs):
        if name == "psycopg2" or name.startswith("psycopg2."):
            raise AssertionError("psycopg2 should not be imported")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded_import)
    monkeypatch.setitem(sys.modules, "psycopg2", FailingPsycopg2)


def test_delegates_contextual_resolution_to_workflow_data(monkeypatch):
    calls: list[dict] = []

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

    monkeypatch.setenv("WORKFLOW_DATA_API_MODE", "postgres")
    _block_psycopg2_imports(monkeypatch)
    monkeypatch.setattr(resolve_mcp_config, "workflow_data_client", FakeWorkflowDataClient())

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


def test_workflow_data_failure_does_not_fallback_to_postgres(monkeypatch):
    class FailingWorkflowDataClient:
        def resolve_mcp_config(self, *_args, **_kwargs):
            raise RuntimeError("workflow-data unavailable")

    _block_psycopg2_imports(monkeypatch)
    monkeypatch.setattr(resolve_mcp_config, "workflow_data_client", FailingWorkflowDataClient())

    for mode in ("http", "http-fallback-db", "postgres"):
        monkeypatch.setenv("WORKFLOW_DATA_API_MODE", mode)
        try:
            resolve_mcp_config.resolve_agent_mcp_servers(
                None,
                {
                    "projectId": "project-1",
                    "requestedServers": [{"pieceName": "github"}],
                },
            )
        except RuntimeError as exc:
            assert "workflow-data unavailable" in str(exc)
        else:
            raise AssertionError("workflow-data failure should surface")


def test_rejects_malformed_workflow_data_response(monkeypatch):
    class MalformedWorkflowDataClient:
        def resolve_mcp_config(self, *_args, **_kwargs):
            return {"warnings": ["missing servers"]}

    _block_psycopg2_imports(monkeypatch)
    monkeypatch.setattr(
        resolve_mcp_config,
        "workflow_data_client",
        MalformedWorkflowDataClient(),
    )

    try:
        resolve_mcp_config.resolve_agent_mcp_servers(
            None,
            {"projectId": "project-1"},
        )
    except RuntimeError as exc:
        assert "mcpServers" in str(exc)
    else:
        raise AssertionError("malformed workflow-data response should fail")


def test_keeps_direct_stdio_server_without_database(monkeypatch):
    class FailingWorkflowDataClient:
        def resolve_mcp_config(self, *_args, **_kwargs):
            raise AssertionError("workflow-data should not be called without context")

    _block_psycopg2_imports(monkeypatch)
    monkeypatch.setattr(resolve_mcp_config, "workflow_data_client", FailingWorkflowDataClient())

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


def test_qualifies_direct_nimble_service_url_for_cross_namespace_agents(monkeypatch):
    class FailingWorkflowDataClient:
        def resolve_mcp_config(self, *_args, **_kwargs):
            raise AssertionError("workflow-data should not be called without context")

    _block_psycopg2_imports(monkeypatch)
    monkeypatch.setattr(resolve_mcp_config, "workflow_data_client", FailingWorkflowDataClient())

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
                "url": "http://ap-microsoft-onedrive-service.workflow-builder.svc.cluster.local/mcp?tools=list_files%2Clist_folders",
                "allowedTools": ["list_files", "list_folders"],
            }
        ],
        "warnings": [],
    }


def test_drops_profile_servers_without_workflow_or_project_context(monkeypatch):
    class FailingWorkflowDataClient:
        def resolve_mcp_config(self, *_args, **_kwargs):
            raise AssertionError("workflow-data should not be called without context")

    _block_psycopg2_imports(monkeypatch)
    monkeypatch.setattr(resolve_mcp_config, "workflow_data_client", FailingWorkflowDataClient())

    result = resolve_mcp_config.resolve_agent_mcp_servers(
        None,
        {
            "requestedServers": [
                {
                    "server_name": "piece_github",
                    "pieceName": "github",
                    "allowedTools": ["create_issue"],
                }
            ],
        },
    )

    assert result == {"mcpServers": [], "warnings": []}
