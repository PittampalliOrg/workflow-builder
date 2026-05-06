from src.app import ExecutionClassConfig, ExecutionRequest, build_job_manifest


def _request(execution_class: str = "benchmark-fast") -> ExecutionRequest:
    return ExecutionRequest(
        runId="run_1",
        instanceId="sympy__sympy-20590",
        workflowId="wf_1",
        workflowExecutionId="exec_1",
        executionClass=execution_class,
        timeoutSeconds=7200,
        workflow={"document": {"dsl": "1.0.0"}},
        triggerData={"runId": "run_1"},
        inferenceEnvironment={"sandboxImage": "ghcr.io/example/image@sha256:1"},
        callback={
            "path": "/api/internal/benchmarks/runs/run_1/instances/sympy__sympy-20590/execution"
        },
    )


def test_benchmark_fast_job_is_kueue_managed() -> None:
    manifest = build_job_manifest(
        _request(),
        execution_id="hexec-123",
        namespace="sandbox-execution",
        class_config=ExecutionClassConfig(localQueue="benchmark-fast"),
    )

    assert manifest["metadata"]["labels"]["kueue.x-k8s.io/queue-name"] == "benchmark-fast"
    pod_spec = manifest["spec"]["template"]["spec"]
    assert pod_spec["nodeSelector"] == {"stacks.io/swebench-pool": "dev-benchmark"}
    assert pod_spec["serviceAccountName"] == "sandbox-execution-worker"
    assert pod_spec["imagePullSecrets"] == [{"name": "ghcr-pull-credentials"}]
    assert "runtimeClassName" not in pod_spec
    assert pod_spec["containers"][0]["image"] == "ghcr.io/pittampalliorg/sandbox-execution-api:latest"
    assert pod_spec["containers"][0]["command"] == ["python", "-m", "src.worker"]
    assert pod_spec["containers"][0]["resources"]["requests"]["ephemeral-storage"] == "16Gi"


def test_secure_gvisor_sets_runtime_class_and_queue() -> None:
    manifest = build_job_manifest(
        _request("secure-gvisor"),
        execution_id="hexec-123",
        namespace="sandbox-execution",
        class_config=ExecutionClassConfig(
            localQueue="secure-gvisor",
            runtimeClassName="gvisor",
        ),
    )

    assert manifest["metadata"]["labels"]["kueue.x-k8s.io/queue-name"] == "secure-gvisor"
    assert manifest["spec"]["template"]["spec"]["runtimeClassName"] == "gvisor"
