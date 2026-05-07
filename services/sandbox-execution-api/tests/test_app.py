import json

from src.app import (
    ExecutionClassConfig,
    ExecutionRequest,
    build_job_manifest,
    build_payload_configmap_manifest,
)


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
    request = _request()
    manifest = build_job_manifest(
        request,
        execution_id="hexec-123",
        namespace="sandbox-execution",
        class_config=ExecutionClassConfig(localQueue="benchmark-fast"),
    )
    configmap = build_payload_configmap_manifest(
        request,
        execution_id="hexec-123",
        namespace="sandbox-execution",
    )

    assert manifest["metadata"]["labels"]["kueue.x-k8s.io/queue-name"] == "benchmark-fast"
    pod_spec = manifest["spec"]["template"]["spec"]
    container = pod_spec["containers"][0]
    assert pod_spec["nodeSelector"] == {"stacks.io/swebench-pool": "dev-benchmark"}
    assert pod_spec["serviceAccountName"] == "sandbox-execution-worker"
    assert pod_spec["imagePullSecrets"] == [{"name": "ghcr-pull-credentials"}]
    assert "runtimeClassName" not in pod_spec
    assert container["image"] == "ghcr.io/pittampalliorg/sandbox-execution-api:latest"
    assert container["command"] == ["python", "-m", "src.worker"]
    assert container["resources"]["requests"]["ephemeral-storage"] == "16Gi"
    assert container["env"][0] == {
        "name": "EXECUTION_REQUEST_PATH",
        "value": "/var/run/sandbox-execution/request.json",
    }
    assert "EXECUTION_REQUEST_JSON" not in json.dumps(container["env"])
    assert container["volumeMounts"][0]["name"] == "execution-request"
    assert pod_spec["volumes"][0]["configMap"]["name"] == configmap["metadata"]["name"]
    payload = json.loads(configmap["data"]["request.json"])
    assert payload["runId"] == "run_1"
    assert payload["instanceId"] == "sympy__sympy-20590"


def test_worker_retry_and_throttle_env_is_passed_through(monkeypatch) -> None:
    monkeypatch.setenv("SANDBOX_EXECUTION_WORKFLOW_START_ATTEMPTS", "20")
    monkeypatch.setenv("SANDBOX_EXECUTION_WORKFLOW_START_STAGGER_SECONDS", "180")
    manifest = build_job_manifest(
        _request(),
        execution_id="hexec-123",
        namespace="sandbox-execution",
        class_config=ExecutionClassConfig(localQueue="benchmark-fast"),
    )

    env = {
        entry["name"]: entry.get("value")
        for entry in manifest["spec"]["template"]["spec"]["containers"][0]["env"]
    }
    assert env["SANDBOX_EXECUTION_WORKFLOW_START_ATTEMPTS"] == "20"
    assert env["SANDBOX_EXECUTION_WORKFLOW_START_STAGGER_SECONDS"] == "180"


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


def test_long_resource_names_keep_unique_suffixes() -> None:
    first = _request()
    first.instanceId = "scikit-learn__scikit-learn-10908"
    second = _request()
    second.instanceId = "scikit-learn__scikit-learn-13496"

    first_job = build_job_manifest(
        first,
        execution_id="hexec-d699a",
        namespace="sandbox-execution",
        class_config=ExecutionClassConfig(localQueue="benchmark-fast"),
    )
    second_job = build_job_manifest(
        second,
        execution_id="hexec-80977",
        namespace="sandbox-execution",
        class_config=ExecutionClassConfig(localQueue="benchmark-fast"),
    )
    first_configmap = build_payload_configmap_manifest(
        first,
        execution_id="hexec-d699a",
        namespace="sandbox-execution",
    )
    second_configmap = build_payload_configmap_manifest(
        second,
        execution_id="hexec-80977",
        namespace="sandbox-execution",
    )

    assert first_job["metadata"]["name"] != second_job["metadata"]["name"]
    assert first_configmap["metadata"]["name"] != second_configmap["metadata"]["name"]
    assert len(first_job["metadata"]["name"]) <= 63
    assert len(second_job["metadata"]["name"]) <= 63
    assert len(first_configmap["metadata"]["name"]) <= 63
    assert len(second_configmap["metadata"]["name"]) <= 63
