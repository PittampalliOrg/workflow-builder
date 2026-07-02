from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

try:
    requests_spec = importlib.util.find_spec("requests")
except ValueError:
    requests_spec = None

if requests_spec is None:
    requests_stub = types.ModuleType("requests")
    requests_stub.get = lambda *_args, **_kwargs: None
    requests_stub.post = lambda *_args, **_kwargs: None
    requests_stub.patch = lambda *_args, **_kwargs: None
    requests_stub.Session = lambda: types.SimpleNamespace(
        request=lambda *_args, **_kwargs: None
    )
    requests_stub.exceptions = types.SimpleNamespace(RequestException=Exception)
    sys.modules["requests"] = requests_stub

activities_pkg = types.ModuleType("activities")
activities_pkg.__path__ = [str(ROOT / "activities")]
sys.modules["activities"] = activities_pkg
workflow_data_spec = importlib.util.spec_from_file_location(
    "activities.workflow_data_client",
    ROOT / "activities" / "workflow_data_client.py",
)
assert workflow_data_spec is not None and workflow_data_spec.loader is not None
workflow_data_module = importlib.util.module_from_spec(workflow_data_spec)
sys.modules["activities.workflow_data_client"] = workflow_data_module
workflow_data_spec.loader.exec_module(workflow_data_module)


def _load_activity(name: str):
    path = ROOT / "activities" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"{name}_migration_tests", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


track_agent_run = _load_activity("track_agent_run")
persist_plan_artifact = _load_activity("persist_plan_artifact")
finalizer = _load_activity("finalize_otel_trace_root")


class FailingPsycopg2:
    @staticmethod
    def connect(*_args, **_kwargs):
        raise AssertionError("psycopg2.connect should not be called in strict http mode")


def test_track_agent_run_strict_http_uses_workflow_data_client(monkeypatch):
    calls: list[dict] = []

    class FakeWorkflowDataClient:
        def schedule_agent_run(self, payload):
            calls.append(payload)
            return {"ok": True, "id": payload["id"]}

    monkeypatch.setenv("WORKFLOW_DATA_API_MODE", "http")
    monkeypatch.setitem(sys.modules, "psycopg2", FailingPsycopg2)
    monkeypatch.setattr(track_agent_run, "workflow_data_client", FakeWorkflowDataClient())
    monkeypatch.setattr(
        track_agent_run,
        "_get_database_url",
        lambda: (_ for _ in ()).throw(AssertionError("database URL should not be fetched")),
    )

    result = track_agent_run.track_agent_run_scheduled(
        None,
        {
            "id": "agent-run-1",
            "workflowExecutionId": "exec-1",
            "workflowId": "wf-1",
            "nodeId": "agent",
            "mode": "run",
            "agentWorkflowId": "agent-run-1",
            "daprInstanceId": "agent-run-1",
            "parentExecutionId": "parent-1",
        },
    )

    assert result == {"success": True, "id": "agent-run-1"}
    assert calls == [
        {
            "id": "agent-run-1",
            "workflowExecutionId": "exec-1",
            "workflowId": "wf-1",
            "nodeId": "agent",
            "mode": "run",
            "agentWorkflowId": "agent-run-1",
            "daprInstanceId": "agent-run-1",
            "parentExecutionId": "parent-1",
            "workspaceRef": None,
            "artifactRef": None,
        }
    ]


def test_persist_plan_artifact_strict_http_uses_workflow_data_client(monkeypatch):
    calls: list[dict] = []

    class FakeWorkflowDataClient:
        def upsert_plan_artifact(self, payload):
            calls.append(payload)
            return {
                "artifactRef": payload["artifactRef"],
                "storageBackend": "workflow_plan_artifacts",
                "artifactType": payload["artifactType"],
                "status": payload["status"],
            }

    monkeypatch.setenv("WORKFLOW_DATA_API_MODE", "http")
    monkeypatch.setitem(sys.modules, "psycopg2", FailingPsycopg2)
    monkeypatch.setattr(persist_plan_artifact, "workflow_data_client", FakeWorkflowDataClient())
    monkeypatch.setattr(
        persist_plan_artifact,
        "_get_database_url",
        lambda: (_ for _ in ()).throw(AssertionError("database URL should not be fetched")),
    )

    result = persist_plan_artifact.persist_plan_artifact(
        None,
        {
            "artifactRef": "plan-1",
            "dbExecutionId": "exec-1",
            "workflowId": "wf-1",
            "nodeId": "agent",
            "goal": "ship it",
            "sourcePrompt": "ship it",
            "planJson": {"steps": []},
            "status": "draft",
        },
    )

    assert result == {
        "success": True,
        "artifactRef": "plan-1",
        "storageBackend": "workflow_plan_artifacts",
        "artifactType": "claude_task_graph_v1",
        "status": "draft",
    }
    assert calls[0]["workflowExecutionId"] == "exec-1"
    assert calls[0]["planJson"] == {"steps": []}


def test_trace_lineage_strict_http_uses_workflow_data_client(monkeypatch):
    recorded: list[dict] = []

    class FakeWorkflowDataClient:
        def get_trace_targets(self, execution_id):
            assert execution_id == "exec-1"
            return [
                {
                    "entityType": "workflow_execution",
                    "entityId": "exec-1",
                    "projectId": "project-1",
                    "externalExperimentId": "exp-1",
                    "externalRunId": "run-1",
                }
            ]

        def upsert_trace_lineage(self, payload):
            recorded.append(payload)
            return {"recorded": 1}

    monkeypatch.setenv("WORKFLOW_DATA_API_MODE", "http")
    monkeypatch.setitem(sys.modules, "psycopg2", FailingPsycopg2)
    monkeypatch.setattr(finalizer, "workflow_data_client", FakeWorkflowDataClient())

    targets = finalizer._fetch_trace_targets("exec-1")
    finalizer._record_lineage_links(
        trace_id="1234567890abcdef1234567890abcdef",
        targets=targets,
        source="primary",
        attrs={"service.name": "workflow-orchestrator"},
    )

    assert targets == [
        {
            "entity_type": "workflow_execution",
            "entity_id": "exec-1",
            "project_id": "project-1",
            "external_experiment_id": "exp-1",
            "external_run_id": "run-1",
        }
    ]
    assert recorded == [
        {
            "traceId": "1234567890abcdef1234567890abcdef",
            "targets": [
                {
                    "entityType": "workflow_execution",
                    "entityId": "exec-1",
                    "projectId": "project-1",
                    "externalExperimentId": "exp-1",
                    "externalRunId": "run-1",
                }
            ],
            "source": "primary",
            "attrs": {"service.name": "workflow-orchestrator"},
        }
    ]


def test_trace_target_fetch_falls_back_to_postgres_in_fallback_mode(monkeypatch):
    class FailingWorkflowDataClient:
        def get_trace_targets(self, _execution_id):
            raise RuntimeError("workflow-data unavailable")

    class FakeCursor:
        def __init__(self):
            self.query_count = 0

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def execute(self, *_args):
            self.query_count += 1

        def fetchone(self):
            return ("exec-1", "project-1", "exp-1", "run-1")

        def fetchall(self):
            return [("session-1", "project-1", "exp-2", "run-2")]

    class FakeConnection:
        def __init__(self):
            self.cursor_obj = FakeCursor()

        def cursor(self):
            return self.cursor_obj

        def close(self):
            pass

    monkeypatch.setenv("WORKFLOW_DATA_API_MODE", "http-fallback-db")
    monkeypatch.setenv("DATABASE_URL", "postgres://unit-test")
    monkeypatch.setattr(finalizer, "workflow_data_client", FailingWorkflowDataClient())
    monkeypatch.setitem(
        sys.modules,
        "psycopg2",
        types.SimpleNamespace(connect=lambda *_args, **_kwargs: FakeConnection()),
    )
    monkeypatch.setattr(finalizer, "_database_url", None)

    assert finalizer._fetch_trace_targets("exec-1") == [
        {
            "entity_type": "workflow_execution",
            "entity_id": "exec-1",
            "project_id": "project-1",
            "external_experiment_id": "exp-1",
            "external_run_id": "run-1",
        },
        {
            "entity_type": "session",
            "entity_id": "session-1",
            "project_id": "project-1",
            "external_experiment_id": "exp-2",
            "external_run_id": "run-2",
        },
    ]
