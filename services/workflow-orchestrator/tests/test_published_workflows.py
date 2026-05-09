from __future__ import annotations

import importlib.util
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


class _FakeWorkflowTask:
    def __init__(self, kind, result=None, **attrs):
        self.kind = kind
        self.result = result
        for key, value in attrs.items():
            setattr(self, key, value)

    def get_result(self):
        return self.result


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


def test_readiness_requires_taskhub_but_not_metadata_worker_count(monkeypatch):
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
        db_execution_id=None,
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


def test_benchmark_durable_run_waits_for_queued_agent_session_host_before_child_workflow():
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
        instance_id = "parent-benchmark-wf-queued-host"
        current_utc_datetime = datetime(2026, 5, 8, tzinfo=timezone.utc)

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
                "timeoutMinutes": "1",
                "agentConfig": {"name": "durable-validation"},
            },
        },
        tc,
    )

    yielded = next(workflow_gen)
    assert yielded["activity"] == "spawn_session_for_workflow"

    readiness_timer = workflow_gen.send(
        {
            "childInput": {"sessionId": "child-session"},
            "agentAppId": "agent-session-abc123",
            "agentHostStatus": "queued",
        }
    )
    assert readiness_timer.kind == "timer"
    assert readiness_timer.timeout == timedelta(
        seconds=SW_WORKFLOW.AGENT_SESSION_HOST_READY_POLL_SECONDS
    )

    ctx.current_utc_datetime += readiness_timer.timeout
    recheck = workflow_gen.send(readiness_timer)
    assert recheck["activity"] == "spawn_session_for_workflow"

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
        current_utc_datetime = datetime(2026, 5, 8, tzinfo=timezone.utc)

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
