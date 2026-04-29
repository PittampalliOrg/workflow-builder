from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]


def load_app(monkeypatch):
    sys.path.insert(0, str(SERVICE_ROOT))

    class FakeRuntime:
        def register_workflow(self, *_args, **_kwargs):
            return None

        def register_activity(self, *_args, **_kwargs):
            return None

        def start(self):
            return None

        def shutdown(self):
            return None

    class FakeWorkflowClient:
        def schedule_new_workflow(self, *_args, **_kwargs):
            return None

        def terminate_workflow(self, *_args, **_kwargs):
            return None

        def raise_workflow_event(self, *_args, **_kwargs):
            return None

    workflow_mod = types.ModuleType("dapr.ext.workflow")
    workflow_mod.WorkflowRuntime = FakeRuntime
    workflow_mod.DaprWorkflowClient = FakeWorkflowClient
    workflow_mod.when_all = lambda tasks: tasks
    workflow_mod.when_any = lambda tasks: tasks[0]
    dapr_mod = types.ModuleType("dapr")
    dapr_ext_mod = types.ModuleType("dapr.ext")
    dapr_ext_mod.workflow = workflow_mod
    monkeypatch.setitem(sys.modules, "dapr", dapr_mod)
    monkeypatch.setitem(sys.modules, "dapr.ext", dapr_ext_mod)
    monkeypatch.setitem(sys.modules, "dapr.ext.workflow", workflow_mod)
    monkeypatch.setitem(sys.modules, "requests", types.SimpleNamespace(request=lambda *_args, **_kwargs: None))

    class FakeFastAPI:
        def __init__(self, *_args, **_kwargs):
            pass

        def get(self, *_args, **_kwargs):
            return lambda fn: fn

        def post(self, *_args, **_kwargs):
            return lambda fn: fn

    class FakeHTTPException(Exception):
        def __init__(self, status_code: int, detail: str):
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail

    class FakeBaseModel:
        def __init__(self, **kwargs):
            for key, value in kwargs.items():
                setattr(self, key, value)

        def model_dump(self, exclude_none: bool = False):
            data = dict(self.__dict__)
            if exclude_none:
                data = {key: value for key, value in data.items() if value is not None}
            return data

    monkeypatch.setitem(
        sys.modules,
        "fastapi",
        types.SimpleNamespace(FastAPI=FakeFastAPI, HTTPException=FakeHTTPException, Request=object),
    )
    monkeypatch.setitem(sys.modules, "pydantic", types.SimpleNamespace(BaseModel=FakeBaseModel))

    module_path = SERVICE_ROOT / "src" / "app.py"
    spec = importlib.util.spec_from_file_location("swebench_coordinator_app_test", module_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Obj:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


def test_ensure_evaluator_job_treats_already_exists_as_success(monkeypatch):
    app = load_app(monkeypatch)

    class ApiException(Exception):
        def __init__(self, status: int):
            super().__init__(f"status={status}")
            self.status = status

    monkeypatch.setitem(sys.modules, "kubernetes", types.ModuleType("kubernetes"))
    monkeypatch.setitem(sys.modules, "kubernetes.client", types.ModuleType("kubernetes.client"))
    monkeypatch.setitem(
        sys.modules,
        "kubernetes.client.rest",
        types.SimpleNamespace(ApiException=ApiException),
    )

    class FakeClient:
        V1EnvVar = Obj
        V1Container = Obj
        V1ResourceRequirements = Obj
        V1VolumeMount = Obj
        V1EnvVarSource = Obj
        V1SecretKeySelector = Obj
        V1SecurityContext = Obj
        V1PodTemplateSpec = Obj
        V1ObjectMeta = Obj
        V1PodSpec = Obj
        V1LocalObjectReference = Obj
        V1Volume = Obj
        V1PersistentVolumeClaimVolumeSource = Obj
        V1EmptyDirVolumeSource = Obj
        V1Job = Obj
        V1JobSpec = Obj

    class FakeBatch:
        def __init__(self):
            self.body = None

        def create_namespaced_job(self, *, namespace, body):
            self.namespace = namespace
            self.body = body
            raise ApiException(409)

    batch = FakeBatch()
    monkeypatch.setattr(app, "_load_kubernetes_clients", lambda: (FakeClient, batch, None))
    monkeypatch.setattr(
        app,
        "_load_run",
        lambda run_id: {
            "id": run_id,
            "suiteSlug": "SWE-bench_Lite",
            "selectedInstanceIds": ["sympy__sympy-20590"],
            "evaluatorResourceClass": "standard",
            "timeoutSeconds": 120,
            "concurrency": 3,
        },
    )
    marked = {}
    monkeypatch.setattr(app, "_mark_run_status", lambda _ctx, data: marked.update(data) or {"run": data})

    result = app._ensure_evaluator_job(
        None,
        {
            "runId": "Run_ABC",
            "predictionsPath": "/artifacts/predictions.jsonl",
            "datasetPath": "/artifacts/run_abc/dataset.jsonl",
        },
    )

    job_name = app._evaluator_job_name("Run_ABC")
    assert result == {
        "jobName": job_name,
        "alreadyExists": True,
        "maxWorkers": 3,
    }
    assert marked["status"] == "evaluating"
    assert marked["evaluatorJobName"] == job_name
    evaluator = batch.body.spec.template.spec.containers[1]
    env = {item.name: getattr(item, "value", None) for item in evaluator.env}
    env_sources = {item.name: getattr(item, "value_from", None) for item in evaluator.env}
    assert env["DATASET_NAME"] == "/artifacts/run_abc/dataset.jsonl"
    assert env["SWEBENCH_MAX_WORKERS"] == "3"
    assert env["SWEBENCH_EVALUATOR_JOB_NAME"] == job_name
    assert env["INTERNAL_API_TOKEN"] is None
    token_source = env_sources["INTERNAL_API_TOKEN"].secret_key_ref
    assert token_source.name == "workflow-builder-secrets"
    assert token_source.key == "INTERNAL_API_TOKEN"
    assert len(job_name) <= 63


def test_validate_instance_metadata_rejects_missing_db_rows(monkeypatch):
    app = load_app(monkeypatch)
    monkeypatch.setattr(
        app,
        "_load_run",
        lambda _run_id: {
            "id": "run_1",
            "suiteName": "SWE-bench Lite",
            "selectedInstanceIds": ["sympy__sympy-20590", "psf__requests-2317"],
            "instances": [
                {
                    "instanceId": "sympy__sympy-20590",
                    "repo": "sympy/sympy",
                    "baseCommit": "abc123",
                    "problemStatement": "Fix it",
                },
                {
                    "instanceId": "psf__requests-2317",
                    "repo": "psf/requests",
                    "baseCommit": None,
                    "problemStatement": "Fix it",
                },
            ],
        },
    )

    try:
        app._validate_instance_metadata(None, {"runId": "run_1"})
    except RuntimeError as exc:
        assert "psf__requests-2317" in str(exc)
        assert "must be imported" in str(exc)
    else:
        raise AssertionError("expected missing metadata to fail validation")


def test_write_evaluation_dataset_uses_bff_jsonl_and_records_artifact(monkeypatch, tmp_path):
    app = load_app(monkeypatch)
    monkeypatch.setattr(app, "ARTIFACT_ROOT", tmp_path)
    requests = []

    monkeypatch.setattr(
        app,
        "_bff_text",
        lambda method, path, timeout=60: requests.append((method, path, timeout))
        or '{"instance_id":"sympy__sympy-20590"}\n',
    )
    posted = {}
    monkeypatch.setattr(
        app,
        "_bff",
        lambda method, path, json_body=None, timeout=60: posted.update(
            {"method": method, "path": path, "json": json_body}
        ) or {"success": True},
    )

    result = app._write_evaluation_dataset(None, {"runId": "run_1"})

    assert result["path"] == str(tmp_path / "run_1" / "dataset.jsonl")
    assert (tmp_path / "run_1" / "dataset.jsonl").read_text(encoding="utf-8") == (
        '{"instance_id":"sympy__sympy-20590"}\n'
    )
    assert requests == [
        ("GET", "/api/internal/benchmarks/runs/run_1/dataset.jsonl", 120)
    ]
    assert posted["path"] == "/api/internal/benchmarks/runs/run_1/dataset-artifact"
    assert posted["json"] == {"path": str(tmp_path / "run_1" / "dataset.jsonl")}


def test_mark_evaluation_timeout_only_marks_active_rows(monkeypatch):
    app = load_app(monkeypatch)
    monkeypatch.setattr(
        app,
        "_load_run",
        lambda _run_id: {
            "id": "run_1",
            "status": "evaluating",
            "selectedInstanceIds": ["resolved", "active", "cancelled"],
            "instances": [
                {"instanceId": "resolved", "status": "resolved"},
                {"instanceId": "active", "status": "evaluating"},
                {"instanceId": "cancelled", "status": "cancelled"},
            ],
        },
    )
    posted = {}
    monkeypatch.setattr(
        app,
        "_bff",
        lambda method, path, json_body=None, timeout=60: posted.update(
            {"method": method, "path": path, "json": json_body, "timeout": timeout}
        ) or {"success": True},
    )

    result = app._mark_evaluation_timeout(None, {"runId": "run_1", "jobName": "job-1"})

    assert result["timedOut"] == 1
    assert posted["path"] == "/api/internal/benchmarks/runs/run_1/evaluation-results"
    assert [row["instance_id"] for row in posted["json"]["results"]] == ["active"]
    assert posted["json"]["results"][0]["status"] == "timeout"


def test_hash_suffixed_names_are_stable_and_collision_resistant(monkeypatch):
    app = load_app(monkeypatch)
    run_id = "Run_" + ("A" * 120)
    similar_a = "django__django-12345678901234567890-a"
    similar_b = "django__django-12345678901234567890-b"

    job_a = app._evaluator_job_name(run_id)
    job_b = app._evaluator_job_name(run_id)
    child_a = app._child_instance_workflow_id(run_id, similar_a)
    child_b = app._child_instance_workflow_id(run_id, similar_b)

    assert job_a == job_b
    assert job_a.startswith("swebench-eval-run-")
    assert len(job_a) <= 63
    assert child_a.startswith("swebench-inst-run-")
    assert child_a != child_b
    assert len(child_a) <= 100
    assert len(child_b) <= 100


def test_start_benchmark_run_is_idempotent_when_workflow_exists(monkeypatch):
    app = load_app(monkeypatch)
    app.INTERNAL_API_TOKEN = "token"

    class ExistingWorkflowClient:
        def schedule_new_workflow(self, *_args, **_kwargs):
            raise RuntimeError("workflow instance already exists")

    monkeypatch.setattr(app, "DaprWorkflowClient", ExistingWorkflowClient)

    response = app.start_benchmark_run(
        app.StartRunRequest(runId="run_1"),
        Obj(headers={"x-internal-token": "token"}),
    )

    assert response == {
        "success": True,
        "executionId": "swebench-run-run_1",
        "alreadyStarted": True,
    }
