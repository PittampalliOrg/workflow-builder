"""Concurrency plan P3: static guards for the tuned WorkflowRuntime wiring.

The DAPR_WORKFLOW_MAX_* envs were stamped on the pods but consumed by nothing
(DurableAgent built a bare runtime). These tests pin the injection so a
refactor can't silently regress pool pods back to durabletask defaults
(cpu+4 thread-pool workers — the real per-pod serialization point).
"""

from __future__ import annotations

import pathlib


ROOT = pathlib.Path(__file__).resolve().parents[1]


def test_agent_is_constructed_with_tuned_runtime():
    source = (ROOT / "src/main.py").read_text()
    assert "runtime=_build_tuned_workflow_runtime()" in source


def test_tuned_runtime_reads_the_stamped_env_names():
    source = (ROOT / "src/main.py").read_text()
    builder = source.split("def _build_tuned_workflow_runtime", 1)[1].split("\nagent = ", 1)[0]
    assert "DAPR_WORKFLOW_MAX_CONCURRENT_ORCHESTRATIONS" in builder
    assert "DAPR_WORKFLOW_MAX_CONCURRENT_ACTIVITIES" in builder
    assert "DAPR_WORKFLOW_MAX_THREAD_POOL_WORKERS" in builder
    assert "maximum_concurrent_orchestration_work_items" in builder
    assert "maximum_concurrent_activity_work_items" in builder
    assert "maximum_thread_pool_workers" in builder
    # Startup log is the pool-pod evidence channel for the configured limits.
    assert "[workflow-runtime] concurrency configured" in builder


def test_session_id_log_context_is_seeded_at_entry_points():
    source = (ROOT / "src/main.py").read_text()
    assert "[session=%(session_id)s]" in source
    # session_workflow re-seeds on every replay step; both bridge endpoints
    # seed their request paths (workflow threads are shared across instances).
    assert source.count("set_session_id_log_context(") >= 4
