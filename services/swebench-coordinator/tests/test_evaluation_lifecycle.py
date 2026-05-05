from __future__ import annotations

import importlib.util
import json
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
    monkeypatch.setitem(
        sys.modules,
        "requests",
        types.SimpleNamespace(request=lambda *_args, **_kwargs: None),
    )

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
        types.SimpleNamespace(
            FastAPI=FakeFastAPI, HTTPException=FakeHTTPException, Request=object
        ),
    )
    monkeypatch.setitem(
        sys.modules, "pydantic", types.SimpleNamespace(BaseModel=FakeBaseModel)
    )

    module_path = SERVICE_ROOT / "src" / "app.py"
    spec = importlib.util.spec_from_file_location(
        "swebench_coordinator_app_test", module_path
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_cancel_benchmark_run_terminates_child_instance_workflows(monkeypatch):
    app = load_app(monkeypatch)
    app.INTERNAL_API_TOKEN = "token"
    terminated: list[tuple[str, str | None]] = []
    status_updates: list[dict[str, str]] = []
    lease_releases: list[dict[str, str]] = []

    class RecordingWorkflowClient:
        def terminate_workflow(self, *, instance_id, output=None):
            terminated.append((instance_id, output))

    monkeypatch.setattr(app, "DaprWorkflowClient", RecordingWorkflowClient)
    monkeypatch.setattr(app, "_delete_evaluator_job", lambda *_args, **_kwargs: {"success": True})
    monkeypatch.setattr(
        app,
        "_mark_run_status",
        lambda _ctx, data: status_updates.append(data) or {"success": True},
    )
    monkeypatch.setattr(
        app,
        "_release_run_leases",
        lambda _ctx, data: lease_releases.append(data) or {"released": 5},
    )
    monkeypatch.setattr(
        app,
        "_load_run",
        lambda run_id: {
            "id": run_id,
            "selectedInstanceIds": ["django__django-12754", "django__django-12965"],
            "instances": [],
        },
    )

    request = types.SimpleNamespace(headers={"x-internal-token": "token"})
    result = app.cancel_benchmark_run(
        "run_1",
        request,
        app.CancelRunRequest(reason="operator stop"),
    )

    terminated_ids = [item[0] for item in terminated]
    assert "swebench-run-run_1" in terminated_ids
    assert "swebench-eval-run_1" in terminated_ids
    assert app._child_instance_workflow_id("run_1", "django__django-12754") in terminated_ids
    assert app._child_instance_workflow_id("run_1", "django__django-12965") in terminated_ids
    assert result["childTermination"]["selectedInstanceCount"] == 2
    assert result["childTermination"]["terminated"] == 2
    assert result["childTermination"]["terminationErrors"] == {}
    assert status_updates == [
        {
            "runId": "run_1",
            "status": "cancelled",
            "error": "operator stop",
        }
    ]
    assert lease_releases == [{"runId": "run_1", "reason": "operator stop"}]
    assert result["leaseRelease"] == {"released": 5}


class Obj:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class FakeWorkflowCtx:
    def __init__(self):
        self.calls = []

    def call_activity(self, fn, *, input=None):
        marker = ("activity", fn.__name__, input)
        self.calls.append(marker)
        return marker

    def call_child_workflow(self, name, *, input=None, instance_id=None, app_id=None):
        marker = ("child", name, input, instance_id, app_id)
        self.calls.append(marker)
        return marker

    def create_timer(self, delta):
        marker = ("timer", int(delta.total_seconds()))
        self.calls.append(marker)
        return marker


def test_ensure_evaluator_job_treats_already_exists_as_success(monkeypatch):
    app = load_app(monkeypatch)

    class ApiException(Exception):
        def __init__(self, status: int):
            super().__init__(f"status={status}")
            self.status = status

    monkeypatch.setitem(sys.modules, "kubernetes", types.ModuleType("kubernetes"))
    monkeypatch.setitem(
        sys.modules, "kubernetes.client", types.ModuleType("kubernetes.client")
    )
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
    monkeypatch.setattr(
        app, "_load_kubernetes_clients", lambda: (FakeClient, batch, None)
    )
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
            "evaluationConcurrency": 7,
            "instances": [
                {
                    "instanceId": "sympy__sympy-20590",
                    "inferenceEnvironment": {
                        "sandboxImage": "ghcr.io/example/swebench:env",
                    },
                }
            ],
        },
    )
    marked = {}
    monkeypatch.setattr(
        app, "_mark_run_status", lambda _ctx, data: marked.update(data) or {"run": data}
    )

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
        "evaluationMaxParallel": 7,
        "activeDeadlineSeconds": 1320,
    }
    assert marked["status"] == "evaluating"
    assert marked["evaluatorJobName"] == job_name
    assert batch.body.spec.active_deadline_seconds == 1320
    evaluator = batch.body.spec.template.spec.containers[0]
    env = {item.name: getattr(item, "value", None) for item in evaluator.env}
    env_sources = {
        item.name: getattr(item, "value_from", None) for item in evaluator.env
    }
    assert env["DATASET_NAME"] == "/artifacts/run_abc/dataset.jsonl"
    assert env["SWEBENCH_EVAL_MAX_PARALLEL"] == "7"
    assert env["SWEBENCH_EVALUATOR_JOB_NAME"] == job_name
    assert env["INTERNAL_API_TOKEN"] is None
    token_source = env_sources["INTERNAL_API_TOKEN"].secret_key_ref
    assert token_source.name == "workflow-builder-secrets"
    assert token_source.key == "INTERNAL_API_TOKEN"
    assert len(job_name) <= 63


def test_ensure_evaluator_job_skips_terminal_run(monkeypatch):
    app = load_app(monkeypatch)
    monkeypatch.setattr(
        app,
        "_load_run",
        lambda run_id: {
            "id": run_id,
            "status": "cancelled",
            "selectedInstanceIds": ["sympy__sympy-20590"],
        },
    )
    monkeypatch.setattr(
        app,
        "_load_kubernetes_clients",
        lambda: (_ for _ in ()).throw(AssertionError("should not create a Job")),
    )

    result = app._ensure_evaluator_job(
        None,
        {
            "runId": "Run_ABC",
            "predictionsPath": "/artifacts/predictions.jsonl",
            "datasetPath": "/artifacts/run_abc/dataset.jsonl",
        },
    )

    assert result == {
        "jobName": app._evaluator_job_name("Run_ABC"),
        "skipped": True,
        "reason": "run-terminal",
        "runStatus": "cancelled",
    }


def test_mark_run_status_retries_bff_updates(monkeypatch):
    app = load_app(monkeypatch)
    captured = {}

    def fake_bff_with_retry(method, path, json_body=None, timeout=60, **_kwargs):
        captured.update(
            {
                "method": method,
                "path": path,
                "json": json_body,
                "timeout": timeout,
            }
        )
        return {"run": {"status": json_body["status"]}}

    monkeypatch.setattr(app, "_bff_with_retry", fake_bff_with_retry)

    result = app._mark_run_status(
        None,
        {
            "runId": "run_1",
            "status": "evaluating",
            "evaluatorJobName": "job-1",
        },
    )

    assert result == {"run": {"status": "evaluating"}}
    assert captured == {
        "method": "POST",
        "path": "/api/internal/benchmarks/runs/run_1/status",
        "json": {"status": "evaluating", "evaluatorJobName": "job-1"},
        "timeout": 60,
    }


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


def test_write_evaluation_dataset_uses_bff_jsonl_and_records_artifact(
    monkeypatch, tmp_path
):
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
        )
        or {"success": True},
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


def test_write_predictions_keeps_only_official_prediction_fields(monkeypatch, tmp_path):
    app = load_app(monkeypatch)
    monkeypatch.setattr(app, "ARTIFACT_ROOT", tmp_path)
    monkeypatch.setattr(app, "_mlflow_log_artifact", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        app,
        "_load_run",
        lambda _run_id: {
            "id": "run_1",
            "modelNameOrPath": "agent-v1",
            "mlflowRunId": "mlflow_1",
            "instances": [
                {
                    "instanceId": "sympy__sympy-20590",
                    "modelPatch": "diff --git a/sympy/core/add.py b/sympy/core/add.py\n",
                    "testMetadata": {
                        "test_patch": "diff --git a/sympy/tests/test_add.py b/sympy/tests/test_add.py\n",
                        "FAIL_TO_PASS": ["sympy/tests/test_add.py::test_regression"],
                        "PASS_TO_PASS": ["sympy/tests/test_add.py::test_existing"],
                    },
                    "goldPatch": "diff --git a/sympy/core/add.py b/sympy/core/add.py\n",
                }
            ],
        },
    )
    posted = {}
    monkeypatch.setattr(
        app,
        "_bff",
        lambda method, path, json_body=None, timeout=60: posted.update(
            {"method": method, "path": path, "json": json_body}
        )
        or {"success": True},
    )

    result = app._write_predictions(None, {"runId": "run_1"})

    record = json.loads(
        (tmp_path / "run_1" / "predictions.jsonl").read_text(encoding="utf-8")
    )
    assert record == {
        "instance_id": "sympy__sympy-20590",
        "model_name_or_path": "agent-v1",
        "model_patch": "diff --git a/sympy/core/add.py b/sympy/core/add.py\n",
    }
    assert "test_patch" not in json.dumps(record)
    assert "FAIL_TO_PASS" not in json.dumps(record)
    assert "goldPatch" not in json.dumps(record)
    assert posted["path"] == "/api/internal/benchmarks/runs/run_1/predictions-artifact"
    assert posted["json"] == {"path": str(tmp_path / "run_1" / "predictions.jsonl")}
    assert result["bytes"] > 0


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
        )
        or {"success": True},
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


def test_preflight_workflow_persists_validated_environment_map(monkeypatch):
    app = load_app(monkeypatch)
    ctx = FakeWorkflowCtx()
    run = {
        "id": "run_1",
        "suiteSlug": "SWE-bench_Lite",
        "datasetName": "princeton-nlp/SWE-bench_Lite",
        "selectedInstanceIds": ["sympy__sympy-20590"],
        "summary": {"capacity": {"effectiveConcurrency": 5}},
        "instances": [
            {
                "instanceId": "sympy__sympy-20590",
                "repo": "sympy/sympy",
                "baseCommit": "abc123",
                "problemStatement": "Fix it",
                "testMetadata": {"version": "1.7"},
            }
        ],
    }
    environment = {
        "environmentStatus": "validated",
        "environmentKey": "sympy-1.7",
        "envSpecHash": "a" * 64,
        "sandboxTemplate": "dapr-agent",
        "sandboxImage": "ghcr.io/example/swebench:env@sha256:" + ("1" * 64),
        "validationStatus": "validated",
    }
    workflow = app.swebench_environment_preflight_workflow(ctx, {"runId": "run_1"})

    assert next(workflow) == ("activity", "_load_run_activity", {"runId": "run_1"})
    assert workflow.send(run) == (
        "activity",
        "_validate_instance_metadata",
        {"runId": "run_1"},
    )
    assert workflow.send({"validated": 1}) == (
        "activity",
        "_load_run_activity",
        {"runId": "run_1"},
    )
    assert workflow.send(run) == (
        "activity",
        "_prepare_instance_environment",
        {
            "suiteSlug": "SWE-bench_Lite",
            "datasetName": "princeton-nlp/SWE-bench_Lite",
            "instanceId": "sympy__sympy-20590",
            "repo": "sympy/sympy",
            "baseCommit": "abc123",
            "testMetadata": {"version": "1.7"},
        },
    )
    assert workflow.send(
        {
            "environmentStatus": "validated",
            "environment": environment,
        }
    ) == (
        "activity",
        "_persist_preflight_results",
        {
            "runId": "run_1",
            "inferenceEnvironmentsByInstanceId": {
                "sympy__sympy-20590": environment
            },
            "preflightSummary": {
                "status": "validated",
                "instanceCount": 1,
                "groupCount": 1,
                "groups": [
                    {
                        "environmentKey": "sympy-1.7",
                        "envSpecHash": "a" * 64,
                        "buildId": None,
                        "sandboxImage": "ghcr.io/example/swebench:env@sha256:"
                        + ("1" * 64),
                        "validationStatus": "validated",
                        "pipelineRunName": None,
                        "pipelineRunNamespace": None,
                        "instanceIds": ["sympy__sympy-20590"],
                    }
                ],
                "capacitySnapshot": {"effectiveConcurrency": 5},
            },
            "capacitySnapshot": {"effectiveConcurrency": 5},
        },
    )
    try:
        workflow.send({"success": True})
    except StopIteration as stop:
        assert stop.value["validatedInstances"] == 1
        assert stop.value["persisted"] == {"success": True}
    else:
        raise AssertionError("workflow should have completed")


def test_prepare_instance_environment_requests_explicit_build_permission(monkeypatch):
    app = load_app(monkeypatch)
    captured = {}

    def fake_bff_with_retry(
        method,
        path,
        json_body=None,
        timeout=60,
        attempts=1,
        delay_seconds=1,
    ):
        captured.update(
            {
                "method": method,
                "path": path,
                "json": json_body,
                "timeout": timeout,
                "attempts": attempts,
                "delaySeconds": delay_seconds,
            }
        )
        return {"success": True}

    monkeypatch.setattr(app, "_bff_with_retry", fake_bff_with_retry)

    result = app._prepare_instance_environment(
        None,
        {
            "suiteSlug": "SWE-bench_Verified",
            "datasetName": "princeton-nlp/SWE-bench_Verified",
            "instanceId": "django__django-12754",
            "repo": "django/django",
            "baseCommit": "abc123",
            "testMetadata": {"version": "3.2"},
        },
    )

    assert result == {"success": True}
    assert captured["method"] == "POST"
    assert captured["path"] == "/api/internal/environments/ensure"
    assert captured["json"]["allowBuild"] is True
    assert captured["json"]["suiteSlug"] == "SWE-bench_Verified"
    assert captured["json"]["instanceId"] == "django__django-12754"


def test_run_workflow_starts_preflight_before_marking_inferencing(monkeypatch):
    app = load_app(monkeypatch)
    ctx = FakeWorkflowCtx()
    workflow = app.swebench_run_workflow(ctx, {"runId": "run_1"})

    first = next(workflow)
    assert first == (
        "child",
        "swebench_environment_preflight_workflow",
        {"runId": "run_1"},
        app._preflight_workflow_id("run_1"),
        app.SWEBENCH_COORDINATOR_APP_ID,
    )
    assert workflow.send({"validatedInstances": 1}) == (
        "activity",
        "_load_run_activity",
        {"runId": "run_1"},
    )
    run = {
        "id": "run_1",
        "selectedInstanceIds": [],
        "concurrency": 1,
        "timeoutSeconds": 60,
        "evaluationConcurrency": 1,
    }
    assert workflow.send(run) == (
        "activity",
        "_mark_run_status",
        {"runId": "run_1", "status": "inferencing"},
    )


def test_run_workflow_stops_when_status_mark_returns_terminal(monkeypatch):
    app = load_app(monkeypatch)
    ctx = FakeWorkflowCtx()
    workflow = app.swebench_run_workflow(ctx, {"runId": "run_1"})
    assert next(workflow)[0] == "child"
    assert workflow.send({"validatedInstances": 1}) == (
        "activity",
        "_load_run_activity",
        {"runId": "run_1"},
    )
    run = {
        "id": "run_1",
        "selectedInstanceIds": ["django__django-12754"],
        "concurrency": 1,
        "timeoutSeconds": 60,
        "evaluationConcurrency": 1,
    }
    assert workflow.send(run) == (
        "activity",
        "_mark_run_status",
        {"runId": "run_1", "status": "inferencing"},
    )
    try:
        workflow.send({"success": True, "run": {"status": "cancelled"}})
    except StopIteration as stop:
        assert stop.value == {
            "success": False,
            "skipped": True,
            "reason": "run-terminal",
            "runStatus": "cancelled",
        }
    else:
        raise AssertionError("workflow should stop after terminal status")


def test_run_workflow_acquires_and_releases_instance_leases(monkeypatch):
    app = load_app(monkeypatch)
    monkeypatch.setattr(app, "wf_when_any", None)
    ctx = FakeWorkflowCtx()
    workflow = app.swebench_run_workflow(ctx, {"runId": "run_1"})

    assert next(workflow)[0] == "child"
    assert workflow.send({"validatedInstances": 1}) == (
        "activity",
        "_load_run_activity",
        {"runId": "run_1"},
    )
    run = {
        "id": "run_1",
        "selectedInstanceIds": ["django__django-12754"],
        "concurrency": 1,
        "timeoutSeconds": 60,
        "evaluationConcurrency": 1,
    }
    assert workflow.send(run) == (
        "activity",
        "_mark_run_status",
        {"runId": "run_1", "status": "inferencing"},
    )
    assert workflow.send({"success": True, "run": {"status": "inferencing"}}) == (
        "activity",
        "_acquire_instance_leases",
        {"runId": "run_1", "instanceId": "django__django-12754"},
    )
    assert workflow.send({"admitted": True, "holderId": "lease-holder"}) == (
        "child",
        "swebench_instance_workflow",
        {
            "runId": "run_1",
            "instanceId": "django__django-12754",
            "timeoutSeconds": 60,
        },
        app._child_instance_workflow_id("run_1", "django__django-12754"),
        app.SWEBENCH_COORDINATOR_APP_ID,
    )
    assert workflow.send(
        {"instanceId": "django__django-12754", "status": "inferred"}
    ) == (
        "activity",
        "_release_instance_leases",
        {
            "runId": "run_1",
            "instanceId": "django__django-12754",
            "holderId": "lease-holder",
            "phase": "inference",
            "reason": "instance workflow completed",
        },
    )
    assert workflow.send({"released": 5}) == (
        "activity",
        "_release_run_leases",
        {"runId": "run_1", "reason": "inference fan-out completed"},
    )


def test_run_workflow_waits_on_openshell_sandbox_admission_before_child(monkeypatch):
    app = load_app(monkeypatch)
    monkeypatch.setattr(app, "wf_when_any", None)
    ctx = FakeWorkflowCtx()
    workflow = app.swebench_run_workflow(ctx, {"runId": "run_1"})

    assert next(workflow)[0] == "child"
    assert workflow.send({"validatedInstances": 1}) == (
        "activity",
        "_load_run_activity",
        {"runId": "run_1"},
    )
    run = {
        "id": "run_1",
        "selectedInstanceIds": ["django__django-12754"],
        "concurrency": 1,
        "timeoutSeconds": 60,
        "evaluationConcurrency": 1,
    }
    assert workflow.send(run) == (
        "activity",
        "_mark_run_status",
        {"runId": "run_1", "status": "inferencing"},
    )
    assert workflow.send({"success": True, "run": {"status": "inferencing"}}) == (
        "activity",
        "_acquire_instance_leases",
        {"runId": "run_1", "instanceId": "django__django-12754"},
    )

    assert workflow.send(
        {
            "admitted": False,
            "blockedBy": "openshell_sandbox",
            "reason": "capacity_exhausted",
            "retryAfterSeconds": 12,
        }
    ) == ("timer", 12)
    assert not any(
        call[0] == "child" and call[1] == "swebench_instance_workflow"
        for call in ctx.calls
    )
    assert workflow.send(None) == (
        "activity",
        "_acquire_instance_leases",
        {"runId": "run_1", "instanceId": "django__django-12754"},
    )


def test_run_workflow_batches_instance_child_starts(monkeypatch):
    app = load_app(monkeypatch)
    monkeypatch.setenv("SWEBENCH_COORDINATOR_INSTANCE_START_BATCH_SIZE", "1")
    monkeypatch.setenv("SWEBENCH_COORDINATOR_INSTANCE_START_BATCH_DELAY_SECONDS", "7")
    monkeypatch.setattr(app, "wf_when_any", None)
    ctx = FakeWorkflowCtx()
    workflow = app.swebench_run_workflow(ctx, {"runId": "run_1"})

    assert next(workflow)[0] == "child"
    assert workflow.send({"validatedInstances": 2}) == (
        "activity",
        "_load_run_activity",
        {"runId": "run_1"},
    )
    run = {
        "id": "run_1",
        "selectedInstanceIds": ["django__django-12754", "django__django-13012"],
        "concurrency": 2,
        "timeoutSeconds": 60,
        "evaluationConcurrency": 1,
    }
    assert workflow.send(run) == (
        "activity",
        "_mark_run_status",
        {"runId": "run_1", "status": "inferencing"},
    )
    assert workflow.send({"success": True, "run": {"status": "inferencing"}}) == (
        "activity",
        "_acquire_instance_leases",
        {"runId": "run_1", "instanceId": "django__django-12754"},
    )

    assert workflow.send({"admitted": True, "holderId": "lease-1"}) == ("timer", 7)
    assert any(
        call[0] == "child"
        and call[1] == "swebench_instance_workflow"
        and call[2]["instanceId"] == "django__django-12754"
        for call in ctx.calls
    )
    assert not any(
        call[0] == "child"
        and call[1] == "swebench_instance_workflow"
        and call[2]["instanceId"] == "django__django-13012"
        for call in ctx.calls
    )

    assert workflow.send(None) == (
        "activity",
        "_acquire_instance_leases",
        {"runId": "run_1", "instanceId": "django__django-13012"},
    )
    assert workflow.send({"admitted": True, "holderId": "lease-2"}) == (
        "child",
        "swebench_instance_workflow",
        {
            "runId": "run_1",
            "instanceId": "django__django-12754",
            "timeoutSeconds": 60,
        },
        app._child_instance_workflow_id("run_1", "django__django-12754"),
        app.SWEBENCH_COORDINATOR_APP_ID,
    )


def test_registered_child_workflow_target_validation(monkeypatch):
    app = load_app(monkeypatch)
    assert (
        app._registered_child_workflow_name("swebench_instance_workflow")
        == "swebench_instance_workflow"
    )
    assert app._registered_child_workflow_app_id("swebench-coordinator") == (
        "swebench-coordinator"
    )

    try:
        app._registered_child_workflow_name("missing_workflow")
    except RuntimeError as exc:
        assert "unregistered SWE-bench child workflow target" in str(exc)
    else:
        raise AssertionError("expected missing workflow name to fail")

    try:
        app._registered_child_workflow_app_id("")
    except RuntimeError as exc:
        assert "missing Dapr app id" in str(exc)
    else:
        raise AssertionError("expected missing app id to fail")


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
