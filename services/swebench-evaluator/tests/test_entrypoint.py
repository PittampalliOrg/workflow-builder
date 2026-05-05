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
    assert calls[0]["json"] == {
        "results": [{"instance_id": "i1", "resolved": True}]
    }


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

    assert entrypoint.taskrun_execution_spec() == {
        "serviceAccountName": "swebench-runner",
        "podTemplate": {
            "imagePullSecrets": [
                {"name": "workflow-builder-ghcr-pull-credentials"},
                {"name": "ghcr-pull-credentials"},
            ]
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
        run_id="run_1",
        instance_id="django__django-11133",
        instance_image="ghcr.io/example/private:tag",
        timeout_seconds=120,
    )

    assert body["spec"]["podTemplate"] == {
        "imagePullSecrets": [{"name": "ghcr-pull-credentials"}]
    }


def test_dispatch_run_instance_taskruns_batches_by_eval_parallelism(monkeypatch):
    entrypoint = load_entrypoint()
    created: list[tuple[str, str]] = []
    waited: list[list[str]] = []

    def fake_name(run_id: str, phase: str, instance_id: str | None = None) -> str:
        return f"{phase}-{instance_id or run_id}"

    def fake_create(_api, _namespace, body):
        labels = body["metadata"]["labels"]
        name = body["metadata"]["name"]
        created.append((labels["swebench.phase"], name))

    def fake_wait(_api, _namespace, names, deadline_seconds):
        waited.append(list(names))
        return {
            name: {
                "metadata": {"name": name},
                "status": {"conditions": [{"type": "Succeeded", "status": "True"}]},
            }
            for name in names
        }

    monkeypatch.setattr(entrypoint, "taskrun_name", fake_name)
    monkeypatch.setattr(entrypoint, "create_taskrun", fake_create)
    monkeypatch.setattr(entrypoint, "wait_for_taskruns", fake_wait)

    result = entrypoint.dispatch_run_instance_taskruns(
        api=object(),
        namespace="workflow-builder",
        pvc_name="swebench-artifacts",
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
    assert waited == [["run-a", "run-b"], ["run-c", "run-d"], ["run-e"]]
    assert sorted(result) == ["run-a", "run-b", "run-c", "run-d", "run-e"]
