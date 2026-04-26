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
            post=lambda *args, **kwargs: types.SimpleNamespace(raise_for_status=lambda: None)
        ),
    )
    module_path = Path(__file__).resolve().parents[1] / "entrypoint.py"
    spec = importlib.util.spec_from_file_location("swebench_evaluator_entrypoint", module_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_parse_results_handles_swebench_aggregate_report(tmp_path: Path):
    entrypoint = load_entrypoint()
    report = {
        "total_instances": 1,
        "submitted_instances": 1,
        "completed_instances": 1,
        "resolved_instances": 1,
        "unresolved_instances": 0,
        "empty_patch_instances": 0,
        "error_instances": 0,
        "completed_ids": ["sympy__sympy-20590"],
        "resolved_ids": ["sympy__sympy-20590"],
        "unresolved_ids": [],
        "empty_patch_ids": [],
        "error_ids": [],
        "schema_version": 2,
    }
    (tmp_path / "model.run.json").write_text(json.dumps(report), encoding="utf-8")

    results = entrypoint.parse_results(tmp_path, ["sympy__sympy-20590"])

    assert results == [
        {
            "instance_id": "sympy__sympy-20590",
            "resolved": True,
            "status": "resolved",
            "logs_path": str(tmp_path / "model.run.json"),
            "harness_result": report,
            "test_output_summary": (
                "SWE-bench report: total=1, submitted=1, completed=1, "
                "resolved=1, unresolved=0, empty_patches=0, errors=0"
            ),
        }
    ]


def test_parse_results_marks_aggregate_errors(tmp_path: Path):
    entrypoint = load_entrypoint()
    report = {
        "total_instances": 1,
        "submitted_instances": 1,
        "completed_instances": 0,
        "resolved_instances": 0,
        "unresolved_instances": 0,
        "empty_patch_instances": 0,
        "error_instances": 1,
        "resolved_ids": [],
        "unresolved_ids": [],
        "empty_patch_ids": [],
        "error_ids": ["sympy__sympy-20590"],
        "schema_version": 2,
    }
    (tmp_path / "model.run.json").write_text(json.dumps(report), encoding="utf-8")

    results = entrypoint.parse_results(tmp_path, ["sympy__sympy-20590"])

    assert results[0]["status"] == "error"
    assert results[0]["resolved"] is False
    assert results[0]["error"] == "Harness error"
