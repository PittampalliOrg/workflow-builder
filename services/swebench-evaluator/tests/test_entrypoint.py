from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path


def load_entrypoint():
    sys.modules.setdefault(
        "requests",
        types.SimpleNamespace(
            post=lambda *args, **kwargs: types.SimpleNamespace(
                raise_for_status=lambda: None
            )
        ),
    )
    module_path = Path(__file__).resolve().parents[1] / "entrypoint.py"
    spec = importlib.util.spec_from_file_location(
        "swebench_evaluator_entrypoint", module_path
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_evaluation_max_parallel_defaults_and_bounds(monkeypatch):
    entrypoint = load_entrypoint()

    monkeypatch.delenv("SWEBENCH_EVAL_MAX_PARALLEL", raising=False)
    monkeypatch.delenv("SWEBENCH_MAX_WORKERS", raising=False)
    assert entrypoint.evaluation_max_parallel() == 24

    monkeypatch.setenv("SWEBENCH_EVAL_MAX_PARALLEL", "64")
    assert entrypoint.evaluation_max_parallel() == 64

    monkeypatch.setenv("SWEBENCH_EVAL_MAX_PARALLEL", "999")
    assert entrypoint.evaluation_max_parallel() == 128

    monkeypatch.setenv("SWEBENCH_EVAL_MAX_PARALLEL", "not-a-number")
    assert entrypoint.evaluation_max_parallel() == 24


def test_evaluation_max_parallel_accepts_legacy_max_workers(monkeypatch):
    entrypoint = load_entrypoint()

    monkeypatch.delenv("SWEBENCH_EVAL_MAX_PARALLEL", raising=False)
    monkeypatch.setenv("SWEBENCH_MAX_WORKERS", "8")

    assert entrypoint.evaluation_max_parallel() == 8


def test_taskrun_names_keep_long_instances_unique():
    entrypoint = load_entrypoint()
    run_id = "nZ4F1-pvj8GFOHb1rIG-x"

    first = entrypoint.taskrun_name(
        run_id,
        "run",
        "scikit-learn__scikit-learn-13496",
    )
    second = entrypoint.taskrun_name(
        run_id,
        "run",
        "scikit-learn__scikit-learn-14053",
    )

    assert first != second
    assert len(first) <= 63
    assert len(second) <= 63
    assert first.startswith("swebench-run-nz4f1-pvj8gfohb1rig-x-scikit-learn")
    assert second.startswith("swebench-run-nz4f1-pvj8gfohb1rig-x-scikit-learn")


def test_load_custom_objects_api_adds_bearer_prefix(monkeypatch):
    entrypoint = load_entrypoint()
    set_default_calls = []

    class FakeConfiguration:
        def __init__(self):
            self.api_key = {"authorization": "bearer token"}
            self.api_key_prefix = {}
            self.access_token = None

        @classmethod
        def get_default_copy(cls):
            return fake_config

        @classmethod
        def set_default(cls, cfg):
            set_default_calls.append(cfg)

    class FakeCustomObjectsApi:
        pass

    fake_config = FakeConfiguration()
    monkeypatch.setitem(
        sys.modules,
        "kubernetes",
        types.SimpleNamespace(
            client=types.SimpleNamespace(
                Configuration=FakeConfiguration,
                CustomObjectsApi=FakeCustomObjectsApi,
            ),
            config=types.SimpleNamespace(load_incluster_config=lambda: None),
        ),
    )

    api = entrypoint.load_custom_objects_api()

    assert isinstance(api, FakeCustomObjectsApi)
    assert fake_config.api_key["authorization"] == "token"
    assert fake_config.api_key_prefix["authorization"] == "Bearer"
    assert fake_config.api_key["BearerToken"] == "token"
    assert fake_config.api_key_prefix["BearerToken"] == "Bearer"
    assert fake_config.access_token == "token"
    assert set_default_calls == [fake_config]


def test_post_results_retries_transient_bff_failure(monkeypatch):
    entrypoint = load_entrypoint()
    calls: list[dict[str, object]] = []

    class Response:
        def __init__(self, ok: bool):
            self.ok = ok

        def raise_for_status(self):
            if not self.ok:
                raise RuntimeError("temporary BFF outage")

    def fake_post(*_args, **kwargs):
        calls.append(kwargs)
        return Response(ok=len(calls) > 1)

    monkeypatch.setenv("WORKFLOW_BUILDER_URL", "http://workflow-builder")
    monkeypatch.setenv("INTERNAL_API_TOKEN", "token")
    monkeypatch.setenv("SWEBENCH_BFF_MAX_RETRIES", "2")
    monkeypatch.setenv("SWEBENCH_BFF_RETRY_DELAY_SECONDS", "0.1")
    monkeypatch.setattr(entrypoint.requests, "post", fake_post)
    monkeypatch.setattr(entrypoint.time, "sleep", lambda _seconds: None)

    entrypoint.post_results("run_1", [{"instance_id": "i1", "resolved": True}])

    assert len(calls) == 2
    assert calls[0]["json"] == {"results": [{"instance_id": "i1", "resolved": True}]}


def test_parse_instance_image_map_requires_every_selected_instance():
    entrypoint = load_entrypoint()

    image_map = entrypoint.parse_instance_image_map(
        json.dumps({"a": "image-a", "b": "image-b"}),
        ["a", "b"],
    )

    assert image_map == {"a": "image-a", "b": "image-b"}

    try:
        entrypoint.parse_instance_image_map(json.dumps({"a": "image-a"}), ["a", "b"])
    except RuntimeError as exc:
        assert "missing image refs" in str(exc)
        assert "b" in str(exc)
    else:
        raise AssertionError("expected missing image refs to fail")


def test_taskrun_execution_spec_defaults_to_ghcr_pull_secret(monkeypatch):
    entrypoint = load_entrypoint()

    monkeypatch.delenv("SWEBENCH_TEKTON_SERVICE_ACCOUNT", raising=False)
    monkeypatch.delenv("SWEBENCH_TEKTON_IMAGE_PULL_SECRETS", raising=False)
    monkeypatch.delenv("SWEBENCH_TEKTON_POD_PRIORITY_CLASS", raising=False)

    assert entrypoint.taskrun_execution_spec() == {
        "podTemplate": {"imagePullSecrets": [{"name": "ghcr-pull-credentials"}]}
    }


def test_taskrun_execution_spec_accepts_service_account_and_secret_list(monkeypatch):
    entrypoint = load_entrypoint()

    monkeypatch.setenv("SWEBENCH_TEKTON_SERVICE_ACCOUNT", "swebench-runner")
    monkeypatch.setenv(
        "SWEBENCH_TEKTON_IMAGE_PULL_SECRETS",
        "workflow-builder-ghcr-pull-credentials, ghcr-pull-credentials",
    )
    monkeypatch.setenv("SWEBENCH_TEKTON_POD_PRIORITY_CLASS", "benchmark-workload")

    assert entrypoint.taskrun_execution_spec() == {
        "serviceAccountName": "swebench-runner",
        "podTemplate": {
            "imagePullSecrets": [
                {"name": "workflow-builder-ghcr-pull-credentials"},
                {"name": "ghcr-pull-credentials"},
            ],
            "priorityClassName": "benchmark-workload",
        },
    }


def test_run_instance_taskrun_includes_pull_secret(monkeypatch):
    entrypoint = load_entrypoint()

    monkeypatch.delenv("SWEBENCH_TEKTON_SERVICE_ACCOUNT", raising=False)
    monkeypatch.setenv("SWEBENCH_TEKTON_IMAGE_PULL_SECRETS", "ghcr-pull-credentials")

    body = entrypoint.build_run_instance_taskrun(
        name="run-a",
        namespace="workflow-builder",
        pvc_name="swebench-artifacts",
        artifact_mode="pvc",
        run_id="run_1",
        instance_id="django__django-11133",
        instance_image="ghcr.io/example/private:tag",
        timeout_seconds=120,
    )

    assert body["spec"]["podTemplate"] == {
        "imagePullSecrets": [{"name": "ghcr-pull-credentials"}]
    }


def test_object_mode_taskruns_use_emptydir_instead_of_pvc(monkeypatch):
    entrypoint = load_entrypoint()
    monkeypatch.setenv("WORKFLOW_BUILDER_URL", "http://workflow-builder")

    body = entrypoint.build_run_instance_taskrun(
        name="run-a",
        namespace="workflow-builder",
        pvc_name="swebench-artifacts",
        artifact_mode="object",
        run_id="run_1",
        instance_id="django__django-11133",
        instance_image="ghcr.io/example/private:tag",
        timeout_seconds=120,
    )

    assert body["spec"]["workspaces"] == [{"name": "artifacts", "emptyDir": {}}]
    params = {param["name"]: param["value"] for param in body["spec"]["params"]}
    assert params["artifact_mode"] == "object"
    assert params["workflow_builder_url"] == "http://workflow-builder"


def test_dispatch_run_instance_taskruns_uses_sliding_window(monkeypatch):
    entrypoint = load_entrypoint()
    created: list[tuple[str, str]] = []
    waited: list[list[str]] = []
    released: list[str] = []
    terminal_order = ["run-b", "run-c", "run-d", "run-e", "run-a"]

    def fake_name(run_id: str, phase: str, instance_id: str | None = None) -> str:
        return f"{phase}-{instance_id or run_id}"

    def fake_create(_api, _namespace, body):
        labels = body["metadata"]["labels"]
        name = body["metadata"]["name"]
        created.append((labels["swebench.phase"], name))

    def fake_wait_next(_api, _namespace, names, deadline_at):
        waited.append(list(names))
        name = next(candidate for candidate in terminal_order if candidate in names)
        terminal_order.remove(name)
        return name, {
            "metadata": {"name": name},
            "status": {"conditions": [{"type": "Succeeded", "status": "True"}]},
        }

    monkeypatch.setattr(entrypoint, "taskrun_name", fake_name)
    monkeypatch.setattr(entrypoint, "create_taskrun", fake_create)
    monkeypatch.setattr(entrypoint, "wait_for_next_taskrun", fake_wait_next)
    monkeypatch.setattr(
        entrypoint,
        "acquire_evaluator_slot",
        lambda _run_id, instance_id: f"holder-{instance_id}",
    )
    monkeypatch.setattr(
        entrypoint,
        "release_evaluator_slot",
        lambda _run_id, instance_id, _holder_id, _reason: released.append(instance_id),
    )

    result = entrypoint.dispatch_run_instance_taskruns(
        api=object(),
        namespace="workflow-builder",
        pvc_name="swebench-artifacts",
        artifact_mode="pvc",
        run_id="run_1",
        instance_ids=["a", "b", "c", "d", "e"],
        image_map={iid: f"image-{iid}" for iid in ["a", "b", "c", "d", "e"]},
        timeout_seconds=120,
        max_parallel=2,
        deadline_seconds=1800,
    )

    assert [name for _phase, name in created] == [
        "run-a",
        "run-b",
        "run-c",
        "run-d",
        "run-e",
    ]
    assert all(phase == "run-instance" for phase, _name in created)
    assert waited == [
        ["run-a", "run-b"],
        ["run-a", "run-c"],
        ["run-a", "run-d"],
        ["run-a", "run-e"],
        ["run-a"],
    ]
    assert released == ["b", "c", "d", "e", "a"]
    assert sorted(result) == ["run-a", "run-b", "run-c", "run-d", "run-e"]


def test_dispatch_run_instance_taskruns_polls_active_when_slot_pool_is_full(
    monkeypatch,
):
    entrypoint = load_entrypoint()
    created: list[str] = []
    waited: list[list[str]] = []
    released: list[str] = []
    active_leases: set[str] = set()

    def fake_name(run_id: str, phase: str, instance_id: str | None = None) -> str:
        return f"{phase}-{instance_id or run_id}"

    def fake_create(_api, _namespace, body):
        created.append(body["metadata"]["name"])

    def fake_acquire(_run_id, instance_id):
        if len(active_leases) >= 2:
            return None
        active_leases.add(instance_id)
        return f"holder-{instance_id}"

    def fake_release(_run_id, instance_id, _holder_id, _reason):
        active_leases.discard(instance_id)
        released.append(instance_id)

    def fake_wait_next(_api, _namespace, names, deadline_at):
        waited.append(list(names))
        name = names[0]
        return name, {
            "metadata": {"name": name},
            "status": {"conditions": [{"type": "Succeeded", "status": "True"}]},
        }

    monkeypatch.setattr(entrypoint, "taskrun_name", fake_name)
    monkeypatch.setattr(entrypoint, "create_taskrun", fake_create)
    monkeypatch.setattr(entrypoint, "wait_for_next_taskrun", fake_wait_next)
    monkeypatch.setattr(
        entrypoint, "benchmark_leases_url", lambda _run_id: "http://leases"
    )
    monkeypatch.setattr(entrypoint, "acquire_evaluator_slot", fake_acquire)
    monkeypatch.setattr(entrypoint, "release_evaluator_slot", fake_release)

    result = entrypoint.dispatch_run_instance_taskruns(
        api=object(),
        namespace="workflow-builder",
        pvc_name="swebench-artifacts",
        artifact_mode="pvc",
        run_id="run_1",
        instance_ids=["a", "b", "c"],
        image_map={iid: f"image-{iid}" for iid in ["a", "b", "c"]},
        timeout_seconds=120,
        max_parallel=3,
        deadline_seconds=1800,
    )

    assert created == ["run-a", "run-b", "run-c"]
    assert waited == [["run-a", "run-b"], ["run-b", "run-c"], ["run-c"]]
    assert released == ["a", "b", "c"]
    assert sorted(result) == ["run-a", "run-b", "run-c"]


def test_wait_for_next_taskrun_records_disappeared_taskrun(monkeypatch):
    entrypoint = load_entrypoint()

    class NotFound(Exception):
        status = 404

    class FakeApi:
        def get_namespaced_custom_object(self, **_kwargs):
            raise NotFound("taskrun deleted")

    monkeypatch.setenv("SWEBENCH_POLL_INTERVAL_SECONDS", "2")

    name, taskrun = entrypoint.wait_for_next_taskrun(
        FakeApi(),
        "workflow-builder",
        ["run-a"],
        deadline_at=entrypoint.time.monotonic() + 10,
    )

    assert name == "run-a"
    condition = taskrun["status"]["conditions"][0]
    assert condition["status"] == "False"
    assert condition["reason"] == "TaskRunNotFound"


def test_post_terminal_results_persists_native_results(monkeypatch, tmp_path):
    entrypoint = load_entrypoint()
    calls: list[str] = []
    results = [{"instance_id": "i1", "status": "error"}]

    monkeypatch.setattr(
        entrypoint, "collect_results", lambda *_args, **_kwargs: results
    )
    monkeypatch.setattr(
        entrypoint,
        "post_results",
        lambda *_args, **_kwargs: calls.append("post_results"),
    )
    code = entrypoint._post_terminal_results(
        "run_1",
        ["i1"],
        tmp_path,
        tmp_path / "harness",
        error="failed",
        succeeded=False,
    )

    assert code == 1
    assert calls == ["post_results"]


def test_collect_results_preserves_stage_failure_when_report_missing(tmp_path):
    entrypoint = load_entrypoint()
    run_dir = tmp_path / "run_1"

    results = entrypoint.collect_results(
        run_dir,
        ["django__django-11133"],
        missing_report_error="prepare TaskRun failed: dataset.jsonl missing",
    )

    assert results == [
        {
            "instance_id": "django__django-11133",
            "resolved": False,
            "status": "error",
            "error": "prepare TaskRun failed: dataset.jsonl missing",
            "logs_path": str(run_dir / "django__django-11133"),
            "harness_result": {
                "resolved": False,
                "status": "error",
                "error": "prepare TaskRun failed: dataset.jsonl missing",
                "source": "swebench-evaluator",
                "missing_report_json": True,
            },
        }
    ]
