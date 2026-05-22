from __future__ import annotations

import importlib.util
import json
import sys
import types
import time
from datetime import datetime, timezone
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]


def load_app(monkeypatch):
    sys.path.insert(0, str(SERVICE_ROOT))

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"success": True}

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
        types.SimpleNamespace(
            request=lambda *_args, **_kwargs: FakeResponse(),
            put=lambda *_args, **_kwargs: FakeResponse(),
        ),
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


def test_otel_tracing_respects_disabled_exporter(monkeypatch):
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://otel-collector:4318")
    monkeypatch.setenv("OTEL_TRACES_EXPORTER", "none")

    app = load_app(monkeypatch)

    assert app._otel_disabled_by() == "OTEL_TRACES_EXPORTER"
    assert app._otel_ready is False


def test_otel_tracing_respects_sdk_disabled(monkeypatch):
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://otel-collector:4318")
    monkeypatch.setenv("OTEL_SDK_DISABLED", "true")

    app = load_app(monkeypatch)

    assert app._otel_disabled_by() == "OTEL_SDK_DISABLED"
    assert app._otel_ready is False


def test_mlflow_trace_id_normalization(monkeypatch):
    app = load_app(monkeypatch)

    assert (
        app._normalize_mlflow_trace_id("abcdefabcdefabcdefabcdefabcdefab")
        == "tr-abcdefabcdefabcdefabcdefabcdefab"
    )
    assert (
        app._normalize_mlflow_trace_id("tr-ABCDEFABCDEFABCDEFABCDEFABCDEFAB")
        == "tr-abcdefabcdefabcdefabcdefabcdefab"
    )
    assert (
        app._normalize_mlflow_trace_id(
            "00-abcdefabcdefabcdefabcdefabcdefab-0123456789abcdef-01"
        )
        == "tr-abcdefabcdefabcdefabcdefabcdefab"
    )
    assert app._normalize_mlflow_trace_id("0" * 32) is None


def test_mlflow_eval_prefers_native_trace_search(monkeypatch):
    app = load_app(monkeypatch)
    searched: list[dict[str, object]] = []

    class FakeFrame:
        empty = False

        def __len__(self):
            return 1

    class FakeEmptyFrame:
        empty = True

        def __len__(self):
            return 0

    class FakeMlflow:
        def get_experiment_by_name(self, name):
            assert name == "workflow-builder/ryzen/traces"
            return types.SimpleNamespace(experiment_id="trace-exp-1")

        def search_traces(self, *, locations, filter_string, include_spans=None):
            assert locations == ["1", "trace-exp-1"]
            assert include_spans is True
            searched.append({"locations": locations, "filter": filter_string})
            if "abcdefabcdefabcdefabcdefabcdefab" in filter_string:
                return FakeFrame()
            raise AssertionError("unexpected trace filter")

    summary: dict[str, object] = {}
    traces = app._search_mlflow_eval_traces(
        FakeMlflow(),
        "1",
        {"id": "run_1", "mlflowTraceExperimentName": "workflow-builder/ryzen/traces"},
        [
            {
                "outputs": {
                    "mlflow_trace_id": "tr-abcdefabcdefabcdefabcdefabcdefab",
                    "trace_ids": [],
                },
                "metadata": {"instance_id": "i1"},
            }
        ],
        summary,
    )

    assert traces is not None
    assert searched
    assert all("tags." not in str(entry["filter"]) for entry in searched)
    assert summary["nativeTraceIds"] == ["tr-abcdefabcdefabcdefabcdefabcdefab"]
    assert summary["nativeTraceCount"] == 1


def test_mlflow_eval_trace_search_falls_back_to_experiment_ids(monkeypatch):
    app = load_app(monkeypatch)
    calls: list[dict[str, object]] = []

    class FakeFrame:
        empty = False

    class FakeMlflow:
        def get_experiment_by_name(self, _name):
            return None

        def search_traces(self, **kwargs):
            calls.append(kwargs)
            if "locations" in kwargs:
                raise TypeError("search_traces() got an unexpected keyword argument 'locations'")
            assert kwargs["experiment_ids"] == ["parent-exp"]
            assert kwargs["filter_string"] == "request_id = 'tr-abcdefabcdefabcdefabcdefabcdefab'"
            assert kwargs["include_spans"] is True
            return FakeFrame()

    summary: dict[str, object] = {}
    traces = app._search_mlflow_eval_traces(
        FakeMlflow(),
        "parent-exp",
        {"id": "run_1"},
        [
            {
                "outputs": {"mlflow_trace_id": "tr-abcdefabcdefabcdefabcdefabcdefab"},
                "metadata": {"instance_id": "i1"},
            }
        ],
        summary,
    )

    assert traces is not None
    assert "locations" in calls[0]
    assert "experiment_ids" in calls[1]


def test_mlflow_eval_trace_row_lookup_restores_swebench_row(monkeypatch):
    app = load_app(monkeypatch)
    row = {
        "outputs": {
            "status": "resolved",
            "evaluation_status": "resolved",
            "model_patch": "diff --git a/sympy/core.py b/sympy/core.py\n+change\n",
            "mlflow_trace_id": "tr-abcdefabcdefabcdefabcdefabcdefab",
        },
        "metadata": {"instance_id": "sympy__sympy-20590"},
    }
    lookup = app._mlflow_eval_trace_row_lookup([row])
    summary: dict[str, object] = {}

    trace = types.SimpleNamespace(
        info=types.SimpleNamespace(request_id="tr-abcdefabcdefabcdefabcdefabcdefab")
    )
    resolved = app._mlflow_eval_row_for_trace(trace, lookup, summary)

    assert resolved is row
    assert app._row_scorer_values(resolved)["swebench_harness_resolved"] is True
    assert app._row_scorer_values(resolved)["patch_present_and_well_formed"] is True


def test_mlflow_eval_missing_trace_row_mapping_is_recorded(monkeypatch):
    app = load_app(monkeypatch)
    summary: dict[str, object] = {}

    trace = {"request_id": "tr-deadbeefdeadbeefdeadbeefdeadbeef"}
    resolved = app._mlflow_eval_row_for_trace(trace, {}, summary)

    assert resolved is None
    assert summary["missingNativeTraceRowIds"] == [
        "tr-deadbeefdeadbeefdeadbeefdeadbeef"
    ]
    assert summary["missingNativeTraceRowCount"] == 1


def test_mlflow_eval_proxy_trace_is_created_and_linked(monkeypatch):
    app = load_app(monkeypatch)
    source_trace_id = "tr-abcdefabcdefabcdefabcdefabcdefab"
    proxy_trace_id = "tr-fedcbafedcbafedcbafedcbafedcbafe"
    row = {
        "inputs": {
            "problem_statement": "Fix it",
            "repo": "sympy/sympy",
            "base_commit": "abc",
        },
        "outputs": {
            "status": "resolved",
            "evaluation_status": "resolved",
            "model_patch": "diff --git a/sympy/core.py b/sympy/core.py\n+change\n",
            "mlflow_trace_id": source_trace_id,
        },
        "metadata": {
            "run_id": "run_1",
            "run_instance_id": "ri_1",
            "instance_id": "sympy__sympy-20590",
            "mlflow_run_id": "child_run_1",
        },
    }
    linked: list[tuple[tuple[str, ...], str]] = []
    ended: list[str] = []

    class FakeFrame:
        empty = False

        def __len__(self):
            return 1

    class FakeMlflow:
        def flush_trace_async_logging(self):
            pass

        def search_traces(self, *, locations, filter_string, include_spans=None):
            assert locations == ["8"]
            assert filter_string == f"request_id = '{proxy_trace_id}'"
            assert include_spans is True
            return FakeFrame()

    class FakeClient:
        def start_trace(self, **kwargs):
            assert kwargs["experiment_id"] == "8"
            assert kwargs["tags"]["workflow_builder.source_mlflow_trace_id"] == source_trace_id
            return types.SimpleNamespace(trace_id=proxy_trace_id)

        def end_trace(self, trace_id, **_kwargs):
            ended.append(trace_id)

        def link_traces_to_run(self, *, trace_ids, run_id):
            linked.append((tuple(trace_ids), run_id))

    summary: dict[str, object] = {}
    lookup = app._mlflow_eval_trace_row_lookup([row])

    frame = app._mlflow_create_eval_trace_proxies(
        FakeMlflow(),
        FakeClient(),
        "8",
        "parent_run_1",
        "eval_run_1",
        [row],
        lookup,
        summary,
    )

    assert frame is not None
    assert ended == [proxy_trace_id]
    assert lookup[proxy_trace_id] is row
    assert (tuple([proxy_trace_id]), "eval_run_1") in linked
    assert (tuple([proxy_trace_id]), "parent_run_1") in linked
    assert summary["evalProxyTraceIds"] == [proxy_trace_id]


def test_mlflow_trace_link_uses_rest_fallback(monkeypatch):
    monkeypatch.setenv("MLFLOW_TRACKING_URI", "http://mlflow.test")
    app = load_app(monkeypatch)
    app.MLFLOW_TRACKING_URI = "http://mlflow.test"
    posts: list[tuple[str, dict[str, object], int]] = []

    class FakeResponse:
        status_code = 200
        text = "{}"

    def fake_post(url, json=None, timeout=10):
        posts.append((url, json, timeout))
        return FakeResponse()

    class FakeClient:
        def link_traces_to_run(self, **_kwargs):
            raise AttributeError("link_traces_to_run unavailable")

    monkeypatch.setattr(app.requests, "post", fake_post, raising=False)
    summary: dict[str, object] = {}

    app._mlflow_link_traces_to_runs(
        FakeClient(),
        ["tr-abcdefabcdefabcdefabcdefabcdefab"],
        ["run_1"],
        summary,
    )

    assert posts == [
        (
            "http://mlflow.test/api/2.0/mlflow/traces/link-to-run",
            {
                "trace_ids": ["tr-abcdefabcdefabcdefabcdefabcdefab"],
                "run_id": "run_1",
            },
            10,
        )
    ]
    assert summary["linkedEvalTraceRunIds"] == ["run_1"]


def test_cancel_benchmark_run_terminates_child_instance_workflows(monkeypatch):
    app = load_app(monkeypatch)
    app.INTERNAL_API_TOKEN = "token"
    terminated: list[tuple[str, str | None]] = []
    status_updates: list[dict[str, str]] = []
    lease_releases: list[dict[str, str]] = []
    terminal_cleanups: list[dict[str, str]] = []

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
        "_retry_run_terminal_cleanup",
        lambda _ctx, data: terminal_cleanups.append(data)
        or {
            "success": True,
            "background": True,
            "run": {"id": data["runId"], "status": "cancelled"},
        },
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
    assert result["childTermination"]["workflowExecutionCount"] == 2
    assert result["childTermination"]["terminated"] == 2
    assert result["childTermination"]["terminationErrors"] == {}
    assert status_updates == [
        {
            "runId": "run_1",
            "status": "cancelled",
            "error": "operator stop",
        }
    ]
    assert lease_releases == []
    assert terminal_cleanups == [{"runId": "run_1"}]
    assert result["leaseRelease"]["success"] is True
    assert result["leaseRelease"]["background"] is True
    assert result["leaseRelease"]["run"]["status"] == "cancelled"


def test_child_instance_cancel_uses_recorded_workflow_execution_ids(monkeypatch):
    app = load_app(monkeypatch)
    terminated: list[tuple[str, str | None]] = []

    class RecordingWorkflowClient:
        def terminate_workflow(self, *, instance_id, output=None):
            terminated.append((instance_id, output))

    monkeypatch.setattr(
        app,
        "_load_run",
        lambda run_id: {
            "id": run_id,
            "selectedInstanceIds": ["django__django-12754", "django__django-12965"],
            "instances": [
                {
                    "instanceId": "django__django-12754",
                    "workflowExecutionId": "sw-swebench-instance-exec-a",
                    "daprInstanceId": "sw-swebench-instance-exec-a",
                },
                {
                    "instance_id": "django__django-12965",
                    "workflow_execution_id": "sw-swebench-instance-exec-b",
                    "dapr_instance_id": "sw-swebench-instance-dapr-b",
                },
                {
                    "instanceId": "sympy__sympy-20590",
                    "workflowExecutionId": "sw-swebench-instance-exec-ignored",
                },
            ],
        },
    )

    result = app._cancel_child_instance_workflows(
        RecordingWorkflowClient(),
        "run_2",
        "operator stop",
    )

    terminated_ids = [item[0] for item in terminated]
    assert terminated_ids == [
        "sw-swebench-instance-exec-a",
        "sw-swebench-instance-exec-b",
        "sw-swebench-instance-dapr-b",
        app._child_instance_workflow_id("run_2", "django__django-12754"),
        app._child_instance_workflow_id("run_2", "django__django-12965"),
    ]
    assert all(item[1] == "operator stop" for item in terminated)
    assert result["selectedInstanceCount"] == 2
    assert result["workflowExecutionCount"] == 5
    assert result["terminated"] == 5
    assert result["terminationErrors"] == {}


class Obj:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class FakeWorkflowCtx:
    def __init__(self):
        self.calls = []
        self.current_utc_datetime = datetime(2026, 1, 1, tzinfo=timezone.utc)

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


def test_evaluation_workflow_deletes_job_after_terminal_progress(monkeypatch):
    app = load_app(monkeypatch)
    monkeypatch.setattr(app, "wf_when_any", None)
    ctx = FakeWorkflowCtx()
    workflow = app.swebench_evaluation_workflow(
        ctx,
        {
            "runId": "run_1",
            "predictionsPath": "/artifacts/run_1/predictions.jsonl",
            "datasetPath": "/artifacts/run_1/dataset.jsonl",
            "timeoutSeconds": 60,
            "evaluationMaxParallel": 1,
            "instanceCount": 1,
        },
    )

    assert next(workflow) == (
        "activity",
        "_ensure_evaluator_job",
        {
            "runId": "run_1",
            "predictionsPath": "/artifacts/run_1/predictions.jsonl",
            "datasetPath": "/artifacts/run_1/dataset.jsonl",
        },
    )
    assert workflow.send({"jobName": "swebench-eval-run_1"}) == (
        "activity",
        "_load_evaluation_progress",
        {"runId": "run_1"},
    )
    terminal_progress = {
        "runStatus": "completed",
        "activeEvaluationRows": 0,
    }
    assert workflow.send(terminal_progress) == (
        "activity",
        "_delete_evaluator_job",
        {
            "runId": "run_1",
            "jobName": "swebench-eval-run_1",
            "reason": "evaluation rows reached terminal state",
        },
    )
    assert workflow.send({"success": True, "deleted": True}) == (
        "activity",
        "_run_mlflow_swebench_eval",
        {"runId": "run_1"},
    )
    try:
        workflow.send({"success": True, "mlflowEvalRunId": "eval_run_1"})
    except StopIteration as stop:
        assert stop.value == {
            "success": True,
            "jobName": "swebench-eval-run_1",
            "progress": terminal_progress,
            "deleteResult": {"success": True, "deleted": True},
            "mlflowEvaluation": {"success": True, "mlflowEvalRunId": "eval_run_1"},
        }
    else:
        raise AssertionError("expected evaluation workflow to complete")


def test_evaluation_workflow_deletes_failed_job_after_timeout_mark(monkeypatch):
    app = load_app(monkeypatch)
    monkeypatch.setattr(app, "wf_when_any", None)
    ctx = FakeWorkflowCtx()
    workflow = app.swebench_evaluation_workflow(
        ctx,
        {
            "runId": "run_1",
            "predictionsPath": "/artifacts/run_1/predictions.jsonl",
            "datasetPath": "/artifacts/run_1/dataset.jsonl",
            "timeoutSeconds": 60,
            "evaluationMaxParallel": 1,
            "instanceCount": 1,
        },
    )

    assert next(workflow)[0] == "activity"
    assert workflow.send({"jobName": "swebench-eval-run_1"}) == (
        "activity",
        "_load_evaluation_progress",
        {"runId": "run_1"},
    )
    assert workflow.send({"runStatus": "evaluating", "activeEvaluationRows": 1}) == (
        "activity",
        "_get_evaluator_job_status",
        {"runId": "run_1", "jobName": "swebench-eval-run_1"},
    )
    assert workflow.send({"failed": True, "message": "BackoffLimitExceeded"}) == (
        "activity",
        "_mark_evaluation_failure",
        {
            "runId": "run_1",
            "jobName": "swebench-eval-run_1",
            "error": "BackoffLimitExceeded",
        },
    )
    assert workflow.send({"success": True, "skipped": True}) == (
        "activity",
        "_load_evaluation_progress",
        {"runId": "run_1"},
    )
    assert workflow.send({"runStatus": "evaluating", "activeEvaluationRows": 1}) == (
        "activity",
        "_mark_evaluation_timeout",
        {
            "runId": "run_1",
            "jobName": "swebench-eval-run_1",
            "error": "SWE-bench evaluator job failed before all active rows completed",
        },
    )
    assert workflow.send({"success": True, "timedOut": 1}) == (
        "activity",
        "_delete_evaluator_job",
        {
            "runId": "run_1",
            "jobName": "swebench-eval-run_1",
            "reason": "evaluation job failed after partial results",
        },
    )
    try:
        workflow.send({"success": True, "deleted": True})
    except StopIteration as stop:
        assert stop.value == {
            "success": True,
            "timedOut": 1,
            "deleteResult": {"success": True, "deleted": True},
        }
    else:
        raise AssertionError("expected evaluation workflow to complete")


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

    assert result == {
        "success": True,
        "run": {"id": None, "status": "evaluating", "error": None},
    }
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
    monkeypatch.setenv("SWEBENCH_EVALUATOR_ARTIFACT_MODE", "pvc")
    monkeypatch.setenv("MLFLOW_ENABLED", "false")
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


def test_write_jsonl_preview_artifact_creates_json_array(monkeypatch, tmp_path):
    app = load_app(monkeypatch)
    jsonl_path = tmp_path / "dataset.jsonl"
    jsonl_path.write_text('{"a":1}\n{"b":2}\n', encoding="utf-8")

    preview_path = app._write_jsonl_preview_artifact(jsonl_path)

    assert preview_path == tmp_path / "dataset.preview.json"
    assert json.loads(preview_path.read_text(encoding="utf-8")) == [{"a": 1}, {"b": 2}]


def test_write_predictions_keeps_only_official_prediction_fields(monkeypatch, tmp_path):
    monkeypatch.setenv("SWEBENCH_EVALUATOR_ARTIFACT_MODE", "pvc")
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


def test_mlflow_artifact_logging_has_hard_timeout(monkeypatch, tmp_path):
    monkeypatch.setenv("MLFLOW_TRACKING_URI", "http://mlflow.example")
    monkeypatch.setenv("MLFLOW_ARTIFACT_TIMEOUT_SECONDS", "0.1")
    app = load_app(monkeypatch)
    artifact = tmp_path / "predictions.jsonl"
    artifact.write_text("{}", encoding="utf-8")

    def slow_upload(*_args, **_kwargs):
        time.sleep(5)

    monkeypatch.setattr(app, "_mlflow_log_artifact_sync", slow_upload)

    started = time.monotonic()
    app._mlflow_log_artifact("mlflow_run", artifact, "swebench")
    elapsed = time.monotonic() - started

    assert elapsed < 1


def test_load_run_activity_returns_compact_workflow_payload(monkeypatch):
    app = load_app(monkeypatch)
    large_patch = "diff --git a/file.py b/file.py\n" + ("+" * 100_000)
    monkeypatch.setattr(
        app,
        "_load_run",
        lambda _run_id: {
            "id": "run_1",
            "status": "inferencing",
            "suiteSlug": "SWE-bench_Lite",
            "datasetName": "princeton-nlp/SWE-bench_Lite",
            "selectedInstanceIds": ["sympy__sympy-20590"],
            "concurrency": 5,
            "evaluationConcurrency": 5,
            "summary": {
                "capacity": {"effectiveConcurrency": 5},
                "preflight": {"groups": [{"large": "x" * 100_000}]},
            },
            "instances": [
                {
                    "id": "bri_1",
                    "instanceId": "sympy__sympy-20590",
                    "status": "inferred",
                    "repo": "sympy/sympy",
                    "baseCommit": "abc123",
                    "problemStatement": "Fix it" * 10_000,
                    "testMetadata": {"version": "1.7"},
                    "modelPatch": large_patch,
                    "goldPatch": large_patch,
                    "harnessResult": {"stdout": "x" * 100_000},
                }
            ],
            "artifacts": [{"path": "/tmp/large", "payload": "x" * 100_000}],
        },
    )

    result = app._load_run_activity(None, {"runId": "run_1"})
    encoded = json.dumps(result)

    assert result["summary"] == {"capacity": {"effectiveConcurrency": 5}}
    assert result["instances"][0]["repo"] == "sympy/sympy"
    assert result["instances"][0]["testMetadata"] == {"version": "1.7"}
    assert "problemStatement" not in result["instances"][0]
    assert "modelPatch" not in result["instances"][0]
    assert "goldPatch" not in result["instances"][0]
    assert "harnessResult" not in result["instances"][0]
    assert "artifacts" not in result
    assert len(encoded) < 5_000


def test_sync_instance_logs_patch_but_returns_compact_payload(monkeypatch, tmp_path):
    app = load_app(monkeypatch)
    monkeypatch.setattr(app, "ARTIFACT_ROOT", tmp_path)
    logged = {}
    monkeypatch.setattr(
        app,
        "_mlflow_log_text",
        lambda run_id, text, file_path, artifact_path: logged.update(
            {
                "runId": run_id,
                "text": text,
                "filePath": file_path,
                "artifactPath": artifact_path,
            }
        ),
    )
    monkeypatch.setattr(
        app,
        "_bff_with_retry",
        lambda *_args, **_kwargs: {
            "success": True,
            "instance": {
                "instanceId": "sympy__sympy-20590",
                "status": "inferred",
                "mlflowRunId": "mlflow_1",
                "modelPatch": "diff --git a/file.py b/file.py\n" + ("+" * 100_000),
                "harnessResult": {"stdout": "x" * 100_000},
            },
        },
    )

    result = app._sync_instance(
        None, {"runId": "run_1", "instanceId": "sympy__sympy-20590"}
    )

    assert logged["runId"] == "mlflow_1"
    assert logged["artifactPath"] == "patches"
    assert result["instance"]["status"] == "inferred"
    assert "modelPatch" not in result["instance"]
    assert "harnessResult" not in result["instance"]
    assert len(json.dumps(result)) < 1_000


def test_mlflow_eval_summary_scores_completed_rows(monkeypatch):
    app = load_app(monkeypatch)

    summary = app._summarize_mlflow_eval_rows(
        [
            {
                "outputs": {
                    "status": "resolved",
                    "evaluation_status": "resolved",
                    "model_patch": "diff --git a/sympy/core.py b/sympy/core.py\n+change\n",
                    "trace_ids": ["trace_1"],
                },
                "metadata": {"instance_id": "sympy__sympy-20590"},
            },
            {
                "outputs": {
                    "status": "failed",
                    "evaluation_status": "empty_patch",
                    "model_patch": "",
                    "trace_ids": [],
                },
                "metadata": {"instance_id": "django__django-1"},
            },
        ]
    )

    assert summary["rowCount"] == 2
    assert summary["scorers"]["swebench_harness_resolved"]["passing"] == 1
    assert summary["scorers"]["patch_present_and_well_formed"]["passing"] == 1
    assert summary["scorers"]["trace_health"]["passing"] == 1


def test_mlflow_benchmark_comparison_tags_are_queryable(monkeypatch):
    app = load_app(monkeypatch)

    assert app._mlflow_benchmark_comparison_tags(
        {
            "tags": [
                "experiment-2026-05",
                "mcp.ablation",
                "baseline/control",
                "EXPERIMENT-2026-05",
            ]
        }
    ) == {
        "workflow_builder.benchmark_tags": (
            "experiment-2026-05,mcp.ablation,baseline/control"
        ),
        "workflow_builder.benchmark_tag.experiment-2026-05": "true",
        "workflow_builder.benchmark_tag.mcp.ablation": "true",
        "workflow_builder.benchmark_tag.baseline_control": "true",
    }


def test_run_mlflow_swebench_eval_persists_eval_projection(monkeypatch, tmp_path):
    monkeypatch.setenv("MLFLOW_ENABLED", "true")
    app = load_app(monkeypatch)
    app.MLFLOW_TRACKING_URI = "http://mlflow.test"
    monkeypatch.setattr(app, "ARTIFACT_ROOT", tmp_path)
    monkeypatch.setattr(app, "_mlflow_log_artifact", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        app,
        "_mlflow_genai_evaluate_sync",
        lambda parent_run_id, run, rows, summary: "eval_run_1",
    )
    posted = {}
    monkeypatch.setattr(
        app,
        "_bff_with_retry",
        lambda method, path, json_body=None, **_kwargs: posted.update(
            {"method": method, "path": path, "json": json_body}
        )
        or {"success": True},
    )
    monkeypatch.setattr(
        app,
        "_load_run",
        lambda _run_id: {
            "id": "run_1",
            "suiteSlug": "SWE-bench_Verified",
            "datasetName": "princeton-nlp/SWE-bench_Verified",
            "agentId": "agent_1",
            "agentVersion": 3,
            "agentRuntimeAppId": "agent-runtime-agent-1",
            "modelNameOrPath": "model",
            "mlflowRunId": "parent_run_1",
            "tags": ["experiment-2026-05", "baseline"],
            "instances": [
                {
                    "id": "ri_1",
                    "instanceId": "sympy__sympy-20590",
                    "status": "resolved",
                    "evaluationStatus": "resolved",
                    "repo": "sympy/sympy",
                    "baseCommit": "abc",
                    "problemStatement": "Fix it",
                    "testMetadata": {"FAIL_TO_PASS": ["test_a"]},
                    "modelPatch": "diff --git a/sympy/core.py b/sympy/core.py\n+change\n",
                    "traceIds": ["trace_1"],
                    "mlflowRunId": "child_run_1",
                }
            ],
        },
    )

    result = app._run_mlflow_swebench_eval(None, {"runId": "run_1"})

    assert result["success"] is True
    assert result["mlflowEvalRunId"] == "eval_run_1"
    assert (tmp_path / "run_1" / "mlflow-eval-input.jsonl").exists()
    assert (tmp_path / "run_1" / "mlflow-eval-summary.json").exists()
    input_rows = [
        json.loads(line)
        for line in (tmp_path / "run_1" / "mlflow-eval-input.jsonl").read_text().splitlines()
    ]
    assert input_rows[0]["metadata"]["benchmark_tags"] == [
        "experiment-2026-05",
        "baseline",
    ]
    assert posted["path"] == "/api/internal/benchmarks/runs/run_1/mlflow-evaluation"
    assert posted["json"]["mlflowEvalRunId"] == "eval_run_1"


def test_load_evaluation_progress_does_not_return_full_run(monkeypatch):
    app = load_app(monkeypatch)
    monkeypatch.setattr(
        app,
        "_load_run",
        lambda _run_id: {
            "id": "run_1",
            "status": "evaluating",
            "selectedInstanceIds": ["resolved", "active"],
            "summary": {"capacity": {"effectiveConcurrency": 5}},
            "instances": [
                {
                    "instanceId": "resolved",
                    "status": "resolved",
                    "modelPatch": "x" * 100_000,
                },
                {
                    "instanceId": "active",
                    "status": "evaluating",
                    "problemStatement": "x" * 100_000,
                },
            ],
        },
    )

    progress = app._load_evaluation_progress(None, {"runId": "run_1"})

    assert progress["runStatus"] == "evaluating"
    assert progress["activeInstanceIds"] == ["active"]
    assert progress["terminalInstanceIds"] == ["resolved"]
    assert "run" not in progress
    assert "modelPatch" not in json.dumps(progress)


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
    assert captured["json"]["forceRefreshLegacyStatic"] is True
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


def test_acquire_instance_leases_lets_bff_select_backend_resources(monkeypatch):
    app = load_app(monkeypatch)
    calls: list[dict[str, object]] = []

    def fake_bff(method, path, json_body=None, timeout=60):
        calls.append(
            {
                "method": method,
                "path": path,
                "jsonBody": json_body,
                "timeout": timeout,
            }
        )
        return {"admitted": True, "holderId": "lease-holder"}

    monkeypatch.setattr(app, "_bff", fake_bff)

    result = app._acquire_instance_leases(
        None,
        {"runId": "run_1", "instanceId": "django__django-12754"},
    )

    assert result == {"success": True, "admitted": True, "holderId": "lease-holder"}
    assert calls == [
        {
            "method": "POST",
            "path": "/api/internal/benchmarks/runs/run_1/leases",
            "jsonBody": {
                "action": "acquire",
                "instanceId": "django__django-12754",
                "phase": "inference",
                "metadata": {"source": "swebench-coordinator"},
            },
            "timeout": 60,
        }
    ]


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
        "activity",
        "_start_instance",
        {"runId": "run_1", "instanceId": "django__django-12754"},
    )
    assert workflow.send({"success": True}) == (
        "activity",
        "_sync_instance",
        {"runId": "run_1", "instanceId": "django__django-12754"},
    )
    assert workflow.send(
        {"instance": {"instanceId": "django__django-12754", "status": "inferred"}}
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


def test_run_workflow_releases_lease_when_start_skips_instance(monkeypatch):
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
        "activity",
        "_start_instance",
        {"runId": "run_1", "instanceId": "django__django-12754"},
    )
    assert workflow.send(
        {"success": True, "skipped": True, "reason": "benchmark_instance_start_superseded"}
    ) == (
        "activity",
        "_release_instance_leases",
        {
            "runId": "run_1",
            "instanceId": "django__django-12754",
            "holderId": "lease-holder",
            "phase": "inference",
            "reason": "benchmark_instance_start_superseded",
        },
    )
    assert workflow.send({"released": 1}) == (
        "activity",
        "_release_run_leases",
        {"runId": "run_1", "reason": "inference fan-out completed"},
    )


def test_run_workflow_requeues_when_orchestrator_start_is_retryable(monkeypatch):
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
        "activity",
        "_start_instance",
        {"runId": "run_1", "instanceId": "django__django-12754"},
    )
    assert workflow.send(
        {
            "success": False,
            "retryable": True,
            "reason": "workflow_orchestrator_not_ready",
            "retryAfterSeconds": 15,
        }
    ) == (
        "activity",
        "_release_instance_leases",
        {
            "runId": "run_1",
            "instanceId": "django__django-12754",
            "holderId": "lease-holder",
            "phase": "inference",
            "reason": "workflow_orchestrator_not_ready",
        },
    )
    assert workflow.send({"released": 1}) == ("timer", 15)


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
        call[0] == "activity" and call[1] == "_start_instance"
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

    assert workflow.send({"admitted": True, "holderId": "lease-1"}) == (
        "activity",
        "_start_instance",
        {"runId": "run_1", "instanceId": "django__django-12754"},
    )
    assert workflow.send({"success": True}) == ("timer", 7)
    assert any(
        call[0] == "activity"
        and call[1] == "_start_instance"
        and call[2]["instanceId"] == "django__django-12754"
        for call in ctx.calls
    )
    assert not any(
        call[0] == "activity"
        and call[1] == "_start_instance"
        and call[2]["instanceId"] == "django__django-13012"
        for call in ctx.calls
    )

    assert workflow.send(None) == (
        "activity",
        "_acquire_instance_leases",
        {"runId": "run_1", "instanceId": "django__django-13012"},
    )
    assert workflow.send({"admitted": True, "holderId": "lease-2"}) == (
        "activity",
        "_start_instance",
        {"runId": "run_1", "instanceId": "django__django-13012"},
    )


def test_run_workflow_can_start_instances_in_parallel_batches(monkeypatch):
    app = load_app(monkeypatch)
    monkeypatch.setenv("SWEBENCH_COORDINATOR_INSTANCE_START_BATCH_SIZE", "10")
    monkeypatch.setenv("SWEBENCH_COORDINATOR_INSTANCE_START_BATCH_DELAY_SECONDS", "0")
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
    batch = workflow.send({"success": True, "run": {"status": "inferencing"}})

    assert batch == [
        (
            "activity",
            "_admit_and_start_instance",
            {"runId": "run_1", "instanceId": "django__django-12754"},
        ),
        (
            "activity",
            "_admit_and_start_instance",
            {"runId": "run_1", "instanceId": "django__django-13012"},
        ),
    ]
    assert workflow.send(
        [
            {
                "success": True,
                "instanceId": "django__django-12754",
                "admission": {"admitted": True, "holderId": "lease-1"},
                "start": {"success": True},
            },
            {
                "success": True,
                "instanceId": "django__django-13012",
                "admission": {"admitted": True, "holderId": "lease-2"},
                "start": {"success": True},
            },
        ]
    ) == (
        "activity",
        "_sync_instance",
        {"runId": "run_1", "instanceId": "django__django-12754"},
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


def test_activity_wrapper_stamps_redacted_input_and_output(monkeypatch):
    app = load_app(monkeypatch)
    stamped: list[tuple[str, object]] = []
    monkeypatch.setattr(app, "set_current_span_io", lambda prefix, value: stamped.append((prefix, value)))

    def activity(_ctx, data):
        return {"ok": True, "token": "server-secret", "echo": data["command"]}

    wrapped = app._activity_with_content_io(activity)

    assert wrapped(None, {"command": "run", "apiKey": "client-secret"}) == {
        "ok": True,
        "token": "server-secret",
        "echo": "run",
    }
    assert wrapped.__name__ == "activity"
    assert stamped == [
        ("input", {"command": "run", "apiKey": "client-secret"}),
        ("output", {"ok": True, "token": "server-secret", "echo": "run"}),
    ]


def test_activity_wrapper_stamps_error_output(monkeypatch):
    app = load_app(monkeypatch)
    stamped: list[tuple[str, object]] = []
    monkeypatch.setattr(app, "set_current_span_io", lambda prefix, value: stamped.append((prefix, value)))

    def activity(_ctx, _data):
        raise RuntimeError("failed")

    wrapped = app._activity_with_content_io(activity)

    try:
        wrapped(None, {"runId": "run_1"})
    except RuntimeError:
        pass
    else:
        raise AssertionError("expected activity error")
    assert stamped == [
        ("input", {"runId": "run_1"}),
        ("output", {"error": "failed", "errorType": "RuntimeError"}),
    ]
