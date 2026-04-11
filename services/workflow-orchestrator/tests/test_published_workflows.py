from __future__ import annotations

import importlib.util
import sys
import types
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

    class _FakeTaskHubSidecarServiceStub:
        def __init__(self, *_args, **_kwargs):
            return None

    pb_module.CreateInstanceRequest = _FakeCreateInstanceRequest
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


def test_durable_run_routes_through_function_router():
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
                "agentRuntime": "openshell-durable-agent",
                "maxTurns": "8",
                "timeoutMinutes": "15",
                "agentConfig": {"name": "durable-validation"},
            },
        },
        tc,
    )

    yielded = next(workflow_gen)
    assert yielded["kind"] == "call_activity"
    assert yielded["activity"] == "execute_action"
    config = yielded["input"]["node"]["config"]
    assert config["actionType"] == "durable/run"
    assert config["prompt"] == "Create a validation marker"
    assert config["workspaceRef"] == "ws_test_123"
    assert config["sandboxName"] == "ws-test-123"
    assert config["cwd"] == "/sandbox/repo"
    assert config["agentRuntime"] == "openshell-durable-agent"
    assert config["maxTurns"] == "8"

    with pytest.raises(StopIteration) as stop:
        workflow_gen.send(
            {
                "success": True,
                "content": "VALIDATION COMPLETE",
            }
        )

    result = stop.value.value
    assert result["success"] is True
