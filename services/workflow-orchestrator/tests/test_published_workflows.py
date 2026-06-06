from __future__ import annotations

import base64
import contextlib
import importlib.util
import json
import sys
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

if "grpc" not in sys.modules:
    grpc_module = types.ModuleType("grpc")
    grpc_module.Channel = object
    grpc_module.insecure_channel = lambda *_args, **_kwargs: object()
    sys.modules["grpc"] = grpc_module

if "httpx" not in sys.modules:
    httpx_module = types.ModuleType("httpx")
    httpx_module.AsyncClient = object
    sys.modules["httpx"] = httpx_module

if "requests" not in sys.modules:
    requests_module = types.ModuleType("requests")
    requests_module.get = lambda *_args, **_kwargs: None
    requests_module.post = lambda *_args, **_kwargs: None
    requests_module.request = lambda *_args, **_kwargs: None
    requests_module.exceptions = types.SimpleNamespace(RequestException=Exception)
    sys.modules["requests"] = requests_module

if "durabletask.internal.orchestrator_service_pb2" not in sys.modules:
    durabletask_module = types.ModuleType("durabletask")
    internal_module = types.ModuleType("durabletask.internal")
    pb_module = types.ModuleType("durabletask.internal.orchestrator_service_pb2")
    pb_grpc_module = types.ModuleType("durabletask.internal.orchestrator_service_pb2_grpc")

    class _FakeCreateInstanceRequest:
        def __init__(self, **kwargs):
            self.instanceId = kwargs.get("instanceId")
            self.name = kwargs.get("name")
            self.input = kwargs.get("input")
            self.version = types.SimpleNamespace(CopyFrom=lambda *_args, **_kwargs: None)

    class _FakeGetInstanceRequest:
        def __init__(self, **kwargs):
            self.instanceId = kwargs.get("instanceId")
            self.getInputsAndOutputs = kwargs.get("getInputsAndOutputs")

    class _FakeRerunWorkflowFromEventRequest:
        def __init__(self, **kwargs):
            self.sourceInstanceID = kwargs.get("sourceInstanceID")
            self.eventID = kwargs.get("eventID")
            self.newInstanceID = kwargs.get("newInstanceID", "")
            self.overwriteInput = kwargs.get("overwriteInput", False)
            self.input = types.SimpleNamespace(
                value=None,
                CopyFrom=lambda value: setattr(self.input, "value", value.value),
            )

    class _FakeTaskHubSidecarServiceStub:
        def __init__(self, *_args, **_kwargs):
            return None

    pb_module.CreateInstanceRequest = _FakeCreateInstanceRequest
    pb_module.GetInstanceRequest = _FakeGetInstanceRequest
    pb_module.RerunWorkflowFromEventRequest = _FakeRerunWorkflowFromEventRequest
    pb_grpc_module.TaskHubSidecarServiceStub = _FakeTaskHubSidecarServiceStub

    sys.modules["durabletask"] = durabletask_module
    sys.modules["durabletask.internal"] = internal_module
    sys.modules["durabletask.internal.orchestrator_service_pb2"] = pb_module
    sys.modules["durabletask.internal.orchestrator_service_pb2_grpc"] = pb_grpc_module

if "dapr" not in sys.modules:
    dapr_module = types.ModuleType("dapr")
    ext_module = types.ModuleType("dapr.ext")
    workflow_module = types.ModuleType("dapr.ext.workflow")
    clients_module = types.ModuleType("dapr.clients")

    class _FakeWorkflowRuntime:
        def activity(self, _name=None, **_kwargs):
            def decorator(fn):
                return fn

            return decorator

        def workflow(self, _name=None, **_kwargs):
            def decorator(fn):
                return fn

            return decorator

        def register_activity(self, *_args, **_kwargs):
            return None

        def register_versioned_workflow(self, *_args, **_kwargs):
            return None

        def start(self):
            return None

        def shutdown(self):
            return None

    class _FakeDaprWorkflowClient:
        def __init__(self, *_args, **_kwargs):
            return None

    class _FakeDaprClient:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def get_state(self, *_args, **_kwargs):
            return types.SimpleNamespace(data=None)

        def save_state(self, *_args, **_kwargs):
            return None

        def delete_state(self, *_args, **_kwargs):
            return None

        def publish_event(self, **_kwargs):
            return None

    workflow_module.WorkflowRuntime = _FakeWorkflowRuntime
    workflow_module.DaprWorkflowContext = object
    workflow_module.DaprWorkflowClient = _FakeDaprWorkflowClient
    workflow_module.when_any = lambda tasks: {"kind": "when_any", "tasks": tasks}
    clients_module.DaprClient = _FakeDaprClient

    sys.modules["dapr"] = dapr_module
    sys.modules["dapr.ext"] = ext_module
    sys.modules["dapr.ext.workflow"] = workflow_module
    sys.modules["dapr.clients"] = clients_module

if "fastapi" not in sys.modules:
    fastapi_module = types.ModuleType("fastapi")
    fastapi_middleware_module = types.ModuleType("fastapi.middleware")
    cors_module = types.ModuleType("fastapi.middleware.cors")
    encoders_module = types.ModuleType("fastapi.encoders")

    class _FakeHTTPException(Exception):
        def __init__(self, status_code: int, detail=None):
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail

    class _FakeFastAPI:
        def __init__(self, *_args, **_kwargs):
            return None

        def add_middleware(self, *_args, **_kwargs):
            return None

        def __getattr__(self, name):
            if name in {"get", "post", "delete", "put", "patch", "options"}:
                def route_decorator(*_args, **_kwargs):
                    def decorator(fn):
                        return fn

                    return decorator

                return route_decorator
            raise AttributeError(name)

    class _FakeRequest:
        headers = {}

    class _FakeCORSMiddleware:
        pass

    fastapi_module.FastAPI = _FakeFastAPI
    fastapi_module.HTTPException = _FakeHTTPException
    fastapi_module.Request = _FakeRequest
    cors_module.CORSMiddleware = _FakeCORSMiddleware
    encoders_module.jsonable_encoder = lambda value, **_kwargs: value

    sys.modules["fastapi"] = fastapi_module
    sys.modules["fastapi.middleware"] = fastapi_middleware_module
    sys.modules["fastapi.middleware.cors"] = cors_module
    sys.modules["fastapi.encoders"] = encoders_module

if "pydantic" not in sys.modules:
    pydantic_module = types.ModuleType("pydantic")

    class _FakeBaseModel:
        def __init__(self, **kwargs):
            for key, value in kwargs.items():
                setattr(self, key, value)

    def _fake_field(default=None, **_kwargs):
        return default

    pydantic_module.BaseModel = _FakeBaseModel
    pydantic_module.Field = _fake_field
    sys.modules["pydantic"] = pydantic_module

if "google.protobuf.wrappers_pb2" not in sys.modules:
    google_module = types.ModuleType("google")
    protobuf_module = types.ModuleType("google.protobuf")
    wrappers_module = types.ModuleType("google.protobuf.wrappers_pb2")

    class _FakeStringValue:
        def __init__(self, value=None):
            self.value = value

    wrappers_module.StringValue = _FakeStringValue

    sys.modules["google"] = google_module
    sys.modules["google.protobuf"] = protobuf_module
    sys.modules["google.protobuf.wrappers_pb2"] = wrappers_module

if "celpy" not in sys.modules:
    celpy_module = types.ModuleType("celpy")
    celpy_adapter_module = types.ModuleType("celpy.adapter")

    class _FakeProgram:
        def evaluate(self, _activation):
            return False

    class _FakeEnvironment:
        def compile(self, expression):
            return expression

        def program(self, _ast):
            return _FakeProgram()

    celpy_module.Environment = _FakeEnvironment
    celpy_adapter_module.json_to_cel = lambda value: value

    sys.modules["celpy"] = celpy_module
    sys.modules["celpy.adapter"] = celpy_adapter_module

if "psycopg2" not in sys.modules:
    psycopg2_module = types.ModuleType("psycopg2")
    psycopg2_module.connect = lambda *_args, **_kwargs: None
    sys.modules["psycopg2"] = psycopg2_module


def _load_module(name: str, relative_path: str):
    module_path = ROOT / relative_path
    spec = importlib.util.spec_from_file_location(name, module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load module from {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


APP = _load_module("workflow_orchestrator_app", "app.py")
SW_WORKFLOW = _load_module(
    "workflow_orchestrator_sw_workflow", "workflows/sw_workflow.py"
)
SPAWN_SESSION = _load_module(
    "workflow_orchestrator_spawn_session", "activities/spawn_session.py"
)
PERSIST_RESULTS = _load_module(
    "workflow_orchestrator_persist_results", "activities/persist_results_to_db.py"
)


class _FakeWorkflowTask:
    def __init__(self, kind, result=None, **attrs):
        self.kind = kind
        self.result = result
        for key, value in attrs.items():
            setattr(self, key, value)

    def get_result(self):
        return self.result


class _FakeTerminalWorkflowCtx:
    instance_id = "parent-terminal-wf-1"
    is_replaying = True

    def __init__(self):
        self.statuses = []

    def set_custom_status(self, status):
        self.statuses.append(status)

    def call_activity(self, activity, input=None):
        return {
            "kind": "call_activity",
            "activity": getattr(activity, "__name__", str(activity)),
            "input": input,
        }


def _minimal_sw_workflow(tasks=None):
    return {
        "document": {
            "dsl": "1.0.0",
            "namespace": "test",
            "name": "test-workflow",
            "version": "0.1.0",
        },
        "do": tasks or [],
    }


def _terminal_workflow_input(tasks=None):
    trace_id = "1234567890abcdef1234567890abcdef"
    return {
        "workflow": _minimal_sw_workflow(tasks),
        "workflowId": "wf_test",
        "triggerData": {},
        "dbExecutionId": "db_exec_123",
        "_otel": {"traceId": trace_id},
    }


def _install_terminal_workflow_model_fakes(monkeypatch):
    class _FakeDocument:
        def __init__(self, data):
            self.name = data.get("name") or "test-workflow"

    class _FakeWorkflow:
        def __init__(self, data):
            self._data = data
            self.document = _FakeDocument(data.get("document") or {})
            self.input = None
            self.output = None
            self.use = None
            self.do = data.get("do") or []

        def unwrap_tasks(self):
            return [
                (name, task_data)
                for item in self.do
                for name, task_data in item.items()
            ]

        def model_dump(self, **_kwargs):
            return self._data

    class _WorkflowModel:
        @classmethod
        def model_validate(cls, data):
            if not isinstance(data, dict) or "do" not in data:
                raise ValueError("Invalid workflow document")
            return _FakeWorkflow(data)

    class _WorkflowOutputModel:
        def __init__(
            self,
            *,
            success,
            outputs=None,
            workflowOutput=None,
            error=None,
            duration_ms=0,
            phase="completed",
            **_kwargs,
        ):
            self.payload = {
                "success": success,
                "outputs": outputs or {},
                "workflowOutput": workflowOutput,
                "error": error,
                "durationMs": duration_ms,
                "phase": phase,
            }

        def model_dump(self, **_kwargs):
            return dict(self.payload)

    monkeypatch.setattr(SW_WORKFLOW, "Workflow", _WorkflowModel)
    monkeypatch.setattr(SW_WORKFLOW, "SWWorkflowOutput", _WorkflowOutputModel)


def test_extract_published_revisions_reads_latest_revision_snapshot():
    workflow_row = {
        "id": "wf_123",
        "name": "Published Workflow",
        "nodes": [],
        "edges": [],
        "specVersion": "workflow-spec/v1",
        "daprWorkflowName": "wf_wf_123",
        "spec": {
            "metadata": {
                "publishedRuntime": {
                    "status": "published",
                    "workflowName": "wf_wf_123",
                    "latestVersion": "pub_2",
                    "publishedAt": "2026-03-29T12:00:00Z",
                    "revisions": [
                        {
                            "version": "pub_1",
                            "publishedAt": "2026-03-29T11:00:00Z",
                            "definition": {"id": "wf_123", "name": "v1"},
                        },
                        {
                            "version": "pub_2",
                            "publishedAt": "2026-03-29T12:00:00Z",
                            "definition": {"id": "wf_123", "name": "v2"},
                        },
                    ],
                }
            }
        },
    }

    workflow_name, latest_version, revisions = APP._extract_published_revisions(
        workflow_row
    )

    assert workflow_name == "wf_wf_123"
    assert latest_version == "pub_2"
    assert [revision["version"] for revision in revisions] == ["pub_1", "pub_2"]
    assert revisions[-1]["definition"]["name"] == "v2"


def test_legacy_execution_routes_are_not_registered():
    assert not hasattr(APP, "_resolve_execution_target")
    assert not hasattr(APP, "start_workflow")
    assert not hasattr(APP, "execute_workflow_by_id")
    assert not hasattr(APP, "start_ap_workflow")


def test_workflow_failure_details_from_history_supports_dapr_camel_case():
    error, stack_trace = APP._workflow_failure_details_from_history(
        [
            {
                "eventType": "ExecutionCompleted",
                "raw": {
                    "orchestrationStatus": "ORCHESTRATION_STATUS_FAILED",
                    "failureDetails": {
                        "errorType": "NonDeterminismError",
                        "errorMessage": "A previous execution called call_activity with ID=5",
                        "stackTrace": "durabletask stack",
                    },
                },
            }
        ]
    )

    assert error == "A previous execution called call_activity with ID=5"
    assert stack_trace == "durabletask stack"


def test_idempotent_schedule_returns_existing_pending_before_start(monkeypatch):
    calls: list[str] = []

    class FakeClient:
        def get_workflow_state(self, *, instance_id, fetch_payloads):
            calls.append(f"get:{instance_id}:{fetch_payloads}")
            return types.SimpleNamespace(runtime_status="WORKFLOWSTATUS.PENDING")

        def purge_workflow(self, *, instance_id):
            calls.append(f"purge:{instance_id}")

    monkeypatch.setattr(APP, "get_workflow_client", lambda: FakeClient())
    monkeypatch.setattr(
        APP,
        "_schedule_new_workflow_instance",
        lambda **_kwargs: calls.append("start") or "new-instance",
    )

    result = APP._idempotent_schedule(
        workflow_name="sw_workflow_v1",
        instance_id="instance-1",
        workflow_input={"ok": True},
    )

    assert result == "instance-1"
    assert calls == ["get:instance-1:False"]


def test_idempotent_schedule_purges_terminal_before_start(monkeypatch):
    calls: list[str] = []

    class FakeClient:
        def get_workflow_state(self, *, instance_id, fetch_payloads):
            calls.append(f"get:{instance_id}:{fetch_payloads}")
            return types.SimpleNamespace(runtime_status="ORCHESTRATION_STATUS_FAILED")

        def purge_workflow(self, *, instance_id):
            calls.append(f"purge:{instance_id}")

    monkeypatch.setattr(APP, "get_workflow_client", lambda: FakeClient())
    monkeypatch.setattr(
        APP,
        "_schedule_new_workflow_instance",
        lambda **_kwargs: calls.append("start") or "new-instance",
    )

    result = APP._idempotent_schedule(
        workflow_name="sw_workflow_v1",
        instance_id="instance-1",
        workflow_input={"ok": True},
    )

    assert result == "new-instance"
    assert calls == ["get:instance-1:False", "purge:instance-1", "start"]


def test_terminate_workflow_requests_parent_before_legacy_child_cleanup(monkeypatch):
    calls: list[str] = []

    def fake_workflow_post(instance_id: str, suffix: str):
        calls.append(f"parent:{instance_id}:{suffix}")

    def fake_child_cleanup(parent_execution_id: str, **_kwargs):
        calls.append(f"legacy-child:{parent_execution_id}")
        return {"success": True}

    def fake_client_terminate(_client, instance_id: str, _timeout_seconds: int):
        calls.append(f"client:{instance_id}")

    monkeypatch.setattr(APP, "_workflow_http_post", fake_workflow_post)
    monkeypatch.setattr(APP, "_terminate_workflow_with_timeout", fake_client_terminate)
    monkeypatch.setattr(
        APP,
        "terminate_durable_runs_by_parent_execution",
        fake_child_cleanup,
    )

    result = APP.terminate_workflow(
        "instance-1",
        APP.TerminateRequest(reason="operator cleanup"),
    )

    assert calls == [
        "parent:instance-1:/terminate",
        "client:instance-1",
        "legacy-child:instance-1",
    ]
    assert result["parentTerminationRequested"] is True
    assert result["clientTerminationRequested"] is True
    assert result["nativeChildCascade"] is True
    assert result["childTermination"] == {"success": True}


def test_terminate_workflow_reports_status_unknown_for_transient_parent_error(
    monkeypatch,
):
    calls: list[str] = []

    def fake_workflow_post(_instance_id: str, _suffix: str):
        calls.append("parent")
        raise RuntimeError("Dapr workflow terminate failed with HTTP 503: busy")

    def fake_child_cleanup(parent_execution_id: str, **_kwargs):
        calls.append(f"legacy-child:{parent_execution_id}")
        return {"success": True}

    def fake_client_terminate(_client, instance_id: str, _timeout_seconds: int):
        calls.append(f"client:{instance_id}")

    monkeypatch.setattr(APP, "_workflow_http_post", fake_workflow_post)
    monkeypatch.setattr(APP, "_terminate_workflow_with_timeout", fake_client_terminate)
    monkeypatch.setattr(
        APP,
        "terminate_durable_runs_by_parent_execution",
        fake_child_cleanup,
    )

    result = APP.terminate_workflow("instance-1", APP.TerminateRequest())

    assert calls == ["parent", "client:instance-1", "legacy-child:instance-1"]
    assert result["parentTerminationRequested"] is True
    assert result["clientTerminationRequested"] is True
    assert result["terminationStatusUnknown"] is True


def test_terminate_workflow_keeps_status_unknown_when_client_fallback_times_out(
    monkeypatch,
):
    calls: list[str] = []

    def fake_workflow_post(_instance_id: str, _suffix: str):
        calls.append("parent")

    def fake_client_terminate(_client, instance_id: str, _timeout_seconds: int):
        calls.append(f"client:{instance_id}")
        raise TimeoutError("still running")

    def fake_child_cleanup(parent_execution_id: str, **_kwargs):
        calls.append(f"legacy-child:{parent_execution_id}")
        return {"success": True}

    monkeypatch.setattr(APP, "_workflow_http_post", fake_workflow_post)
    monkeypatch.setattr(APP, "_terminate_workflow_with_timeout", fake_client_terminate)
    monkeypatch.setattr(
        APP,
        "terminate_durable_runs_by_parent_execution",
        fake_child_cleanup,
    )

    result = APP.terminate_workflow("instance-1", APP.TerminateRequest())

    assert calls == ["parent", "client:instance-1", "legacy-child:instance-1"]
    assert result["parentTerminationRequested"] is True
    assert result["clientTerminationRequested"] is True
    assert result["terminationStatusUnknown"] is True


def test_delete_workflow_actor_reminders_rejects_non_new_event_names():
    with pytest.raises(APP.HTTPException) as exc:
        APP.delete_workflow_actor_reminders(
            "instance-1",
            APP.ReminderDeleteRequest(reminderNames=["delete-all"]),
        )

    assert exc.value.status_code == 400


def test_delete_workflow_actor_reminders_rejects_mismatched_actor_id():
    with pytest.raises(APP.HTTPException) as exc:
        APP.delete_workflow_actor_reminders(
            "instance-1",
            APP.ReminderDeleteRequest(
                actorId="instance-2",
                reminderNames=["new-event-abc"],
            ),
        )

    assert exc.value.status_code == 400


def test_delete_workflow_actor_reminders_calls_actor_reminder_delete(monkeypatch):
    calls: list[str] = []

    class FakeResponse:
        ok = True
        status_code = 204
        text = ""

    def fake_delete(url: str, **_kwargs):
        calls.append(url)
        return FakeResponse()

    monkeypatch.setattr(APP.requests, "delete", fake_delete, raising=False)

    result = APP.delete_workflow_actor_reminders(
        "instance-1",
        APP.ReminderDeleteRequest(
            reminderNames=["new-event-abc"],
            reason="operator recovery",
        ),
    )

    assert result["deleted"] == ["new-event-abc"]
    assert result["failed"] == []
    assert "/v1.0/actors/" in calls[0]
    assert "/instance-1/reminders/new-event-abc" in calls[0]


def test_existing_live_execution_instance_returns_running_dapr_id(monkeypatch):
    class FakeCursor:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def execute(self, *_args, **_kwargs):
            return None

        def fetchone(self):
            return ("running", "sw-instance-1")

    class FakeConnection:
        def cursor(self):
            return FakeCursor()

        def close(self):
            return None

    fake_psycopg2 = types.SimpleNamespace(connect=lambda _url: FakeConnection())
    monkeypatch.setitem(sys.modules, "psycopg2", fake_psycopg2)
    monkeypatch.setattr(APP, "_get_database_url", lambda: "postgres://test")

    assert APP._existing_live_execution_instance("exec-1") == "sw-instance-1"


def test_existing_live_execution_instance_ignores_terminal_rows(monkeypatch):
    class FakeCursor:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def execute(self, *_args, **_kwargs):
            return None

        def fetchone(self):
            return ("error", "sw-instance-1")

    class FakeConnection:
        def cursor(self):
            return FakeCursor()

        def close(self):
            return None

    fake_psycopg2 = types.SimpleNamespace(connect=lambda _url: FakeConnection())
    monkeypatch.setitem(sys.modules, "psycopg2", fake_psycopg2)
    monkeypatch.setattr(APP, "_get_database_url", lambda: "postgres://test")

    assert APP._existing_live_execution_instance("exec-1") is None


def test_readiness_requires_taskhub_and_metadata_worker_count(monkeypatch):
    observed_kwargs = {}

    def fake_runtime_status(*_args, **kwargs):
        observed_kwargs.update(kwargs)
        return True, {"workflowConnectedWorkers": 1}

    monkeypatch.setattr(APP, "_get_workflow_runtime_status", fake_runtime_status)

    response = APP.readiness_check()

    assert response["status"] == "ready"
    assert observed_kwargs.get("require_workflow_workers") is True


def test_health_is_process_local(monkeypatch):
    def fail_runtime_status(*_args, **_kwargs):
        raise AssertionError("liveness must not depend on Dapr workflow readiness")

    monkeypatch.setattr(APP, "_get_workflow_runtime_status", fail_runtime_status)

    response = APP.health_check()

    assert response["status"] == "healthy"
    assert response["service"] == "workflow-orchestrator"
    assert "runtimeStatus" not in response


def test_sw_workflow_trace_context_is_isolated_per_execution():
    parent_trace_id = "0" * 31 + "1"
    parent_span_id = "0" * 15 + "2"
    request = types.SimpleNamespace(
        headers={
            "traceparent": f"00-{parent_trace_id}-{parent_span_id}-01",
            "baggage": "caller.id=smoke",
        }
    )

    first = APP._merge_otel_context(request, isolate_trace=True)
    second = APP._merge_otel_context(request, isolate_trace=True)

    assert first["traceId"] != parent_trace_id
    assert second["traceId"] != parent_trace_id
    assert first["traceId"] != second["traceId"]
    assert first["parentTraceId"] == parent_trace_id
    assert second["parentTraceId"] == parent_trace_id
    assert first["baggage"] == "caller.id=smoke"


def test_workflow_activity_context_merges_baggage_without_overwriting_traceparent():
    from tracing import merge_workflow_activity_context

    carrier = {
        "traceparent": "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
        "tracestate": "vendor=value",
        "baggage": "caller.id=smoke",
    }

    merged = merge_workflow_activity_context(
        carrier,
        {
            "workflow.activity.correlation_id": "exec_1:node_a:0",
            "workflow.node.id": "node_a",
            "workflow.node.sequence": 0,
            "workflow.execution.id": "exec_1",
            "workflow.id": "wf_1",
            "session.id": "exec_1",
        },
    )

    assert merged["traceparent"] == carrier["traceparent"]
    assert merged["tracestate"] == "vendor=value"
    assert "caller.id=smoke" in merged["baggage"]
    assert "workflow.activity.correlation_id=exec_1:node_a:0" in merged["baggage"]
    assert "workflow.node.sequence=0" in merged["baggage"]


def test_execute_action_includes_otel_body_fallback(monkeypatch):
    execute_action_module = _load_module(
        "workflow_orchestrator_execute_action_test", "activities/execute_action.py"
    )
    captured = {}

    def fake_dapr_invoke(app_id, method, payload, **kwargs):
        captured["app_id"] = app_id
        captured["method"] = method
        captured["payload"] = payload
        captured["metadata"] = kwargs.get("metadata")
        return 200, {"success": True, "data": {"ok": True}}, "{}"

    monkeypatch.setattr(execute_action_module, "dapr_invoke", fake_dapr_invoke)

    result = execute_action_module.execute_action(
        None,
        {
            "node": {
                "id": "profile",
                "label": "Profile",
                "config": {
                    "actionType": "workspace/profile",
                    "input": {"workspaceRef": "ws-1"},
                },
            },
            "nodeOutputs": {},
            "executionId": "sw-test-exec",
            "workflowId": "wf-1",
            "dbExecutionId": "exec-1",
            "_otel": {
                "traceparent": "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
                "baggage": "workflow.activity.correlation_id=exec-1:profile:0",
                "workflow.activity.correlation_id": "exec-1:profile:0",
            },
        },
    )

    assert result["success"] is True
    assert captured["payload"]["_otel"]["workflow.activity.correlation_id"] == (
        "exec-1:profile:0"
    )
    assert captured["metadata"]["traceparent"].startswith("00-0af765")
    assert "workflow.activity.correlation_id=exec-1:profile:0" in captured["metadata"][
        "baggage"
    ]


def test_mark_workflow_execution_started_persists_primary_trace_id(monkeypatch):
    executed = {}

    class _Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def execute(self, sql, params):
            executed["sql"] = sql
            executed["params"] = params

    class _Connection:
        def cursor(self):
            return _Cursor()

        def commit(self):
            executed["committed"] = True

        def close(self):
            executed["closed"] = True

    monkeypatch.setattr(APP, "_get_database_url", lambda: "postgres://test")
    monkeypatch.setattr(
        sys.modules["psycopg2"],
        "connect",
        lambda *_args, **_kwargs: _Connection(),
    )

    APP._mark_workflow_execution_started(
        "db_exec_123",
        "sw-test-exec-db_exec_123",
        "1234567890abcdef1234567890abcdef",
    )

    assert "primary_trace_id = COALESCE(primary_trace_id, %s)" in executed["sql"]
    assert executed["params"] == (
        "sw-test-exec-db_exec_123",
        "running",
        0,
        "db_exec_123",
        "1234567890abcdef1234567890abcdef",
        "db_exec_123",
    )
    assert executed["committed"] is True


def test_persist_results_backfills_primary_trace_id_from_otel(monkeypatch):
    executed = []

    class _Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def execute(self, sql, params):
            executed.append((sql, params))

        def fetchone(self):
            return (datetime.now(timezone.utc),)

    class _Connection:
        def cursor(self):
            return _Cursor()

        def commit(self):
            return None

        def close(self):
            return None

    monkeypatch.setattr(PERSIST_RESULTS, "_get_database_url", lambda: "postgres://test")
    monkeypatch.setattr(
        sys.modules["psycopg2"],
        "connect",
        lambda *_args, **_kwargs: _Connection(),
    )

    result = PERSIST_RESULTS.persist_results_to_db(
        None,
        {
            "dbExecutionId": "db_exec_123",
            "executionId": "sw-test-exec-db_exec_123",
            "outputs": {},
            "success": True,
            "durationMs": 10,
            "_otel": {"traceId": "1234567890abcdef1234567890abcdef"},
        },
    )

    assert result["success"] is True
    update_sql, update_params = executed[-1]
    assert "primary_trace_id = COALESCE(primary_trace_id, %s)" in update_sql
    assert update_params[-2:] == (
        "1234567890abcdef1234567890abcdef",
        "db_exec_123",
    )


def test_mlflow_workflow_run_enrichment_logs_completion_projection(monkeypatch):
    json_artifacts = []
    binary_artifacts = []
    batches = []

    monkeypatch.setattr(PERSIST_RESULTS, "_mlflow_enabled", lambda: True)
    monkeypatch.setattr(
        PERSIST_RESULTS,
        "_fetch_browser_artifacts",
        lambda _db_url, _execution_id: [
            {
                "id": "bwf_test",
                "workflowId": "workflow_1",
                "nodeId": "browser_validate_capture",
                "workspaceRef": "workspace_1",
                "artifactType": "capture_flow_v1",
                "artifactVersion": 1,
                "status": "completed",
                "manifestJson": {
                    "assets": [
                        {
                            "kind": "screenshot",
                            "label": "Initial",
                            "storageRef": "workflow-browser-artifacts/exec/bwf_test/screenshot-1.png",
                            "contentType": "image/png",
                        },
                        {
                            "kind": "trace",
                            "label": "Trace",
                            "storageRef": "workflow-browser-artifacts/exec/bwf_test/trace-2.zip",
                            "contentType": "application/zip",
                        },
                    ],
                },
                "blobs": {
                    "workflow-browser-artifacts/exec/bwf_test/screenshot-1.png": {
                        "payloadBase64": base64.b64encode(b"png-bytes").decode(),
                        "contentType": "image/png",
                    },
                    "workflow-browser-artifacts/exec/bwf_test/trace-2.zip": {
                        "payloadBase64": base64.b64encode(b"zip-bytes").decode(),
                        "contentType": "application/zip",
                    },
                },
            }
        ],
    )
    monkeypatch.setattr(
        PERSIST_RESULTS,
        "_log_mlflow_json_artifact",
        lambda run_id, artifact_path, value: json_artifacts.append(
            (run_id, artifact_path, value)
        )
        or True,
    )
    monkeypatch.setattr(
        PERSIST_RESULTS,
        "_log_mlflow_artifact",
        lambda run_id, artifact_path, payload, content_type: binary_artifacts.append(
            (run_id, artifact_path, payload, content_type)
        )
        or True,
    )
    monkeypatch.setattr(
        PERSIST_RESULTS,
        "_log_mlflow_batch",
        lambda run_id, **payload: batches.append((run_id, payload)),
    )

    PERSIST_RESULTS._enrich_mlflow_workflow_run(
        run_id="run_123",
        db_url="postgres://test",
        db_execution_id="exec_123",
        workflow_id="workflow_1",
        project_id="project_1",
        workflow_input={"prompt": "hello"},
        trace_id="1234567890abcdef1234567890abcdef",
        final_output={"success": True, "outputs": {"node": {"ok": True}}},
        summary_fields={"title": "Demo"},
        status="success",
        duration_ms=1234,
        outputs_size_chars=99,
    )

    assert ("run_123", "workflow/input.json", {"prompt": "hello"}) in json_artifacts
    assert any(path == "workflow/output.json" for _run, path, _value in json_artifacts)
    assert any(path == "browser/bwf_test/manifest.json" for _run, path, _value in json_artifacts)
    assert (
        "run_123",
        "browser/bwf_test/assets/screenshot-1.png",
        b"png-bytes",
        "image/png",
    ) in binary_artifacts
    assert (
        "run_123",
        "browser/bwf_test/assets/trace-2.zip",
        b"zip-bytes",
        "application/zip",
    ) in binary_artifacts
    assert batches
    batch = batches[0][1]
    assert {"key": "workflow_execution_id", "value": "exec_123"} in batch["params"]
    assert {"key": "workflow_builder.mlflow_projection", "value": "workflow_completion_v1"} in batch["tags"]
    metric_values = {metric["key"]: metric["value"] for metric in batch["metrics"]}
    assert metric_values["workflow.duration_ms"] == 1234.0
    assert metric_values["browser_artifacts"] == 1.0
    assert metric_values["browser_assets_logged"] == 2.0


def test_sw_workflow_success_schedules_mlflow_finalizer_after_persist_and_cleanup(monkeypatch):
    _install_terminal_workflow_model_fakes(monkeypatch)
    ctx = _FakeTerminalWorkflowCtx()
    workflow_gen = SW_WORKFLOW.sw_workflow(ctx, _terminal_workflow_input())

    persisted = next(workflow_gen)
    assert persisted["activity"] == "persist_results_to_db"
    assert persisted["input"]["success"] is True

    cleanup = workflow_gen.send({"success": True})
    assert cleanup["activity"] == "cleanup_execution_workspaces"

    finalized = workflow_gen.send({"success": True})
    assert finalized["activity"] == "finalize_mlflow_trace_root"
    assert finalized["input"]["status"] == "OK"
    assert finalized["input"]["traceId"] == "1234567890abcdef1234567890abcdef"
    assert finalized["input"]["traceName"] == "wf_test/db_exec_123"

    with pytest.raises(StopIteration) as stop:
        workflow_gen.send({"success": True})

    assert stop.value.value["success"] is True


def test_sw_workflow_failure_schedules_mlflow_finalizer_with_error_after_cleanup(monkeypatch):
    _install_terminal_workflow_model_fakes(monkeypatch)
    ctx = _FakeTerminalWorkflowCtx()
    workflow_gen = SW_WORKFLOW.sw_workflow(
        ctx,
        _terminal_workflow_input(
            [
                {
                    "fail_step": {
                        "call": "system/fail",
                        "with": {},
                    }
                }
            ]
        ),
    )

    execution = next(workflow_gen)
    assert execution["activity"] == "execute_action"

    persisted = workflow_gen.send({"success": False, "error": "forced failure"})
    assert persisted["activity"] == "persist_results_to_db"
    assert persisted["input"]["success"] is False
    assert persisted["input"]["error"] == "forced failure"

    cleanup = workflow_gen.send({"success": True})
    assert cleanup["activity"] == "cleanup_execution_workspaces"

    finalized = workflow_gen.send({"success": True})
    assert finalized["activity"] == "finalize_mlflow_trace_root"
    assert finalized["input"]["status"] == "ERROR"
    assert finalized["input"]["error"] == "forced failure"

    with pytest.raises(StopIteration) as stop:
        workflow_gen.send({"success": False})

    assert stop.value.value["success"] is False
    assert stop.value.value["phase"] == "failed"


def test_sw_workflow_dispatches_task_activity_otel_context(monkeypatch):
    _install_terminal_workflow_model_fakes(monkeypatch)
    ctx = _FakeTerminalWorkflowCtx()
    workflow_gen = SW_WORKFLOW.sw_workflow(
        ctx,
        _terminal_workflow_input(
            [
                {
                    "profile": {
                        "call": "workspace/profile",
                        "with": {"sandboxTemplate": "default-sandbox"},
                    }
                }
            ]
        ),
    )

    execution = next(workflow_gen)

    assert execution["activity"] == "execute_action"
    otel = execution["input"]["_otel"]
    assert otel["traceId"] == "1234567890abcdef1234567890abcdef"
    assert otel["workflow.activity.correlation_id"] == "db_exec_123:profile:0"
    assert otel["workflow.node.id"] == "profile"
    assert otel["workflow.node.sequence"] == "0"
    assert "workflow.activity.correlation_id=db_exec_123:profile:0" in otel["baggage"]
    assert "workflow.node.action_type=workspace/profile" in otel["baggage"]


def test_sw_workflow_parse_failure_schedules_error_finalizer_when_trace_exists(monkeypatch):
    _install_terminal_workflow_model_fakes(monkeypatch)
    ctx = _FakeTerminalWorkflowCtx()
    workflow_gen = SW_WORKFLOW.sw_workflow(
        ctx,
        {
            "workflow": {"document": {"name": "broken-workflow"}},
            "workflowId": "wf_broken",
            "dbExecutionId": "db_exec_broken",
            "_otel": {"traceId": "abcdefabcdefabcdefabcdefabcdefab"},
        },
    )

    finalized = next(workflow_gen)
    assert finalized["activity"] == "finalize_mlflow_trace_root"
    assert finalized["input"]["status"] == "ERROR"
    assert finalized["input"]["workflowId"] == "wf_broken"
    assert finalized["input"]["workflowName"] == "broken-workflow"

    with pytest.raises(StopIteration) as stop:
        workflow_gen.send({"success": False})

    assert stop.value.value["success"] is False
    assert stop.value.value["phase"] == "failed"


def test_sw_workflow_schedules_node_span_only_when_input_feature_enabled(monkeypatch):
    _install_terminal_workflow_model_fakes(monkeypatch)
    task = {"assign": {"set": {"foo": "bar"}}}

    disabled_input = _terminal_workflow_input([task])
    disabled_input["dbExecutionId"] = None
    disabled_ctx = _FakeTerminalWorkflowCtx()
    disabled_gen = SW_WORKFLOW.sw_workflow(disabled_ctx, disabled_input)
    disabled_first = next(disabled_gen)
    assert disabled_first["activity"] != "emit_mlflow_node_span"

    enabled_input = _terminal_workflow_input([task])
    enabled_input["dbExecutionId"] = None
    enabled_input["features"] = {"mlflowNodeSpans": True}
    enabled_ctx = _FakeTerminalWorkflowCtx()
    enabled_gen = SW_WORKFLOW.sw_workflow(enabled_ctx, enabled_input)
    node_span = next(enabled_gen)

    assert node_span["activity"] == "emit_mlflow_node_span"
    assert node_span["input"]["status"] == "OK"
    assert node_span["input"]["nodeId"] == "assign"
    assert node_span["input"]["traceId"] == "1234567890abcdef1234567890abcdef"


def test_benchmark_sw_workflow_suppresses_parent_mlflow_finalizer_by_default(monkeypatch):
    _install_terminal_workflow_model_fakes(monkeypatch)
    ctx = _FakeTerminalWorkflowCtx()
    workflow_input = _terminal_workflow_input()
    workflow_input["triggerData"] = {
        "runId": "bench-run-1",
        "instanceId": "django__django-12345",
    }

    workflow_gen = SW_WORKFLOW.sw_workflow(ctx, workflow_input)
    persisted = next(workflow_gen)

    assert persisted["activity"] == "persist_results_to_db"
    assert persisted["input"]["success"] is True
    with pytest.raises(StopIteration) as stop:
        workflow_gen.send({"success": True})

    assert stop.value.value["success"] is True


def test_benchmark_sw_workflow_can_enable_parent_mlflow_finalizer(monkeypatch):
    _install_terminal_workflow_model_fakes(monkeypatch)
    monkeypatch.setenv("WORKFLOW_ORCHESTRATOR_BENCHMARK_MLFLOW_FINALIZE_ENABLED", "true")
    ctx = _FakeTerminalWorkflowCtx()
    workflow_input = _terminal_workflow_input()
    workflow_input["triggerData"] = {
        "runId": "bench-run-1",
        "instanceId": "django__django-12345",
    }

    workflow_gen = SW_WORKFLOW.sw_workflow(ctx, workflow_input)
    persisted = next(workflow_gen)
    finalized = workflow_gen.send({"success": True})

    assert persisted["activity"] == "persist_results_to_db"
    assert finalized["activity"] == "finalize_mlflow_trace_root"
    assert finalized["input"]["status"] == "OK"


def test_benchmark_sw_workflow_suppresses_parent_node_spans_by_default(monkeypatch):
    _install_terminal_workflow_model_fakes(monkeypatch)
    workflow_input = _terminal_workflow_input([{"assign": {"set": {"foo": "bar"}}}])
    workflow_input["dbExecutionId"] = None
    workflow_input["triggerData"] = {
        "runId": "bench-run-1",
        "instanceId": "django__django-12345",
    }

    workflow_gen = SW_WORKFLOW.sw_workflow(_FakeTerminalWorkflowCtx(), workflow_input)

    with pytest.raises(StopIteration) as stop:
        next(workflow_gen)

    assert stop.value.value["success"] is True


def test_benchmark_sw_workflow_preserves_requested_node_span_schedule(monkeypatch):
    _install_terminal_workflow_model_fakes(monkeypatch)
    workflow_input = _terminal_workflow_input([{"assign": {"set": {"foo": "bar"}}}])
    workflow_input["dbExecutionId"] = None
    workflow_input["features"] = {"mlflowNodeSpans": True}
    workflow_input["triggerData"] = {
        "runId": "bench-run-1",
        "instanceId": "django__django-12345",
    }

    workflow_gen = SW_WORKFLOW.sw_workflow(_FakeTerminalWorkflowCtx(), workflow_input)
    node_span = next(workflow_gen)

    assert node_span["activity"] == "emit_mlflow_node_span"
    assert node_span["input"]["status"] == "OK"
    assert node_span["input"]["nodeId"] == "assign"


def test_rerun_workflow_passes_new_instance_without_input_override(monkeypatch):
    captured = {}

    def fake_taskhub_call(method, request):
        captured[method] = request
        if method == "GetInstance":
            return types.SimpleNamespace(exists=True)
        if method == "RerunWorkflowFromEvent":
            return types.SimpleNamespace(newInstanceID=request.newInstanceID)
        raise AssertionError(f"unexpected TaskHub method {method}")

    monkeypatch.setattr(APP, "_taskhub_call", fake_taskhub_call)

    result = APP.rerun_workflow(
        "source-instance",
        APP.RerunWorkflowRequest(
            fromEventId=5,
            newInstanceId="rerun-instance",
            reason="test rerun",
        ),
    )

    request = captured["RerunWorkflowFromEvent"]
    assert request.sourceInstanceID == "source-instance"
    assert request.eventID == 5
    assert request.newInstanceID == "rerun-instance"
    assert not request.overwriteInput
    assert result["newInstanceId"] == "rerun-instance"


def test_rerun_workflow_only_sends_input_when_overwrite_requested(monkeypatch):
    captured = {}

    def fake_taskhub_call(method, request):
        captured[method] = request
        if method == "GetInstance":
            return types.SimpleNamespace(exists=True)
        if method == "RerunWorkflowFromEvent":
            return types.SimpleNamespace(newInstanceID="generated-rerun")
        raise AssertionError(f"unexpected TaskHub method {method}")

    monkeypatch.setattr(APP, "_taskhub_call", fake_taskhub_call)

    APP.rerun_workflow(
        "source-instance",
        APP.RerunWorkflowRequest(
            fromEventId=0,
            overwriteInput=True,
            input={"dbExecutionId": "rerun-db-id"},
        ),
    )

    request = captured["RerunWorkflowFromEvent"]
    assert request.overwriteInput
    assert request.input.value == '{"dbExecutionId": "rerun-db-id"}'


def test_resolve_native_agent_args_renders_trigger_templates_before_child_workflow():
    workflow = types.SimpleNamespace(
        document=types.SimpleNamespace(name="test-workflow"),
        model_dump=lambda **_kwargs: {
            "document": {
                "dsl": "1.0.0",
                "namespace": "test",
                "name": "test-workflow",
                "version": "0.1.0",
            }
        },
    )
    tc = SW_WORKFLOW.TaskContext(
        workflow=workflow,
        workflow_id="test-workflow",
        trigger_data={"owner": "giteaadmin", "repo": "repo-test-1"},
        execution_id="exec_123",
        db_execution_id="db_exec_123",
        integrations=None,
    )

    resolved = SW_WORKFLOW._resolve_native_agent_args(
        tc,
        None,
        {
            "prompt": "Create repo {{trigger.owner}}/{{trigger.repo}}",
            "cwd": "/sandbox/{{trigger.repo}}",
            "body": {
                "input": {
                    "owner": "{{trigger.owner}}",
                    "repo": "{{trigger.repo}}",
                }
            },
        },
    )

    assert resolved["prompt"] == "Create repo giteaadmin/repo-test-1"
    assert resolved["cwd"] == "/sandbox/repo-test-1"
    assert resolved["body"]["input"]["owner"] == "giteaadmin"
    assert resolved["body"]["input"]["repo"] == "repo-test-1"


def test_durable_run_routes_through_session_bridge():
    workflow = types.SimpleNamespace(
        use=None,
        document=types.SimpleNamespace(name="test-workflow"),
        model_dump=lambda **_kwargs: {
            "document": {
                "dsl": "1.0.0",
                "namespace": "test",
                "name": "test-workflow",
                "version": "0.1.0",
            }
        },
    )
    tc = SW_WORKFLOW.TaskContext(
        workflow=workflow,
        workflow_id="test-workflow",
        trigger_data={
            "prompt": "Create a validation marker",
            "executionClass": "benchmark-minimal-agent",
        },
        execution_id="exec_456",
        db_execution_id=None,
        integrations=None,
    )

    class _FakeCtx:
        instance_id = "parent-wf-1"

        def call_activity(self, activity, input=None):
            return {
                "kind": "call_activity",
                "activity": getattr(activity, "__name__", str(activity)),
                "input": input,
            }

        def call_child_workflow(self, name, input=None, instance_id=None, app_id=None):
            return _FakeWorkflowTask(
                "call_child_workflow",
                result={
                    "success": True,
                    "content": "VALIDATION COMPLETE",
                },
                name=name,
                input=input,
                instance_id=instance_id,
                app_id=app_id,
            )

        def create_timer(self, timeout):
            return _FakeWorkflowTask("timer", timeout=timeout)

    ctx = _FakeCtx()
    workflow_gen = SW_WORKFLOW._handle_call_task(
        ctx,
        "durable_validation_run",
        {
            "call": "durable/run",
            "with": {
                "prompt": "Create a validation marker",
                "workspaceRef": "ws_test_123",
                "sandboxName": "ws-test-123",
                "cwd": "/sandbox/repo",
                "agentRuntime": "dapr-agent-py",
                "maxTurns": "8",
                "timeoutMinutes": "15",
                "agentConfig": {
                    "id": "agent_123",
                    "version": 4,
                    "slug": "durable-validation",
                    "name": "durable-validation",
                },
            },
        },
        tc,
    )

    yielded = next(workflow_gen)
    assert yielded["kind"] == "call_activity"
    assert yielded["activity"] == "spawn_session_for_workflow"
    bridge_payload = yielded["input"]
    assert bridge_payload["initialMessage"].startswith(
        "Repository root: /sandbox/repo"
    )
    assert bridge_payload["workspaceRef"] == "ws_test_123"
    assert bridge_payload["sandboxName"] == "ws-test-123"
    assert bridge_payload["cwd"] == "/sandbox/repo"
    assert bridge_payload["agentId"] == "agent_123"
    assert bridge_payload["agentVersion"] == 4
    assert bridge_payload["agentSlug"] == "durable-validation"
    assert bridge_payload["agentConfig"]["name"] == "durable-validation"
    assert bridge_payload["timeoutMinutes"] == 15
    assert bridge_payload["maxIterations"] == 8
    assert bridge_payload["benchmarkExecutionClass"] == "benchmark-minimal-agent"

    wait_yield = workflow_gen.send(
        {
            "childInput": {"sessionId": "child-session"},
            "agentAppId": "agent-runtime-test",
            "runtimeSandboxName": "agent-host-child-session",
        }
    )
    assert wait_yield["kind"] == "when_any"
    child_task, timer_task = wait_yield["tasks"]
    assert child_task.kind == "call_child_workflow"
    assert child_task.name == "session_workflow"
    assert child_task.app_id == "agent-runtime-test"
    assert child_task.input["workflowId"] == "test-workflow"
    assert child_task.input["workflowExecutionId"] == "exec_456"
    assert child_task.input["nodeId"] == "durable_validation_run"
    assert child_task.input["nodeName"] == "durable_validation_run"
    assert child_task.input["agentId"] == "agent_123"
    assert child_task.input["agentVersion"] == 4
    assert child_task.input["agentSlug"] == "durable-validation"
    assert child_task.input["runtimeSandboxName"] == "agent-host-child-session"
    assert child_task.input["sandboxName"] == "ws-test-123"
    assert child_task.input["workspaceRef"] == "ws_test_123"
    assert child_task.input["_message_metadata"]["agentSlug"] == "durable-validation"
    assert timer_task.kind == "timer"

    with pytest.raises(StopIteration) as stop:
        workflow_gen.send(child_task)

    result = stop.value.value
    assert result["success"] is True
    assert result["childAppId"] == "agent-runtime-test"
    assert result["runtimeSandboxName"] == "agent-host-child-session"


def test_durable_run_session_bridge_times_out_when_child_does_not_finish():
    workflow = types.SimpleNamespace(
        use=None,
        document=types.SimpleNamespace(name="test-workflow"),
        model_dump=lambda **_kwargs: {
            "document": {
                "dsl": "1.0.0",
                "namespace": "test",
                "name": "test-workflow",
                "version": "0.1.0",
            }
        },
    )
    tc = SW_WORKFLOW.TaskContext(
        workflow=workflow,
        workflow_id="test-workflow",
        trigger_data={"prompt": "Create a validation marker"},
        execution_id="exec_timeout",
        db_execution_id=None,
        integrations=None,
    )

    class _FakeCtx:
        instance_id = "parent-wf-timeout"

        def call_activity(self, activity, input=None):
            return {
                "kind": "call_activity",
                "activity": getattr(activity, "__name__", str(activity)),
                "input": input,
            }

        def call_child_workflow(self, name, input=None, instance_id=None, app_id=None):
            return _FakeWorkflowTask(
                "call_child_workflow",
                result={"success": True},
                name=name,
                input=input,
                instance_id=instance_id,
                app_id=app_id,
            )

        def create_timer(self, timeout):
            return _FakeWorkflowTask("timer", timeout=timeout)

    workflow_gen = SW_WORKFLOW._handle_call_task(
        _FakeCtx(),
        "durable_validation_run",
        {
            "call": "durable/run",
            "with": {
                "prompt": "Create a validation marker",
                "workspaceRef": "ws_test_123",
                "sandboxName": "ws-test-123",
                "cwd": "/sandbox/repo",
                "agentRuntime": "dapr-agent-py",
                "timeoutMinutes": "1",
                "agentConfig": {"name": "durable-validation"},
            },
        },
        tc,
    )

    yielded = next(workflow_gen)
    assert yielded["activity"] == "spawn_session_for_workflow"
    wait_yield = workflow_gen.send(
        {
            "childInput": {"sessionId": "child-session"},
            "agentAppId": "agent-runtime-test",
        }
    )
    child_task, timer_task = wait_yield["tasks"]
    assert child_task.name == "session_workflow"

    with pytest.raises(TimeoutError, match="session_workflow/.+ within 60s"):
        workflow_gen.send(timer_task)


def test_benchmark_durable_run_session_bridge_uses_child_completion_without_parent_timer():
    workflow = types.SimpleNamespace(
        use=None,
        document=types.SimpleNamespace(name="test-workflow"),
        model_dump=lambda **_kwargs: {
            "document": {
                "dsl": "1.0.0",
                "namespace": "test",
                "name": "test-workflow",
                "version": "0.1.0",
            }
        },
    )
    tc = SW_WORKFLOW.TaskContext(
        workflow=workflow,
        workflow_id="test-workflow",
        trigger_data={
            "prompt": "Create a validation marker",
            "runId": "bench-run-1",
            "instanceId": "django__django-12345",
        },
        execution_id="exec_benchmark",
        db_execution_id="db_exec_benchmark",
        integrations=None,
    )

    class _FakeCtx:
        instance_id = "parent-benchmark-wf-1"

        def call_activity(self, activity, input=None):
            return {
                "kind": "call_activity",
                "activity": getattr(activity, "__name__", str(activity)),
                "input": input,
            }

        def call_child_workflow(self, name, input=None, instance_id=None, app_id=None):
            return _FakeWorkflowTask(
                "call_child_workflow",
                result={
                    "success": True,
                    "content": "VALIDATION COMPLETE",
                },
                name=name,
                input=input,
                instance_id=instance_id,
                app_id=app_id,
            )

        def create_timer(self, timeout):
            raise AssertionError("benchmark durable/run should not create a parent timer")

        def wait_for_external_event(self, event_name):
            return _FakeWorkflowTask(
                "external_event",
                result={"reason": "cancelled"},
                name=event_name,
            )

    workflow_gen = SW_WORKFLOW._handle_call_task(
        _FakeCtx(),
        "durable_validation_run",
        {
            "call": "durable/run",
            "with": {
                "prompt": "Create a validation marker",
                "workspaceRef": "ws_test_123",
                "sandboxName": "ws-test-123",
                "cwd": "/sandbox/repo",
                "agentRuntime": "dapr-agent-py",
                "timeoutMinutes": "1",
                "agentConfig": {"name": "durable-validation"},
            },
        },
        tc,
    )

    yielded = next(workflow_gen)
    assert yielded["activity"] == "spawn_session_for_workflow"
    assert yielded["input"]["workflowExecutionId"] == "db_exec_benchmark"
    wait_yield = workflow_gen.send(
        {
            "childInput": {"sessionId": "child-session"},
            "agentAppId": "agent-runtime-test",
        }
    )
    assert wait_yield["kind"] == "when_any"
    child_yield, cancel_yield = wait_yield["tasks"]
    assert child_yield.kind == "call_child_workflow"
    assert child_yield.name == "session_workflow"
    assert child_yield.app_id == "agent-runtime-test"
    assert cancel_yield.kind == "external_event"
    assert cancel_yield.name == "workflow.cancel"

    with pytest.raises(StopIteration) as stop:
        workflow_gen.send(child_yield)

    result = stop.value.value
    assert result["success"] is True


def test_benchmark_durable_run_session_bridge_returns_cancelled_on_workflow_cancel():
    workflow = types.SimpleNamespace(
        use=None,
        document=types.SimpleNamespace(name="test-workflow"),
        model_dump=lambda **_kwargs: {
            "document": {
                "dsl": "1.0.0",
                "namespace": "test",
                "name": "test-workflow",
                "version": "0.1.0",
            }
        },
    )
    tc = SW_WORKFLOW.TaskContext(
        workflow=workflow,
        workflow_id="test-workflow",
        trigger_data={
            "prompt": "Create a validation marker",
            "runId": "bench-run-1",
            "instanceId": "django__django-12345",
        },
        execution_id="exec_benchmark_cancel",
        db_execution_id="db_exec_benchmark_cancel",
        integrations=None,
    )

    class _FakeCtx:
        instance_id = "parent-benchmark-wf-cancel"

        def call_activity(self, activity, input=None):
            return {
                "kind": "call_activity",
                "activity": getattr(activity, "__name__", str(activity)),
                "input": input,
            }

        def call_child_workflow(self, name, input=None, instance_id=None, app_id=None):
            return _FakeWorkflowTask(
                "call_child_workflow",
                result={"success": True, "content": "VALIDATION COMPLETE"},
                name=name,
                input=input,
                instance_id=instance_id,
                app_id=app_id,
            )

        def create_timer(self, timeout):
            raise AssertionError("benchmark durable/run should not create a parent timer")

        def wait_for_external_event(self, event_name):
            return _FakeWorkflowTask(
                "external_event",
                result={"reason": "operator cleanup", "source": "benchmark_cleanup"},
                name=event_name,
            )

    workflow_gen = SW_WORKFLOW._handle_call_task(
        _FakeCtx(),
        "durable_validation_run",
        {
            "call": "durable/run",
            "with": {
                "prompt": "Create a validation marker",
                "workspaceRef": "ws_test_123",
                "sandboxName": "ws-test-123",
                "cwd": "/sandbox/repo",
                "agentRuntime": "dapr-agent-py",
                "timeoutMinutes": "1",
                "agentConfig": {"name": "durable-validation"},
            },
        },
        tc,
    )

    yielded = next(workflow_gen)
    assert yielded["activity"] == "spawn_session_for_workflow"
    wait_yield = workflow_gen.send(
        {
            "childInput": {"sessionId": "child-session"},
            "agentAppId": "agent-runtime-test",
        }
    )
    child_yield, cancel_yield = wait_yield["tasks"]
    assert child_yield.name == "session_workflow"
    assert cancel_yield.name == "workflow.cancel"

    with pytest.raises(StopIteration) as stop:
        workflow_gen.send(cancel_yield)

    result = stop.value.value
    assert result["success"] is False
    assert result["cancelled"] is True
    assert result["error"] == "operator cleanup"
    assert result["stopReason"] == {
        "type": "cancelled",
        "reason": "operator cleanup",
        "source": "benchmark_cleanup",
    }
    assert result["childWorkflowName"] == "session_workflow"


def test_benchmark_durable_run_does_not_add_parent_readiness_timer():
    workflow = types.SimpleNamespace(
        use=None,
        document=types.SimpleNamespace(name="test-workflow"),
        model_dump=lambda **_kwargs: {
            "document": {
                "dsl": "1.0.0",
                "namespace": "test",
                "name": "test-workflow",
                "version": "0.1.0",
            }
        },
    )
    tc = SW_WORKFLOW.TaskContext(
        workflow=workflow,
        workflow_id="test-workflow",
        trigger_data={
            "prompt": "Create a validation marker",
            "runId": "bench-run-1",
            "instanceId": "django__django-12345",
        },
        execution_id="exec_benchmark",
        db_execution_id=None,
        integrations=None,
    )

    class _FakeCtx:
        instance_id = "parent-benchmark-wf-pre-waited-host"

        def call_activity(self, activity, input=None):
            return {
                "kind": "call_activity",
                "activity": getattr(activity, "__name__", str(activity)),
                "input": input,
            }

        def call_child_workflow(self, name, input=None, instance_id=None, app_id=None):
            return _FakeWorkflowTask(
                "call_child_workflow",
                result={
                    "success": True,
                    "content": "VALIDATION COMPLETE",
                },
                name=name,
                input=input,
                instance_id=instance_id,
                app_id=app_id,
            )

        def create_timer(self, timeout):
            raise AssertionError("agent host readiness belongs inside spawn_session activity")

        def wait_for_external_event(self, event_name):
            return _FakeWorkflowTask("external_event", result={}, name=event_name)

    ctx = _FakeCtx()
    workflow_gen = SW_WORKFLOW._handle_call_task(
        ctx,
        "durable_validation_run",
        {
            "call": "durable/run",
            "with": {
                "prompt": "Create a validation marker",
                "workspaceRef": "ws_test_123",
                "sandboxName": "ws-test-123",
                "cwd": "/sandbox/repo",
                "agentRuntime": "dapr-agent-py",
                "timeoutMinutes": "1",
                "agentConfig": {"name": "durable-validation"},
            },
        },
        tc,
    )

    yielded = next(workflow_gen)
    assert yielded["activity"] == "spawn_session_for_workflow"

    wait_yield = workflow_gen.send(
        {
            "childInput": {"sessionId": "child-session"},
            "agentAppId": "agent-session-abc123",
            "agentHostStatus": "ready",
        }
    )
    child_yield, cancel_yield = wait_yield["tasks"]
    assert child_yield.kind == "call_child_workflow"
    assert child_yield.name == "session_workflow"
    assert child_yield.app_id == "agent-session-abc123"
    assert cancel_yield.name == "workflow.cancel"

    with pytest.raises(StopIteration) as stop:
        workflow_gen.send(child_yield)

    result = stop.value.value
    assert result["success"] is True


def test_benchmark_durable_run_returns_cancelled_when_spawn_sees_cancelled_run():
    workflow = types.SimpleNamespace(
        use=None,
        document=types.SimpleNamespace(name="test-workflow"),
        model_dump=lambda **_kwargs: {
            "document": {
                "dsl": "1.0.0",
                "namespace": "test",
                "name": "test-workflow",
                "version": "0.1.0",
            }
        },
    )
    tc = SW_WORKFLOW.TaskContext(
        workflow=workflow,
        workflow_id="test-workflow",
        trigger_data={
            "prompt": "Create a validation marker",
            "runId": "bench-run-1",
            "instanceId": "django__django-12345",
        },
        execution_id="exec_benchmark_cancel",
        db_execution_id="db_exec_benchmark_cancel",
        integrations=None,
    )

    class _FakeCtx:
        instance_id = "parent-benchmark-wf-cancel"

        def call_activity(self, activity, input=None):
            return {
                "kind": "call_activity",
                "activity": getattr(activity, "__name__", str(activity)),
                "input": input,
            }

        def call_child_workflow(self, *_args, **_kwargs):
            raise AssertionError("cancelled benchmark should not start child workflow")

        def create_timer(self, _timeout):
            raise AssertionError("benchmark durable/run should not create a parent timer")

    workflow_gen = SW_WORKFLOW._handle_call_task(
        _FakeCtx(),
        "durable_validation_run",
        {
            "call": "durable/run",
            "with": {
                "prompt": "Create a validation marker",
                "workspaceRef": "ws_test_123",
                "sandboxName": "ws-test-123",
                "cwd": "/sandbox/repo",
                "agentRuntime": "dapr-agent-py",
                "timeoutMinutes": "1",
                "agentConfig": {"name": "durable-validation"},
            },
        },
        tc,
    )

    yielded = next(workflow_gen)
    assert yielded["activity"] == "spawn_session_for_workflow"

    with pytest.raises(StopIteration) as stop:
        workflow_gen.send(
            {
                "sessionId": "child-session",
                "success": False,
                "cancelled": True,
                "error": "Benchmark run bench-run-1 is cancelled",
                "stopReason": {
                    "type": "cancelled",
                    "reason": "Benchmark run bench-run-1 is cancelled",
                    "source": "benchmark_cleanup",
                },
            }
        )

    result = stop.value.value
    assert result["success"] is False
    assert result["cancelled"] is True
    assert result["error"] == "Benchmark run bench-run-1 is cancelled"
    assert result["childWorkflowName"] == "session_workflow"


def test_benchmark_durable_run_without_agent_host_status_preserves_child_workflow_order():
    workflow = types.SimpleNamespace(
        use=None,
        document=types.SimpleNamespace(name="test-workflow"),
        model_dump=lambda **_kwargs: {
            "document": {
                "dsl": "1.0.0",
                "namespace": "test",
                "name": "test-workflow",
                "version": "0.1.0",
            }
        },
    )
    tc = SW_WORKFLOW.TaskContext(
        workflow=workflow,
        workflow_id="test-workflow",
        trigger_data={
            "prompt": "Create a validation marker",
            "runId": "bench-run-1",
            "instanceId": "django__django-12345",
        },
        execution_id="exec_benchmark",
        db_execution_id=None,
        integrations=None,
    )

    class _FakeCtx:
        instance_id = "parent-benchmark-wf-no-host-status"

        def call_activity(self, activity, input=None):
            return {
                "kind": "call_activity",
                "activity": getattr(activity, "__name__", str(activity)),
                "input": input,
            }

        def call_child_workflow(self, name, input=None, instance_id=None, app_id=None):
            return _FakeWorkflowTask(
                "call_child_workflow",
                result={"success": True},
                name=name,
                input=input,
                instance_id=instance_id,
                app_id=app_id,
            )

        def create_timer(self, timeout):
            raise AssertionError("missing agentHostStatus should not add a new timer")

        def wait_for_external_event(self, event_name):
            return _FakeWorkflowTask("external_event", result={}, name=event_name)

    workflow_gen = SW_WORKFLOW._handle_call_task(
        _FakeCtx(),
        "durable_validation_run",
        {
            "call": "durable/run",
            "with": {
                "prompt": "Create a validation marker",
                "workspaceRef": "ws_test_123",
                "sandboxName": "ws-test-123",
                "cwd": "/sandbox/repo",
                "agentRuntime": "dapr-agent-py",
                "timeoutMinutes": "1",
                "agentConfig": {"name": "durable-validation"},
            },
        },
        tc,
    )

    yielded = next(workflow_gen)
    assert yielded["activity"] == "spawn_session_for_workflow"

    wait_yield = workflow_gen.send(
        {
            "childInput": {"sessionId": "child-session"},
            "agentAppId": "agent-session-abc123",
        }
    )
    child_yield, cancel_yield = wait_yield["tasks"]
    assert child_yield.kind == "call_child_workflow"
    assert child_yield.name == "session_workflow"
    assert child_yield.app_id == "agent-session-abc123"
    assert cancel_yield.name == "workflow.cancel"


class _FakeResponse:
    def __init__(self, body, status_code=200, text=""):
        self._body = body
        self.status_code = status_code
        self.text = text

    def json(self):
        return self._body


def test_spawn_session_activity_polls_agent_session_host_until_ready(monkeypatch):
    bodies = [
        {
            "sessionId": "child-session",
            "agentAppId": "agent-session-abc123",
            "agentHostStatus": "queued",
            "childInput": {"sessionId": "child-session"},
        },
        {
            "sessionId": "child-session",
            "agentAppId": "agent-session-abc123",
            "agentHostStatus": "ready",
            "childInput": {"sessionId": "child-session"},
        },
    ]
    posts = []

    def fake_post(endpoint, **kwargs):
        posts.append((endpoint, kwargs))
        return _FakeResponse(bodies[len(posts) - 1])

    sleeps = []
    monotonic_values = iter([0, 1])
    monkeypatch.setenv("AGENT_SESSION_HOST_READY_POLL_SECONDS", "1")
    monkeypatch.setenv("AGENT_SESSION_HOST_READY_TIMEOUT_SECONDS", "10")
    monkeypatch.setattr(SPAWN_SESSION.requests, "post", fake_post)
    monkeypatch.setattr(SPAWN_SESSION.time, "sleep", lambda seconds: sleeps.append(seconds))
    monkeypatch.setattr(SPAWN_SESSION.time, "monotonic", lambda: next(monotonic_values))

    body = SPAWN_SESSION._ensure_agent_session_host_ready(
        "http://workflow-builder/api/internal/sessions/ensure-for-workflow",
        {"sessionId": "child-session"},
        "token",
        {
            "traceparent": "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
            "tracestate": "vendor=value",
            "baggage": "workflow.execution.id=exec_1,session.id=session_1",
        },
    )

    assert body["agentHostStatus"] == "ready"
    assert len(posts) == 2
    assert sleeps == [1]
    assert posts[0][1]["headers"] == {
        "X-Internal-Token": "token",
        "traceparent": "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
        "tracestate": "vendor=value",
        "baggage": "workflow.execution.id=exec_1,session.id=session_1",
    }


def test_spawn_session_activity_returns_cancelled_for_cancelled_benchmark_run(monkeypatch):
    def fake_post(_endpoint, **_kwargs):
        return _FakeResponse(
            {},
            status_code=409,
            text='{"message":"Benchmark run run-1 is cancelled; refusing to provision session host"}',
        )

    monkeypatch.setattr(SPAWN_SESSION.requests, "post", fake_post)

    body = SPAWN_SESSION._ensure_agent_session_host_ready(
        "http://workflow-builder/api/internal/sessions/ensure-for-workflow",
        {"sessionId": "child-session"},
        "token",
    )

    assert body["sessionId"] == "child-session"
    assert body["success"] is False
    assert body["cancelled"] is True
    assert body["stopReason"]["type"] == "cancelled"


def test_spawn_session_activity_times_out_waiting_for_agent_session_host(monkeypatch):
    def fake_post(_endpoint, **_kwargs):
        return _FakeResponse(
            {
                "sessionId": "child-session",
                "agentAppId": "agent-session-abc123",
                "agentHostStatus": "queued",
                "childInput": {"sessionId": "child-session"},
            }
        )

    monotonic_values = iter([0, 4])
    monkeypatch.setenv("AGENT_SESSION_HOST_READY_TIMEOUT_SECONDS", "3")
    monkeypatch.setattr(SPAWN_SESSION.requests, "post", fake_post)
    monkeypatch.setattr(SPAWN_SESSION.time, "monotonic", lambda: next(monotonic_values))

    with pytest.raises(TimeoutError, match="agent workflow host agent-session-abc123"):
        SPAWN_SESSION._ensure_agent_session_host_ready(
            "http://workflow-builder/api/internal/sessions/ensure-for-workflow",
            {"sessionId": "child-session"},
            "token",
        )


def test_spawn_session_activity_preserves_old_bff_missing_host_status(monkeypatch):
    def fake_post(_endpoint, **_kwargs):
        return _FakeResponse(
            {
                "sessionId": "child-session",
                "agentAppId": "agent-session-abc123",
                "childInput": {"sessionId": "child-session"},
            }
        )

    monkeypatch.setattr(SPAWN_SESSION.requests, "post", fake_post)
    monkeypatch.setattr(
        SPAWN_SESSION.time,
        "sleep",
        lambda _seconds: (_ for _ in ()).throw(AssertionError("should not sleep")),
    )

    body = SPAWN_SESSION._ensure_agent_session_host_ready(
        "http://workflow-builder/api/internal/sessions/ensure-for-workflow",
        {"sessionId": "child-session"},
        "token",
    )

    assert body["agentAppId"] == "agent-session-abc123"


def test_benchmark_sw_workflow_skips_parent_workspace_cleanup():
    workflow = types.SimpleNamespace(
        unwrap_tasks=lambda: [],
        document=types.SimpleNamespace(name="test-workflow"),
    )
    tc = SW_WORKFLOW.TaskContext(
        workflow=workflow,
        workflow_id="test-workflow",
        trigger_data={
            "runId": "bench-run-1",
            "instanceId": "django__django-12345",
        },
        execution_id="exec_benchmark",
        db_execution_id="db_exec_benchmark",
        integrations=None,
    )

    assert SW_WORKFLOW._should_cleanup_workspaces(tc) is False


def _durable_skill_policy_generator(agent_config):
    workflow = types.SimpleNamespace(
        use=None,
        document=types.SimpleNamespace(name="test-workflow"),
        model_dump=lambda **_kwargs: {
            "document": {
                "dsl": "1.0.0",
                "namespace": "test",
                "name": "test-workflow",
                "version": "0.1.0",
            }
        },
    )
    tc = SW_WORKFLOW.TaskContext(
        workflow=workflow,
        workflow_id="test-workflow",
        trigger_data={"prompt": "Use a configured skill"},
        execution_id="exec_skill",
        db_execution_id=None,
        integrations=None,
    )

    class _FakeCtx:
        instance_id = "parent-skill-wf-1"

        def call_activity(self, activity, input=None):
            return {
                "kind": "call_activity",
                "activity": getattr(activity, "__name__", str(activity)),
                "input": input,
            }

    return SW_WORKFLOW._handle_call_task(
        _FakeCtx(),
        "skill_run",
        {
            "call": "durable/run",
            "with": {
                "prompt": "Use the configured skill",
                "workspaceRef": "ws_test_skill",
                "cwd": "/sandbox",
                "agentRuntime": "dapr-agent-py",
                "agentConfig": agent_config,
            },
        },
        tc,
    )


def test_durable_run_allows_profile_skill_from_snapshot():
    skill = {
        "name": "answer-yes-no",
        "description": "Answer as yes or no",
        "installSource": "vercel-labs/agent-skills",
        "skillName": "answer-yes-no",
        "registryUrl": "https://skills.sh/vercel-labs/agent-skills/answer-yes-no",
        "allowedTools": ["read_file"],
        "sourceType": "profile",
    }
    workflow_gen = _durable_skill_policy_generator(
        {
            "profileRef": {"slug": "default-sandbox-agent"},
            "profileSnapshot": {
                "skills": [skill],
                "runtimeOverridePolicy": {
                    "allowSkillAdditions": False,
                    "allowSkillNarrowing": True,
                },
            },
            "runtimeOverridePolicy": {
                "allowSkillAdditions": False,
                "allowSkillNarrowing": True,
            },
            "skills": [{**skill, "allowedTools": ["read_file"]}],
        }
    )

    yielded = next(workflow_gen)
    assert yielded["kind"] == "call_activity"
    assert yielded["activity"] == "spawn_session_for_workflow"
    agent_config = yielded["input"]["agentConfig"]
    assert agent_config["skills"][0]["name"] == "answer-yes-no"


def test_durable_run_rejects_inline_skill_when_profile_disallows_additions():
    workflow_gen = _durable_skill_policy_generator(
        {
            "profileRef": {"slug": "default-sandbox-agent"},
            "profileSnapshot": {
                "skills": [],
                "runtimeOverridePolicy": {
                    "allowSkillAdditions": False,
                    "allowSkillNarrowing": True,
                },
            },
            "runtimeOverridePolicy": {
                "allowSkillAdditions": False,
                "allowSkillNarrowing": True,
            },
            "skills": [
                {
                    "name": "registry-review",
                    "installSource": "vercel-labs/agent-skills",
                    "skillName": "web-design-guidelines",
                    "sourceType": "registry",
                }
            ],
        }
    )

    with pytest.raises(RuntimeError, match="not allowed by the selected agent profile"):
        next(workflow_gen)


def test_durable_run_allows_registry_skill_without_profile():
    workflow_gen = _durable_skill_policy_generator(
        {
            "name": "custom-agent",
            "skills": [
                {
                    "name": "registry-review",
                    "installSource": "vercel-labs/agent-skills",
                    "skillName": "web-design-guidelines",
                    "sourceType": "registry",
                }
            ],
        }
    )

    yielded = next(workflow_gen)
    assert yielded["kind"] == "call_activity"
    assert yielded["activity"] == "spawn_session_for_workflow"
    agent_config = yielded["input"]["agentConfig"]
    assert agent_config["skills"][0]["skillName"] == "web-design-guidelines"


def test_durable_run_rejects_profile_skill_tool_expansion():
    profile_skill = {
        "name": "bounded-skill",
        "installSource": "vercel-labs/agent-skills",
        "skillName": "web-design-guidelines",
        "allowedTools": ["read_file"],
        "sourceType": "profile",
    }
    workflow_gen = _durable_skill_policy_generator(
        {
            "profileRef": {"slug": "default-sandbox-agent"},
            "profileSnapshot": {
                "skills": [profile_skill],
                "runtimeOverridePolicy": {
                    "allowSkillAdditions": False,
                    "allowSkillNarrowing": True,
                },
            },
            "runtimeOverridePolicy": {
                "allowSkillAdditions": False,
                "allowSkillNarrowing": True,
            },
            "skills": [{**profile_skill, "allowedTools": ["read_file", "write_file"]}],
        }
    )

    with pytest.raises(RuntimeError, match="requested tools outside"):
        next(workflow_gen)


def test_durable_run_rejects_profile_skill_changes_when_narrowing_disabled():
    profile_skill = {
        "name": "locked-skill",
        "description": "Locked",
        "installSource": "vercel-labs/agent-skills",
        "skillName": "web-design-guidelines",
        "registryUrl": "https://skills.sh/vercel-labs/agent-skills/web-design-guidelines",
        "allowedTools": ["read_file"],
        "sourceType": "profile",
    }
    workflow_gen = _durable_skill_policy_generator(
        {
            "profileRef": {"slug": "default-sandbox-agent"},
            "profileSnapshot": {
                "skills": [profile_skill],
                "runtimeOverridePolicy": {
                    "allowSkillAdditions": False,
                    "allowSkillNarrowing": False,
                },
            },
            "runtimeOverridePolicy": {
                "allowSkillAdditions": False,
                "allowSkillNarrowing": False,
            },
            "skills": [{**profile_skill, "skillName": "vercel-react-best-practices"}],
        }
    )

    with pytest.raises(RuntimeError, match="cannot be modified"):
        next(workflow_gen)


def test_activity_wrapper_stamps_redacted_input_and_output(monkeypatch):
    stamped: list[dict[str, object]] = []
    monkeypatch.setattr(APP, "set_current_span_attrs", lambda attrs: stamped.append(attrs))

    def activity(_ctx, data):
        return {"ok": True, "token": "server-secret", "echo": data["command"]}

    wrapped = APP._activity_with_content_io(activity)

    assert wrapped(None, {"command": "run", "apiKey": "client-secret"}) == {
        "ok": True,
        "token": "server-secret",
        "echo": "run",
    }
    assert wrapped.__name__ == "activity"
    assert len(stamped) == 2
    assert json.loads(stamped[0]["input.value"]) == {
        "command": "run",
        "apiKey": "[REDACTED]",
    }
    assert json.loads(stamped[1]["output.value"]) == {
        "ok": True,
        "token": "[REDACTED]",
        "echo": "run",
    }


def test_activity_wrapper_stamps_error_output(monkeypatch):
    stamped: list[dict[str, object]] = []
    monkeypatch.setattr(APP, "set_current_span_attrs", lambda attrs: stamped.append(attrs))

    def activity(_ctx, _data):
        raise RuntimeError("failed")

    wrapped = APP._activity_with_content_io(activity)

    with pytest.raises(RuntimeError, match="failed"):
        wrapped(None, {"runId": "run_1"})
    assert len(stamped) == 2
    assert json.loads(stamped[0]["input.value"]) == {"runId": "run_1"}
    assert json.loads(stamped[1]["output.value"]) == {
        "error": "failed",
        "errorType": "RuntimeError",
    }


def test_agent_events_subscription_stamps_output_on_server_span(monkeypatch):
    stamped: list[dict[str, object]] = []
    monkeypatch.setattr(APP, "set_current_span_attrs", lambda attrs: stamped.append(attrs))
    monkeypatch.setattr(
        APP,
        "start_activity_span",
        lambda *_args, **_kwargs: contextlib.nullcontext(None),
    )

    class FakeSpanContext:
        is_valid = True

    class FakeSpan:
        def __init__(self):
            self.attributes: dict[str, object] = {}

        def get_span_context(self):
            return FakeSpanContext()

        def set_attribute(self, key, value):
            self.attributes[key] = value

    server_span = FakeSpan()
    monkeypatch.setattr(APP, "_current_otel_span", lambda: server_span)

    event = APP.CloudEvent(
        type="com.dapr.event.sent",
        source="openshell-agent-runtime",
        data={"type": "sandbox.list_snapshot", "count": 0},
    )

    result = APP.agent_events_subscription(event)

    assert result == {
        "status": "SUCCESS",
        "result": {"status": "ignored", "event_type": "sandbox.list_snapshot"},
    }
    assert json.loads(server_span.attributes["output.value"]) == result
    assert json.loads(stamped[-1]["output.value"]) == result
