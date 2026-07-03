from __future__ import annotations

import builtins
import importlib.util
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_original_activities = sys.modules.get("activities")
_original_workflow_data_client = sys.modules.get("activities.workflow_data_client")
try:
    activities_pkg = types.ModuleType("activities")
    activities_pkg.__path__ = [str(ROOT / "activities")]
    sys.modules["activities"] = activities_pkg

    workflow_data_spec = importlib.util.spec_from_file_location(
        "activities.workflow_data_client",
        ROOT / "activities" / "workflow_data_client.py",
    )
    assert workflow_data_spec is not None and workflow_data_spec.loader is not None
    workflow_data_module = importlib.util.module_from_spec(workflow_data_spec)
    sys.modules["activities.workflow_data_client"] = workflow_data_module
    workflow_data_spec.loader.exec_module(workflow_data_module)

    finalizer_spec = importlib.util.spec_from_file_location(
        "finalize_otel_trace_root_for_tests",
        ROOT / "activities" / "finalize_otel_trace_root.py",
    )
    assert finalizer_spec is not None and finalizer_spec.loader is not None
    finalizer = importlib.util.module_from_spec(finalizer_spec)
    finalizer_spec.loader.exec_module(finalizer)
finally:
    if _original_activities is None:
        sys.modules.pop("activities", None)
    else:
        sys.modules["activities"] = _original_activities
    if _original_workflow_data_client is None:
        sys.modules.pop("activities.workflow_data_client", None)
    else:
        sys.modules["activities.workflow_data_client"] = _original_workflow_data_client


class FailingPsycopg2:
    @staticmethod
    def connect(*_args, **_kwargs):
        raise AssertionError("psycopg2.connect should not be called in strict http mode")


def _block_psycopg2_imports(monkeypatch):
    original_import = builtins.__import__

    def guarded_import(name, *args, **kwargs):
        if name == "psycopg2" or name.startswith("psycopg2."):
            raise AssertionError(
                "psycopg2 should not be imported in strict http mode"
            )
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded_import)


def test_finalize_otel_trace_root_records_lineage_through_workflow_data(monkeypatch):
    recorded: list[dict] = []

    class FakeWorkflowDataClient:
        def get_trace_targets(self, execution_id):
            assert execution_id == "exec-1"
            return [
                {
                    "entityType": "workflow_execution",
                    "entityId": "exec-1",
                    "projectId": "project-1",
                    "externalExperimentId": "legacy-exp-1",
                    "externalRunId": "legacy-run-1",
                }
            ]

        def upsert_trace_lineage(self, payload):
            recorded.append(payload)
            return {"recorded": 1, "sourceKeys": ["workflow_execution:exec-1"]}

    monkeypatch.setenv("WORKFLOW_DATA_API_MODE", "http")
    _block_psycopg2_imports(monkeypatch)
    monkeypatch.setitem(sys.modules, "psycopg2", FailingPsycopg2)
    monkeypatch.setattr(finalizer, "workflow_data_client", FakeWorkflowDataClient())

    result = finalizer.finalize_otel_trace_root(
        None,
        {
            "traceId": "tr-1234567890abcdef1234567890abcdef",
            "dbExecutionId": "exec-1",
            "workflowId": "wf-1",
            "workflowName": "Workflow",
            "status": "OK",
        },
    )

    assert result == {
        "success": True,
        "traceId": "1234567890abcdef1234567890abcdef",
        "linked": True,
        "recorded": 1,
        "sourceKeys": ["workflow_execution:exec-1"],
    }
    assert recorded == [
        {
            "traceId": "1234567890abcdef1234567890abcdef",
            "targets": [
                {
                    "entityType": "workflow_execution",
                    "entityId": "exec-1",
                    "projectId": "project-1",
                    "externalRunId": "legacy-run-1",
                    "externalExperimentId": "legacy-exp-1",
                }
            ],
            "source": "primary",
            "attrs": {
                "service.name": "workflow-orchestrator",
                "workflow.status": "OK",
            },
        }
    ]


def test_finalize_otel_trace_root_strict_http_does_not_fallback_to_postgres(monkeypatch):
    class FailingWorkflowDataClient:
        def get_trace_targets(self, _execution_id):
            raise RuntimeError("workflow-data unavailable")

    monkeypatch.setenv("WORKFLOW_DATA_API_MODE", "http")
    _block_psycopg2_imports(monkeypatch)
    monkeypatch.setitem(sys.modules, "psycopg2", FailingPsycopg2)
    monkeypatch.setattr(finalizer, "workflow_data_client", FailingWorkflowDataClient())

    result = finalizer.finalize_otel_trace_root(
        None,
        {
            "traceId": "1234567890abcdef1234567890abcdef",
            "dbExecutionId": "exec-1",
        },
    )

    assert result == {
        "success": True,
        "traceId": "1234567890abcdef1234567890abcdef",
        "linked": False,
        "reason": "no_trace_targets",
    }


def test_finalize_otel_trace_root_skips_invalid_trace_id(monkeypatch):
    monkeypatch.setenv("WORKFLOW_DATA_API_MODE", "http")
    _block_psycopg2_imports(monkeypatch)
    monkeypatch.setitem(sys.modules, "psycopg2", FailingPsycopg2)

    assert finalizer.finalize_otel_trace_root(None, {"traceId": "not-a-trace"}) == {
        "success": True,
        "skipped": True,
        "reason": "missing_or_invalid_trace_id",
    }
