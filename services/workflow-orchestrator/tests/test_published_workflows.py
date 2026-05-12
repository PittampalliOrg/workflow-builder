from __future__ import annotations

import importlib.util
import sys
import types
from datetime import timedelta
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


def test_sw_workflow_instance_id_fits_dapr_http_limit():
    instance_id = APP._build_sw_workflow_instance_id(
        "this-workflow-name-is-intentionally-longer-than-dapr-http-allows",
        "execution-id-that-is-also-too-long-for-the-http-api",
    )

    assert len(instance_id) <= APP.MAX_DAPR_WORKFLOW_INSTANCE_ID_LENGTH
    assert instance_id.startswith("sw-this-workflow-name")
    assert "-exec-" in instance_id


def test_workflow_http_start_keeps_trace_context_out_of_headers(monkeypatch):
    captured = {}

    def fake_post_json(url, **kwargs):
        captured["url"] = url
        captured["kwargs"] = kwargs
        return 202, '{"instanceID":"started-instance"}'

    monkeypatch.setattr(APP, "_dapr_http_sidecar_url", lambda: "http://dapr")
    monkeypatch.setattr(
        APP,
        "_post_json_without_http_instrumentation",
        fake_post_json,
    )

    result = APP._workflow_http_start_instance(
        "sw_workflow_v1",
        "sw-test-exec-123",
        {"hello": "world"},
        parent_trace_context={
            "traceparent": "00-" + ("1" * 32) + "-" + ("2" * 16) + "-01",
            "tracestate": "vendor=value",
            "baggage": "session.id=abc",
        },
    )

    assert result == "started-instance"
    assert captured["url"] == (
        "http://dapr/v1.0/workflows/dapr/sw_workflow_v1/start"
        "?instanceID=sw-test-exec-123"
    )
    assert captured["kwargs"]["payload"] == {"hello": "world"}
    assert captured["kwargs"]["headers"] == {"content-type": "application/json"}
    assert captured["kwargs"]["timeout"] == APP._workflow_start_http_timeout_seconds()


def test_schedule_uses_http_start_by_default(monkeypatch):
    captured = {}

    def fake_http_start(workflow_name, instance_id, workflow_input, **kwargs):
        captured["workflow_name"] = workflow_name
        captured["instance_id"] = instance_id
        captured["workflow_input"] = workflow_input
        captured["kwargs"] = kwargs
        return "http-started"

    def fail_taskhub(*_args, **_kwargs):
        raise AssertionError("TaskHub gRPC start should not be used by default")

    monkeypatch.delenv("WORKFLOW_ORCHESTRATOR_WORKFLOW_START_METHOD", raising=False)
    monkeypatch.setattr(APP, "_workflow_http_start_instance", fake_http_start)
    monkeypatch.setattr(APP, "_taskhub_call", fail_taskhub)

    result = APP._schedule_new_workflow_instance(
        "sw_workflow_v1",
        "sw-test-exec-123",
        {"input": True},
        workflow_version="1.0.0",
        parent_trace_context={"traceparent": "00-" + ("1" * 32) + "-" + ("2" * 16) + "-01"},
    )

    assert result == "http-started"
    assert captured["workflow_name"] == "sw_workflow_v1"
    assert captured["instance_id"] == "sw-test-exec-123"
    assert captured["workflow_input"] == {"input": True}
    assert captured["kwargs"]["parent_trace_context"]["traceparent"].startswith("00-")


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
        trigger_data={"prompt": "Create a validation marker"},
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
                "agentConfig": {"name": "durable-validation"},
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
    assert bridge_payload["agentConfig"]["name"] == "durable-validation"
    assert bridge_payload["timeoutMinutes"] == 15
    assert bridge_payload["maxIterations"] == 8

    wait_yield = workflow_gen.send(
        {
            "childInput": {"sessionId": "child-session"},
            "agentAppId": "agent-runtime-test",
        }
    )
    assert wait_yield["kind"] == "when_any"
    child_task, timer_task = wait_yield["tasks"]
    assert child_task.kind == "call_child_workflow"
    assert child_task.name == "session_workflow"
    assert child_task.app_id == "agent-runtime-test"
    assert timer_task.kind == "timer"

    with pytest.raises(StopIteration) as stop:
        workflow_gen.send(child_task)

    result = stop.value.value
    assert result["success"] is True


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
    child_yield = workflow_gen.send(
        {
            "childInput": {"sessionId": "child-session"},
            "agentAppId": "agent-runtime-test",
        }
    )
    assert child_yield.kind == "call_child_workflow"
    assert child_yield.name == "session_workflow"
    assert child_yield.app_id == "agent-runtime-test"

    with pytest.raises(StopIteration) as stop:
        workflow_gen.send(child_yield)

    result = stop.value.value
    assert result["success"] is True


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

    child_yield = workflow_gen.send(
        {
            "childInput": {"sessionId": "child-session"},
            "agentAppId": "agent-session-abc123",
            "agentHostStatus": "ready",
        }
    )
    assert child_yield.kind == "call_child_workflow"
    assert child_yield.name == "session_workflow"
    assert child_yield.app_id == "agent-session-abc123"

    with pytest.raises(StopIteration) as stop:
        workflow_gen.send(child_yield)

    result = stop.value.value
    assert result["success"] is True


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

    child_yield = workflow_gen.send(
        {
            "childInput": {"sessionId": "child-session"},
            "agentAppId": "agent-session-abc123",
        }
    )
    assert child_yield.kind == "call_child_workflow"
    assert child_yield.name == "session_workflow"
    assert child_yield.app_id == "agent-session-abc123"


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
    )

    assert body["agentHostStatus"] == "ready"
    assert len(posts) == 2
    assert sleeps == [1]


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
