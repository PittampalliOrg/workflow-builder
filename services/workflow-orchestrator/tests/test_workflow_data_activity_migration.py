from __future__ import annotations

import builtins
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

try:
    dapr_workflow_spec = importlib.util.find_spec("dapr.ext.workflow")
except (ImportError, ModuleNotFoundError, ValueError):
    dapr_workflow_spec = None

if dapr_workflow_spec is None:
    dapr_stub = types.ModuleType("dapr")
    dapr_ext_stub = types.ModuleType("dapr.ext")
    dapr_workflow_stub = types.ModuleType("dapr.ext.workflow")

    class DaprWorkflowClient:
        def __init__(self, *_args, **_kwargs):
            return None

        def raise_workflow_event(self, *_args, **_kwargs):
            return None

    dapr_workflow_stub.WorkflowActivityContext = object
    dapr_workflow_stub.DaprWorkflowClient = DaprWorkflowClient
    dapr_ext_stub.workflow = dapr_workflow_stub
    dapr_stub.ext = dapr_ext_stub
    sys.modules["dapr"] = dapr_stub
    sys.modules["dapr.ext"] = dapr_ext_stub
    sys.modules["dapr.ext.workflow"] = dapr_workflow_stub

try:
    dapr_clients_spec = importlib.util.find_spec("dapr.clients")
except (ImportError, ModuleNotFoundError, ValueError):
    dapr_clients_spec = None

if dapr_clients_spec is None:
    dapr_clients_stub = types.ModuleType("dapr.clients")

    class DaprClient:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def publish_event(self, **_kwargs):
            return None

    dapr_clients_stub.DaprClient = DaprClient
    sys.modules["dapr.clients"] = dapr_clients_stub
    if "dapr" in sys.modules:
        setattr(sys.modules["dapr"], "clients", dapr_clients_stub)

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
    spec = importlib.util.spec_from_file_location(f"activities.{name}_migration_tests", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


track_agent_run = _load_activity("track_agent_run")
persist_plan_artifact = _load_activity("persist_plan_artifact")
finalizer = _load_activity("finalize_otel_trace_root")
log_node_execution = _load_activity("log_node_execution")
fetch_child_workflow = _load_activity("fetch_child_workflow")
persist_workspace_session = _load_activity("persist_workspace_session")
register_resumable_workspace = _load_activity("register_resumable_workspace")
publish_event = _load_activity("publish_event")
persist_results = _load_activity("persist_results_to_db")


class FailingPsycopg2:
    @staticmethod
    def connect(*_args, **_kwargs):
        raise AssertionError("psycopg2.connect should not be called in strict http mode")


def _block_psycopg2_imports(monkeypatch):
    original_import = builtins.__import__

    def guarded_import(name, *args, **kwargs):
        if name == "psycopg2" or name.startswith("psycopg2."):
            raise AssertionError(
                "psycopg2 should not be imported in strict http mode"
            )
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded_import)


def _fail_database_url():
    raise AssertionError("database URL should not be fetched")


def test_track_agent_run_strict_http_uses_workflow_data_client(monkeypatch):
    calls: list[dict] = []

    class FakeWorkflowDataClient:
        def schedule_agent_run(self, payload):
            calls.append(payload)
            return {"ok": True, "id": payload["id"]}

    monkeypatch.setenv("WORKFLOW_DATA_API_MODE", "http")
    _block_psycopg2_imports(monkeypatch)
    monkeypatch.setitem(sys.modules, "psycopg2", FailingPsycopg2)
    monkeypatch.setattr(track_agent_run, "workflow_data_client", FakeWorkflowDataClient())

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


def test_track_agent_run_lifecycle_strict_http_uses_workflow_data_client(monkeypatch):
    calls: list[tuple[str, dict]] = []

    class FakeWorkflowDataClient:
        def update_agent_run(self, run_id, payload):
            calls.append((run_id, payload))
            return {"ok": True, "id": run_id}

    monkeypatch.setenv("WORKFLOW_DATA_API_MODE", "http")
    _block_psycopg2_imports(monkeypatch)
    monkeypatch.setitem(sys.modules, "psycopg2", FailingPsycopg2)
    monkeypatch.setattr(track_agent_run, "workflow_data_client", FakeWorkflowDataClient())

    running = track_agent_run.track_agent_run_running(
        None,
        {"id": "agent-run-1", "result": {"phase": "thinking"}},
    )
    completed = track_agent_run.track_agent_run_completed(
        None,
        {
            "id": "agent-run-1",
            "success": True,
            "result": {"content": "done", "workspaceRef": "workspace-1"},
            "eventPublished": True,
        },
    )

    assert running == {"success": True, "id": "agent-run-1", "status": "running"}
    assert completed == {"success": True, "id": "agent-run-1", "status": "completed"}
    assert calls == [
        ("agent-run-1", {"status": "running", "result": {"phase": "thinking"}}),
        (
            "agent-run-1",
            {
                "status": "completed",
                "result": {"content": "done", "workspaceRef": "workspace-1"},
                "error": None,
                "workspaceRef": "workspace-1",
                "eventPublished": True,
            },
        ),
    ]


def test_track_agent_run_lifecycle_strict_http_failure_does_not_fallback(monkeypatch):
    class FailingWorkflowDataClient:
        def update_agent_run(self, *_args, **_kwargs):
            raise RuntimeError("workflow-data unavailable")

    monkeypatch.setenv("WORKFLOW_DATA_API_MODE", "http")
    _block_psycopg2_imports(monkeypatch)
    monkeypatch.setitem(sys.modules, "psycopg2", FailingPsycopg2)
    monkeypatch.setattr(track_agent_run, "workflow_data_client", FailingWorkflowDataClient())

    running = track_agent_run.track_agent_run_running(
        None,
        {"id": "agent-run-1", "result": {"phase": "thinking"}},
    )
    completed = track_agent_run.track_agent_run_completed(
        None,
        {"id": "agent-run-1", "success": False, "error": "failed"},
    )

    assert running["success"] is False
    assert "workflow-data unavailable" in running["error"]
    assert completed["success"] is False
    assert "workflow-data unavailable" in completed["error"]


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
    _block_psycopg2_imports(monkeypatch)
    monkeypatch.setitem(sys.modules, "psycopg2", FailingPsycopg2)
    monkeypatch.setattr(persist_plan_artifact, "workflow_data_client", FakeWorkflowDataClient())

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


def test_plan_artifact_update_and_fetch_strict_http_use_workflow_data_client(monkeypatch):
    calls: list[tuple[str, str | None, dict | None]] = []

    class FakeWorkflowDataClient:
        def update_plan_artifact(self, artifact_ref, payload):
            calls.append(("update", artifact_ref, payload))
            return {"artifactRef": artifact_ref, "status": payload["status"]}

        def get_plan_artifact(self, artifact_ref):
            calls.append(("get", artifact_ref, None))
            return {
                "artifactRef": artifact_ref,
                "status": "ready",
                "goal": "ship it",
                "planJson": {"steps": []},
                "planMarkdown": "## Plan",
                "metadata": {"reviewed": True},
                "workspaceRef": "workspace-1",
                "clonePath": "/repo",
            }

    monkeypatch.setenv("WORKFLOW_DATA_API_MODE", "http")
    _block_psycopg2_imports(monkeypatch)
    monkeypatch.setitem(sys.modules, "psycopg2", FailingPsycopg2)
    monkeypatch.setattr(persist_plan_artifact, "workflow_data_client", FakeWorkflowDataClient())

    updated = persist_plan_artifact.update_plan_artifact_status(
        None,
        {
            "artifactRef": "plan-1",
            "status": "ready",
            "metadata": {"reviewed": True},
        },
    )
    fetched = persist_plan_artifact.fetch_plan_artifact(
        None,
        {"artifactRef": "plan-1"},
    )

    assert updated == {"success": True, "artifactRef": "plan-1", "status": "ready"}
    assert fetched == {
        "success": True,
        "artifactRef": "plan-1",
        "status": "ready",
        "goal": "ship it",
        "planJson": {"steps": []},
        "planMarkdown": "## Plan",
        "metadata": {"reviewed": True},
        "workspaceRef": "workspace-1",
        "clonePath": "/repo",
    }
    assert calls == [
        ("update", "plan-1", {"status": "ready", "metadata": {"reviewed": True}}),
        ("get", "plan-1", None),
    ]


def test_plan_artifact_update_and_fetch_strict_http_failure_does_not_fallback(monkeypatch):
    class FailingWorkflowDataClient:
        def update_plan_artifact(self, *_args, **_kwargs):
            raise RuntimeError("workflow-data unavailable")

        def get_plan_artifact(self, *_args, **_kwargs):
            raise RuntimeError("workflow-data unavailable")

    monkeypatch.setenv("WORKFLOW_DATA_API_MODE", "http")
    _block_psycopg2_imports(monkeypatch)
    monkeypatch.setitem(sys.modules, "psycopg2", FailingPsycopg2)
    monkeypatch.setattr(persist_plan_artifact, "workflow_data_client", FailingWorkflowDataClient())

    updated = persist_plan_artifact.update_plan_artifact_status(
        None,
        {"artifactRef": "plan-1", "status": "ready"},
    )
    fetched = persist_plan_artifact.fetch_plan_artifact(
        None,
        {"artifactRef": "plan-1"},
    )

    assert updated["success"] is False
    assert "workflow-data unavailable" in updated["error"]
    assert fetched["success"] is False
    assert "workflow-data unavailable" in fetched["error"]


def test_fetch_child_workflow_strict_http_failure_does_not_fallback(monkeypatch):
    class FailingWorkflowDataClient:
        def get_workflow(self, *_args, **_kwargs):
            raise RuntimeError("workflow-data unavailable")

    monkeypatch.setenv("WORKFLOW_DATA_API_MODE", "http")
    _block_psycopg2_imports(monkeypatch)
    monkeypatch.setitem(sys.modules, "psycopg2", FailingPsycopg2)
    monkeypatch.setattr(fetch_child_workflow, "workflow_data_client", FailingWorkflowDataClient())

    try:
        fetch_child_workflow._fetch_workflow("wf-child")
    except RuntimeError as exc:
        assert "workflow-data unavailable" in str(exc)
    else:
        raise AssertionError("strict child workflow fetch should surface workflow-data failure")


def test_fetch_child_workflow_fallback_mode_does_not_call_postgres(monkeypatch):
    class FailingWorkflowDataClient:
        def get_workflow(self, *_args, **_kwargs):
            raise RuntimeError("workflow-data unavailable")

    monkeypatch.setenv("WORKFLOW_DATA_API_MODE", "http-fallback-db")
    _block_psycopg2_imports(monkeypatch)
    monkeypatch.setitem(sys.modules, "psycopg2", FailingPsycopg2)
    monkeypatch.setattr(fetch_child_workflow, "workflow_data_client", FailingWorkflowDataClient())

    try:
        fetch_child_workflow._fetch_workflow("wf-child")
    except RuntimeError as exc:
        assert "workflow-data unavailable" in str(exc)
    else:
        raise AssertionError("child workflow fetch should surface workflow-data failure")


def test_log_node_execution_strict_http_uses_workflow_data_client(monkeypatch):
    calls: list[tuple[str, dict]] = []

    class FakeWorkflowDataClient:
        def append_execution_log(self, execution_id, payload):
            calls.append((f"append:{execution_id}", payload))
            return {"log": {"id": payload["id"]}}

        def patch_execution(self, execution_id, payload):
            calls.append((f"patch:{execution_id}", payload))
            return {"ok": True}

        def update_execution_log(self, execution_id, log_id, payload):
            calls.append((f"update:{execution_id}:{log_id}", payload))
            return {"log": {"id": log_id}}

    monkeypatch.setenv("WORKFLOW_DATA_API_MODE", "http")
    _block_psycopg2_imports(monkeypatch)
    monkeypatch.setitem(sys.modules, "psycopg2", FailingPsycopg2)
    monkeypatch.setattr(log_node_execution, "workflow_data_client", FakeWorkflowDataClient())

    start = log_node_execution.log_node_start(
        None,
        {
            "executionId": "exec-1",
            "nodeId": "agent",
            "nodeName": "Agent",
            "nodeType": "action",
            "actionType": "durable/run",
            "input": {"prompt": "ship it"},
        },
    )
    update = log_node_execution.update_execution_node(
        None,
        {"executionId": "exec-1", "nodeId": "agent", "nodeName": "Agent"},
    )
    complete = log_node_execution.log_node_complete(
        None,
        {
            "executionId": "exec-1",
            "logId": start["logId"],
            "status": "success",
            "output": {"content": "done"},
            "durationMs": 42,
        },
    )

    assert start["success"] is True
    assert update == {"success": True}
    assert complete == {"success": True}
    assert [name for name, _payload in calls] == [
        "append:exec-1",
        "patch:exec-1",
        f"update:exec-1:{start['logId']}",
    ]
    assert calls[0][1]["activityName"] == "durable/run"
    assert calls[1][1] == {"currentNodeId": "agent", "currentNodeName": "Agent"}
    assert calls[2][1]["duration"] == "42"


def test_log_node_execution_strict_http_failure_does_not_fallback(monkeypatch):
    class FailingWorkflowDataClient:
        def append_execution_log(self, *_args, **_kwargs):
            raise RuntimeError("workflow-data unavailable")

    monkeypatch.setenv("WORKFLOW_DATA_API_MODE", "http")
    _block_psycopg2_imports(monkeypatch)
    monkeypatch.setitem(sys.modules, "psycopg2", FailingPsycopg2)
    monkeypatch.setattr(log_node_execution, "workflow_data_client", FailingWorkflowDataClient())

    result = log_node_execution.log_node_start(
        None,
        {
            "executionId": "exec-1",
            "nodeId": "agent",
            "nodeName": "Agent",
            "nodeType": "action",
            "actionType": "durable/run",
        },
    )

    assert result["success"] is False
    assert "workflow-data unavailable" in result["error"]


def test_log_node_execution_fallback_mode_does_not_call_postgres(monkeypatch):
    class FailingWorkflowDataClient:
        def append_execution_log(self, *_args, **_kwargs):
            raise RuntimeError("workflow-data unavailable")

        def patch_execution(self, *_args, **_kwargs):
            raise RuntimeError("workflow-data unavailable")

        def update_execution_log(self, *_args, **_kwargs):
            raise RuntimeError("workflow-data unavailable")

    monkeypatch.setenv("WORKFLOW_DATA_API_MODE", "http-fallback-db")
    _block_psycopg2_imports(monkeypatch)
    monkeypatch.setitem(sys.modules, "psycopg2", FailingPsycopg2)
    monkeypatch.setattr(log_node_execution, "workflow_data_client", FailingWorkflowDataClient())

    start = log_node_execution.log_node_start(
        None,
        {
            "executionId": "exec-1",
            "nodeId": "agent",
            "nodeName": "Agent",
            "nodeType": "action",
            "actionType": "durable/run",
        },
    )
    update = log_node_execution.update_execution_node(
        None,
        {"executionId": "exec-1", "nodeId": "agent", "nodeName": "Agent"},
    )
    complete = log_node_execution.log_node_complete(
        None,
        {"executionId": "exec-1", "logId": "log-1", "status": "success"},
    )

    assert start["success"] is False
    assert update["success"] is False
    assert complete["success"] is False
    assert "workflow-data unavailable" in start["error"]
    assert "workflow-data unavailable" in update["error"]
    assert "workflow-data unavailable" in complete["error"]


def test_persist_workspace_session_strict_http_uses_workflow_data_client(monkeypatch):
    calls: list[dict] = []

    class FakeWorkflowDataClient:
        def upsert_workspace_session(self, payload):
            calls.append(payload)
            return {"ok": True}

    monkeypatch.setenv("WORKFLOW_DATA_API_MODE", "http")
    _block_psycopg2_imports(monkeypatch)
    monkeypatch.setitem(sys.modules, "psycopg2", FailingPsycopg2)
    monkeypatch.setattr(
        persist_workspace_session,
        "workflow_data_client",
        FakeWorkflowDataClient(),
    )

    result = persist_workspace_session.persist_workspace_session(
        None,
        {
            "workflowExecutionId": "exec-1",
            "actionType": "workspace/profile",
            "keepAfterRun": True,
            "taskName": "workspace_profile",
            "result": {
                "success": True,
                "data": {
                    "workspaceRef": "ws-1",
                    "rootPath": "/sandbox",
                    "backend": "openshell",
                    "enabledTools": ["shell"],
                    "sandbox": {
                        "details": {
                            "sandboxName": "ws-1",
                            "executionId": "exec-1",
                            "template": "dapr-agent",
                        }
                    },
                },
            },
        },
    )

    assert result == {"success": True, "workspace_ref": "ws-1"}
    assert calls == [
        {
            "workspaceRef": "ws-1",
            "workflowExecutionId": "exec-1",
            "name": "workspace_profile",
            "rootPath": "/sandbox",
            "backend": "openshell",
            "enabledTools": ["shell"],
            "status": "active",
            "sandboxState": {
                "backend": "openshell",
                "details": {
                    "template": "dapr-agent",
                    "sandboxId": None,
                    "sandboxName": "ws-1",
                    "executionId": "exec-1",
                    "rootPath": "/sandbox",
                    "workspaceRef": "ws-1",
                    "image": None,
                    "provider": None,
                },
                "rootPath": "/sandbox",
                "workingDirectory": "/sandbox",
                "keepAfterRun": True,
            },
        }
    ]


def test_register_resumable_workspace_strict_http_uses_workflow_data_client(monkeypatch):
    calls: list[dict] = []

    class FakeWorkflowDataClient:
        def upsert_workspace_session(self, payload):
            calls.append(payload)
            return {"ok": True}

    monkeypatch.setenv("WORKFLOW_DATA_API_MODE", "http")
    _block_psycopg2_imports(monkeypatch)
    monkeypatch.setitem(sys.modules, "psycopg2", FailingPsycopg2)
    monkeypatch.setattr(
        register_resumable_workspace,
        "workflow_data_client",
        FakeWorkflowDataClient(),
    )

    result = register_resumable_workspace.register_resumable_workspace(
        None,
        {"workspaceRef": "resumable-1", "dbExecutionId": "exec-1"},
    )

    assert result == {"success": True, "workspace_ref": "resumable-1"}
    assert calls == [
        {
            "workspaceRef": "resumable-1",
            "workflowExecutionId": "exec-1",
            "name": "exec-1",
            "rootPath": "/sandbox/work",
            "backend": "juicefs",
            "enabledTools": [],
            "status": "active",
            "sandboxState": {},
        }
    ]


def test_workspace_session_upserts_do_not_fallback_to_postgres_in_fallback_mode(monkeypatch):
    class FailingWorkflowDataClient:
        def upsert_workspace_session(self, *_args, **_kwargs):
            raise RuntimeError("workflow-data unavailable")

    monkeypatch.setenv("WORKFLOW_DATA_API_MODE", "http-fallback-db")
    _block_psycopg2_imports(monkeypatch)
    monkeypatch.setitem(sys.modules, "psycopg2", FailingPsycopg2)
    monkeypatch.setattr(
        persist_workspace_session,
        "workflow_data_client",
        FailingWorkflowDataClient(),
    )
    monkeypatch.setattr(
        register_resumable_workspace,
        "workflow_data_client",
        FailingWorkflowDataClient(),
    )

    persisted = persist_workspace_session.persist_workspace_session(
        None,
        {
            "workflowExecutionId": "exec-1",
            "actionType": "workspace/profile",
            "keepAfterRun": True,
            "result": {"workspaceRef": "ws-1", "rootPath": "/sandbox"},
        },
    )
    registered = register_resumable_workspace.register_resumable_workspace(
        None,
        {"workspaceRef": "resumable-1", "dbExecutionId": "exec-1"},
    )

    assert persisted["success"] is False
    assert "workflow-data unavailable" in persisted["error"]
    assert registered["success"] is False
    assert "workflow-data unavailable" in registered["error"]


def test_publish_phase_persist_uses_workflow_data_without_postgres_fallback(monkeypatch):
    calls: list[tuple[str, dict]] = []

    class FakeWorkflowDataClient:
        def patch_execution(self, execution_id, payload):
            calls.append((execution_id, payload))
            return {"ok": True}

    monkeypatch.setenv("WORKFLOW_DATA_API_MODE", "http-fallback-db")
    _block_psycopg2_imports(monkeypatch)
    monkeypatch.setitem(sys.modules, "psycopg2", FailingPsycopg2)
    monkeypatch.setattr(publish_event, "workflow_data_client", FakeWorkflowDataClient())

    publish_event._persist_execution_phase("exec-1", "running", 42)

    assert calls == [("exec-1", {"phase": "running", "progress": 42})]


def test_publish_phase_persist_failure_does_not_fallback_to_postgres(monkeypatch):
    class FailingWorkflowDataClient:
        def patch_execution(self, *_args, **_kwargs):
            raise RuntimeError("workflow-data unavailable")

    monkeypatch.setenv("WORKFLOW_DATA_API_MODE", "http-fallback-db")
    _block_psycopg2_imports(monkeypatch)
    monkeypatch.setitem(sys.modules, "psycopg2", FailingPsycopg2)
    monkeypatch.setattr(publish_event, "workflow_data_client", FailingWorkflowDataClient())

    try:
        publish_event._persist_execution_phase("exec-1", "running", 42)
    except RuntimeError as exc:
        assert "workflow-data unavailable" in str(exc)
    else:
        raise AssertionError("workflow-data failure should surface without Postgres fallback")


def test_persist_results_failure_does_not_fallback_to_postgres(monkeypatch):
    class FailingWorkflowDataClient:
        def get_execution(self, *_args, **_kwargs):
            raise RuntimeError("workflow-data unavailable")

        def patch_execution(self, *_args, **_kwargs):
            raise AssertionError("patch should not be called after get failure")

    _block_psycopg2_imports(monkeypatch)
    monkeypatch.setitem(sys.modules, "psycopg2", FailingPsycopg2)
    monkeypatch.setattr(persist_results, "workflow_data_client", FailingWorkflowDataClient())

    for mode in ("http-fallback-db", "postgres"):
        monkeypatch.setenv("WORKFLOW_DATA_API_MODE", mode)
        result = persist_results.persist_results_to_db(
            None,
            {
                "dbExecutionId": f"exec-{mode}",
                "outputs": {},
                "success": True,
                "durationMs": 10,
            },
        )

        assert result["success"] is False
        assert "workflow-data unavailable" in result["error"]


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
    _block_psycopg2_imports(monkeypatch)
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


def test_trace_target_fetch_does_not_fallback_to_postgres_in_fallback_mode(monkeypatch):
    class FailingWorkflowDataClient:
        def get_trace_targets(self, _execution_id):
            raise RuntimeError("workflow-data unavailable")

    monkeypatch.setenv("WORKFLOW_DATA_API_MODE", "http-fallback-db")
    _block_psycopg2_imports(monkeypatch)
    monkeypatch.setattr(finalizer, "workflow_data_client", FailingWorkflowDataClient())
    monkeypatch.setitem(sys.modules, "psycopg2", FailingPsycopg2)

    assert finalizer._fetch_trace_targets("exec-1") == []


# ---------------------------------------------------------------------------
# Wire-contract section: the shared fixtures in
# services/shared/workflow-data-contract/fixtures drive an HTTP stub under
# WorkflowDataClient and pin method + path + body + parsed return for every
# endpoint. The same fixtures are replayed against the SvelteKit route
# handlers by src/routes/api/internal/workflow-data/workflow-data-contract.test.ts.
# Contract rules (additive-only) live in the fixture directory's README.
# ---------------------------------------------------------------------------

import json as json_module

import pytest

CONTRACT_FIXTURE_DIR = ROOT.parent / "shared" / "workflow-data-contract" / "fixtures"


class _FixtureHttpStub:
    """requests.Session stand-in that records the wire request and replays
    the fixture's responseBody."""

    def __init__(self, fixture: dict):
        self._fixture = fixture
        self.calls: list[dict] = []

    def request(self, method, url, headers=None, json=None, timeout=None):
        self.calls.append(
            {"method": method, "url": url, "headers": headers or {}, "json": json}
        )
        return types.SimpleNamespace(
            status_code=200,
            json=lambda: self._fixture["responseBody"],
            text="",
        )


_CONTRACT_CALLS = {
    "get-workflow": lambda c, f: c.get_workflow(
        f["pathParams"]["workflowRef"], by=f["queryParams"]["by"]
    ),
    "get-execution": lambda c, f: c.get_execution(f["pathParams"]["executionId"]),
    "read-model-ready": lambda c, _f: c.assert_execution_read_model_ready(),
    "get-execution-by-instance": lambda c, f: c.get_execution_by_instance(
        f["pathParams"]["instanceId"]
    ),
    "create-execution": lambda c, f: c.create_execution(f["requestBody"]),
    "get-live-execution-instance": lambda c, f: c.get_live_execution_instance(
        f["pathParams"]["executionId"]
    ),
    "attach-scheduler-instance": lambda c, f: c.attach_execution_scheduler_instance(
        f["pathParams"]["executionId"], f["requestBody"]
    ),
    "mark-start-failed": lambda c, f: c.mark_execution_start_failed(
        f["pathParams"]["executionId"], f["requestBody"]["error"]
    ),
    "list-stale-executions": lambda c, f: c.list_stale_running_executions(
        int(f["queryParams"]["staleOlderThanMinutes"])
    ),
    "patch-execution": lambda c, f: c.patch_execution(
        f["pathParams"]["executionId"], f["requestBody"]
    ),
    "append-execution-log": lambda c, f: c.append_execution_log(
        f["pathParams"]["executionId"], f["requestBody"]
    ),
    "update-execution-log": lambda c, f: c.update_execution_log(
        f["pathParams"]["executionId"], f["pathParams"]["logId"], f["requestBody"]
    ),
    "upsert-workflow-artifact": lambda c, f: c.upsert_workflow_artifact(
        f["pathParams"]["executionId"], f["requestBody"]
    ),
    "upsert-workspace-session": lambda c, f: c.upsert_workspace_session(f["requestBody"]),
    "resolve-mcp-config": lambda c, f: c.resolve_mcp_config(f["requestBody"]),
    "schedule-agent-run": lambda c, f: c.schedule_agent_run(f["requestBody"]),
    "update-agent-run": lambda c, f: c.update_agent_run(
        f["pathParams"]["runId"], f["requestBody"]
    ),
    "upsert-plan-artifact": lambda c, f: c.upsert_plan_artifact(f["requestBody"]),
    "update-plan-artifact": lambda c, f: c.update_plan_artifact(
        f["pathParams"]["artifactRef"], f["requestBody"]
    ),
    "get-plan-artifact": lambda c, f: c.get_plan_artifact(f["pathParams"]["artifactRef"]),
    "get-trace-targets": lambda c, f: c.get_trace_targets(f["pathParams"]["executionId"]),
    "upsert-trace-lineage": lambda c, f: c.upsert_trace_lineage(f["requestBody"]),
}

_CONTRACT_RETURNS = {
    "get-workflow": lambda f: f["responseBody"]["workflow"],
    "get-execution": lambda f: f["responseBody"]["execution"],
    "read-model-ready": lambda _f: None,
    "get-execution-by-instance": lambda f: f["responseBody"]["execution"],
    "get-live-execution-instance": lambda f: f["responseBody"]["instance"],
    "list-stale-executions": lambda f: f["responseBody"]["executions"],
    "get-plan-artifact": lambda f: f["responseBody"]["artifact"],
    "get-trace-targets": lambda f: f["responseBody"]["targets"],
}


def _contract_fixture_paths() -> list[Path]:
    return sorted(CONTRACT_FIXTURE_DIR.glob("*.json"))


def test_contract_fixture_coverage_is_exhaustive():
    fixture_names = {path.stem for path in _contract_fixture_paths()}
    assert fixture_names, f"no contract fixtures found in {CONTRACT_FIXTURE_DIR}"
    assert fixture_names == set(_CONTRACT_CALLS), (
        "contract fixtures and client-call mappings drifted apart; "
        "update _CONTRACT_CALLS alongside the fixture directory"
    )


@pytest.mark.parametrize(
    "fixture_path", _contract_fixture_paths(), ids=lambda path: path.stem
)
def test_workflow_data_client_matches_wire_contract(monkeypatch, fixture_path):
    fixture = json_module.loads(fixture_path.read_text())
    monkeypatch.setenv("INTERNAL_API_TOKEN", "token-1")
    monkeypatch.setenv("WORKFLOW_DATA_API_TRANSPORT", "direct")
    monkeypatch.setenv("WORKFLOW_BUILDER_URL", "http://workflow-builder.test")

    client = workflow_data_module.WorkflowDataClient()
    stub = _FixtureHttpStub(fixture)
    client._session = stub

    result = _CONTRACT_CALLS[fixture_path.stem](client, fixture)

    assert len(stub.calls) == 1
    call = stub.calls[0]
    assert call["method"] == fixture["method"]
    assert call["url"] == f"http://workflow-builder.test{fixture['path']}"
    assert call["json"] == fixture["requestBody"]
    assert call["headers"]["X-Internal-Token"] == "token-1"

    expected = _CONTRACT_RETURNS.get(fixture_path.stem, lambda f: f["responseBody"])(fixture)
    assert result == expected
