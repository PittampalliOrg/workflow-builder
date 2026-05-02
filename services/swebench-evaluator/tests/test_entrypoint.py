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
